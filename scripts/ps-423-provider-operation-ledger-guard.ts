import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('drizzle/0072_external_operations.sql');
const service = read('src/services/fulfillment-operation-ledger.ts');
const schema = read('src/db/schema/external-operations.ts');
const readiness = read('src/services/runtime-schema-readiness.ts');
const labels = read('src/services/labels.ts');
const verifiedRecovery = read('src/services/verified-forward-label-recovery.ts');
const outbox = read('src/services/fulfillment/outbox.ts');
const connectorTypes = read('src/connectors/types.ts');
const shipstationLabels = read('src/lib/shipstation/labels.ts');
const admin = read('src/routes/admin.ts');
const migrationRunner = read('scripts/apply-ps-423-external-operations-migration.ts');

assert.match(migration, /CREATE TABLE IF NOT EXISTS external_operations/);
assert.match(migration, /external_operations_key_unq/);
assert.match(migration, /external_operations_idempotency_unq/);
assert.match(migration, /external_operations_state_lease_idx/);
assert.match(migration, /ALTER TABLE external_operations ENABLE ROW LEVEL SECURITY/);
assert.doesNotMatch(
  migration,
  /\b(?:UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+(?:public\.)?(?:orders|shipments)\b/i,
  'PS-423 migration is additive and never mutates protected production history',
);

for (const state of [
  'prepared',
  'in_flight',
  'receipt_recorded',
  'consumed',
  'failed_pre_dispatch',
  'reconcile_required',
]) {
  assert.ok(schema.includes(`'${state}'`) || migration.includes(`'${state}'`), `schema owns ${state}`);
}
assert.match(service, /hashFulfillmentOperationRequest/);
assert.match(service, /buildFulfillmentOperationIdempotencyKey/);
assert.match(service, /eq\(externalOperations\.generation, lease\.generation\)/);
assert.match(service, /runDurableWorkerAttempt/);
assert.match(service, /recordFulfillmentOperationReceipt/);
assert.match(service, /consumeFulfillmentOperation/);
assert.match(service, /local_result = \$\{serializedLocalResult\}::jsonb/);
assert.match(service, /resolveFulfillmentOperationNoEffect/);
assert.match(service, /recordFulfillmentOperationReceiptByOperator/);
assert.match(service, /holdExpiredFulfillmentOperationForReconciliation/);
assert.match(readiness, /'external_operations'/);
assert.match(readiness, /0072_external_operations\.sql/);

for (const kind of [
  'forward_label',
  'shopify_label',
  'return_label',
  'void_label',
  'marketplace_confirmation',
]) {
  assert.ok(labels.includes(`kind: '${kind}'`) || outbox.includes(`kind: '${kind}'`), `${kind} delegates to the ledger`);
}
assert.match(labels, /dispatchFulfillmentOperation/);
assert.match(labels, /consumeFulfillmentOperation/);
assert.match(verifiedRecovery, /resumeVerifiedShipStationForwardLabel/);
assert.match(verifiedRecovery, /Verified ShipStation forward-label receipt is not recoverable/);
assert.doesNotMatch(verifiedRecovery, /createCarrierLabel|dispatchFulfillmentOperation|ssCreateLabel/);
assert.match(outbox, /consumeFulfillmentOperationWithSql/);
assert.match(outbox, /releaseResolvedShipmentConfirmationForResume/);
assert.match(outbox, /operation\.state IN \('receipt_recorded', 'consumed'\)/);
assert.match(outbox, /operation\.state = 'failed_pre_dispatch'/);
assert.match(connectorTypes, /signal\?: AbortSignal/);
assert.match(connectorTypes, /idempotencyKey\?: string/);
assert.match(shipstationLabels, /external_shipment_id/);
assert.doesNotMatch(
  labels,
  /createLabelPurchaseIntent\(/,
  'new label purchases must use the canonical provider-operation ledger instead of creating a second intent',
);
assert.match(admin, /\/external-operations/);
assert.match(admin, /provider_verified_no_effect/);
assert.match(admin, /provider_receipt_found/);
assert.match(migrationRunner, /orders\/shipments mutation detected/);
assert.match(migrationRunner, /Object\.values\(after\)\.some/);

console.log('PASS PS-423 provider-operation ledger structural guard');
