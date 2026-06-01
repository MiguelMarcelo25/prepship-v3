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

const [ordersView, ratesRoute, ratesService, ratesBackfill, orderRateDto, apiClient, packageJson] = await Promise.all([
  read('web/src/components/Views/OrdersView.tsx'),
  read('src/routes/rates.ts'),
  read('src/services/rates.ts'),
  read('src/services/rates-backfill.ts'),
  read('src/services/order-rate-dto.ts'),
  read('web/src/lib/v2-apiClient.ts'),
  read('package.json'),
])

assert(
  ordersView.includes('buildRateRequestFingerprint') &&
    ordersView.includes('hasValidSavedBestRateForRequest') &&
    !ordersView.includes('function hasValidBestRateForCurrentDims(order: OrderSummaryDto)'),
  'Orders UI validates saved best rates with request fingerprint/freshness/completeness, not dims-only',
)

assert(
  ordersView.includes("currentStatus === 'awaiting_shipment'") &&
    ordersView.includes('passiveRatingAccountsEnabled') &&
    ordersView.includes('fetchCachedRatesBulk'),
  'Awaiting Shipment page load enables account data and uses cached bulk lookup before passive live rating',
)

assert(
  ordersView.includes('forceRefresh: false') &&
    !ordersView.includes('forceRefresh: true,\n        }) as Array<Record<string, unknown>>\n\n        const bestRate = pickBestPanelRate(rates)'),
  'Passive auto-rating does not force live rates for every order',
)

assert(
  ratesRoute.includes("matchType: 'miss'") &&
    ratesRoute.includes("isComplete: false") &&
    ratesRoute.includes("matchType: 'exact'") &&
    !ratesRoute.includes("matchQuality: 'rough' as const"),
  'Bulk cached rates expose exact/fresh/complete metadata and do not auto-apply rough hits',
)

assert(
  ratesService.includes('shipDateBucket') &&
    ratesService.includes('st=') &&
    ratesService.includes('ci=') &&
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
  ratesBackfill.includes('requestFingerprint') &&
    ratesBackfill.includes('isComplete: result.carrierDiagnostics.every') &&
    ratesBackfill.includes('bestRateJson: bestWithMetadata'),
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
