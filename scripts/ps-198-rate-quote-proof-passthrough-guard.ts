/**
 * PS-198 guard — preserve the Rate Browser quote proof through Apply → Create Label /
 * Print Queue.
 *
 * THE BUG: /rates/browse stamps every rate with the backend snapshot ref (rateQuoteId +
 * selectedRateKey) and the response-level proof (requestFingerprint/cacheKey/proofSource),
 * but TWO frontend translations dropped them:
 *   1. translateRateToV2Shape rebuilt snake→camel without rateQuoteId/selectedRateKey
 *      (they survived only inside `raw`), and
 *   2. the modal's toAppliedRate()/handleRateClick() rebuilt the applied rate with
 *      display/money fields only.
 * The persisted best_rate_json then had ALL proof fields null, so a fresh, just-applied
 * quote was rejected at Create Label / Print Queue with "Rate changed or expired".
 *
 * THE FIX is pass-through restoration ONLY — the frontend never synthesizes proof:
 *   - translateRateToV2Shape carries rateQuoteId/selectedRateKey top-level (null when the
 *     backend issued none, e.g. the PS-197b manual estimate — still non-purchasable).
 *   - the modal lifts the backend-issued fields via rateBackendProof(r) in BOTH apply
 *     paths (manual click + canonical auto-applied best).
 *   - rateQuoteRefFromCandidates accepts a candidate carrying BOTH opaque ids as a
 *     complete backend snapshot ref (server-side validated at the purchase boundary)
 *     even when the legacy proofSource/requestFingerprint were dropped by a translation.
 *   - OrdersView.withRateRequestMetadata keeps passing rateQuoteId/selectedRateKey
 *     through untouched (it only re-stamps the fingerprint trio from backend values).
 *
 * Pins:
 *   1-6. rateQuoteRefFromCandidates behavior (ids-only ref, candidate order, legacy
 *        fallback unchanged, {} when nothing backend-issued — never synthesized).
 *   7-8. selectProofFromCandidates legacy semantics untouched.
 *   9-13. Source pins: modal lift helper + both apply spreads, translation pass-through,
 *        manual estimate stays unstamped, withRateRequestMetadata does not strip ids.
 *
 *   npx tsx scripts/ps-198-rate-quote-proof-passthrough-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rateQuoteRefFromCandidates,
  selectProofFromCandidates,
} from '../web/src/lib/rate-proof';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { failures += 1; console.error(`FAIL ${name}: got ${g}, want ${w}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. The PS-198 case: applied rate carries ONLY the opaque snapshot ref ─────
// (proofSource/requestFingerprint were dropped by a display translation). The ref
// must still be returned so the backend can validate the snapshot server-side.
check(
  'ids-only candidate yields the full snapshot ref (no legacy proof required)',
  rateQuoteRefFromCandidates([{ rateQuoteId: 'rq_abc', selectedRateKey: 'srk_def' }]),
  { rateQuoteId: 'rq_abc', selectedRateKey: 'srk_def' },
);

// ── 2. Candidate order: the explicit candidate wins over the saved fallback ───
check(
  'first candidate carrying both ids wins',
  rateQuoteRefFromCandidates([
    { rateQuoteId: 'rq_new', selectedRateKey: 'srk_new' },
    { rateQuoteId: 'rq_old', selectedRateKey: 'srk_old', proofSource: 'backend_rate_response', requestFingerprint: 'fp_old' },
  ]),
  { rateQuoteId: 'rq_new', selectedRateKey: 'srk_new' },
);

// ── 3. A HALF ref (one id missing) is NOT a snapshot ref on its own ───────────
// — it must fall through to the legacy-proof selection, which here picks the
// fully-proven saved rate.
check(
  'half ref falls through to the legacy-proven candidate',
  rateQuoteRefFromCandidates([
    { rateQuoteId: 'rq_half' },
    { rateQuoteId: 'rq_saved', selectedRateKey: 'srk_saved', proofSource: 'backend_rate_response', requestFingerprint: 'fp_saved' },
  ]),
  { rateQuoteId: 'rq_saved', selectedRateKey: 'srk_saved' },
);

// ── 4. Legacy fallback unchanged: proven candidate without ids yields {} ──────
// (the proof path is used instead; nothing is synthesized).
check(
  'legacy-proven candidate without ids yields {} (proof path used instead)',
  rateQuoteRefFromCandidates([
    { proofSource: 'backend_rate_response', requestFingerprint: 'fp_only' },
  ]),
  {},
);

// ── 5. Nothing backend-issued => {} — the frontend NEVER invents a ref ────────
check(
  'unproven candidates yield {}',
  rateQuoteRefFromCandidates([
    { amount: 8.95, serviceCode: 'usps_ground_advantage' },
    null,
    undefined,
  ]),
  {},
);

// ── 6. Non-string ids are rejected (no coercion of junk into a ref) ───────────
check(
  'non-string ids are ignored',
  rateQuoteRefFromCandidates([{ rateQuoteId: 123, selectedRateKey: { v: 1 } }]),
  {},
);

// ── 7-8. selectProofFromCandidates legacy semantics untouched ─────────────────
check(
  'legacy proof selection still requires backend proofSource + fingerprint',
  selectProofFromCandidates([{ requestFingerprint: 'fp_x' }]) === undefined,
  true,
);
{
  const proven = { proofSource: 'backend_rate_response', requestFingerprint: 'fp_y', serviceCode: 's' };
  const got = selectProofFromCandidates([{ rateQuoteId: 'rq_only', selectedRateKey: 'srk_only' }, proven]);
  check('ids-only candidate does NOT satisfy the legacy proof payload', got?.requestFingerprint, 'fp_y');
}

// ── 9-11. Modal source pins: lift helper exists and feeds BOTH apply paths ────
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
assert.ok(
  /function rateBackendProof\(r: RateRow\)/.test(modal),
  'RateBrowserModal must define rateBackendProof(r: RateRow) (PS-198 lift helper)',
);
console.log('ok   modal defines rateBackendProof');
{
  const clickStart = modal.indexOf('function handleRateClick(');
  const clickEnd = modal.indexOf('}', modal.indexOf('onClose();', clickStart));
  const clickBlock = modal.slice(clickStart, clickEnd);
  assert.ok(
    clickBlock.includes('...rateBackendProof(r)'),
    'handleRateClick (manual apply) must spread rateBackendProof(r)',
  );
  console.log('ok   manual apply (handleRateClick) preserves the backend proof');
}
{
  const appliedStart = modal.indexOf('function toAppliedRate(');
  const appliedBlock = modal.slice(appliedStart, modal.indexOf('  }', appliedStart));
  assert.ok(
    appliedBlock.includes('...rateBackendProof(r)'),
    'toAppliedRate (canonical/seeded apply) must spread rateBackendProof(r)',
  );
  console.log('ok   canonical apply (toAppliedRate) preserves the backend proof');
}
// Anti-synthesis: the lift helper must not mint a proofSource (or any) literal —
// it only copies what the backend stamped.
{
  const helperStart = modal.indexOf('function rateBackendProof(');
  const helperBlock = modal.slice(helperStart, modal.indexOf('\n  }', helperStart));
  assert.ok(
    !/proofSource\s*[:=]\s*['"`]/.test(helperBlock),
    'rateBackendProof must not synthesize a proofSource literal',
  );
  console.log('ok   lift helper is pass-through only (no synthesized proofSource)');
}

// ── 12. Translation pass-through + manual estimate stays unstamped ────────────
const shared = readFileSync('web/src/lib/v2-apiClient/shared.ts', 'utf8');
assert.ok(
  /rateQuoteId:\s*obj\.rateQuoteId\s*\?\?\s*null/.test(shared) &&
  /selectedRateKey:\s*obj\.selectedRateKey\s*\?\?\s*null/.test(shared),
  'translateRateToV2Shape must pass rateQuoteId/selectedRateKey through (null when absent)',
);
console.log('ok   translateRateToV2Shape carries the backend snapshot ref top-level');
{
  // The PS-197b manual-estimate baseline must remain structurally non-purchasable:
  // its rates are translated WITHOUT backendProofMetadata (ps-197 guard pins the
  // call site; here we pin that translate itself cannot invent an id).
  assert.ok(
    !/rateQuoteId:\s*['"`]/.test(shared),
    'translateRateToV2Shape must not mint a rateQuoteId literal',
  );
  console.log('ok   translation cannot invent a snapshot ref');
}

// ── 13. withRateRequestMetadata must not strip the snapshot ref ───────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
{
  const metaStart = ordersView.indexOf('function withRateRequestMetadata(');
  assert.ok(metaStart >= 0, 'OrdersView must define withRateRequestMetadata');
  const metaBlock = ordersView.slice(metaStart, ordersView.indexOf('\n  }', metaStart));
  assert.ok(
    !/rateQuoteId\s*:\s*_/.test(metaBlock) && !/selectedRateKey\s*:\s*_/.test(metaBlock),
    'withRateRequestMetadata must not destructure-discard rateQuoteId/selectedRateKey',
  );
  console.log('ok   withRateRequestMetadata passes the snapshot ref through untouched');
}

if (failures > 0) {
  console.error(`\nPS-198 guard: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nPS-198 guard: all checks passed');
