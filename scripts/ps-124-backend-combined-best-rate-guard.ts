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
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const ratesService = readFileSync('src/services/rates.ts', 'utf8');

const fetchRatesStart = apiClient.indexOf('fetchRates(data: Record<string, unknown>)');
const fetchRatesEnd = apiClient.indexOf('\n  fetchCachedRatesBulk', fetchRatesStart);
const fetchRatesBlock = fetchRatesStart >= 0 && fetchRatesEnd > fetchRatesStart
  ? apiClient.slice(fetchRatesStart, fetchRatesEnd)
  : '';

const browseRatesStart = apiClient.indexOf('browseRates(data: Record<string, unknown>)');
const browseRatesEnd = apiClient.indexOf('\n  fetchOrdersDailyCounts', browseRatesStart);
const browseRatesBlock = browseRatesStart >= 0 && browseRatesEnd > browseRatesStart
  ? apiClient.slice(browseRatesStart, browseRatesEnd)
  : '';

const browseRouteStart = ratesRoute.indexOf("app.post('/browse'");
const browseRouteEnd = ratesRoute.indexOf('\n// v2-parity:', browseRouteStart);
const browseRouteBlock = browseRouteStart >= 0 && browseRouteEnd > browseRouteStart
  ? ratesRoute.slice(browseRouteStart, browseRouteEnd)
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

check(
  'backend /rates/browse includes direct carrier quotes before choosing cheapest',
  /getDirectCarrierRatesForRateInput/.test(ratesRoute) &&
    /combinedRates\s*=\s*dedupeBrowseRates\(\[\.\.\.filtered,\s*\.\.\.directRates\.rates\]\)/.test(browseRouteBlock) &&
    /const cheapest = \[\.\.\.combinedRates\]\.sort/.test(browseRouteBlock) &&
    /bestRate:\s*bestRateOut/.test(browseRouteBlock),
);

check(
  'backend /rates/browse diagnostics include direct carriers instead of hiding failures',
  /directCarrierStatuses/.test(browseRouteBlock) &&
    /directCarrierDiagnostics/.test(browseRouteBlock) &&
    /directCarrierErrors/.test(browseRouteBlock) &&
    /directCarrierMetas/.test(browseRouteBlock),
);

if (failures > 0) {
  console.error(`\nFAIL PS-124 backend combined best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-124 backend combined best-rate guard');
