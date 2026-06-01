import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const outbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const recoveryScript = readFileSync('scripts/recover-missing-shipment-confirmations.ts', 'utf8');
const inspector = readFileSync('scripts/inspect-shipping-order.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  outbox.includes('export async function enqueueMissingShipmentConfirmations'),
  'fulfillment outbox must expose automatic missing-confirmation recovery',
);
assert(
  outbox.includes("o.order_status = 'shipped'") &&
    outbox.includes("o.external_order_id ~ '^[0-9]+$'") &&
    outbox.includes('s.confirmation_status IS NULL') &&
    outbox.includes('s.label_url IS NOT NULL') &&
    outbox.includes('s.tracking_number'),
  'auto recovery must target shipped ShipStation-backed labels missing confirmation state',
);
assert(
  outbox.includes('NOT EXISTS') &&
    outbox.includes('FROM fulfillment_outbox fo') &&
    outbox.includes("fo.event_type = 'shipment_confirmation_requested'"),
  'auto recovery must not duplicate existing fulfillment_outbox confirmation work',
);
assert(
  outbox.includes("confirmationProvider: 'shipstation'") &&
    outbox.includes('autoRecoveredMissingConfirmation'),
  'auto recovery must enqueue ShipStation marketplace notification for existing labels',
);
assert(
  outbox.includes('never creates/voids labels or rewrites shipment history'),
  'auto recovery must document that it does not create labels, void labels, or rewrite history',
);
assert(
  scheduler.includes('enqueueMissingShipmentConfirmations') &&
    scheduler.indexOf('enqueueMissingShipmentConfirmations({ limit: 25 })') <
      scheduler.indexOf('processFulfillmentOutboxOnce({ limit: 25 })'),
  'scheduler must enqueue missing confirmations before processing the fulfillment outbox',
);
assert.equal(
  pkg.scripts['shipment-confirmation:recover'],
  'tsx scripts/recover-missing-shipment-confirmations.ts',
  'package.json must expose dry-run missing confirmation recovery',
);
assert.equal(
  pkg.scripts['shipment-confirmation:recover:apply'],
  'tsx scripts/recover-missing-shipment-confirmations.ts --apply',
  'package.json must expose apply-gated missing confirmation recovery',
);
assert(
  recoveryScript.includes("if (args.apply && (!args.orderId || !args.shipmentId))") &&
    recoveryScript.includes("throw new Error('--apply requires exact --order-id and --shipment-id')"),
  'apply recovery must require exact order and shipment ids',
);
assert(
  recoveryScript.includes('createsLabels: false') &&
    recoveryScript.includes('buysPostage: false') &&
    recoveryScript.includes('notifiesMarketplaceDirectly: false'),
  'dry-run recovery output must certify it does not create labels, buy postage, or directly notify marketplaces',
);
assert(
  inspector.includes('FROM print_queue_orders') &&
    inspector.includes('printQueue: printQueue.map'),
  'shipping inspector must report print queue state for PS-059 diagnosis',
);
assert(
  inspector.includes("raw->>'legacyOrderId'") &&
    inspector.includes("raw->>'orderId'") &&
    !inspector.includes("WHERE provider = 'walmart'"),
  'shipping inspector must search marketplace store_orders beyond Walmart-only rows',
);

console.log('shipment confirmation auto-recovery guard passed');
