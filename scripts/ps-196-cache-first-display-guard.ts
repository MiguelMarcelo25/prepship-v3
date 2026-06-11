/**
 * PS-196 guard — cache-first Awaiting Shipment Best Rate display after reload.
 *
 * THE BUG: ~29k awaiting orders have saved best rates, but legacy rows lack the newer proof
 * metadata (requestFingerprint / isComplete / cacheExpiresAt), so the workflow classified them
 * 'unknown' and the FE display contract rejected them — reload showed spinners ("rates gone").
 *
 * THE FIX SEPARATES TWO DECISIONS:
 *   display:  BestRateWorkflowDto.savedRateDisplay ('fresh'|'stale'|'saved_unproven'|'none') —
 *             the backend's display-only verdict; the FE renders the saved value immediately.
 *   purchase: allowedActions (+ the backend selected-rate proof asserts) — UNCHANGED; only a
 *             current fresh proven rate is purchase-authorized.
 *
 * Pins (behavioral, pure — no DB/network):
 *   1. Legacy saved rate (positive amount + identity, no proof metadata) => state 'unknown',
 *      savedRateDisplay 'saved_unproven', canCreateLabel/canUseSavedRate FALSE.
 *   2. Fully-proven fresh rate => 'fresh' display AND purchase-authorized.
 *   3. Changed fingerprint => 'stale' display, NOT purchase-authorized (requiresRerate).
 *   4. Saved amount with NO display identity => 'none' (never render an empty cell).
 *   5. FE contract accepts the backend verdict for display (legacy now displayable) while the
 *      strict legacy-rejecting behavior is preserved when no verdict is provided.
 *   6. FE classifier renders 'ready' for displayable stale/unknown rows (no spinner wipe), and
 *      still spins/terminals when nothing is displayable.
 *   7. Cache-first source pin: the passive enqueue skip + display-order retention use the same
 *      display contract (hasValidSavedBestRateForRequest / hasSavedBestRateForRequest).
 *
 *   npx tsx scripts/ps-196-cache-first-display-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBestRateWorkflowDto } from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  classifyAwaitingRateCellStateWithWorkflow,
  savedBestRateCanDisplayForCurrentRequest,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { failures += 1; console.error(`FAIL ${name}: got ${g}, want ${w}`); }
  else console.log(`ok   ${name}`);
}

// ── 1-4. Backend DTO: display vs purchase separation ──────────────────────────
const LEGACY_SAVED = {
  amount: 8.95,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  carrierNickname: 'ROCEL C81F70',
  // deliberately NO requestFingerprint / cacheKey / isComplete / cacheExpiresAt — the legacy era
};
{
  const dto = buildBestRateWorkflowDto({ savedBestRate: LEGACY_SAVED, source: 'cache' });
  check('legacy saved rate classifies unknown (purchase semantics unchanged)', dto.bestRateState, 'unknown');
  check('legacy saved rate is DISPLAYABLE as saved_unproven', dto.savedRateDisplay, 'saved_unproven');
  check('legacy saved rate is NOT purchase-authorized', dto.allowedActions.canCreateLabel, false);
  check('legacy saved rate cannot be used as the selected rate', dto.allowedActions.canUseSavedRate, false);
  check('legacy saved rate requires re-rate for purchase', dto.allowedActions.requiresRerate, true);
}
{
  const fresh = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp-1',
    savedBestRate: {
      ...LEGACY_SAVED,
      requestFingerprint: 'fp-1',
      isComplete: true,
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    source: 'cache',
  });
  check('proven current rate stays fresh', fresh.bestRateState, 'fresh');
  check('proven current rate displays as fresh', fresh.savedRateDisplay, 'fresh');
  check('proven current rate IS purchase-authorized', fresh.allowedActions.canCreateLabel, true);
}
{
  const mismatched = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp-NEW',
    savedBestRate: {
      ...LEGACY_SAVED,
      requestFingerprint: 'fp-OLD',
      isComplete: true,
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    source: 'cache',
  });
  check('changed fingerprint classifies mismatched_request', mismatched.bestRateState, 'mismatched_request');
  check('changed fingerprint displays as stale (saved value visible)', mismatched.savedRateDisplay, 'stale');
  check('changed fingerprint is NOT purchase-authorized', mismatched.allowedActions.canCreateLabel, false);
}
{
  const noIdentity = buildBestRateWorkflowDto({ savedBestRate: { amount: 5.5 }, source: 'cache' });
  check('saved amount without display identity -> none (never an empty cell)', noIdentity.savedRateDisplay, 'none');
}

// ── 5. FE display contract: backend verdict accepted; strict path preserved ───
const STRICT_LEGACY_INPUT = {
  clientRequestKey: null,
  requestKey: 'req-1',
  hasBackendIssuedRateProof: false,
  isComplete: false,
  cacheExpiresAt: null,
  baseAmount: 8.95,
} as const;
check('WITHOUT backend verdict, the strict contract still rejects legacy (unchanged)',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT }), false);
check('WITH backend saved_unproven verdict, legacy displays',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'saved_unproven' }), true);
check('WITH backend stale verdict, proven-stale displays',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'stale' }), true);
check('backend none verdict does NOT loosen the strict contract',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'none' }), false);
check('a zero-amount rate never displays, even with a verdict',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, baseAmount: 0, backendSavedRateDisplay: 'saved_unproven' }), false);

// ── 6. FE classifier: displayable saved rows render 'ready', not a spinner ────
const FALLBACK_DISPLAYABLE = {
  hasDims: true, hasWeight: true, hasDisplayableBestRate: true,
  isCalculatingBestRate: false, resolvedNoRate: false, hasCarrierContext: true, accountsLoading: false,
};
const FALLBACK_BLANK = { ...FALLBACK_DISPLAYABLE, hasDisplayableBestRate: false };
check("'unknown' + displayable saved -> ready (the reload fix)",
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'unknown', savedRateDisplay: 'saved_unproven' }, FALLBACK_DISPLAYABLE), 'ready');
check("'stale' + displayable saved -> ready (saved value, no spinner wipe)",
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'stale', savedRateDisplay: 'stale' }, FALLBACK_DISPLAYABLE), 'ready');
check("'mismatched_request' + displayable saved -> ready",
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'mismatched_request', savedRateDisplay: 'stale' }, FALLBACK_DISPLAYABLE), 'ready');
check("'stale' WITHOUT a displayable rate still refreshes (calculating)",
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'stale', savedRateDisplay: 'none' }, FALLBACK_BLANK), 'calculating');
check("'missing' is still terminal unavailable (no indefinite spinner)",
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'missing', savedRateDisplay: 'none' }, FALLBACK_BLANK), 'unavailable');

// ── 7. Cache-first source pins ─────────────────────────────────────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('passive enqueue still skips rows with a valid saved display (cache-first)',
  /hasValidSavedBestRateForRequest\(order, request\)\) return null/.test(ordersView), true);
check('display order keeps the saved rate via the same contract',
  /!hasSavedBestRateForRequest\(order, autoRequest\)/.test(ordersView), true);
check('the FE passes the backend savedRateDisplay verdict into the contract',
  /backendSavedRateDisplay: toStringValue\(toRecord\(workflow\)\?\.savedRateDisplay\)/.test(ordersView), true);

if (failures > 0) {
  console.error(`\nFAIL PS-196 cache-first display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-196 cache-first display guard');
