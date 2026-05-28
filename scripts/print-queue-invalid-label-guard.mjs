import fs from 'node:fs';
import path from 'node:path';
import { createGuardReport } from './lib/detailed-guard-report.mjs';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const routeSource = read('src/routes/print-queue.ts');
const serviceSource = read('src/services/print-queue.ts');

const report = createGuardReport({
  title: 'Print Queue Label Safety Guard',
  bug: 'Corrupt or missing label URLs can enter the queue, then PDF merge fails later with unclear errors.',
  scope: 'Static source guard for print queue route validation, URL normalization, merge failure handling, and existing-label queue recovery.',
});

report.check({
  name: 'Routes return typed invalid-label errors',
  condition: routeSource.includes('isPrintQueueLabelUrlError') &&
    routeSource.includes('printQueueLabelUrlErrorResponse'),
  why: 'Operators need a clear queue-label error instead of a generic 500 when a label URL is malformed.',
  evidence: 'src/routes/print-queue.ts imports the typed guard and uses the typed response helper.',
  failure: 'The route may be swallowing PrintQueueLabelUrlError or returning a generic backend error.',
  fix: 'Restore isPrintQueueLabelUrlError and printQueueLabelUrlErrorResponse in print-queue route catch blocks.',
});

report.check({
  name: 'Add route lets service validate unknown label payloads',
  condition: routeSource.includes('label_url: z.unknown()') &&
    routeSource.includes('labelUrl: b.label_url'),
  why: 'Provider SDKs sometimes return object-shaped label payloads; the service owns safe unwrapping and rejection.',
  evidence: 'The route schema accepts unknown label_url and passes it through to addToQueue.',
  failure: 'The route may reject provider label objects too early or stringify them into [object Object].',
  fix: 'Keep label_url as z.unknown() and pass the raw value to addToQueue for normalization.',
});

report.check({
  name: 'Service defines a typed invalid-label error',
  condition: serviceSource.includes('class PrintQueueLabelUrlError extends Error') &&
    serviceSource.includes("code = 'INVALID_LABEL_URL'"),
  why: 'Typed errors let UI and API distinguish queueable-label problems from unrelated backend failures.',
  evidence: 'src/services/print-queue.ts defines PrintQueueLabelUrlError with INVALID_LABEL_URL.',
  failure: 'Invalid label URLs may surface as ambiguous errors and become hard to diagnose.',
  fix: 'Restore PrintQueueLabelUrlError and throw it from label URL normalization failures.',
});

report.check({
  name: 'Service rejects empty/object-sentinel label URLs',
  condition: serviceSource.includes('extractShipstationLabelUrl(labelUrl)') &&
    serviceSource.includes("typeof normalized !== 'string'") &&
    serviceSource.includes('trimmed.length === 0') &&
    serviceSource.includes("trimmed === '[object Object]'"),
  why: 'The historical bug was [object Object] or blank label URLs getting queued and breaking PDF print later.',
  evidence: 'normalizePrintQueueLabelUrl unwraps known objects, requires a string, rejects blank values, and rejects [object Object].',
  failure: 'Bad label URLs can enter print_queue_orders and cause later PDF merge failures.',
  fix: 'Restore normalizePrintQueueLabelUrl validation for object payloads, empty strings, and [object Object].',
});

report.check({
  name: 'Queue insert normalizes before write',
  condition: serviceSource.includes('const labelUrl = normalizePrintQueueLabelUrl(input.labelUrl)') &&
    serviceSource.includes('labelUrl,'),
  why: 'The database should only store queueable URLs, not raw provider objects or corrupt sentinels.',
  evidence: 'addToQueue normalizes input.labelUrl before insert/update and writes the normalized labelUrl.',
  failure: 'Corrupt label values may be persisted directly into print_queue_orders.',
  fix: 'Call normalizePrintQueueLabelUrl at the top of addToQueue and write only the returned string.',
});

report.check({
  name: 'PDF merge validates queued label URLs',
  condition: serviceSource.includes('function resolveLabelFetchUrl(labelUrl: unknown') &&
    serviceSource.includes('normalizePrintQueueLabelUrl(labelUrl)'),
  why: 'Old queue rows or manually inserted bad rows must fail safely during merge instead of crashing the whole job.',
  evidence: 'resolveLabelFetchUrl validates unknown label values through normalizePrintQueueLabelUrl.',
  failure: 'PDF merge may fetch invalid URLs or crash without a useful per-label reason.',
  fix: 'Route merge URL resolution through normalizePrintQueueLabelUrl before fetching PDFs.',
});

report.check({
  name: 'All-invalid selections return a clear summary',
  condition: serviceSource.includes('collectInvalidLabelErrors(entries)') &&
    serviceSource.includes('All selected labels have invalid URLs'),
  why: 'When every selected label is bad, the operator should know the labels must be recreated or requeued.',
  evidence: 'startPrintJob collects invalid label errors and reports an all-invalid summary.',
  failure: 'The UI may say only that merge failed, without explaining label URL corruption.',
  fix: 'Restore collectInvalidLabelErrors in startPrintJob and keep the all-invalid error message.',
});

report.check({
  name: 'Merge records per-label failures and continues',
  condition: serviceSource.includes('formatLabelUrlError(e, err)') &&
    serviceSource.includes('failedEntryIds.add(e.id)') &&
    serviceSource.includes('continue;'),
  why: 'One bad label should not hide which order failed or block all other valid labels from merging.',
  evidence: 'The merge loop formats the label error, marks the entry failed, and continues.',
  failure: 'A single corrupt label could abort the batch with no order-level diagnosis.',
  fix: 'Keep per-entry invalid-label handling inside the merge loop before PDF fetch.',
});

report.check({
  name: 'Batch-send reuses existing active labels before creating labels',
  condition: serviceSource.includes('findExistingQueueableLabelForOrder') &&
    serviceSource.includes('eq(shipments.orderId, orderId)') &&
    serviceSource.includes('eq(shipments.voided, false)') &&
    serviceSource.includes('eq(shipments.isReturn, false)') &&
    serviceSource.includes('existingLabelUrl = await findExistingQueueableLabelForOrder(order.orderId)'),
  why: 'This prevents the SP6744 bug: an already-shipped order with an existing label should queue that label, not buy postage again.',
  evidence: 'processQueueSendOrder looks up the latest active non-return shipment label before calling createLabelV2.',
  failure: 'Print to Queue may retry label creation for shipped/already-labeled orders and show Cannot create label for shipped order.',
  fix: 'Restore findExistingQueueableLabelForOrder and call it before createLabelV2 in processQueueSendOrder.',
});

report.finish();
