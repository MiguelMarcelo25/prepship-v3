import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planQueueSendRecovery } from '../src/services/print-queue/queue-send-recovery';
import { projectQueueSendOrderOutcomes } from '../src/services/print-queue/queue-send-outcomes';
import { deriveQueueSendSnapshotStatus } from '../src/services/print-queue/queue-send-status';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-key';
process.env.SUPABASE_JWT_SECRET ||= 'test-jwt-secret-test-jwt-secret';
const { normalizeShipStationExternalShipmentId } = await import('../src/lib/shipstation/labels');

const orders = Array.from({ length: 32 }, (_, index) => ({
  orderId: index + 1,
  clientId: 4,
  orderNumber: `PS444-${index + 1}`,
  skuGroupId: `sku-${index + 1}`,
}));

const recoveryItems = [
  ...orders.slice(0, 9).map((order) => ({ orderId: order.orderId, clientId: 4, state: 'queued' as const })),
  ...orders.slice(9, 13).map((order) => ({ orderId: order.orderId, clientId: 4, state: 'shipment_persisted' as const })),
  ...orders.slice(13, 29).map((order) => ({ orderId: order.orderId, clientId: 4, state: 'ready' as const })),
  ...orders.slice(29).map((order) => ({
    orderId: order.orderId,
    clientId: 4,
    state: 'provider_pending_recovery' as const,
    blockedReason: 'label_purchase_reconciliation_required',
  })),
];

const recovery = planQueueSendRecovery({
  workerOrders: orders,
  itemStates: recoveryItems,
  // Fresh durable sidecars must override stale parent results after a hard stop.
  results: orders.slice(9, 13).map((order) => ({
    orderId: order.orderId,
    success: false,
    retryEligible: false,
    retryReason: 'provider_unavailable',
  })),
});
assert.deepEqual(recovery.safeOrders.map((order) => order.orderId), [
  10, 11, 12, 13,
  14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
]);
assert.deepEqual(recovery.providerPendingOrderIds, [30, 31, 32]);
assert.ok(recovery.safeOrders.every((order) => !recovery.providerPendingOrderIds.includes(order.orderId)));

const finalItems = orders.map((order, index) => ({
  orderId: order.orderId,
  clientId: 4,
  state: index < 29 ? 'queued' as const : 'provider_pending_recovery' as const,
  blockedReason: index < 29 ? null : 'label_purchase_reconciliation_required',
  errorMessage: index < 29 ? null : 'Carrier outcome is unknown',
}));
const status = deriveQueueSendSnapshotStatus({
  status: 'interrupted',
  current: 29,
  total: 32,
  queued: 29,
  failed: 0,
  itemStates: finalItems,
}, { inMemoryJobPresent: false });
assert.equal(status.queued, 29);
assert.equal(status.providerPending, 3);
assert.equal(status.completedOrderAttempts, 29);

const outcomes = projectQueueSendOrderOutcomes({ workerOrders: orders, itemStates: finalItems });
assert.equal(outcomes.filter((outcome) => outcome.outcome === 'queued').length, 29);
const held = outcomes.filter((outcome) => outcome.outcome === 'provider_pending');
assert.deepEqual(held.map((outcome) => outcome.orderId), [30, 31, 32]);
assert.ok(held.every((outcome) => outcome.retryEligible === false));
assert.ok(held.every((outcome) => outcome.nextAction === 'reconcile_provider'));

const actionOutcomes = projectQueueSendOrderOutcomes({
  workerOrders: orders.slice(0, 4),
  itemStates: orders.slice(0, 4).map((order) => ({
    orderId: order.orderId,
    clientId: order.clientId,
    state: 'failed_retryable' as const,
  })),
  results: [
    { orderId: 1, success: false, retryEligible: true, retryReason: 'provider_unavailable' },
    { orderId: 2, success: false, retryEligible: false, retryReason: 'insufficient_account_balance' },
    { orderId: 3, success: false, retryEligible: true, retryReason: 'rate_proof_check_unavailable' },
    { orderId: 4, success: false, retryEligible: true, retryReason: 'stale_or_mismatched_rate_proof' },
  ],
});
assert.equal(actionOutcomes[0]?.nextAction, 'retry_later');
assert.equal(actionOutcomes[1]?.nextAction, 'fund_account');
assert.equal(actionOutcomes[2]?.nextAction, 'retry_later');
assert.equal(actionOutcomes[3]?.nextAction, 'rerate');

const legacyOperationKey = `psop_${'a'.repeat(48)}`;
assert.equal(legacyOperationKey.length, 53);
assert.equal(normalizeShipStationExternalShipmentId(legacyOperationKey), legacyOperationKey.slice(0, 50));

const worker = readFileSync(new URL('../src/services/print-queue-worker.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('../src/routes/print-queue.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../src/services/print-queue.ts', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../src/services/print-queue/queue-send-preflight.ts', import.meta.url), 'utf8');
const ratePolicy = readFileSync(new URL('../src/services/rate-preexpiry-refresh-policy.ts', import.meta.url), 'utf8');
const reconciler = readFileSync(new URL('../src/services/print-queue/shipstation-operation-reconciler.ts', import.meta.url), 'utf8');
const shipStationLabels = readFileSync(new URL('../src/lib/shipstation/labels.ts', import.meta.url), 'utf8');
const ratesBackfill = readFileSync(new URL('../src/services/rates-backfill.ts', import.meta.url), 'utf8');
assert.match(worker, /retryLimit:\s*0/);
assert.match(worker, /planQueueSendRecovery/);
assert.match(route, /batch-send\/:jobId\/resume/);
assert.match(route, /projectQueueSendOrderOutcomes/);
assert.match(queue, /provider_pending_recovery/);
assert.match(preflight, /rate_proof_check_unavailable/);
assert.match(preflight, /getHeldLabelOperationOrderIds/);
assert.match(ratePolicy, /selectionRef/);
assert.match(worker, /reconcileQueueShipStationOperation/);
assert.match(reconciler, /ssGetLabelByExternalShipmentId/);
assert.match(reconciler, /resumeVerifiedShipStationForwardLabel/);
assert.match(reconciler, /recordExactShipStationForwardLabelReceipt/);
assert.match(shipStationLabels, /\/v2\/labels\/external_shipment_id\//);
assert.match(ratesBackfill, /authorization:\s*quoteAuthorization/);

console.log('PS-444 print queue recovery guard passed');
