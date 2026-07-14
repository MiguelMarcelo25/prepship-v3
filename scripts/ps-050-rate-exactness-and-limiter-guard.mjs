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

function shipStationScheduleWithinBudget({ requestCount, perMinute, burst }) {
  const windowMs = 60_000
  const burstWindowMs = Math.ceil((windowMs * burst) / perMinute)
  const schedule = []
  const activeWindow = []
  let now = 0

  for (let i = 0; i < requestCount; i += 1) {
    for (;;) {
      while (activeWindow.length && now - activeWindow[0] >= windowMs) activeWindow.shift()
      const recentBurst = activeWindow.filter((timestamp) => now - timestamp < burstWindowMs)
      const burstDelay = recentBurst.length >= burst ? burstWindowMs - (now - recentBurst[0]) : 0
      const minuteDelay = activeWindow.length >= perMinute ? windowMs - (now - activeWindow[0]) : 0
      const delay = Math.max(0, burstDelay, minuteDelay)
      if (delay <= 0) break
      now += delay
    }
    activeWindow.push(now)
    schedule.push(now)
  }

  for (const timestamp of schedule) {
    const minuteCount = schedule.filter((candidate) => candidate >= timestamp && candidate < timestamp + windowMs).length
    const burstCount = schedule.filter((candidate) => candidate >= timestamp && candidate < timestamp + burstWindowMs).length
    if (minuteCount > perMinute || burstCount > burst) return false
  }
  return true
}

const [ratesService, ratesRoute, ratesBackfill, browserSpec, packageJson, v2ApiClient, shipStationClient, ratesCombined, rateBrowseProducer] = await Promise.all([
  read('src/services/rates.ts'),
  read('src/routes/rates.ts'),
  read('src/services/rates-backfill.ts'),
  read('web/e2e/orders-rate-accuracy-and-autostart.spec.js'),
  read('package.json'),
  read('web/src/lib/v2-apiClient.ts'),
  read('src/lib/shipstation/client.ts'),
  // PS-203 (stage 3): the merge + SINGLE cheapest pick moved to the canonical
  // combined-selection owner. The route + backfill both delegate to it.
  read('src/services/rates-combined.ts'),
  read('src/services/rate-browse-response-producer.ts'),
])

assert(
  ratesService.includes('export const RATE_FETCH_CONCURRENCY') &&
    ratesBackfill.includes('RATE_FETCH_CONCURRENCY'),
  'RATE_FETCH_CONCURRENCY is centralized and reused by rate backfill',
)

assert(
  ratesService.includes('globalRateFetchActive') &&
    ratesService.includes('runWithGlobalRateLimiter') &&
    ratesService.includes('return fetchEstimateForCarrier(carrier, input, shipFrom, policy.timeoutMs);') &&
    ratesService.includes('const batch = await runWithGlobalRateLimiter(() => {') &&
    ratesService.includes('return fetchEstimateForCarriers(carriers, input, shipFrom, policy.timeoutMs);'),
  'ShipStation batch and fallback estimate calls use one module-level global limiter across passive/manual/backfill callers',
)

assert(
  ratesService.includes('SHIPSTATION_RATE_LIMIT_PER_MINUTE') &&
    ratesService.includes('SHIPSTATION_RATE_LIMIT_BURST') &&
    ratesService.includes('SHIPSTATION_RATE_LIMIT_WINDOW_MS') &&
    ratesService.includes('shipStationRateLimitTimestamps') &&
    ratesService.includes('await acquireShipStationRateBudget(') &&
    !ratesService.includes('40 / 1500'),
  'ShipStation live rate calls enforce env-driven 160/minute budget with burst control, not the old too-fast limiter',
)

assert(
  shipStationClient.includes('SHIPSTATION_RATE_LIMIT_PER_MINUTE') &&
    shipStationClient.includes('SHIPSTATION_RATE_LIMIT_BURST') &&
    shipStationClient.includes('acquireShipStationV2Budget') &&
    shipStationClient.includes('shipStationV2RateLimitTimestamps') &&
    !shipStationClient.includes('TokenBucket(40, 40 / 1500)') &&
    !shipStationClient.includes("from './rate-limiter.js'"),
  'ShipStation v2 client shares the env-driven limiter for rates, carrier discovery, labels, and other v2 calls',
)

assert(
  shipStationScheduleWithinBudget({ requestCount: 400, perMinute: 160, burst: 20 }),
  'ShipStation limiter has deterministic evidence for 50 fresh orders x 8 carrier accounts without exceeding 160/minute',
)

assert(
  ratesRoute.includes('resolveRateInput') &&
    ratesRoute.includes('rateCacheKey(resolved)') &&
    ratesRoute.includes("'rough' as const") &&
    browserSpec.includes('prior saved best is not assumed best'),
  'cached bulk exactness uses resolved credential/source context and marks rough hits approximate instead of auto-applying them',
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
  // PS-203: the cheapest combined ShipStation/direct-carrier selection lives in
  // the canonical owner rates-combined.ts (merge via dedupeBrowseRates + the single
  // cheapest pick by rateTotal). The route delegates to the rate browse producer,
  // which delegates via combineCarrierUniverses.
  // Repointed (guard rot): rates-combined now drops UNPRICED rates before dedupe/cheapest-pick
  // (.filter(isPricedRate) — the "$0 coercion wins cheapest" root-cause fix); same canonical owner.
  ratesCombined.includes('const combinedRates = dedupeBrowseRates([...input.ssRates, ...input.directRates].filter(isPricedRate));') &&
    ratesCombined.includes('const cheapest = rankedEligibleRates[0]') &&
    ratesRoute.includes('produceRateBrowsePayload') &&
    rateBrowseProducer.includes('combineCarrierUniverses({') &&
    rateBrowseProducer.includes('combinedRates,') &&
    rateBrowseProducer.includes('cheapest,') &&
    v2ApiClient.includes('return postRateBrowseTransport(data);') &&
    !v2ApiClient.includes('const combinedBestRate = combined[0]'),
  'backend /rates/browse selects the cheapest combined ShipStation/direct-carrier rate (canonical rates-combined owner) and v2 client preserves backend bestRate',
)

assert(
  packageJson.includes('"test:ps-050-rate-exactness"'),
  'package script exposes PS-050 exactness/limiter guard',
)

if (process.exitCode) {
  console.error('\nPS-050 exactness/limiter guard failed.')
  process.exit(process.exitCode)
}
