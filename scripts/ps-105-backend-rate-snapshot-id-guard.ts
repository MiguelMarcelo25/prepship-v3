/**
 * PS-105 guard — backend-owned rate quote snapshot ID primitive.
 *
 * Per user override unlock shipped data on 2026-06-06. This guard proves the
 * snapshot primitive is backend-owned, opaque (no PII), and that resolving a
 * (snapshot + selectedRateKey) into a proof passes the SAME strict purchase
 * validator — and that missing/expired/mismatched snapshots yield NO proof and
 * block purchase. It also checks the frontend gains no new fingerprint authority.
 */
import { readFileSync } from 'node:fs';
import {
  deriveRateQuoteId,
  isRateQuoteSnapshotFresh,
  resolveRateQuoteForPurchase,
  assertRateQuoteForLabelPurchase,
  buildSelectedRateProofFromSnapshot,
  selectedRateOpaqueKey,
  RATE_QUOTE_STALE_MESSAGE,
  RATE_QUOTE_SNAPSHOT_TTL_MS,
} from '../src/services/shipping-workflow/rate-quote-snapshot';
import {
  assertSelectedRateProofForLabelPurchase,
} from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── Fixtures: a cacheKey that embeds PII-ish fields + two eligible rates. ──
const cacheKey =
  'v=ground-saver-v2|eligibility=ps-057-hugrab-ground-saver-v1|d=2026-06-06|w=510|z=77422|co=US|st=TX|ci=brazoria|r=1|cl=10|l=90|dw=60|h=30|c=se-433542,se-595995';
const rateA = { carrierCode: 'ups', serviceCode: 'ups_ground', shippingProviderId: 595995, shipmentCost: 6.89, otherCost: 0, packageCode: 'package' };
const rateB = { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shippingProviderId: 433542, shipmentCost: 9.21, otherCost: 0, packageCode: 'package' };
const keyA = selectedRateOpaqueKey(rateA);
const keyB = selectedRateOpaqueKey(rateB);
const freshSnapshot = { cacheKey, rates: [rateA, rateB], fetchedAt: Date.now(), bestRateKey: keyA, bestRateComplete: true };
// Expired-by-construction relative to the ACTUAL snapshot TTL (+1h buffer), so this fixture stays
// genuinely expired regardless of the configured RATE_SAVED_TTL_HOURS (was a hardcoded 7h, which
// silently became "fresh" when the default TTL rose 6h -> 24h on 2026-06-23).
const expiredSnapshot = { cacheKey, rates: [rateA, rateB], fetchedAt: Date.now() - (RATE_QUOTE_SNAPSHOT_TTL_MS + 60 * 60 * 1000), bestRateKey: keyA, bestRateComplete: true };
const incompleteSnapshot = { cacheKey, rates: [rateA, rateB], fetchedAt: Date.now(), bestRateKey: keyA, bestRateComplete: false };

// ── 1. Opaque ID: no PII recoverable, deterministic, distinct from cacheKey. ──
const id = deriveRateQuoteId(cacheKey);
check('rateQuoteId is produced', typeof id === 'string' && id!.length > 0);
check('rateQuoteId is opaque (rq_ prefix, not the cacheKey)', id !== cacheKey && id!.startsWith('rq_'));
check('rateQuoteId leaks no zip/city/dims from cacheKey', !/77422|brazoria|se-433542|cl=10/.test(id ?? ''));
check('rateQuoteId is deterministic', deriveRateQuoteId(cacheKey) === id);
check('rateQuoteId is null for empty key', deriveRateQuoteId('') === null);

// ── 2. Fresh snapshot + valid selection → proof passes the EXISTING validator. ──
const okRes = resolveRateQuoteForPurchase({ snapshot: freshSnapshot, selectedRateKey: keyA });
check('fresh snapshot + valid key resolves ok', okRes.ok === true);
if (okRes.ok) {
  let assertPassed = true;
  try { assertSelectedRateProofForLabelPurchase(okRes.proof); } catch { assertPassed = false; }
  check('reconstructed proof passes assertSelectedRateProofForLabelPurchase', assertPassed);
  check('proof requestFingerprint is the backend cacheKey', okRes.proof.requestFingerprint === cacheKey);
}

// ── 3. Expired snapshot → blocked, no proof. ──
check('expired snapshot is not fresh', isRateQuoteSnapshotFresh(expiredSnapshot, Date.now()) === false);
const expRes = resolveRateQuoteForPurchase({ snapshot: expiredSnapshot, selectedRateKey: keyA });
check('expired snapshot does not resolve', expRes.ok === false && expRes.reason === 'snapshot_expired');

