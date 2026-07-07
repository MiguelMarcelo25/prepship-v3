/**
 * PS-124 guard — final Best Rate selection across ShipStation + direct carriers
 * must be backend-owned. Read-only: no DB, no network, no labels.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, ok: boolean) {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const rateBrowserModal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const rateBrowseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const ratesService = readFileSync('src/services/rates.ts', 'utf8');

const fetchRatesStart = apiClient.indexOf('fetchRates(data: Record<string, unknown>)');
const fetchRatesEnd = apiClient.indexOf('\n  fetchCachedRatesBulk', fetchRatesStart);
const fetchRatesBlock = fetchRatesStart >= 0 && fetchRatesEnd > fetchRatesStart
  ? apiClient.slice(fetchRatesStart, fetchRatesEnd)
  : '';

const browseRatesStart = apiClient.indexOf('browseRates(data: Record<string, unknown>)');
// PS-170: end-anchor repaired — the method after browseRates was renamed
// fetchOrdersDailyCounts -> fetchDashboardDailyCounts in a prior change, which left this
// slice empty (a silently-passing-then-failing guard). Re-anchored so it slices again.
const browseRatesEnd = apiClient.indexOf('\n  fetchDashboardDailyCounts', browseRatesStart);
const browseRatesBlock = browseRatesStart >= 0 && browseRatesEnd > browseRatesStart
  ? apiClient.slice(browseRatesStart, browseRatesEnd)
  : '';

const browseRouteStart = ratesRoute.indexOf("app.post('/browse'");
const browseRouteEnd = ratesRoute.indexOf('\n// v2-parity:', browseRouteStart);
const browseRouteBlock = browseRouteStart >= 0 && browseRouteEnd > browseRouteStart
  ? ratesRoute.slice(browseRouteStart, browseRouteEnd)
  : '';

const rateBrowserCallStart = rateBrowserModal.indexOf('const browsePayload = {');
const rateBrowserCallEnd = rateBrowserModal.indexOf('\n      };', rateBrowserCallStart);
const rateBrowserCallBlock = rateBrowserCallStart >= 0 && rateBrowserCallEnd > rateBrowserCallStart
  ? rateBrowserModal.slice(rateBrowserCallStart, rateBrowserCallEnd)
  : '';

check(
  'frontend fetchRates no longer fetches direct carrier rates or picks combined[0] as final bestRate',
  fetchRatesBlock.length > 0 &&
    !/fetchDirectCarrierRates\(/.test(fetchRatesBlock) &&
    !/combinedBestRate/.test(fetchRatesBlock) &&
    !/combined\[0\]/.test(fetchRatesBlock),
);

check(
  'frontend browseRates no longer fetches direct carrier rates or computes final bestRate from a sorted local merge',
  browseRatesBlock.length > 0 &&
    !/fetchDirectCarrierRates\(/.test(browseRatesBlock) &&
    !/const\s+bestRate\s*=\s*combined\[0\]/.test(browseRatesBlock) &&
    !/directCarrierIds\.map/.test(browseRatesBlock),
);

check(
  'backend rates service exposes direct-carrier quote resolver for combined rate shopping',
  /export async function getDirectCarrierRatesForRateInput/.test(ratesService) &&
    /quoteCarrierRates\(account\.provider/.test(ratesService) &&
    /evaluateDirectCarrierScope/.test(ratesService) &&
    /directCarrierVisibleForScope/.test(ratesService),
);

// PS-203 (stage 3): the merge + single cheapest pick moved VERBATIM to the
// canonical owner (src/services/rates-combined.ts); /browse delegates via
// combineCarrierUniverses. Same pins, split homes — the route still fetches
// the direct quotes and emits the combined best rate; the owner does the pick.
const ratesCombined = readFileSync('src/services/rates-combined.ts', 'utf8');
check(
  'backend /rates/browse includes direct carrier quotes before choosing cheapest',
    /produceRateBrowsePayload/.test(ratesRoute) &&
    /getDirectCarrierRatesForRateInput/.test(rateBrowseProducer) &&
    /const combined = combineCarrierUniverses\(\{/.test(rateBrowseProducer) &&
    /dedupeBrowseRates\(\[\.\.\.input\.ssRates, \.\.\.input\.directRates\]\.filter\(isPricedRate\)\)/.test(ratesCombined) &&
    /\.sort\(\(a, b\) => \(rateTotal\(a\) - rateTotal\(b\)\) \|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)\)\)/.test(ratesCombined) &&
    /bestRate:\s*bestRateOut/.test(rateBrowseProducer),
);

check(
  'backend /rates/browse diagnostics include direct carriers instead of hiding failures',
  /directCarrierStatuses/.test(ratesCombined) &&
    /directCarrierDiagnostics/.test(rateBrowseProducer) &&
    /directCarrierErrors/.test(rateBrowseProducer) &&
    /directCarrierMetas/.test(rateBrowseProducer),
);

check(
  'manual Rate Browser opts into backend-visible direct carriers for table/panel parity',
  rateBrowserCallBlock.length > 0 &&
    /includeVisibleDirectCarriers:\s*true/.test(rateBrowserCallBlock),
);

if (failures > 0) {
  console.error(`\nFAIL PS-124 backend combined best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-124 backend combined best-rate guard');
