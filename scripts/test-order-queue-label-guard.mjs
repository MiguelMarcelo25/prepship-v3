import { readFileSync } from 'node:fs';
import { createGuardReport } from './lib/detailed-guard-report.mjs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const fulfillmentOutbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
const carrierLabels = readFileSync('api/carriers/labels.ts', 'utf8');
const fulfillmentSchemaReadiness = readFileSync('src/services/fulfillment/schema-readiness.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const report = createGuardReport({
  title: 'Test Order and Queue Label Guard',
  bug: 'Label queue flows can silently fail when test orders lack weight, shipped panel state is stale, or an existing label is not queued after creation.',
  scope: 'Static source guard for OrdersView queue/label flows, backend test-label fallback, and fulfillment schema readiness.',
});

const testWeightFallbackCount = (ordersView.match(/const effectiveWeightOz = weightOz > 0 \? weightOz : orderIsTest \? 1 : 0/g) ?? []).length;

report.check({
  name: 'Batch Send to Queue uses test-order weight fallback',
  condition: ordersView.includes('const weightOz = getOrderWeightOz(order, orderDetail)') &&
    ordersView.includes('const effectiveWeightOz = weightOz > 0 ? weightOz : orderIsTest ? 1 : 0') &&
    ordersView.includes('weightOz: effectiveWeightOz > 0 ? effectiveWeightOz : undefined'),
  why: 'Test-client orders should create VOID mock labels even when the real order weight is missing.',
  evidence: 'OrdersView computes order/detail weight, applies a 1 oz test fallback, and sends that effective weight to queue label payloads.',
  failure: 'Batch Print to Queue can fail on sandbox/test orders with missing weight instead of creating a mock label.',
  fix: 'Restore the getOrderWeightOz lookup, effectiveWeightOz fallback, and payload weightOz assignment in batch queue payload construction.',
});

report.check({
  name: 'All queue/print/resume paths apply test weight fallback',
  condition: testWeightFallbackCount >= 3,
  why: 'The same missing-weight bug can appear in batch queue, batch print, and resumed queue jobs if any path skips the fallback.',
  evidence: `Found ${testWeightFallbackCount} effectiveWeightOz fallback occurrences; expected at least 3.`,
  failure: 'At least one label path may still reject test orders for missing weight.',
  fix: 'Apply the same effectiveWeightOz fallback to batch queue, batch print, and resumed batch queue paths.',
});

report.check({
  name: 'Batch label paths avoid stale summary-only weight and dims',
  condition: !ordersView.includes('const weightOz = order.weight?.value ?? 0\n      const dims = getDimensions(order, null)'),
  why: 'Summary rows can be stale or incomplete; label creation should use order detail data when available.',
  evidence: 'The old summary-only lookup snippet is absent from OrdersView.',
  failure: 'Batch label creation may use stale row-only dimensions and fail real orders that have detail-level dims.',
  fix: 'Use orderDetailsById and getDimensions(order, orderDetail) instead of summary-only data.',
});

report.check({
  name: 'Batch Create + Print sends effective weight',
  condition: ordersView.includes('weightOz: effectiveWeightOz,'),
  why: 'Create + Print should use the same validated effective weight as queue mode.',
  evidence: 'The batch print payload includes weightOz: effectiveWeightOz.',
  failure: 'Batch print may bypass the test-order fallback and fail with missing weight.',
  fix: 'Send effectiveWeightOz in the batch Create + Print payload.',
});

report.check({
  name: 'Shipped side-panel queue keeps the open panel order available',
  condition: ordersView.includes('Per user override unlock shipped data on 2026-05-23') &&
    ordersView.includes('orderById.set(panelOrder.orderId, panelOrder)') &&
    ordersView.includes('orderIds.includes(panelOrder.orderId)'),
  why: 'When a row leaves the current page after shipping, the detail drawer still needs the selected order to queue/reprint its existing label.',
  evidence: 'OrdersView preserves panelOrder in the lookup when selected order ids include the panel order.',
  failure: 'The side panel can lose the selected shipped order and hide/disable queue actions incorrectly.',
  fix: 'Keep the panel-order fallback in queueExistingLabels order lookup logic.',
});

