/**
 * PS-432 offline boundary guard.
 *
 * Source inspection plus an in-memory readiness retry. No configured database,
 * provider request, label/postage purchase, marketplace notification, or
 * production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertFulfillmentSchemaReady,
  resetFulfillmentSchemaReadinessForTests,
} from '../src/services/fulfillment/schema-readiness.js';

const read = (path: string) => readFileSync(path, 'utf8');
const inventoryOutbox = read('src/services/fulfillment/inventory-deduction-outbox.ts');
const fulfillmentOutbox = read('src/services/fulfillment/outbox.ts');
const shipmentSync = read('src/services/shipment-sync.ts');
const orderSync = read('src/services/order-sync.ts');
const storeImport = read('src/services/store-order-import.ts');
const externalShipped = read('src/services/fulfillment/mark-shipped-externally.ts');
const labels = read('src/services/labels.ts');
const labelIntent = read('src/lib/label-purchase-intent.ts');
const operationLedger = read('src/services/fulfillment-operation-ledger.ts');
const adminRoute = read('src/routes/admin.ts');
const shipStation = read('src/connectors/store/shipstation.ts');
const inventoryDeductions = read('src/services/fulfillment-deductions.ts');
const inventorySchema = read('src/db/schema/inventory.ts');
const lifecycleCommand = read('src/services/order-lifecycle-command.ts');
const billingGuard = read('scripts/audit-billing-cross-period-reconciliation-guard.ts');
const backfill = read('scripts/backfill-inventory-ledger.ts');
const integration = read('scripts/ps-432-sync-fulfillment-resilience-integration.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.match(inventoryOutbox, /executor: InventoryDeductionOutboxExecutor = db/);
assert.match(inventoryOutbox, /executor[\s\S]*\.insert\(fulfillmentOutbox\)[\s\S]*\.onConflictDoNothing/);
assert.match(shipmentSync, /db\.transaction\(async \(tx\)[\s\S]*applyOrderLifecycleCommandInTransaction\(tx,[\s\S]*fulfillmentFacts[\s\S]*packageConsumption/);
assert.match(orderSync, /inventoryDeductionSource: 'order_sync_status'/);
assert.match(orderSync, /applyOrderLifecycleCommand\(\{[\s\S]*source: 'order_sync_status'/);
assert.match(storeImport, /inventoryDeductionSource\?: string[\s\S]*db\.transaction\(async \(tx\)[\s\S]*applyOrderLifecycleCommandInTransaction\(tx,/);
assert.match(externalShipped, /applyOrderLifecycleCommand\(\{[\s\S]*transition: 'external_shipped'/);
assert.match(labels, /db\.transaction\(async \(tx\)[\s\S]*applyOrderLifecycleCommandInTransaction\(tx,/);
assert.match(lifecycleCommand, /enqueueInventoryClaimDeduction\([\s\S]*, tx\)/);
assert.doesNotMatch(labels, /inventory deduction enqueue failed; recovery scan will retry/);

const settlementStart = fulfillmentOutbox.indexOf('async function settleOutboxRowWithExecutor');
const settlementEnd = fulfillmentOutbox.indexOf('async function failOutboxRow');
const settlement = fulfillmentOutbox.slice(settlementStart, settlementEnd);
assert.ok(settlementStart >= 0 && settlementEnd > settlementStart);
assert.match(settlement, /UPDATE fulfillment_outbox[\s\S]*status = 'succeeded'/);
assert.match(settlement, /markShipmentConfirmationState\([\s\S]*status: 'succeeded'[\s\S]*executor\)/);
assert.match(settlement, /UPDATE orders[\s\S]*canonical_status = 'shipped'/);
assert.match(settlement, /completeOutboxRow[\s\S]*executor\.begin\(\(tx: SqlExecutor\) => settleOutboxRowWithExecutor\(row, tx\)\)/);
assert.match(fulfillmentOutbox, /export async function reconvergeSucceededShipmentConfirmations/);
assert.match(fulfillmentOutbox, /f\.status = 'succeeded'[\s\S]*s\.confirmation_status IS DISTINCT FROM 'succeeded'/);
assert.match(fulfillmentOutbox, /processFulfillmentOutboxOnce[\s\S]*await reconvergeSucceededShipmentConfirmations/);

const enqueueStart = fulfillmentOutbox.indexOf('const dedupeKey = `shipment_confirmation_requested:');
const enqueueEnd = fulfillmentOutbox.indexOf('type MissingShipmentConfirmationRow');
const enqueue = fulfillmentOutbox.slice(enqueueStart, enqueueEnd);
assert.match(enqueue, /pg\.begin\(async \(tx\)/);
assert.match(enqueue, /WHEN fulfillment_outbox\.status = 'succeeded' THEN fulfillment_outbox\.status/);
assert.match(enqueue, /WHEN fulfillment_outbox\.status = 'succeeded' THEN fulfillment_outbox\.payload/);
assert.match(enqueue, /if \(row\.status === 'succeeded'\)[\s\S]*settleOutboxRowWithExecutor\(row, tx\)/);
assert.match(
  enqueue,
  /if \(row\.status === 'succeeded'\)[\s\S]*settleOutboxRowWithExecutor\(row, tx\)[\s\S]*status: 'pending'/,
  'succeeded re-enqueue must reconverge before any pending projection',
);

const directIntentStart = labels.indexOf('const directRef = directLabelAccountRefFromProviderId');
const directIntentEnd = labels.indexOf('// PS-370:', directIntentStart);
const directIntent = labels.slice(directIntentStart, directIntentEnd);
assert.ok(directIntent.indexOf('loadDirectAccountForLabel') < directIntent.indexOf('acquireFulfillmentOperation'));
assert.ok(directIntent.indexOf('acquireFulfillmentOperation') < directIntent.indexOf('dispatchFulfillmentOperation'));
const shopifyStart = labels.indexOf('async function createShopifyShippingLabelForOrderImpl');
const shopifyEnd = labels.indexOf('async function createLabelV2Impl', shopifyStart);
const shopify = labels.slice(shopifyStart, shopifyEnd);
assert.ok(shopify.indexOf('buildShopifyShippingLabelPurchaseInput') < shopify.indexOf('acquireFulfillmentOperation'));
assert.ok(shopify.indexOf('acquireFulfillmentOperation') < shopify.indexOf('purchaseShopifyShippingLabel'));
assert.match(shopify, /externalOperationId: shopifyExternalOperationId/);
assert.match(labels, /pending\.labelPurchaseIntentId[\s\S]*state: 'completed'/);
assert.match(operationLedger, /state: 'reconcile_required'/);
assert.match(operationLedger, /eq\(externalOperations\.generation, lease\.generation\)/);
assert.match(labelIntent, /export async function resolveLabelPurchaseIntentByOperator/);
assert.match(labelIntent, /outcome: 'provider_verified_no_label'/);
assert.match(labelIntent, /AND order_id = \$\{intent\.order_id\}[\s\S]*AND voided = false/);
assert.match(labelIntent, /An active shipment exists for the purchase-intent order/);
assert.match(adminRoute, /label-purchase-intents\/:id\{\[0-9\]\+\}\/resolve/);
assert.match(adminRoute, /recordAuditEvent/);

const shipStationConfirm = shipStation.slice(shipStation.indexOf('async confirmShipment'));
assert.ok(shipStationConfirm.indexOf('ssV1Request<SSOrder>') < shipStationConfirm.indexOf('ssMarkOrderShippedV1'));
assert.match(shipStationConfirm, /orderStatus[\s\S]*=== 'shipped'[\s\S]*ok: true/);

assert.match(inventoryDeductions, /idempotencyKey: `inventory:ship:order:\$\{order\.id\}:inventory:\$\{row\.id\}`/);
assert.match(inventorySchema, /uniqueIndex\('inventory_ledger_idempotency_key_unq'\)\.on\(t\.idempotencyKey\)/);
assert.match(billingGuard, /candidate order must move to its canonical current period/);
assert.match(backfill, /const args: Args = \{ all: false, dryRun: true \}/);
assert.match(backfill, /arg === '--apply'[\s\S]*args\.dryRun = false/);
assert.match(backfill, /Refusing unbounded --all apply\. Pass an audited --since date/);
assert.match(backfill, /o\.updated_at >= \$\{sinceIso\}::timestamptz/);

assert.match(packageJson, /"test:ps-432-sync-fulfillment-resilience"[\s\S]*ps-432-sync-fulfillment-resilience-integration/);
assert.match(guardPack, /'test:ps-432-sync-fulfillment-resilience'/);
assert.match(integration, /forced process failure before commit/);
assert.match(integration, /Shopify retry must not repurchase/);
assert.match(integration, /ShipStation retry must not notify the marketplace twice/);

const requiredColumns: Record<string, string[]> = {
  orders: ['source_provider', 'source_account_id', 'source_order_id', 'source_order_number', 'source_status', 'canonical_status'],
  shipments: ['carrier_provider', 'carrier_account_id', 'label_provider_key', 'confirmation_status', 'confirmation_provider', 'confirmation_attempts', 'confirmation_last_error', 'marketplace_confirmed_at'],
  fulfillment_outbox: ['id', 'order_id', 'shipment_id', 'event_type', 'provider', 'dedupe_key', 'payload', 'status', 'attempts', 'last_error', 'next_run_at', 'created_at', 'updated_at'],
};
const requiredIndexes = [
  'orders_source_provider_idx',
  'orders_canonical_status_idx',
  'shipments_confirmation_status_idx',
  'fulfillment_outbox_dedupe_idx',
  'fulfillment_outbox_due_idx',
];
let firstColumnRead = true;
const retryableSql = async (strings: TemplateStringsArray) => {
  const query = strings.join(' ');
  if (query.includes('information_schema.columns')) {
    if (firstColumnRead) {
      firstColumnRead = false;
      throw new Error('transient readiness failure');
    }
    return Object.entries(requiredColumns).flatMap(([table_name, columns]) =>
      columns.map((column_name) => ({ table_name, column_name })));
  }
  if (query.includes('pg_indexes')) return requiredIndexes.map((indexname) => ({ indexname }));
  throw new Error(`Unexpected readiness query: ${query}`);
};

resetFulfillmentSchemaReadinessForTests();
await assert.rejects(() => assertFulfillmentSchemaReady(retryableSql as never), /transient readiness failure/);
await assert.doesNotReject(() => assertFulfillmentSchemaReady(retryableSql as never));
resetFulfillmentSchemaReadinessForTests();

console.log('PASS PS-432 sync + fulfillment resilience guard');
