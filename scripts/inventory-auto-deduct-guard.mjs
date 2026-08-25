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
  shipmentSync.includes('applyOrderLifecycleCommandInTransaction(tx, {') &&
    shipmentSync.includes("source: 'shipment_sync'") &&
    shipmentSync.includes("kind: 'exact' as const") &&
    shipmentSync.includes('fulfillmentFacts,'),
  'shipment sync must create exact lifecycle claims when it marks orders shipped',
);

assert(
  labels.includes('applyOrderLifecycleCommandInTransaction(tx, {') &&
    labels.includes('fulfillmentFacts:') &&
    labels.includes("kind: 'exact'") &&
    labels.includes('packageConsumption:'),
  'label creation must delegate explicit fulfillment facts and package intent to the lifecycle owner',
);

assert(
  // PS-136: the deduction lives in the extracted owner (shared kill-switch-governed path,
  // keyed external:<source>); the route delegates via markOrderShippedExternally().
  // Re-anchored to where the logic moved — protection intact, no lockdown logic changed.
  markShippedExternally.includes('dependencies.applyLifecycleCommand ?? applyOrderLifecycleCommand') &&
    markShippedExternally.includes('const result = await applyLifecycle({') &&
    markShippedExternally.includes("transition: 'external_shipped'") &&
    markShippedExternally.includes('external:${input.source}') &&
    ordersRoute.includes('markOrderShippedExternally('),
  'external shipped route must deduct inventory through the shared fulfillment deduction path',
);

assert(
  orderSync.includes("import { applyOrderLifecycleCommand } from './order-lifecycle-command'") &&
    orderSync.includes("if (orderStatus === 'shipped' || orderStatus === 'cancelled')") &&
    orderSync.includes("source: 'order_sync_status'") &&
    orderSync.includes('Per user override `unlock shipped data`'),
  'order status catch-up must deduct inventory when it flips awaiting orders to shipped',
);

// PS-497 Slice 2 Release B (S2.4x): the legacy inventory_deduction_requested lane is QUARANTINED — the
// generic worker no longer claims it (outbox.ts de-scoped to confirmation-only), the minters are no-ops, and
// the processor fails closed. Forward deduction now runs through the dedicated, isolated occurrence lane that
// delegates to the kill-switch-governed executor. Re-anchored to where the durable lane moved; the master
// kill switch (asserted above) is unchanged.
const occurrenceOutbox = readFileSync('src/services/fulfillment/occurrence-deduction-outbox.ts', 'utf8');
assert(
  deductionOutbox.includes('quarantined (fail-closed)') &&
    deductionOutbox.includes('INVENTORY_DEDUCTION_OUTBOX_EVENT') &&
    !deductionOutbox.includes('await deductInventoryForOrder('),
  'the legacy durable inventory lane must be quarantined (fail-closed, no legacy deductInventoryForOrder execution)',
);
assert(
  occurrenceOutbox.includes("FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT = 'fulfillment_occurrence_deduction_requested'") &&
    occurrenceOutbox.includes('applyOccurrenceClaims'),
  'forward deduction must run through the dedicated occurrence lane -> the kill-switch-governed occurrence executor',
);

assert(
  pkg.scripts?.['test:inventory-auto-deduct'] === 'node scripts/inventory-auto-deduct-guard.mjs',
  'package.json must expose test:inventory-auto-deduct',
);

console.log('PASS inventory auto-deduct guard');
