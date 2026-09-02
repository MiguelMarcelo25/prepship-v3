import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INVOICE_COLUMNS } from '../src/routes/billing-invoice-columns';
import {
  decideShipmentVoidLifecycle,
  SHIPMENT_BILLING_CARDINALITY,
  withShipmentBillingLineage,
} from '../src/services/shipment-aggregate.js';

const read = (path: string) => readFileSync(path, 'utf8');
const billing = read('src/services/billing.ts');
const labels = read('src/services/labels.ts');
const lifecycle = read('src/services/order-lifecycle-command.ts');
const schema = read('src/db/schema/billing.ts');
const migration = read('drizzle/0068_billing_shipment_cardinality.sql');
const route = read('src/routes/billing.ts');
const csv = read('src/routes/billing-invoice-csv.ts');

assert.equal(SHIPMENT_BILLING_CARDINALITY, 'per_shipment');
assert.equal(
  withShipmentBillingLineage('Shipping · order A1', 77),
  'Shipping · order A1 · shipment #77',
);
assert.equal(decideShipmentVoidLifecycle({
  remainingActiveOutboundShipmentCount: 1,
  orderStatus: 'shipped',
}).kind, 'keep_shipped');
assert.equal(decideShipmentVoidLifecycle({
  remainingActiveOutboundShipmentCount: 0,
  orderStatus: 'shipped',
}).kind, 'reopen');
assert.equal(decideShipmentVoidLifecycle({
  remainingActiveOutboundShipmentCount: 0,
  orderStatus: 'shipped',
  canonicalStatus: 'cancelled',
}).kind, 'preserve_terminal');

assert.match(schema, /billing_li_shipment_unique_idx[\s\S]{0,160}t\.orderId, t\.shipmentId, t\.lineType, t\.description/);
assert.match(schema, /billing_li_order_unique_idx[\s\S]{0,160}t\.orderId, t\.lineType, t\.description/);
assert.match(migration, /billing_li_shipment_unique_idx[\s\S]{0,180}\(order_id, shipment_id, line_type, description\)/i);
assert.match(billing, /activeOutboundShipmentPredicate\(\)/);
assert.match(billing, /withShipmentBillingLineage\(row\.description, row\.shipmentId\)/);
assert.doesNotMatch(
  billing.slice(billing.indexOf('const CHUNK = 500'), billing.indexOf('// ─── Storage fees')),
  /onConflictDoNothing/,
  'order-line inserts must fail loudly instead of conflict-dropping',
);
assert.match(billing, /\.returning\(\{[\s\S]{0,180}shipmentId:[\s\S]{0,180}totalCost:/);

assert.match(route, /b\.shipment_id,/);
// PS-488 M3 — this pinned the grouping key as one literal string, so inserting b.return_id
// between shipment_id and ship_date failed it. The rule PS-425 owns is that the invoice
// groups PER SHIPMENT: two shipments of one order must stay two invoice rows. That rule is
// about shipment_id being present in the key, not about what follows it. Asserted per key,
// so this guard now fails only when the shipment grain is actually lost.
const invoiceGroupBy = /\n\s*group by ([\s\S]*?)\n\s*(?:--|order by)/.exec(route)?.[1] ?? '';
assert.ok(invoiceGroupBy.includes('b.shipment_id'),
  'PS-425: the invoice must group per shipment, or two shipments of one order collapse into one row');
assert.ok(invoiceGroupBy.includes('b.order_id') && invoiceGroupBy.includes('b.ship_date'),
  'the invoice grouping key must keep order and ship date');
// PS-488 M3: a return event is a grain of its own. Without this key two returns raised on
// one order in one billing day merge into a single invoice row — the money stays right
// while the row count silently disagrees with the Billing table for the same period.
assert.ok(invoiceGroupBy.includes('b.return_id'),
  'PS-488 M3: the invoice must group per return event');
// The Shipment # column is no longer declared three times, once per renderer. All three
// invoice artifacts derive their columns from one contract (billing-invoice-columns.ts), which
// is what stopped the HTML, XLSX and CSV carrying different columns under different names. So
// assert the column exists ONCE, in the owner every renderer reads, rather than re-pinning a
// literal <th> and an inline XLSX entry that no longer exist.
assert.ok(
  INVOICE_COLUMNS.some((column) => column.key === 'shipmentId' && column.header === 'Shipment #'),
  'the shared invoice column contract must carry Shipment #',
);
assert.match(csv, /row\.shipment_id == null/);

assert.match(labels, /voidOrderShipmentLifecycleInTransaction\(tx,/);
assert.match(lifecycle, /activeOutboundShipmentPredicate\(\{[\s\S]{0,180}excludeShipmentId: input\.shipmentId/);
assert.match(lifecycle, /\.for\('update'\)/);
assert.match(lifecycle, /decideShipmentVoidLifecycle\(\{/);
assert.match(labels, /lifecycleDecision\?\.kind === 'reopen'/);
assert.doesNotMatch(
  labels.slice(labels.indexOf('export async function voidLabelV2'), labels.indexOf('export async function createReturnLabelV2')),
  /set\(\{ orderStatus: 'awaiting_shipment'/,
  'the void route may not unconditionally reopen an order',
);

assert.match(labels, /Per user override unlock shipped data on 2026-05-23: PS-425/);
assert.match(billing, /Per user override unlock shipped data on 2026-05-23: PS-425/);

console.log('PASS PS-425 multi-shipment cardinality/lifecycle guard');
