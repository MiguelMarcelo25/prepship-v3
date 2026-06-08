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
  check('backend /browse derives completeness via isBestRateComplete(carrierStatuses)',
    /const bestRateComplete = isBestRateComplete\(carrierStatuses\)/.test(ratesRoute), true);
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

if (failures > 0) {
  console.error(`\nFAIL PS-111 backend rate authority guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-111 backend rate authority guard');
