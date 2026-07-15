import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
// PS-136 extracted the manual mark-shipped-externally transition (status flip + the shared-path
// inventory deduction) into this service owner; the orders route now delegates to it.
const markShippedExternally = readFileSync('src/services/fulfillment/mark-shipped-externally.ts', 'utf8');
const deductions = readFileSync('src/services/fulfillment-deductions.ts', 'utf8');
const deductionOutbox = readFileSync('src/services/fulfillment/inventory-deduction-outbox.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  deductions.includes('INVENTORY_AUTO_DEDUCT') &&
    deductions.includes("return { deducted: 0, skipped: true, lockedDown: true }"),
  'fulfillment deductions must keep the INVENTORY_AUTO_DEDUCT kill switch',
);

assert(
  shipmentSync.includes('enqueueInventoryDeduction(row, { source:') &&
    shipmentSync.includes("source: 'shipment_sync'"),
  'shipment sync must deduct inventory when it marks awaiting orders shipped',
);

assert(
  labels.includes('enqueueInventoryDeduction(args.order') &&
    labels.includes('enqueue inventory deduction'),
  'label creation must enqueue the shared durable inventory deduction path',
);

assert(
  // PS-136: the deduction lives in the extracted owner (shared kill-switch-governed path,
  // keyed external:<source>); the route delegates via markOrderShippedExternally().
  // Re-anchored to where the logic moved — protection intact, no lockdown logic changed.
  /enqueueInventoryDeduction\(\s*order,[\s\S]*tx,/.test(markShippedExternally) &&
    markShippedExternally.includes('external:${input.source}') &&
    ordersRoute.includes('markOrderShippedExternally('),
  'external shipped route must deduct inventory through the shared fulfillment deduction path',
);

assert(
  orderSync.includes("import { enqueueInventoryDeduction } from './fulfillment/inventory-deduction-outbox'") &&
    orderSync.includes("if (orderStatus === 'shipped')") &&
    orderSync.includes("source: 'order_sync_status'") &&
    orderSync.includes('Per user override `unlock shipped data`'),
  'order status catch-up must deduct inventory when it flips awaiting orders to shipped',
);

assert(
  deductionOutbox.includes('await deductInventoryForOrder(') &&
    deductionOutbox.includes('INVENTORY_DEDUCTION_OUTBOX_EVENT') &&
    deductionOutbox.includes('enqueueMissingInventoryDeductions'),
  'the durable lane must delegate to the kill-switched owner and repair missed events',
);

assert(
  pkg.scripts?.['test:inventory-auto-deduct'] === 'node scripts/inventory-auto-deduct-guard.mjs',
  'package.json must expose test:inventory-auto-deduct',
);

console.log('PASS inventory auto-deduct guard');
