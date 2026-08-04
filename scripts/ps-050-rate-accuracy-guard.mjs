import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

async function read(relPath) {
  return readFile(path.join(root, relPath), 'utf8')
}

function assert(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`)
  if (!condition) process.exitCode = 1
}

const [ordersView, ratesRoute, ratesService, ratesBackfill, orderRateDto, apiClient, packageJson, rateRequestSrc] = await Promise.all([
  read('web/src/components/Views/OrdersView.tsx'),
  read('src/routes/rates.ts'),
  read('src/services/rates.ts'),
  read('src/services/rates-backfill.ts'),
  read('src/services/order-rate-dto.ts'),
  read('web/src/lib/v2-apiClient.ts'),
  read('package.json'),
  // PS-317: buildRateRequestDraftKey moved to ./orders/best-rate/rate-request.
  read('web/src/components/Views/orders/best-rate/rate-request.ts'),
])

assert(
  (ordersView + rateRequestSrc).includes('buildRateRequestDraftKey') &&
    ordersView.includes('hasValidSavedBestRateForRequest') &&
    ordersView.includes('savedBestRateCanDisplayForCurrentRequest') &&
    ordersView.includes('cacheExpiresAt') &&
    ordersView.includes('isComplete') &&
    !ordersView.includes('function hasValidBestRateForCurrentDims(order: OrderSummaryDto)'),
  'Orders UI validates saved best rates with request fingerprint/freshness/completeness, not dims-only',
)

// RETIRED (was: Awaiting Shipment page load enables account data and uses cached bulk lookup
// before passive live rating): PS-345 (164b8667) deleted OrdersView passive rating outright —
// refreshVisibleBestRate, runPassiveAutoRating, PASSIVE_LIVE_BEST_RATE_*, and the
// fetchCachedRatesBulk consumer are gone. Rate loading is backend-owned (bounded backfill),
// pinned by scripts/ps-345-rate-loading-sot-guard.ts. The replacement below asserts the PS-345
// reality: the awaiting support-data gate survives and the deleted machinery stays gone.
assert(
  ordersView.includes('awaitingRateAccountsEnabled') &&
    !ordersView.includes('refreshVisibleBestRate') &&
    !ordersView.includes('runPassiveAutoRating') &&
    !ordersView.includes('fetchCachedRatesBulk'),
  'Awaiting Shipment support-data gate survives; deleted FE passive rating stays gone (PS-345)',
)

// RETIRED (was: Passive auto-rating does not force live rates for every order (only
// display-refresh rows, budget-capped)): superseded by PS-345 (164b8667) — the FE passive
// auto-rating path was deleted entirely; live-work bounding now lives in the backend bounded
// backfill (pinned by the test:recalculate-all-* guards) and scripts/ps-345-rate-loading-sot-guard.ts.

// Repointed (guard rot): PS-345 (164b8667) deleted the OrdersView `result?.matchType === 'exact'`
// auto-apply consumer; the backend cached-bulk metadata legs (src/routes/rates.ts) remain the
// canonical protection and are pinned in their current exact forms.
assert(
  ratesRoute.includes("matchType: 'miss' as const,") &&
    ratesRoute.includes('isComplete: false,') &&
    ratesRoute.includes('matchType: matchQuality,') &&
    ratesRoute.includes(": 'rough' as const,") &&
    ratesRoute.includes("approximate: matchQuality === 'rough' ? true : false,"),
  'Bulk cached rates expose exact/fresh/complete metadata and mark rough hits approximate',
)

assert(
  ratesService.includes('shipDateBucket') &&
    ratesService.includes('clientId: input.clientId') &&
    ratesService.includes('storeId: input.storeId') &&
    ratesService.includes('sourceClientId: input.sourceClientId') &&
    ratesService.includes('apiKeyFingerprint: input.apiKeyV2') &&
    ratesService.includes('insuranceProvider: options.insuranceProvider') &&
    ratesService.includes('insuredValue: options.insuredValue') &&
    ratesService.includes('automationRulesVersion: input.automationRulesVersion') &&
    ratesService.includes('CACHE_TTL_MS'),
  'Backend rate cache key/fingerprint includes ship-date bucket and normalized destination/account context',
)

assert(
  orderRateDto.includes('requestFingerprint') &&
    orderRateDto.includes('isComplete') &&
    orderRateDto.includes('cacheExpiresAt'),
  'Persisted order best-rate DTO preserves PS-050 request metadata',
)

assert(
  apiClient.includes('fetchCachedRatesBulk') &&
    apiClient.includes('/rates/cached/bulk'),
  'Frontend API client exposes POST /rates/cached/bulk',
)

assert(
  // PS-111/PS-203: completeness is now derived over the COMBINED universe
  // (combined.bestRateComplete), not the raw carrierDiagnostics.every check.
  // PS-293: the persisted object is the house-tuple-STAMPED best (stampedBest),
  // which is bestWithMetadata + the (default-OFF inert) house tuple; the
  // fingerprint/freshness/completeness metadata is preserved unchanged.
  ratesBackfill.includes('requestFingerprint') &&
    ratesBackfill.includes('isComplete: combined.bestRateComplete') &&
    // Repointed 2026-08-04. This pinned the exact variable name at the persist
    // site and broke when stampRateSourceDisplay was inserted into the chain:
    // bestWithMetadata -> stampHouseTuple -> stampedBest -> stampRateSourceDisplay
    // -> sourceStampedBest -> persisted. Each step wraps the previous, so the
    // fingerprint/freshness/completeness metadata this check exists to protect is
    // still preserved unchanged; only the final binding was renamed. Pin that a
    // stamped-best derivative is what gets persisted, so another wrapping step
    // does not read as a metadata regression.
    /bestRateJson: \w*[Ss]tampedBest\b/.test(ratesBackfill),
  'Rate backfill persists fingerprint/freshness/completeness metadata',
)

assert(
  packageJson.includes('"test:ps-050-rate-accuracy"'),
  'package script exposes PS-050 rate accuracy guard',
)

if (process.exitCode) {
  console.error('\nPS-050 rate accuracy guard failed.')
  process.exit(process.exitCode)
}
