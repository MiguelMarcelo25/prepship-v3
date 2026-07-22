import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createRateSignatureCacheMetrics,
  decideDirectCarrierCacheUse,
  rateSourcesArePurchaseProofEligible,
  recordRateSignatureCacheLookup,
} from '../src/services/shipping-workflow/rate-signature-cache-policy';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const startedAt = performance.now();
let providerFetches = 0;
let metrics = createRateSignatureCacheMetrics();
for (let index = 0; index < 600; index += 1) {
  const decision = decideDirectCarrierCacheUse({
    cachedOnly: false,
    cacheFirst: true,
    cachedRateCount: 4,
  });
  if (decision === 'provider_fetch') providerFetches += 1;
  metrics = recordRateSignatureCacheLookup(metrics, {
    shipStationCached: true,
    directCarrierCacheUsed: decision === 'cache_hit',
    providerFetches: decision === 'provider_fetch' ? 1 : 0,
  });
}
const elapsedMs = performance.now() - startedAt;
assert.equal(providerFetches, 0, '600 warm exact-signature lookups initiate zero provider fetches');
assert.equal(metrics.lookups, 600);
assert.equal(metrics.fullHits, 600);
assert.equal(metrics.hitRatePct, 100);
assert.ok(elapsedMs < 2_000, `600 warm lookups complete in seconds (actual ${elapsedMs.toFixed(2)}ms)`);

assert.equal(
  decideDirectCarrierCacheUse({ cachedOnly: false, cacheFirst: true, cachedRateCount: 0 }),
  'provider_fetch',
  'a cache-first miss falls through to the canonical provider owner',
);
assert.equal(
  decideDirectCarrierCacheUse({ cachedOnly: true, cacheFirst: false, cachedRateCount: 0 }),
  'uncached',
  'a cached-only miss never calls a provider',
);
assert.equal(
  rateSourcesArePurchaseProofEligible({ shipStationCached: true, directCarrierCacheUsed: false }),
  false,
  'ShipStation cache hits cannot mint purchase proof',
);
assert.equal(
  rateSourcesArePurchaseProofEligible({ shipStationCached: false, directCarrierCacheUsed: true }),
  false,
  'direct-carrier cache hits cannot mint purchase proof',
);
assert.equal(
  rateSourcesArePurchaseProofEligible({ shipStationCached: false, directCarrierCacheUsed: false }),
  true,
  'an all-live response remains eligible for backend purchase proof',
);

const rates = read('src/services/rates.ts');
const directCache = read('src/services/direct-carrier-rate-cache.ts');
const backfill = read('src/services/rates-backfill.ts');
const browse = read('src/services/rate-browse-response-producer.ts');
const finalizer = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
const manualOrders = read('src/routes/orders.ts');

const directOwnerStart = rates.indexOf('export async function getDirectCarrierRatesForRateInput');
const cacheRead = rates.indexOf('readFreshDirectCarrierRates(', directOwnerStart);
const providerQuote = rates.indexOf('quoteCarrierRates(account.provider', directOwnerStart);
assert.ok(cacheRead > directOwnerStart && cacheRead < providerQuote, 'exact signature cache is read before provider quote');
assert.match(rates, /cacheFirst\?: boolean/);
assert.match(rates, /CACHE_TTL_MS,[\s\S]{0,500}decideDirectCarrierCacheUse/);
assert.match(rates, /:direct:\$\{account\.sourceTable\}:\$\{account\.id\}/);
assert.match(directCache, /maxAgeMs: number = directCarrierRateCacheTtlMs\(\)/);
assert.match(backfill, /cacheFirst: !rateFetchDecision\.forceRefresh/);
assert.match(backfill, /signatureCache = recordRateSignatureCacheLookup/);
assert.match(backfill, /purchaseProofEligible: rateSourcesArePurchaseProofEligible/);
assert.match(browse, /purchaseProofEligible: rateSourcesArePurchaseProofEligible/);
assert.match(finalizer, /input\.purchaseProofEligible === false\s*\? null\s*:\s*await storeRateQuoteSnapshot/);
assert.match(manualOrders, /!selectedBestRate[\s\S]{0,220}enqueueBackfillBestRatesForOrderIds\(\[created\.id\], undefined, 'rate-on-ingest'\)/);

console.log(
  `PASS PS-459 rate-on-ingest signature cache guard: ${metrics.fullHits}/${metrics.lookups} full hits (${metrics.hitRatePct}%), ${providerFetches} provider fetches, ${elapsedMs.toFixed(2)}ms`,
);