report.check({
  name: 'Single-order queue recovers from already-shipped/already-labeled conflicts',
  condition: ordersView.includes('queueExistingLabelAfterCreateConflict') &&
    ordersView.includes("mode === 'queue'") &&
    ordersView.includes('apiClient.retrieveLabel(order.orderId') &&
    ordersView.includes('apiClient.addToQueue(buildQueueAddPayload(order, queueableLabelUrl))') &&
    ordersView.includes('Existing label added to print queue'),
  why: 'This is the SP6744 bug: label creation succeeded, order became shipped, but the label was not queued; retry should queue the existing label.',
  evidence: 'Queue mode catches the create-label conflict, retrieves the existing label, calls addToQueue, and shows an explicit existing-label queue confirmation.',
  failure: 'Retrying Print to Queue can try to buy a second label and show Cannot create label for shipped order.',
  fix: 'Restore queueExistingLabelAfterCreateConflict, queue the stored label, and show the Existing label added to print queue success toast.',
});

report.check({
  name: 'Queue defaults to all authorized clients with explicit current-client scope',
  condition: ordersView.includes("const [queueScope, setQueueScope] = useState<'all' | 'client'>('all')") &&
    ordersView.includes("const queueClientId = queueScope === 'client' ? inferredQueueClientId : null") &&
    ordersView.includes('apiClient.fetchQueue(queueClientId, queueHistoryVisible)') &&
    ordersView.includes("Switch to Current client before clearing a queue"),
  why: 'Operators need to see queued labels across authorized clients unless they explicitly narrow scope.',
  evidence: 'Queue scope defaults to all, fetchQueue receives null for all-client mode, and clearing requires current-client scope.',
  failure: 'The queue panel may appear empty because it is silently scoped to the wrong client.',
  fix: 'Keep all-client default scope and require explicit current-client mode for destructive queue clearing.',
});

report.check({
  name: 'Backend test labels have safe fallback weight',
  condition: labelsService.includes('body.testLabel ? 1 : 0') &&
    labelsService.includes('if (body.testLabel === true)'),
  why: 'Backend protection must exist even if the frontend forgets to send a test label weight.',
  evidence: 'createLabelV2 falls back to 1 oz for test labels before entering the offline mock-label path.',
  failure: 'A test label request can fail before creating the VOID mock label.',
  fix: 'Keep the body.testLabel ? 1 : 0 fallback before mock label creation.',
});

report.check({
  name: 'Label creation checks fulfillment schema readiness',
  condition: labelsService.includes('ensureFulfillmentSchema') &&
    labelsService.includes("timer.task('fulfillment schema readiness'"),
  why: 'Missing fulfillment/shipment columns should be detected before writing label or outbox records.',
  evidence: 'createLabelV2 imports ensureFulfillmentSchema and runs it as a timed label task.',
  failure: 'Label creation can partially succeed then fail on missing fulfillment schema fields.',
  fix: 'Run ensureFulfillmentSchema before loading the order and writing shipment/fulfillment data.',
});

report.check({
  name: 'Fulfillment readiness requires label_provider_key without request-time DDL',
  condition: fulfillmentOutbox.includes('assertFulfillmentSchemaReady') &&
    carrierLabels.includes('assertFulfillmentSchemaReady') &&
    fulfillmentSchemaReadiness.includes('label_provider_key'),
  why: 'Readiness checks should fail fast instead of mutating schema during live label requests.',
  evidence: 'Outbox and carrier label flows call assertFulfillmentSchemaReady, and readiness includes label_provider_key.',
  failure: 'A deployment missing label_provider_key may fail only during a real label or marketplace confirmation flow.',
  fix: 'Keep assertFulfillmentSchemaReady in the label/outbox paths and include label_provider_key in readiness requirements.',
});

report.check({
  name: 'Package script exposes this guard',
  condition: pkg.scripts?.['test:test-order-queue-label'] === 'node scripts/test-order-queue-label-guard.mjs',
  why: 'The guard must be easy to run from npm when debugging queue/label regressions.',
  evidence: 'package.json contains test:test-order-queue-label pointing at this guard.',
  failure: 'Developers may miss this guard and ship a repeat of the queue-label bug.',
  fix: 'Restore package.json script test:test-order-queue-label to node scripts/test-order-queue-label-guard.mjs.',
});

report.finish();
