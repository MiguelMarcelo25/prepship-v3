/**
 * PS-340 - backend rate-engine bounded fan-out guard.
 *
 * This guard pins the canonical backend engine slice: cache-first display may
 * be instant, but every live carrier fan-out must be backend-owned, bounded,
 * and visible through diagnostics.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildRateEngineVolumeProof } from '../src/services/rate-engine-volume-proof';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`Missing ${endNeedle}`);
  return source.slice(start, end);
}

function sliceFrom(source: string, startNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  return source.slice(start);
}

const ratesService = read('src/services/rates.ts');
const ratesRoute = read('src/routes/rates.ts');
const rateBrowseProducer = read('src/services/rate-browse-response-producer.ts');
const ratesBackfill = read('src/services/rates-backfill.ts');
const volumeProofGuard = read('scripts/ps-340-rate-engine-volume-proof-guard.ts');
const openWorkflow = read('web/src/components/rate-browser-open-workflow.ts');
const modal = read('web/src/components/RateBrowserModal.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-340-backend-rate-engine.md';
const doc = existsSync(docPath) ? read(docPath) : '';
const volumeProof = buildRateEngineVolumeProof({
  selectedOrders: 100,
  visibleShipStationAccounts: 9,
  visibleDirectCarrierAccounts: 17,
  rateFetchConcurrency: 4,
  directCarrierConcurrency: 4,
  backfillOrderConcurrency: 2,
  awaitingPageLoadProviderCalls: 0,
  usesRateBrowseSingleFlight: true,
  usesCacheFirstOpenPreview: true,
  pendingHeartbeatMs: 120_000,
  pendingStaleWindowMs: 360_000,
});

const directCarrierFunction = sliceFrom(
  ratesService,
  'export async function getDirectCarrierRatesForRateInput(',
);

const modalOpenEffect = sliceBetween(
  modal,
  '// Start the live carrier workflow on open',
  '// Auto-select a package',
);

check(
  'backend exports a bounded direct-carrier live fan-out cap',
  /export const DIRECT_CARRIER_RATE_FETCH_CONCURRENCY = Math\.max\([\s\S]{0,260}DIRECT_CARRIER_RATE_FETCH_CONCURRENCY/.test(ratesService),
);

check(
  'direct-carrier live quotes use backend bounded concurrency instead of Promise.all over every account',
  /mapWithConcurrency\(\s*accounts,\s*DIRECT_CARRIER_RATE_FETCH_CONCURRENCY,\s*async \(account\) =>/.test(directCarrierFunction) &&
    !/const calls = accounts\.map/.test(directCarrierFunction) &&
    !/Promise\.all\(calls\)/.test(directCarrierFunction),
);

check(
  'direct-carrier quotes still return per-account diagnostics after bounding',
  /settled\.flatMap\(\(item\) => item\.rates\)/.test(directCarrierFunction) &&
    /diagnostics: settled\.map\(\(item\) => item\.diagnostic\)/.test(directCarrierFunction),
);

check(
  'PS-340 volume proof models 100 selected orders with backend caps',
  volumeProof.selectedOrders === 100 &&
    volumeProof.maxConcurrentBackfillOrders === 2 &&
    volumeProof.maxShipStationCarrierCalls === 4 &&
    volumeProof.maxDirectCarrierCalls === 8 &&
    volumeProof.pendingHeartbeatSafe,
);

check(
  'ShipStation live fan-out remains bounded by the canonical rate service limiter',
  /RATE_FETCH_CONCURRENCY/.test(ratesService) &&
    /runWithGlobalRateLimiter/.test(ratesService) &&
    /fetchEstimateForCarrierWithRetry\([\s\S]{0,140}priority/.test(ratesService),
);

check(
  '/rates/browse collapses identical in-flight provider fan-outs before ranking/proof stamping',
  /produceRateBrowsePayload/.test(ratesRoute) &&
    /runRateBrowseSingleFlight/.test(rateBrowseProducer) &&
    /const \{ result, directRates, shipStationDurationMs, directCarrierDurationMs \} = await runRateBrowseSingleFlight/.test(rateBrowseProducer),
);

check(
  'backend backfill stays bounded and uses background priority for ShipStation quotes',
  /const liveRateBudget = backfillUsesLiveRateBudget\(\{ liveRecalculate, mode: opts\.mode \}\)/.test(ratesBackfill) &&
    /const CONCURRENCY = Math\.max\(1, Math\.min\(liveRateBudget \? LIVE_BACKFILL_CONCURRENCY : 4, RATE_FETCH_CONCURRENCY\)\)/.test(ratesBackfill) &&
    /buildBackfillRateFetchDecision\(\{[\s\S]*preExpiryRefreshReason/.test(ratesBackfill) &&
    /getRates\(rateInput, toGetRatesOptions\(rateFetchDecision\)\)/.test(ratesBackfill),
);

check(
  'Rate Browser open uses explicit backend live workflow, not a passive Awaiting worker',
  /return \{ forceLive: true \}/.test(openWorkflow) &&
    /void browseRates\(undefined, rateBrowserOpenBrowseOptions\(\)\)/.test(modalOpenEffect) &&
    !/cachedOnly:\s*true/.test(modalOpenEffect) &&
    /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(modal),
);

check(
  'Awaiting page does not restart browser-owned passive live-rate workers',
  !/runPassiveAutoRating|refreshVisibleBestRate|fetchCachedRatesBulk/.test(ordersView),
);

check(
  'package wires canonical PS-340 backend rate-engine guards',
  packageJson.includes('"test:ps-340-backend-rate-engine": "tsx scripts/ps-340-backend-rate-engine-guard.ts"') &&
    packageJson.includes('"test:ps-340-rate-engine-volume-proof": "tsx scripts/ps-340-rate-engine-volume-proof-guard.ts"'),
);

check(
  'PS-340 volume guard is wired to backend limiter observability and request-count proof',
  volumeProofGuard.includes('buildRateEngineVolumeProof') &&
    volumeProofGuard.includes('getRateEngineLimiterSnapshot') &&
    volumeProofGuard.includes('100 selected orders'),
);

check(
  'PS-340 backend-engine doc records owner, imperfect data injection, volume proof, and no shipped/cancelled touch',
  doc.includes('## Backend Owner') &&
    doc.includes('## Imperfect Data Injection') &&
    doc.includes('## 2026-06-30 Volume Proof Slice') &&
    doc.includes('No shipped/cancelled surfaces are touched'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-340 backend rate-engine guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-340 backend rate-engine guard');
