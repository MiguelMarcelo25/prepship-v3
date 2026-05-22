import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const deductions = readFileSync('src/services/fulfillment-deductions.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  deductions.includes('INVENTORY_AUTO_DEDUCT') &&
    deductions.includes("return { deducted: 0, skipped: true, lockedDown: true }"),
  'fulfillment deductions must keep the INVENTORY_AUTO_DEDUCT kill switch',
);

assert(
  shipmentSync.includes('deductInventoryForOrder(row, { source:') &&
    shipmentSync.includes("source: 'shipment_sync'"),
  'shipment sync must deduct inventory when it marks awaiting orders shipped',
);

assert(
  labels.includes('deductInventoryForOrder(args.order') &&
    labels.includes('inventory ledger writes'),
  'label creation must deduct inventory through the shared fulfillment deduction path',
);

assert(
  ordersRoute.includes('deductInventoryForOrder(existing') &&
    ordersRoute.includes("external:${body.source}"),
  'external shipped route must deduct inventory through the shared fulfillment deduction path',
);

assert(
  orderSync.includes("import { deductInventoryForOrder } from './fulfillment-deductions'") &&
    orderSync.includes("if (orderStatus === 'shipped')") &&
    orderSync.includes("source: 'order_sync_status'") &&
    orderSync.includes('Per user override `unlock shipped data`'),
  'order status catch-up must deduct inventory when it flips awaiting orders to shipped',
);

assert(
  pkg.scripts?.['test:inventory-auto-deduct'] === 'node scripts/inventory-auto-deduct-guard.mjs',
  'package.json must expose test:inventory-auto-deduct',
);

console.log('PASS inventory auto-deduct guard');