// ── 4. Wrong selection / missing snapshot → blocked, no proof. ──
const badKey = resolveRateQuoteForPurchase({ snapshot: freshSnapshot, selectedRateKey: 'nope|nope' });
check('unknown selectedRateKey does not resolve', badKey.ok === false && badKey.reason === 'selected_rate_not_in_snapshot');
const missing = resolveRateQuoteForPurchase({ snapshot: null, selectedRateKey: keyA });
check('missing snapshot does not resolve', missing.ok === false && missing.reason === 'snapshot_missing');
const manualNonBest = resolveRateQuoteForPurchase({ snapshot: freshSnapshot, selectedRateKey: keyB });
check('fresh finalized snapshot resolves a manually selected non-best rate from the same quote',
  manualNonBest.ok === true);
const notFinal = resolveRateQuoteForPurchase({ snapshot: incompleteSnapshot, selectedRateKey: keyA });
check('incomplete carrier-universe snapshot blocks purchase even for its provisional rank 1',
  notFinal.ok === false && notFinal.reason === 'snapshot_not_final');
check('distinct rates produce distinct authority keys', keyA !== keyB);
check('buildSelectedRateProofFromSnapshot returns null for unknown key',
  buildSelectedRateProofFromSnapshot(freshSnapshot, 'x|y') === null);

