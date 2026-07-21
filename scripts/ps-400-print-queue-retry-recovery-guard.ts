/**
 * PS-400 guard - Print Queue retries recover existing labels without duplicate
 * postage or silent duplicate physical-print risk.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function blockBetween(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return text.slice(start, end > start ? end : start + 5000);
}

const printQueue = read('src/services/print-queue.ts');
const preflight = read('src/services/print-queue/queue-send-preflight.ts');
const route = read('src/routes/print-queue.ts');
const pkg = read('package.json');

const processBlock = blockBetween(
  printQueue,
  'async function processQueueSendOrder',
  'export async function addToQueue',
);
const addToQueueBlock = blockBetween(
  printQueue,
  'export async function addToQueue',
  'export async function startQueueSendJob',
);

check(
  'queue-send checks existing queued/shipment labels before createLabelV2',
  processBlock.indexOf('findExistingQueueSendLabel(order)') >= 0 &&
    processBlock.indexOf('createLabelV2(') > processBlock.indexOf('findExistingQueueSendLabel(order)'),
);

check(
  'queue-send recovers labels after createLabelV2 conflict instead of repurchasing',
  processBlock.includes('existingLabelUrl = getExistingLabelUrl(err)') &&
    processBlock.includes('findExistingQueueSendLabel(order)') &&
    processBlock.includes('if (!recoverCreatedLabelUrl) throw err') &&
    processBlock.includes("timings.labelSource = 'recovered'"),
);

check(
  'label-purchase-in-progress retry waits for persisted existing label',
  processBlock.includes('isLabelPurchaseInProgressError(err)') &&
    processBlock.includes('waitForExistingQueueableLabel(order)') &&
    processBlock.includes("timings.labelSource = 'in_progress_recovered'") &&
    processBlock.includes('QueueSendStaleLabelAttemptError'),
);

check(
  'shipped preflight can recover an active existing label without allowing cancelled orders',
  preflight.includes('loadOrderIdsWithActiveLabels') &&
    preflight.includes('from(shipments)') &&
    preflight.includes('eq(shipments.voided, false)') &&
    preflight.includes('eq(shipments.isReturn, false)') &&
    preflight.includes("if (status === 'cancelled') return 'order_not_editable'") &&
    preflight.includes("if (status === 'shipped') return hasActiveLabel ? null : 'order_not_editable'"),
);

check(
  'shipped preflight read is documented as recovery-only and purchase-free',
  /Per user override unlock shipped data on 2026-07-07 \(PS-400\)/.test(preflight) &&
    preflight.includes('This does not create labels, buy postage'),
);

check(
  'addToQueue refuses to revive printed/delivered history rows into active queued rows',
  addToQueueBlock.includes("existing.status === 'printed' || existing.status === 'delivered'") &&
    addToQueueBlock.includes('throw new PrintQueueAlreadyFinalizedError') &&
    addToQueueBlock.indexOf('throw new PrintQueueAlreadyFinalizedError') <
      addToQueueBlock.indexOf('.onConflictDoUpdate'),
);

check(
  'already-finalized queue rows return a structured 409 from direct add route',
  printQueue.includes('PRINT_QUEUE_ALREADY_FINALIZED') &&
    route.includes('isPrintQueueAlreadyFinalizedError') &&
    route.includes('return c.json({ error: err.message, code: err.code }, err.status);'),
);

check(
  'PS-400 guard is wired in package.json',
  pkg.includes('"test:ps-400-print-queue-retry-recovery": "tsx scripts/ps-400-print-queue-retry-recovery-guard.ts"'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-400 print queue retry recovery guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-400 print queue retry recovery guard');
