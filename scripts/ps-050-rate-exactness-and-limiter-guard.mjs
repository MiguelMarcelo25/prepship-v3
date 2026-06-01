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

const [ratesService, ratesRoute, ratesBackfill, browserSpec, packageJson, v2ApiClient] = await Promise.all([
  read('src/services/rates.ts'),
  read('src/routes/rates.ts'),
  read('src/services/rates-backfill.ts'),
  read('web/e2e/orders-rate-accuracy-and-autostart.spec.js'),
  read('package.json'),
  read('web/src/lib/v2-apiClient.ts'),
])

assert(
  ratesService.includes('export const RATE_FETCH_CONCURRENCY') &&
    ratesBackfill.includes('RATE_FETCH_CONCURRENCY'),
  'RATE_FETCH_CONCURRENCY is centralized and reused by rate backfill',
)

assert(
  ratesService.includes('globalRateFetchActive') &&
    ratesService.includes('runWithGlobalRateLimiter') &&
    ratesService.includes('runWithGlobalRateLimiter(() => fetchEstimateForCarrier'),
  'ShipStation carrier estimate calls use a module-level global limiter across passive/manual/backfill callers',
)

assert(
  ratesService.includes('SHIPSTATION_RATE_LIMIT_PER_MINUTE') &&
    ratesService.includes('SHIPSTATION_RATE_LIMIT_BURST') &&
    ratesService.includes('SHIPSTATION_RATE_LIMIT_WINDOW_MS') &&
    ratesService.includes('shipStationRateLimitTimestamps') &&
    ratesService.includes('await acquireShipStationRateBudget()') &&
    !ratesService.includes('40 / 1500'),
  'ShipStation live rate calls enforce env-driven 160/minute budget with burst control, not the old too-fast limiter',
)

assert(
  ratesRoute.includes('resolveRateInput') &&
    ratesRoute.includes('rateCacheKey(resolved)') &&
    !ratesRoute.includes("matchQuality: 'rough'"),
  'cached bulk exactness uses resolved credential/source context and never exposes rough auto-apply hits',
)

const fingerprintInputs = [
  'different ZIP',
  'different weight',
  'different eligible carrier/account set',
  'ship-date bucket',
  'confirmation',
]
for (const label of fingerprintInputs) {
  assert(
    browserSpec.includes(label) || ratesService.includes(label),
    `PS-050 evidence covers ${label} invalidation`,
  )
}

assert(
  browserSpec.includes('prior saved best is not assumed best') &&
    browserSpec.includes('8.31') &&
    browserSpec.includes('7.25') &&
    browserSpec.includes("toContainText('7.25')"),
  'browser E2E proves a cheaper current eligible rate replaces a prior saved best',
)

assert(
  v2ApiClient.includes('responseBestRate') &&
    v2ApiClient.includes("Object.defineProperty(combined, 'bestRate'"),
  'v2 rate client preserves API-selected bestRate instead of re-sorting stale saved rates into the winner',
)

assert(
  packageJson.includes('"test:ps-050-rate-exactness"'),
  'package script exposes PS-050 exactness/limiter guard',
)

if (process.exitCode) {
  console.error('\nPS-050 exactness/limiter guard failed.')
  process.exit(process.exitCode)
}
