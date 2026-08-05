/**
 * PS-111 — Backend-owned best-rate authority + completeness guard.
 *
 * Proves the backend (not the frontend) owns whether a best rate is COMPLETE, that
 * completeness is derived from carrier diagnostics (never hardcoded true), and that a
 * partial/failed-carrier result is surfaced as partial — so the Orders table can show
 * pending/partial/error/stale instead of a false "complete". Pure: no DB, no network,
 * no provider calls, no postage.
 *
 *   npx tsx scripts/ps-111-backend-rate-authority-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  isBestRateComplete,
  buildBestRateWorkflowDto,
  type BestRateWorkflowCarrierStatus,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
const cs = (status: BestRateWorkflowCarrierStatus['status'], id = `se-${status}`): BestRateWorkflowCarrierStatus =>
  ({ carrierId: id, status, rateCount: status === 'live' || status === 'cached' ? 1 : 0 });

// ── 1) isBestRateComplete — the canonical completeness rule ──────────────────
check('empty carrier set is NOT complete (nothing rated yet)', isBestRateComplete([]), false);
check('null carrier set is NOT complete', isBestRateComplete(null), false);
check('all terminal (live + cached + unavailable + blocked) -> complete',
  isBestRateComplete([cs('live'), cs('cached'), cs('unavailable'), cs('blocked')]), true);
check('any carrier still LOADING -> NOT complete',
  isBestRateComplete([cs('live'), cs('loading')]), false);
check('any carrier ERROR -> NOT complete',
  isBestRateComplete([cs('live'), cs('error')]), false);

// ── 2) Workflow DTO reflects partial/complete from carrier statuses ──────────
{
  // A rate exists but a carrier errored -> partial_carrier_failure, not fresh.
  const partial = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: { amount: 7.5, requestFingerprint: 'fp1', isComplete: false, cacheExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
    carrierStatuses: [cs('live'), cs('error')],
    source: 'live',
  });
  check('DTO: rate + a failed carrier -> partial_carrier_failure', partial.bestRateState, 'partial_carrier_failure');
  check('DTO: partial state cannot use the saved rate / requires re-rate', partial.allowedActions.canUseSavedRate, false);

  // All carriers terminal, fresh, complete -> fresh + usable.
  // PS-299/PS-300: a genuinely usable saved rate is a backend-issued (proofSource)
  // rate with a display identity (serviceCode) — the purchase gate requires both.
  const fresh = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: {
      amount: 7.5,
      requestFingerprint: 'fp1',
      isComplete: true,
      cacheExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      serviceCode: 'usps_ground_advantage',
      proofSource: 'backend_rate_response',
    },
    carrierStatuses: [cs('live'), cs('cached')],
    source: 'live',
  });
  check('DTO: complete + fresh + matching fingerprint -> fresh', fresh.bestRateState, 'fresh');
  check('DTO: fresh state can use the saved rate', fresh.allowedActions.canUseSavedRate, true);

  // No rate at all -> missing.
  const missing = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: null,
    carrierStatuses: [cs('unavailable')],
    source: 'none',
  });
  check('DTO: no saved rate -> missing', missing.bestRateState, 'missing');
}

// ── 3) Backend owns completeness in the combined-universe owner (no hardcoded true) ──
// PS-166/203/271 moved the combine + completeness derivation out of the route and into
// combineCarrierUniverses (rates-combined.ts), the single owner both /browse and the
// backfill producer delegate to. The route is a thin consumer: it destructures
// bestRateComplete and stamps it. Reconcile the assertions to the current SOT location.
{
  const ratesCombined = readFileSync('src/services/rates-combined.ts', 'utf8');
  check('combine owner unions ShipStation + direct-carrier statuses before completeness',
    /const combinedCarrierStatuses = \[\.\.\.carrierStatuses, \.\.\.directCarrierStatuses\]/.test(ratesCombined), true);
  check('combine owner derives completeness from the combined statuses (never hardcoded true)',
    /bestRateComplete: statusesComplete\(combinedCarrierStatuses\)/.test(ratesCombined), true);

  // Repointed (guard rot): /rates/browse was extracted from src/routes/rates.ts into
  // src/services/rate-browse-response-producer.ts (route delegates to produceRateBrowsePayload);
  // the completeness destructure + isComplete stamping live in the producer now, and the
  // metadata fingerprint is combinedRequestKey (was result.cacheKey).
  const browseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
  check('browse producer consumes the owner-computed completeness (destructures bestRateComplete)',
    /\bbestRateComplete,/.test(browseProducer), true);
  check('browse producer stamps the computed completeness onto the best rate (isComplete: bestRateComplete)',
    /isComplete: bestRateComplete/.test(browseProducer), true);
  check('browse producer never hardcodes isComplete: true on the best-rate metadata',
    /isComplete: true/.test(browseProducer), false);
}

// ── 4) Frontend consumes backend completeness (no hardcoded true) ────────────
// PS-166 extracted deriveBackendBestRateComplete into its own small file
// (orders-rate-proof.ts); OrdersView imports and consumes it. Reconcile the locations.
{
  const rateProof = readFileSync('web/src/components/Views/orders-rate-proof.ts', 'utf8');
  check('frontend has a backend-owned completeness resolver (in its own small file)',
    /export function deriveBackendBestRateComplete/.test(rateProof), true);

  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  check('OrdersView imports the backend-owned completeness resolver',
    /import \{ deriveBackendBestRateComplete \} from '\.\/orders-rate-proof'/.test(ordersView), true);
  // Repointed (guard rot): the passive auto-rating call site now derives completeness from
  // decision.rate (was a local bestRate binding) — same backend-owned resolver, renamed arg.
  check('passive auto-rating uses backendComplete (not a hardcoded true)',
    /const backendComplete = deriveBackendBestRateComplete\(response, decision\.rate\)/.test(ordersView)
    && /isComplete: backendComplete/.test(ordersView), true);
  check('frontend still uses the backend bestRate as the source of truth',
    /const bestRate = toRecord\(response\?\.bestRate\)/.test(ordersView), true);
}

// ── 5) Backend pre-rates NEW awaiting orders after sync (no browser needed) ──
{
  const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
  const importOwner = readFileSync('src/services/store-order-import.ts', 'utf8');
  const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
  check('new awaiting imports durably enqueue targeted backend rate work',
    /await enqueueBackfillBestRatesForOrderIds\([\s\S]{0,120}'rate-on-ingest'/.test(importOwner), true);
  // Repointed 2026-08-05: PS-436 moved backfill ownership out of the scheduler. A cron
  // row is now only a wake-up -- the scheduler calls runDurableRateBackfillJob() and the
  // durable owner in rates-backfill.ts decides whether to start work or coalesce into the
  // active generation ("rate backfill cadence coalesced into the active durable
  // generation"). The idempotency is stronger than before: generation-scoped and durable
  // rather than an in-process flag that a restart would clear. Assert it at the owner it
  // moved to, and that the scheduler delegates rather than keeping its own copy.
  const backfillOwner = readFileSync('src/services/rates-backfill.ts', 'utf8');
  check('rate backfill is idempotent (skips when a job is already running)',
    /export function getActiveBackfillJob\(\)/.test(backfillOwner)
    && /const active = getActiveBackfillJob\(\)/.test(backfillOwner)
    && /export function startBackfillBestRates\(/.test(backfillOwner), true);
  check('the scheduler only wakes the durable backfill owner (owns no second start path)',
    /runDurableRateBackfillJob\(payload, signal\)/.test(scheduler)
    && !/startBackfillBestRates\(/.test(scheduler), true);
  check('scheduled sweep remains gated by ENABLE_RATE_BACKFILL_SCHEDULER (opt-in, bounded)',
    /env\.ENABLE_RATE_BACKFILL_SCHEDULER && !env\.DISABLE_RATE_BACKFILL_SCHEDULER/.test(queue)
    && /isRateBackfillSchedulerEnabled\(\)/.test(queue), true);

  // The backend backfill stamps completeness from carrier diagnostics — same rule as
  // /browse — so backend-pre-rated orders are never marked complete while a carrier
  // failed/loaded.
  const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
  // PS-203/271: the backfill now delegates completeness to the SAME combined-universe owner
  // as /browse (combined.bestRateComplete from combineCarrierUniverses) instead of re-deriving
  // it inline — still never a hardcoded true.
  check('backend backfill derives isComplete from the combined-universe owner (not hardcoded true)',
    /isComplete:\s*combined\.bestRateComplete\b/.test(backfill), true);

  // ── 6) HUGRAB insured-total certification (PS-111 ↔ PS-108) ────────────────
  // The backend pre-rating path must produce INSURED HUGRAB totals: backfill -> getRates
  // -> resolveRateInput applies the HUGRAB ParcelGuard $100 default -> the live-rate fan
  // enriches the premium BEFORE pickBestRate. This certifies PS-111's requirement that
  // HUGRAB insured totals are handled via PS-108 before best-rate selection — without a
  // browser session.
  check('backend pre-rating rates HUGRAB orders through getRates (the insured path)',
    /getRates\(/.test(backfill), true);
  // PS-170: the HUGRAB ParcelGuard request-level default moved out of resolveRateInput into the
  // single eligibility owner (resolveHugrabRequestInsurance in shipping-service-eligibility.ts);
  // resolveRateInput now DELEGATES to it. Assert the owner sets the default and the route delegates.
  const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
  check('resolveRateInput delegates the HUGRAB insurance default to the eligibility owner',
    /resolveHugrabRequestInsurance\(/.test(ratesSrc), true);
  const eligibilitySrc = readFileSync('src/lib/shipping-service-eligibility.ts', 'utf8');
  check('the eligibility owner applies the HUGRAB ParcelGuard default insurance',
    /isHugrabShippingContext\(/.test(eligibilitySrc) && /insuranceProvider: 'parcelguard'/.test(eligibilitySrc), true);
  check('the live-rate fan enriches the ParcelGuard premium before best-rate selection',
    /enrichRatesWithInsuranceCost\(/.test(ratesSrc) && /pickBestRate/.test(ratesSrc), true);
  check('rate cache busts when the insurance config changes (no stale insured premium)',
    /insuranceCostConfigFingerprint\(\)/.test(ratesSrc), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-111 backend rate authority guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-111 backend rate authority guard');
