import { readFileSync } from 'node:fs';
import { createGuardReport } from './lib/detailed-guard-report.mjs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-178 (Phase 6, part 3): the Print Queue drawer JSX moved VERBATIM to its own
// render-only component; drawer-string pins read there. Queue STATE pins
// (scope default, fetchQueue scoping) stay against OrdersView, which kept them.
const queueDrawer = readFileSync('web/src/components/Views/OrdersPrintQueueDrawer.tsx', 'utf8');
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
  // PS-176 part 2 re-anchor (count 3 → 2): the resumed-batch-queue path no
  // longer BUYS labels at all — resume hands interrupted batch jobs back to the
  // operator (pinned by test:ps-176-queue-route-authority "resume NEVER buys").
  // 2026-07-07 cleanup re-anchor (count 2 → 1): the legacy batch Create+Print FE
  // buying loop is DELETED — batch print now chains through the SAME queue-send
  // intent payload (buildQueueSendOrderPayload), so both flows share the ONE
  // fallback site. Test orders always take that site (the chain's needsOverride
  // short-circuits on isBackendTestOrder, so no override payload replaces it).
  name: 'All label-BUYING queue/print paths apply test weight fallback',
  condition: testWeightFallbackCount >= 1,
  why: 'The same missing-weight bug can appear in any flow that builds label-buying queue intent if it skips the fallback.',
  evidence: `Found ${testWeightFallbackCount} effectiveWeightOz fallback occurrences; expected at least 1 (batch queue + batch print share buildQueueSendOrderPayload).`,
  failure: 'The label-buying queue intent path may reject test orders for missing weight.',
  fix: 'Apply the effectiveWeightOz fallback in buildQueueSendOrderPayload.',
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
  // 2026-07-07 cleanup re-anchor: the legacy batch print payload (weightOz: effectiveWeightOz,)
  // is deleted with the FE buying loop. Batch Create + Print now sends queue intent through the
  // SAME buildQueueSendOrderPayload as queue mode, so it inherits the validated effective
  // weight from the one shared site (pinned by the checks above).
  name: 'Batch Create + Print sends effective weight',
  condition: ordersView.includes("kind: 'create-print'") &&
    ordersView.includes('sendToQueue: (sendableOrders, overrides) =>') &&
    ordersView.includes('weightOz: effectiveWeightOz > 0 ? effectiveWeightOz : undefined'),
  why: 'Create + Print should use the same validated effective weight as queue mode.',
  evidence: 'Batch print chains through sendOrdersToQueueBackend (create-print kind), whose shared payload builder applies the effective-weight fallback.',
  failure: 'Batch print may bypass the test-order fallback and fail with missing weight.',
  fix: 'Route batch Create + Print through the queue-send intent payload with the effectiveWeightOz fallback.',
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
  // Re-anchored for the print-queue client-dropdown refactor (commit 6623a944): the fetch still
  // stays all-authorized-scope (queueScope fixed to 'all' -> queueClientId null -> fetchQueue(null)),
  // and the dropdown is now a pure client-side VIEW filter (pqClientFilter). A destructive clear
  // still requires an EXPLICIT single client (the Clear button is disabled until pqClientFilter is set),
  // preserving the original safety invariant — only the control changed, not the scope/authz.
  name: 'Queue defaults to all authorized clients; clearing requires an explicit per-client scope',
  condition: ordersView.includes("const [queueScope] = useState<'all' | 'client'>('all')") &&
    ordersView.includes("const queueClientId = queueScope === 'client' ? inferredQueueClientId : null") &&
    ordersView.includes('apiClient.fetchQueue(queueClientId, queueHistoryVisible)') &&
    queueDrawer.includes('Select a client to clear its queue') &&
    queueDrawer.includes('disabled={pqClientFilter == null}'),
  why: 'Operators see queued labels across ALL authorized clients by default (the fetch stays all-scope); the per-client dropdown is a view filter, and a destructive clear still requires an explicit single-client selection.',
  evidence: 'queueScope is fixed to all so fetchQueue receives null (all-client fetch); the per-client dropdown filters the view via pqClientFilter; the Clear button is disabled until a client is selected.',
  failure: 'The queue panel may appear empty because it is silently scoped to the wrong client, or a blanket clear runs without an explicit client.',
  fix: 'Keep the all-scope fetch (queueScope all), the pqClientFilter view filter, and require an explicit selected client before clearing.',
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
  // PS-209 re-anchor: the legacy Vercel label fn is a retired no-import 410 —
  // it does NO database work, so a readiness assert there is meaningless (and
  // request-time DDL is impossible by construction). The readiness protection
  // lives where labels are actually written: the outbox + the v4 owner's
  // ensureFulfillmentSchema task (pinned in the previous check).
  name: 'Fulfillment readiness requires label_provider_key without request-time DDL',
  condition: fulfillmentOutbox.includes('assertFulfillmentSchemaReady') &&
    carrierLabels.includes('LEGACY_LABEL_ENDPOINT_RETIRED') &&
    fulfillmentSchemaReadiness.includes('label_provider_key'),
  why: 'Readiness checks should fail fast instead of mutating schema during live label requests.',
  evidence: 'The outbox asserts readiness (incl. label_provider_key); the legacy label fn is a DB-free retired stub.',
  failure: 'A deployment missing label_provider_key may fail only during a real label or marketplace confirmation flow.',
  fix: 'Keep assertFulfillmentSchemaReady in the outbox path and keep the legacy endpoint a purchase-free stub.',
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
