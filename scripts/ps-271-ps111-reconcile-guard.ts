/**
 * PS-271 (Layer 4) — thin-source ↔ PS-111 completeness RECONCILE guard.
 *
 * Proves the accepted-thin signal flows through the PS-111 completeness owner at the WORKFLOW DTO
 * (buildBestRateWorkflowDto), not only in rates-combined — so a best sourced from a thin carrier is
 * NOT reported COMPLETE / fresh anywhere the row state is derived. And that the change is ADDITIVE +
 * default-inert: with no thin status the DTO is byte-identical to today.
 *
 *   1. isBestRateComplete (the canonical owner) already treats a THIN carrier as not-complete, like
 *      loading/error — re-pinned here so a future edit can't silently drop the thin clause.
 *   2. buildBestRateWorkflowDto: a saved+matching+complete+fresh best that today resolves to `fresh`
 *      is DEMOTED to `partial_carrier_failure` when a live carrier status is flagged thin — re-rate
 *      required (canUseSavedRate=false / canCreateLabel=false), saved value still DISPLAYS (PS-196
 *      savedRateDisplay='stale'). The matching full (non-thin) pass stays `fresh` + usable.
 *   3. INERT off-path: with no thin status, and with an empty carrier set, the DTO is unchanged from
 *      today's behavior (fresh stays fresh; the thin clause is scoped to thin===true, never to the
 *      common empty/loading set).
 *   4. The thin demotion is treated EXACTLY like a failed carrier — the existing hasCarrierFailure
 *      branch and the new thin branch produce the same partial_carrier_failure state + actions.
 *
 * Pure: no DB, no network, no provider calls, no postage. Imports the real module.
 *
 *   npx tsx scripts/ps-271-ps111-reconcile-guard.ts
 */
import {
  isBestRateComplete,
  buildBestRateWorkflowDto,
  type BestRateWorkflowCarrierStatus,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const cs = (
  status: BestRateWorkflowCarrierStatus['status'],
  extra: Partial<BestRateWorkflowCarrierStatus> = {},
): BestRateWorkflowCarrierStatus => ({ carrierId: `se-${status}`, status, rateCount: 1, ...extra });

// A saved best that, on its own, satisfies fresh: positive amount, matching fingerprint, isComplete,
// and a future cache expiry. The carrier statuses are what flip thin/full.
const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
const savedFreshBest = {
  amount: 7.5,
  requestFingerprint: 'fp1',
  isComplete: true,
  cacheExpiresAt: futureExpiry,
  serviceCode: 'usps_ground_advantage',
  // PS-299/PS-300: a genuine backend-issued saved rate stamps proofSource; the
  // display/purchase gate requires it, so a "fresh" fixture must carry it.
  proofSource: 'backend_rate_response',
};

// ── 1) isBestRateComplete still treats a THIN carrier as not-complete (canonical owner) ──
check('canonical: full live UPS+FedEx -> complete',
  isBestRateComplete([cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-fedex' })]) === true);
check('canonical: a THIN carrier -> NOT complete (terminal but unproven)',
  isBestRateComplete([cs('live', { carrierId: 'se-shipp', thin: true })]) === false);
check('canonical: thin alongside a clean carrier still -> NOT complete',
  isBestRateComplete([cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-shipp', thin: true })]) === false);

// ── 2) workflow DTO: a thin carrier demotes fresh -> partial; a full set stays fresh ──
{
  const thin = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    carrierStatuses: [cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-shipp', thin: true })],
    source: 'live',
  });
  check('DTO: a thin live carrier demotes the best to partial_carrier_failure (NOT fresh)',
    thin.bestRateState === 'partial_carrier_failure');
  check('DTO: thin best is NOT purchase-authorized (canUseSavedRate=false)',
    thin.allowedActions.canUseSavedRate === false);
  check('DTO: thin best cannot create a label (canCreateLabel=false)',
    thin.allowedActions.canCreateLabel === false);
  check('DTO: thin best still DISPLAYS the saved value (PS-196 savedRateDisplay=stale)',
    thin.savedRateDisplay === 'stale');
  check('DTO: thin best -> source confidence is partial (not live/cache_fresh)',
    thin.sourceConfidence === 'partial');
  // The DTO's own carrierStatuses preserve the thin flag, and isBestRateComplete over them is false.
  check('DTO: carrierStatuses preserve the thin flag through sanitization',
    thin.carrierStatuses.some((s) => s.carrierId === 'se-shipp' && s.thin === true));
  check('DTO: isBestRateComplete over the DTO carrierStatuses is false (the signal reaches PS-111)',
    isBestRateComplete(thin.carrierStatuses) === false);

  const full = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    carrierStatuses: [cs('live', { carrierId: 'se-ups' }), cs('cached', { carrierId: 'se-fedex' })],
    source: 'live',
  });
  check('DTO: a full (non-thin) terminal set stays fresh',
    full.bestRateState === 'fresh');
  check('DTO: a full set CAN use the saved rate (canUseSavedRate=true)',
    full.allowedActions.canUseSavedRate === true);
  check('DTO: isBestRateComplete over a full DTO set is true',
    isBestRateComplete(full.carrierStatuses) === true);
}

// ── 3) INERT off-path: no thin status -> byte-identical to today ──────────────
{
  // Empty carrier set (the common saved-rate-only path) must NOT be misread as thin/incomplete.
  const emptyCarriers = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    carrierStatuses: [],
    source: 'live',
  });
  check('INERT: empty carrier set + fresh saved best -> still fresh (NOT demoted)',
    emptyCarriers.bestRateState === 'fresh');
  check('INERT: empty carrier set -> saved rate usable',
    emptyCarriers.allowedActions.canUseSavedRate === true);

  // No carrierStatuses argument at all (legacy callers).
  const noCarriers = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    source: 'live',
  });
  check('INERT: omitted carrierStatuses -> still fresh',
    noCarriers.bestRateState === 'fresh');
}

// ── 4) thin is treated EXACTLY like a failed carrier (same partial state + actions) ──
{
  const erroredCarrier = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    carrierStatuses: [cs('live', { carrierId: 'se-ups' }), cs('error', { carrierId: 'se-fedex' })],
    source: 'live',
  });
  const thinCarrier = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: savedFreshBest,
    carrierStatuses: [cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-fedex', thin: true })],
    source: 'live',
  });
  check('PARITY: a failed carrier -> partial_carrier_failure (unchanged PS-111)',
    erroredCarrier.bestRateState === 'partial_carrier_failure');
  check('PARITY: a thin carrier yields the SAME bestRateState as a failed carrier',
    thinCarrier.bestRateState === erroredCarrier.bestRateState);
  check('PARITY: a thin carrier yields the SAME allowedActions as a failed carrier',
    JSON.stringify(thinCarrier.allowedActions) === JSON.stringify(erroredCarrier.allowedActions));
  check('PARITY: a thin carrier yields the SAME savedRateDisplay as a failed carrier',
    thinCarrier.savedRateDisplay === erroredCarrier.savedRateDisplay);
}

if (failures > 0) {
  console.error(`\nFAIL PS-271 PS-111 reconcile guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-271 PS-111 reconcile guard');
