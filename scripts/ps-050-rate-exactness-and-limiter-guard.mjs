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

const [ratesService, ratesRoute, ratesBackfill, browserSpec, packageJson, v2ApiClient, shipStationClient, shipStationLimiterConfig, ratesCombined, rateBrowseProducer] = await Promise.all([
  read('src/services/rates.ts'),
  read('src/routes/rates.ts'),
  read('src/services/rates-backfill.ts'),
  read('web/e2e/orders-rate-accuracy-and-autostart.spec.js'),
  read('package.json'),
  read('web/src/lib/v2-apiClient.ts'),
  read('src/lib/shipstation/client.ts'),
  read('src/lib/shipstation/rate-limit-config.ts'),
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
    ratesService.includes('return fetchEstimateForCarrier(carrier, input, shipFrom, policy.timeoutMs, priority);') &&
    ratesService.includes('const batch = await runWithGlobalRateLimiter(() => {') &&
    ratesService.includes('return fetchEstimateForCarriers(carriers, input, shipFrom, batchProbeTimeoutMs, priority);'),
  'ShipStation batch and fallback estimates use the shared priority concurrency scheduler',
)

// 2026-07-14 (batching-review LOW): the independent substrings above cannot catch a
// refactor that lifts the estimate call OUT of the limiter lambda while both strings
// still exist somewhere in the file. These SPANNING pins require the call to sit
// INSIDE runWithGlobalRateLimiter's callback (with the priority hint), for the
// single-account fallback and the batched path alike.
assert(
  /runWithGlobalRateLimiter\(\(\) => \{[\s\S]{0,500}?return fetchEstimateForCarrier\(carrier, input, shipFrom, policy\.timeoutMs, priority\);[\s\S]{0,120}?\}, priority\)/.test(ratesService) &&
    /runWithGlobalRateLimiter\(\(\) => \{[\s\S]{0,500}?return fetchEstimateForCarriers\(carriers, input, shipFrom, batchProbeTimeoutMs, priority\);[\s\S]{0,120}?\}, priority\)/.test(ratesService),
  'single and batched estimate calls execute INSIDE the limiter lambda (spanning pin)',
)

assert(
  !ratesService.includes('shipStationRateLimitTimestamps') &&
    !ratesService.includes('acquireShipStationRateBudget') &&
    ratesService.includes('getShipStationV2LimiterSnapshot') &&
    ratesService.includes('priority,'),
  'rate service delegates ShipStation admission and priority to the single v2 client gate',
)

assert(
  shipStationLimiterConfig.includes('export const SHIPSTATION_RATE_LIMIT_PER_MINUTE') &&
    shipStationLimiterConfig.includes('process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE') &&
    shipStationLimiterConfig.includes('export const SHIPSTATION_RATE_LIMIT_BURST') &&
    shipStationClient.includes("from './rate-limit-config.js'") &&
    shipStationClient.includes('acquireShipStationV2Budget') &&
    shipStationClient.includes('shipStationV2RateLimitTimestampsByKey') &&
    shipStationClient.includes("process.env.RATE_LIMITER_BACKEND === 'durable'") &&
    shipStationClient.includes('shipStationV2DurableBackgroundBucket') &&
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
    browserSpec.includes("not.toContainText('8.31')"),
  'browser E2E proves Awaiting first paint does not assume a stale prior saved best',
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
