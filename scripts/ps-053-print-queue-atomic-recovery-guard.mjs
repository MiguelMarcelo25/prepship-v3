import { readFileSync } from 'node:fs';
import { createGuardReport } from './lib/detailed-guard-report.mjs';

const printQueueService = readFileSync('src/services/print-queue.ts', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

const report = createGuardReport({
  title: 'PS-053 Print To Queue Atomic Recovery Guard',
  bug: 'Print to Queue can partially succeed: label/postage created and order shipped, but no print queue row is created.',
  scope: 'Static regression guard for queue-mode atomicity, post-label recovery, queue idempotency, label URL normalization, and outbox decoupling.',
});

report.check({
  name: 'Queue mode uses backend create/recover-and-queue path',
  condition: ordersView.includes("if (mode === 'queue')") &&
    ordersView.includes('sendOrdersToQueueBackend([order]') &&
    !ordersView.includes("if (mode === 'queue') {\n        if (!queueableLabelUrl)"),
  why: 'Single-order Print to Queue must not be split into frontend createLabel followed by fragile frontend addToQueue.',
  evidence: 'OrdersView queue mode delegates to the backend queue-send job for one create/recover-and-queue response.',
  failure: 'A frontend or post-label exception can leave a paid label/order shipped without a queue row.',
  fix: 'Route createOrQueueLabel("queue") through sendOrdersToQueueBackend([order], ...), not apiClient.createLabel then apiClient.addToQueue.',
});

report.check({
  name: 'Post-label exceptions recover by re-reading active shipment label',
  // ROTTED-PIN repoint (b1ae3352 "Add print queue timing proof"): the recovery lookup
  // is now wrapped in timeQueueStep(...) and calls findExistingQueueSendLabel(order),
  // which delegates to findExistingQueuedLabelForOrder ?? findExistingQueueableLabelForOrder
  // (print-queue.ts) — same "re-read the active shipment label" fallback, broader.
  condition: /const recoverCreatedLabelUrl = existingLabelUrl \?\? await timeQueueStep\([\s\S]{0,140}?findExistingQueueSendLabel\(order\)/.test(printQueueService) &&
    printQueueService.includes('if (!recoverCreatedLabelUrl) throw err;') &&
    printQueueService.includes('labelUrl = recoverCreatedLabelUrl;'),
  why: 'If createLabelV2 persists a shipment then throws later, recovery must find the active label and queue it without buying duplicate postage.',
  evidence: 'processQueueSendOrder rechecks active shipments after any createLabelV2 error, not only details.labelUrl conflicts.',
  failure: 'Post-label errors can still return failure after postage was bought and skip print_queue_orders insertion.',
  fix: 'In the createLabelV2 catch block, fall back to findExistingQueueableLabelForOrder(order.orderId).',
});

report.check({
  name: 'Marketplace confirmation enqueue cannot block label response',
  condition: labelsService.includes('enqueue marketplace confirmation') &&
    labelsService.includes('[labels] marketplace confirmation enqueue failed') &&
    /try\s*\{[\s\S]{0,260}await timer\.task\('enqueue marketplace confirmation'/.test(labelsService),
  why: 'Marketplace confirmation/outbox failures must remain retryable/observable but cannot prevent the created label from entering the print queue.',
  evidence: 'createLabelV2 catches confirmation enqueue failures before returning the label response.',
  failure: 'Outbox failure can turn a successful label purchase into a queue failure.',
  fix: 'Wrap enqueueShipmentConfirmation in try/catch or background handling that logs/records failure without throwing the label response.',
});

report.check({
  name: 'Queue insertion remains idempotent',
  condition: printQueueService.includes('.onConflictDoUpdate') &&
    printQueueService.includes('target: [printQueue.orderId, printQueue.clientId]') &&
    printQueueService.includes("status: 'queued'") &&
    printQueueService.includes('alreadyQueued'),
  why: 'Repeated Print to Queue clicks for the same active label should refresh/reuse one active queue entry, not create duplicates.',
  evidence: 'addToQueue upserts on orderId/clientId and reports alreadyQueued.',
  failure: 'Repeated recovery attempts can duplicate active queue rows.',
  fix: 'Keep the unique upsert path and queued status refresh in addToQueue.',
});

report.check({
  name: 'Object-shaped label URLs are normalized or rejected',
  condition: printQueueService.includes('extractShipstationLabelUrl(labelUrl)') &&
    printQueueService.includes("trimmed === '[object Object]'") &&
    printQueueService.includes('class PrintQueueLabelUrlError extends Error') &&
    printQueueService.includes('normalizePrintQueueLabelUrl(input.labelUrl)'),
  why: 'Provider label payload objects must never be persisted/enqueued as [object Object] or crash Buffer/PDF merge code.',
  evidence: 'print queue normalization unwraps known objects and raises typed actionable errors for invalid values.',
  failure: 'Operators may see raw Node Buffer/Object errors and queued rows may contain corrupt label URLs.',
  fix: 'Normalize at add/merge/recovery boundaries and reject invalid objects with PrintQueueLabelUrlError.',
});

report.check({
  name: 'Package script exposes PS-053 guard',
  condition: packageJson.scripts?.['test:ps-053-print-queue-atomic'] === 'node scripts/ps-053-print-queue-atomic-recovery-guard.mjs',
  why: 'PS-053 needs a named focused test command in verification reports.',
  evidence: 'package.json exposes test:ps-053-print-queue-atomic.',
  failure: 'Future agents may miss the PS-053 atomic recovery regression guard.',
  fix: 'Add package script test:ps-053-print-queue-atomic.',
});

report.finish();
