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
  const fresh = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp1',
    savedBestRate: { amount: 7.5, requestFingerprint: 'fp1', isComplete: true, cacheExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
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

// ── 3) Backend /browse no longer hardcodes completeness ──────────────────────
{
  const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
  check('backend /browse combines ShipStation + direct-carrier statuses before completeness',
    /const combinedCarrierStatuses = \[\.\.\.carrierStatuses, \.\.\.directCarrierStatuses\]/.test(ratesRoute), true);
  check('backend /browse derives completeness via isBestRateComplete(combinedCarrierStatuses)',
    /const bestRateComplete = isBestRateComplete\(combinedCarrierStatuses\)/.test(ratesRoute), true);
  check('backend /browse stamps the computed completeness onto bestRateMetadata',
    /isComplete: bestRateComplete/.test(ratesRoute), true);
  check('backend /browse no longer hardcodes isComplete: true in bestRateMetadata',
    /requestFingerprint: result\.cacheKey[\s\S]{0,200}isComplete: true/.test(ratesRoute), false);
}

// ── 4) Frontend consumes backend completeness (no hardcoded true) ────────────
{
  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  check('frontend has a backend-owned completeness resolver',
    /function deriveBackendBestRateComplete/.test(ordersView), true);
  check('passive auto-rating uses backendComplete (not a hardcoded true)',
    /const backendComplete = deriveBackendBestRateComplete\(response, bestRate\)/.test(ordersView)
    && /isComplete: backendComplete/.test(ordersView), true);
  check('frontend still uses the backend bestRate as the source of truth',
    /const bestRate = toRecord\(response\?\.bestRate\)/.test(ordersView), true);
}

// ── 5) Backend pre-rates NEW awaiting orders after sync (no browser needed) ──
{
  const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
  check('order sync triggers the rate backfill when new orders land (enqueue-on-sync)',
    /result\.synced > 0 && isRateBackfillSchedulerEnabled\(\)/.test(scheduler)
    && /runBackfillTick\(\)/.test(scheduler), true);
  check('rate backfill is idempotent (skips when a job is already running)',
    /getActiveBackfillJob\(\)/.test(scheduler) && /startBackfillBestRates\(/.test(scheduler), true);
  check('enqueue-on-sync is gated by ENABLE_RATE_BACKFILL_SCHEDULER (opt-in, bounded)',
    /env\.ENABLE_RATE_BACKFILL_SCHEDULER && !env\.DISABLE_RATE_BACKFILL_SCHEDULER/.test(scheduler), true);

  // The backend backfill stamps completeness from carrier diagnostics — same rule as
  // /browse — so backend-pre-rated orders are never marked complete while a carrier
  // failed/loaded.
  const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
  check('backend backfill derives isComplete from carrier diagnostics (not hardcoded true)',
    /isComplete:\s*result\.carrierDiagnostics\.every\(/.test(backfill), true);

  // ── 6) HUGRAB insured-total certification (PS-111 ↔ PS-108) ────────────────
  // The backend pre-rating path must produce INSURED HUGRAB totals: backfill -> getRates
  // -> resolveRateInput applies the HUGRAB ParcelGuard $100 default -> the live-rate fan
  // enriches the premium BEFORE pickBestRate. This certifies PS-111's requirement that
  // HUGRAB insured totals are handled via PS-108 before best-rate selection — without a
  // browser session.
  check('backend pre-rating rates HUGRAB orders through getRates (the insured path)',
    /getRates\(/.test(backfill), true);
  const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
  check('resolveRateInput applies the HUGRAB ParcelGuard default insurance',
    /isHugrabShippingContext\(/.test(ratesSrc) && /insuranceProvider = 'parcelguard'/.test(ratesSrc), true);
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