// ── 5. assert* throws (blocks purchase) for missing/expired before any provider call. ──
function throwsProofError(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
check('assertRateQuoteForLabelPurchase throws on missing snapshot',
  throwsProofError(() => assertRateQuoteForLabelPurchase({ snapshot: null, selectedRateKey: keyA })));
check('assertRateQuoteForLabelPurchase throws on expired snapshot',
  throwsProofError(() => assertRateQuoteForLabelPurchase({ snapshot: expiredSnapshot, selectedRateKey: keyA })));
check('assertRateQuoteForLabelPurchase returns a proof for a manually selected non-best snapshot rate',
  !throwsProofError(() => assertRateQuoteForLabelPurchase({ snapshot: freshSnapshot, selectedRateKey: keyB })));
check('assertRateQuoteForLabelPurchase throws when the snapshot is not carrier-universe complete',
  throwsProofError(() => assertRateQuoteForLabelPurchase({ snapshot: incompleteSnapshot, selectedRateKey: keyA })));
check('assertRateQuoteForLabelPurchase returns a proof on the happy path',
  !throwsProofError(() => assertRateQuoteForLabelPurchase({ snapshot: freshSnapshot, selectedRateKey: keyA })));

// ── 6. Operator-facing message is the canonical re-rate guidance. ──
check('stale message is the canonical re-rate guidance',
  RATE_QUOTE_STALE_MESSAGE === 'Rate changed or expired. Re-rate this order before creating the label.');

// ── 7. No bypass flags + backend-only (frontend gains no fingerprint authority). ──
const moduleSrc = readFileSync('src/services/shipping-workflow/rate-quote-snapshot.ts', 'utf8');
// Strip comments so we only flag actual bypass *code* (a flag prop/param/assign),
// not prose like "no bypass/force flags" or "Per user override unlock shipped data".
const codeOnly = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
check('snapshot module adds no force/bypass/skip-proof flag code',
  !/(force|bypass|skipProof|skipValidation|allowStale|disableProof)\s*[:=?]/i.test(codeOnly));
check('snapshot module delegates final authority to validateExactSelectedRate',
  /validateExactSelectedRate/.test(moduleSrc) && /assertSelectedRateProofForLabelPurchase/.test(moduleSrc));
check('snapshot module stores finalized best identity and completeness without forcing manual selections to rank 1',
  /bestRateKey\?: string \| null/.test(moduleSrc) &&
  /bestRateComplete\?: boolean \| null/.test(moduleSrc) &&
  /snapshot_not_final/.test(moduleSrc));

// ── 8. selectedRateKey is opaque (hashed) — no cost/money digest leaks. ──
check('selectedRateKey is opaque (srk_ prefix)', keyA.startsWith('srk_') && keyA !== keyB);
check('selectedRateKey leaks no cost', !/6\.89|9\.21|6890|9210/.test(keyA) && !/6\.89|9\.21/.test(keyB));

// ── 9. Slice-2 wiring: emit on the rate path, accept (prefer + fallback) at purchase. ──
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const rateBrowseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
// PS-244: /rates/browse emits the snapshot ref + selection keys via the SINGLE finalizer
// (finalizeBestRateWithQuote). PS-346 moved that finalizer behind the shared backend
// browse producer so both /rates/browse and /rates/browse/workflow use the same path.
check('rates /browse emits rateQuoteId + selectedRateKeys via the single finalizer',
  /import \{\s*produceRateBrowsePayload\s*\} from ['"]\.\.\/services\/rate-browse-response-producer['"]/.test(ratesRoute) &&
    /app\.post\('\/browse', zValidator\('json', browseBody\), async \(c\) =>[\s\S]*?const payload = await produceRateBrowsePayload\(\{[\s\S]*?return c\.json\(publicRatesResult\(payload, canViewFinancials\)\)/.test(ratesRoute) &&
    /finalizeBestRateWithQuote\(/.test(rateBrowseProducer) &&
    /responseRates = finalized\.rates/.test(rateBrowseProducer) &&
    /rateQuoteId/.test(rateBrowseProducer));
check('rates /browse stamps snapshot completeness into the single finalizer',
  /finalizeBestRateWithQuote\(\{[\s\S]*?bestRateComplete,/.test(rateBrowseProducer));
check('createLabelV2 boundary uses the unified rate-selection resolver',
  /await assertLabelPurchaseRateSelection\(/.test(labelsService));
check('createLabelV2 input accepts rateQuoteId + selectedRateKey',
  /rateQuoteId\?: string \| null;/.test(labelsService) && /selectedRateKey\?: string \| null;/.test(labelsService));
check('labels route schema accepts rateQuoteId + selectedRateKey',
  /rateQuoteId: z\.string\(\)/.test(labelsRoute) && /selectedRateKey: z\.string\(\)/.test(labelsRoute));
check('purchase resolver PREFERS snapshot id but FALLS BACK to legacy proof (never weaker)',
  /body\.rateQuoteId && body\.selectedRateKey/.test(store) &&
    /assertSelectedRateProofForLabelPurchase\(body\.selectedRateProof \?\? null\)/.test(store) &&
    /snapshot_not_final/.test(store) &&
    !/selected_rate_not_best/.test(store));
check('snapshot persistence is backed by analytics_cache (no migration)',
  /from '\.\.\/analytics-cache\.js'/.test(store) && /rate_quote:/.test(store));

// ── 10. Frontend EMIT: passes { rateQuoteId, selectedRateKey } alongside the proof. ──
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-135 moved the ref/proof candidate selection into web/src/lib/rate-proof.ts
// (rateQuoteRefFromCandidates); OrdersView's buildRateQuoteRefForOrder delegates to it,
// passing the SAME ordered candidates as buildSelectedRateProofPayload. PS-198 lets a
// candidate carrying BOTH backend-minted opaque ids win BEFORE the legacy-proof
// selection (behavior pinned by ps-198-rate-quote-proof-passthrough-guard.ts).
const rateProofLib = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
// PS-317: buildRateQuoteRefForOrder (+ getSavedBestRateRecord it calls) moved to
// ./orders/best-rate/rate-proof.ts. The DEFINE/body regex now reads the new owner; its
// EMIT call sites (...buildRateQuoteRefForOrder(order, ...)) stayed in OrdersView and are
// asserted below, summed across both files so the census never undershoots.
const bestRateProof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
// PS-204 re-anchor: the wrapper's delegation gained an account-binding option
// ({ forShippingProviderId }) so cross-account candidates are filtered out —
// same ordered candidate list, STRICTER selection, never weaker.
check('frontend has buildRateQuoteRefForOrder mirroring the proof rate selection',
  /function buildRateQuoteRefForOrder[\s\S]{0,300}?return rateQuoteRefFromCandidates\(\[\s*toRecord\(candidate\),\s*toRecord\(order\.bestRate\),\s*toRecord\(order\.selectedRate\),\s*getSavedBestRateRecord\(order\),\s*\], \{ forShippingProviderId \}\)/.test(bestRateProof) &&
    /export function rateQuoteRefFromCandidates[\s\S]*?toStr\(r\.rateQuoteId\) && toStr\(r\.selectedRateKey\)[\s\S]*?hasBackendIssuedRateProof\(r\) && rateProofFingerprint\(r\)/.test(rateProofLib));
// PS-204 re-anchor (2026-06-12): both counts below were STALE at base (failing
// silently outside the cert since the PS-178 decomposition consolidated payload
// sites). Honest census: TWO ...buildRateQuoteRefForOrder( emission sites
// (panel single-create + batch queue payload) and THREE selectedRateProof:
// property sites (+ the batch-create `let` form, pinned by the boundary/ps-095
// guards). Both panel/batch forms are now ACCOUNT-BOUND per PS-204 — pinned
// here so the binding can't silently disappear.
check('frontend emits the rate quote ref on the primary create/queue/batch payloads (>= 2)',
  // PS-317: emit call sites stayed in OrdersView; census summed across OrdersView + the moved
  // best-rate/rate-proof.ts so the count never undershoots if a call site later relocates.
  ((ordersView + bestRateProof).match(/\.\.\.buildRateQuoteRefForOrder\(order/g)?.length ?? 0) >= 2 &&
  /\.\.\.buildRateQuoteRefForOrder\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView) &&
  /\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView));
// PS-317 A4 (Per user override unlock shipped data on 2026-06-23): the FE
// direct-carrier label BUY was DELETED. `createDirectCarrierLabelThenQueue`
// (which built its own selectedRateProof + account-bound rateQuoteRef and called
// apiClient.createLabel with a direct-carrier shipTo payload) is gone; every
// queue order now routes to the backend create/recover job. The backend
// (createLabelV2 -> directLabelAccountRefFromProviderId/createDirectCarrierLabelForOrder)
// owns the buy and runs the SAME assertLabelPurchaseRateSelection proof gate +
// account binding. So this guard no longer expects a stale ref on a FE
// direct-buy override path — that path no longer exists.
check('frontend NO LONGER owns a direct-carrier label buy (createDirectCarrierLabelThenQueue deleted)',
  !/createDirectCarrierLabelThenQueue/.test(ordersView) &&
  // anti-regression: no createLabel call may carry a direct-carrier shipTo buy payload.
  !/shipTo:\s*\{[\s\S]{0,400}?\},[\s\S]{0,200}?apiClient\.createLabel/.test(ordersView));
check('frontend does NOT pass a stale ref on any direct-carrier retry/override path',
  // The deleted FE direct-buy's override-wrapper proof path is gone; anti-regression
  // ensures no future FE override-buy reintroduces a buildRateQuoteRefForOrder beside it.
  !/overridePayload\?\.selectedRateProof[\s\S]{0,200}?buildRateQuoteRefForOrder/.test(ordersView));
// The proof + account binding the deleted FE buy used to carry now ride on the
// backend INTENT payload (buildQueueSendOrderPayload -> order.label), which
// print-queue.ts processQueueSendOrder spreads into createLabelV2. Re-point the
// former direct-buy proof line (`const selectedRateProof = ...bestRate ??
// selectedRate, shippingProviderId`) to that intent payload: the SAME
// selectedRateProof + account-bound rate-quote ref + shippingProviderId, all
// keyed to the account this queue order charges.
check('frontend ref is additive (proof still passed at every site)',
  // PS-317: selectedRateProof: buildSelectedRateProofPayload(order, ...) call sites stayed in
  // OrdersView; census summed across both files so the count never undershoots.
  ((ordersView + bestRateProof).match(/selectedRateProof:[\s\S]{0,160}?buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 2 &&
  // RELOCATED: the proof+binding the FE direct-buy carried now lives on the
  // queue INTENT payload (order.label), bound to the same shippingProviderId.
  /payload\.label = options\.labelPayloadOverrides\?\.get\(order\.orderId\) \?\?[\s\S]{0,900}?selectedRateProof: buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\),\s*\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\),/.test(ordersView) &&
  /payload\.label = options\.labelPayloadOverrides\?\.get\(order\.orderId\) \?\?[\s\S]{0,600}?shippingProviderId: shippingProviderId \?\? undefined,/.test(ordersView) &&
  // 2026-07-07 cleanup: the legacy batch loop's proof line is deleted; the chain's override
  // payload carries the fresh-rate proof + rate-quote ref instead.
  ordersView.includes('const selectedRateProof = buildSelectedRateProofPayload(order, rate)') &&
  ordersView.includes('...buildRateQuoteRefForOrder(order, rate, shippingProviderId),'));
// Backend now owns the (former-FE) direct-carrier buy: createLabelV2 detects the
// direct carrier and runs the SAME strict purchase proof gate before spending.
const labelsServiceForRelocation = readFileSync('src/services/labels.ts', 'utf8');
const printQueueService = readFileSync('src/services/print-queue.ts', 'utf8');
check('backend createLabelV2 owns the direct-carrier buy behind the strict proof gate',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsServiceForRelocation) &&
  /createDirectCarrierLabelForOrder\(/.test(labelsServiceForRelocation) &&
  /await assertLabelPurchaseRateSelection\(\{[\s\S]{0,200}?selectedRateProof: body\.selectedRateProof,/.test(labelsServiceForRelocation));
check('print-queue routes the FE intent (order.label proof/binding) into createLabelV2',
  /const labelInput = order\.label;[\s\S]*?createLabelV2\(\{\s*\.\.\.labelInput,[\s\S]*?orderId: order\.orderId,[\s\S]*?orderNumber: order\.orderNumber \?\? labelInput\.orderNumber,/.test(printQueueService));

if (failures > 0) {
  console.error(`\nFAIL PS-105 backend rate snapshot id guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-105 backend rate snapshot id guard');
