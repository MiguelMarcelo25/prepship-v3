/** PS-424 source-of-truth placement guard. Static/offline only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const lifecycle = read('src/services/order-lifecycle-command.ts');
const schema = read('src/db/schema/order-lifecycle.ts');
const migration = read('drizzle/0070_order_lifecycle_commands.sql');
const drizzleConfig = read('drizzle.config.ts');
const deductions = read('src/services/fulfillment-deductions.ts');
const inventoryOutbox = read('src/services/fulfillment/inventory-deduction-outbox.ts');
const labels = read('src/services/labels.ts');
const shipmentSync = read('src/services/shipment-sync.ts');
const orderSync = read('src/services/order-sync.ts');
const storeImport = read('src/services/store-order-import.ts');
const marketplace = read('src/services/marketplace-status-reconciliation.ts');
const deleted = read('src/services/shipstation-deleted-awaiting-reconciliation.ts');
const external = read('src/services/fulfillment/mark-shipped-externally.ts');
const webhook = read('src/services/fulfillment/upstream-reconcile.ts');
const overrides = read('src/services/orders-overrides-command.ts');
const ordersRoute = read('src/routes/orders.ts');
const walmartPuller = read('api/carriers/walmart/orders.ts');
const ebayPuller = read('api/carriers/ebay/orders.ts');
const awaitingReconcile = read('scripts/reconcile-shipstation-awaiting.ts');
const externalReconcile = read('scripts/reconcile-external-shipped-orders.ts');
const applyMigration = read('scripts/apply-ps-424-order-lifecycle-migration.ts');

assert.match(schema, /orderLifecycleEvents = pgTable/);
assert.match(schema, /fulfillmentLineClaims = pgTable/);
assert.match(drizzleConfig, /src\/db\/schema\/order-lifecycle\.ts/);
assert.match(migration, /order_lifecycle_events_command_unq/);
assert.match(migration, /order_lifecycle_events_no_update_delete/);
assert.match(migration, /DROP TRIGGER IF EXISTS order_lifecycle_events_no_update_delete/);
assert.match(migration, /order_lifecycle_events_block_mutations/);
assert.match(migration, /fulfillment_line_claims_idempotency_unq/);
assert.match(migration, /quantity integer NOT NULL CHECK \(quantity > 0\)/);
assert.match(migration, /original_claim_id integer REFERENCES fulfillment_line_claims\(id\)/);

assert.match(lifecycle, /applyOrderLifecycleCommandInTransaction/);
assert.match(lifecycle, /\.for\('update'\)/);
assert.match(lifecycle, /requireAwaitingOrderStatus/);
assert.match(lifecycle, /normalizeFulfilledLines/);
assert.match(lifecycle, /OrderLifecycleFulfillmentFacts/);
assert.match(lifecycle, /fulfillment_lines_unavailable/);
assert.doesNotMatch(lifecycle, /input\.fulfilledLines/);
assert.doesNotMatch(lifecycle, /items:\s*orders\.items|normalizeFulfilledLines\([^)]*order\.items/,
  'the canonical owner must never infer shipment quantities from mutable order items');
assert.match(lifecycle, /consumeOutboundPackageInTransaction/);
assert.match(lifecycle, /reverseOutboundPackageConsumptionInTransaction/);
assert.match(lifecycle, /enqueueInventoryClaimDeduction/);
assert.match(lifecycle, /status: 'superseded'/);
assert.match(lifecycle, /direction: 'reverse'/);
assert.match(lifecycle, /Per user override unlock shipped data on 2026-07-16/);

assert.match(deductions, /if \(!isInventoryAutoDeductEnabled\(\)\)/);
assert.match(deductions, /applyInventoryClaimsForLifecycleEvent/);
assert.match(deductions, /claim\.direction === 'deduct' \? 'ship' : 'return'/);
assert.match(deductions, /idempotencyKey: claim\.idempotencyKey/);
assert.match(deductions, /Per user override unlock shipped data on 2026-07-16/);
assert.match(inventoryOutbox, /lifecycleEventId/);
// PS-497 Slice 2 Release B (S2.4x): the legacy recovery re-minter is retired and the whole legacy lane is
// quarantined (fail-closed); forward deduction recovery is owned by the dedicated occurrence lane. Re-anchored
// from the retired recovery SQL to the quarantine marker.
assert.match(inventoryOutbox, /quarantined \(fail-closed\)/,
  'the legacy inventory recovery lane must be quarantined (fail-closed), not re-minting');

for (const [path, source] of [
  ['labels.ts', labels],
  ['shipment-sync.ts', shipmentSync],
  ['order-sync.ts', orderSync],
  ['store-order-import.ts', storeImport],
  ['marketplace-status-reconciliation.ts', marketplace],
  ['shipstation-deleted-awaiting-reconciliation.ts', deleted],
  ['mark-shipped-externally.ts', external],
  ['upstream-reconcile.ts', webhook],
] as const) {
  assert.match(source, /applyOrderLifecycleCommand/,
    `${path} must delegate terminal facts to OrderLifecycleCommand`);
}

assert.doesNotMatch(labels, /\.set\(\{\s*orderStatus:\s*'shipped'/s);
assert.doesNotMatch(labels, /fulfilledLines:\s*(?:input\.)?order\.items/,
  'label callers must provide Shopify fulfillment-order lines or explicit review state');
assert.match(labels, /extractShopifyFulfillmentLinesForPurchase/);
assert.match(labels, /kind: 'unavailable'/);
assert.doesNotMatch(shipmentSync, /\.set\(\{\s*orderStatus:\s*'shipped'/s);
assert.doesNotMatch(marketplace, /SET\s+order_status\s*=/i);
assert.doesNotMatch(deleted, /orderStatus:\s*'cancelled'/);
assert.doesNotMatch(external, /\.update\(orders\)/);
assert.doesNotMatch(external, /enqueueInventoryDeduction/);
assert.match(external, /requireAwaitingOrderStatus: true/);
assert.doesNotMatch(webhook, /externally_shipped_source\s*=/i,
  'webhook provenance belongs to order_overrides through the lifecycle owner');
assert.doesNotMatch(overrides, /externallyShipped\?:\s*boolean/);
assert.doesNotMatch(overrides, /\.set\(\{\s*externallyShipped:/s);
assert.match(walmartPuller, /upsertNormalizedStoreOrders/);
assert.match(ebayPuller, /upsertNormalizedStoreOrders/);
assert.doesNotMatch(walmartPuller, /order_status = CASE/);
assert.doesNotMatch(ebayPuller, /order_status = CASE/);
assert.match(awaitingReconcile, /applyOrderLifecycleCommand/);
assert.doesNotMatch(awaitingReconcile, /SET order_status = \$\{candidate\.targetStatus\}/);
assert.doesNotMatch(awaitingReconcile, /SET order_status = 'cancelled'/);
assert.match(externalReconcile, /applyOrderLifecycleCommand/);
assert.doesNotMatch(externalReconcile, /\.set\(\{ externallyShipped: true/);
assert.match(applyMigration, /if \(!opsMayMutate\(\)\)/);
assert.match(applyMigration, /\.split\('--> statement-breakpoint'\)/);
assert.match(applyMigration, /append_only_trigger_present/);

const patchSchema = ordersRoute.match(/const patchBody = z\.object\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
assert.ok(patchSchema, 'orders PATCH schema must remain discoverable');
assert.doesNotMatch(patchSchema, /externallyShipped/,
  'generic PATCH must not accept lifecycle/external-shipment state');
assert.match(ordersRoute, /\/shipped-external/,
  'dedicated guarded external-shipment endpoint remains available');

console.log('PASS PS-424 order lifecycle source-of-truth guard');
