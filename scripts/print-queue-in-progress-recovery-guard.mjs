import { readFileSync } from 'node:fs'

const service = readFileSync('src/services/print-queue.ts', 'utf8')
const worker = readFileSync('src/services/print-queue-worker.ts', 'utf8')
const env = readFileSync('src/lib/env.ts', 'utf8')
const pkg = readFileSync('package.json', 'utf8')

const checks = [
  {
    name: 'queue-send does not use a non-cancelling per-order timeout race',
    pass:
      !/QUEUE_SEND_ORDER_TIMEOUT_MS/.test(service) &&
      !/function timeoutAfter/.test(service) &&
      !/Promise\.race\(\[\s*processQueueSendOrder/.test(service),
  },
  {
    name: 'queue-send has a bounded recovery window for concurrent label purchases',
    pass:
      /const QUEUE_SEND_IN_PROGRESS_RECOVERY_MS = 60_000/.test(service) &&
      /async function waitForExistingQueueableLabel/.test(service),
  },
  {
    name: 'queue-send recognizes the structured in-progress label-purchase lock',
    pass:
      /function isLabelPurchaseInProgressError/.test(service) &&
      /code === 'LABEL_PURCHASE_IN_PROGRESS'/.test(service),
  },
  {
    name: 'queue-send reports active label-purchase locks as retryable in-progress failures',
    pass:
      /const labelPurchaseInProgress = isLabelPurchaseInProgressError\(err\)/.test(service) &&
      /const retryEligible = staleLabelAttempt \|\| labelPurchaseInProgress \|\| retry\.retryEligible/.test(service) &&
      /label_purchase_in_progress/.test(service) &&
      /state: retryEligible \? 'failed_retryable' : 'failed_terminal'/.test(service),
  },
  {
    name: 'queue-send waits for the first purchase to persist a queueable label before failing',
    pass: (() => {
      const purchaseIndex = service.indexOf("'labelPurchaseMs'")
      const catchIndex = service.indexOf('} catch (err) {', purchaseIndex)
      if (catchIndex < 0) return false
      const catchBlock = service.slice(catchIndex, service.indexOf('\n    }', catchIndex) + 6)
      return (
        catchBlock.includes('isLabelPurchaseInProgressError(err)') &&
        catchBlock.includes('waitForExistingQueueableLabel(order)') &&
        catchBlock.includes('if (recoveredAfterInProgress)') &&
        catchBlock.includes('labelUrl = recoveredAfterInProgress') &&
        catchBlock.includes('else throw err')
      )
    })(),
  },
  {
    name: 'print worker owns the backend batch deadline',
    pass:
      /PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS/.test(env) &&
      /withDeadline\(/.test(worker) &&
      /env\.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS/.test(worker) &&
      /runQueueSendJobFromWorker\(payload\)/.test(worker),
  },
  {
    name: 'package.json exposes the in-progress recovery guard',
    pass: pkg.includes('"test:print-queue-in-progress-recovery": "node scripts/print-queue-in-progress-recovery-guard.mjs"'),
  },
]

const failures = checks.filter((check) => !check.pass)

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} print queue in-progress recovery guard check${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}

console.log('\nPASS print queue in-progress recovery guard')
