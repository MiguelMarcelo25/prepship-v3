import { readFileSync } from 'node:fs'

const service = readFileSync('src/services/print-queue.ts', 'utf8')
const snapshot = readFileSync('src/services/print-queue/queue-send-snapshot.ts', 'utf8')
const route = readFileSync('src/routes/print-queue.ts', 'utf8')
const pkg = readFileSync('package.json', 'utf8')

const checks = [
  {
    name: 'queue-send result type exposes timing proof',
    pass:
      service.includes('export type QueueSendTimingBreakdown') &&
      service.includes('timings?: QueueSendTimingBreakdown') &&
      service.includes("labelSource?: 'provided' | 'existing' | 'created' | 'recovered' | 'in_progress_recovered' | 'skipped_preflight' | 'failed'"),
  },
  {
    name: 'processQueueSendOrder records existing label, purchase, recovery, and queue write timings',
    pass:
      service.includes('const timings: QueueSendTimingBreakdown =') &&
      service.includes("timings.labelSource = 'provided'") &&
      service.includes('existingLabelLookupMs') &&
      service.includes('labelPurchaseMs') &&
      service.includes('inProgressRecoveryMs') &&
      service.includes('recoveryLookupMs') &&
      service.includes('queueWriteMs'),
  },
  {
    name: 'queue-send worker records total timing for successful and failed orders',
    pass:
      service.includes('const orderStartedAt = Date.now()') &&
      service.includes('withTotalTiming(result, orderStartedAt)') &&
      service.includes("timings: { totalMs: elapsedSince(orderStartedAt), labelSource: 'failed' }"),
  },
  {
    name: 'durable queue-send snapshots include timings',
    pass:
      snapshot.includes('timings?: QueueSendTimingBreakdown') &&
      snapshot.includes('timings: result.timings') &&
      snapshot.includes('results: QueueSendResultSnapshot[]') &&
      snapshot.includes('resultSamples: results.slice(-10)'),
  },
  {
    name: 'status route returns queue-send results for timing inspection',
    pass:
      route.includes('const durableResults = queueSendSnapshotResults(durableJob)') &&
      route.includes('results: durableResults') &&
      route.includes('results: job.results'),
  },
  {
    name: 'package.json exposes print queue timing guard',
    pass: pkg.includes('"test:print-queue-timing-proof": "node scripts/print-queue-timing-proof-guard.mjs"'),
  },
]

const failures = checks.filter((check) => !check.pass)

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} print queue timing proof guard check${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}

console.log('\nPASS print queue timing proof guard')
