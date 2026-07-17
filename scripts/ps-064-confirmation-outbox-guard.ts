import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildShipmentConfirmationLifecyclePlan,
  resolveShipmentConfirmationProvider,
} from '../src/services/fulfillment/outbox';

const shipstationCandidate = {
  orderId: 1191799,
  orderNumber: '1149',
  sourceProvider: 'shipstation',
  externalOrderId: '290770091',
  sourceOrderId: '290770091',
  shipmentId: 24970,
  trackingNumber: '9400111206213900001335',
  carrierCode: 'usps',
  shipDate: '2026-06-01',
  confirmationStatus: null,
  outboxExists: false,
  outboxSucceeded: false,
};

assert.equal(
  resolveShipmentConfirmationProvider(shipstationCandidate),
  'shipstation',
  'ShipStation-sourced labels must resolve provider=shipstation',
);

const plan = buildShipmentConfirmationLifecyclePlan(shipstationCandidate);
assert.equal(plan.safeToBuyLabel, false, 'repair must never buy another label');
assert.equal(plan.provider, 'shipstation', 'repair must target ShipStation for ShipStation-sourced orders');
assert.equal(plan.upstreamOrderId, '290770091', 'repair must use upstream ShipStation order id, not local order id');
assert.equal(plan.plannedAction, 'create_outbox_pending', 'missing ShipStation confirmation lifecycle must plan outbox creation');
assert.equal(plan.notifyMarketplace, true, 'ShipStation confirmation must notify the sales channel');

const alreadySucceededPlan = buildShipmentConfirmationLifecyclePlan({
  ...shipstationCandidate,
  confirmationStatus: 'succeeded',
  outboxExists: true,
  outboxSucceeded: true,
});
assert.equal(alreadySucceededPlan.plannedAction, 'already_succeeded', 'succeeded lifecycle must not be duplicated');

const unsupportedPlan = buildShipmentConfirmationLifecyclePlan({
  ...shipstationCandidate,
  sourceProvider: 'amazon',
  externalOrderId: 'amazon-123',
  sourceOrderId: '123',
});
assert.equal(unsupportedPlan.plannedAction, 'mark_not_supported', 'unsupported live connector must get explicit not_supported state');

const noTrackingPlan = buildShipmentConfirmationLifecyclePlan({
  ...shipstationCandidate,
  trackingNumber: null,
});
assert.equal(noTrackingPlan.plannedAction, 'mark_not_required_no_tracking', 'missing tracking must produce explicit terminal state');

const outboxSource = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
assert.match(outboxSource, /export async function ensureShipmentConfirmationLifecycle/, 'outbox must expose idempotent lifecycle repair helper');

const repairScript = readFileSync('scripts/repair-marketplace-confirmation.ts', 'utf8');
assert.match(repairScript, /--live-approved/, 'live repair command must require --live-approved');
assert.match(repairScript, /safe_to_buy_label/, 'repair dry-run output must report safe_to_buy_label');
assert.doesNotMatch(repairScript, /createLabelV2|createCarrierLabel|buyLabel\(|purchaseLabel\(/i, 'repair command must never create labels or buy postage');

const inspector = readFileSync('scripts/inspect-shipping-order.ts', 'utf8');
assert.match(
  inspector,
  /confirmation lifecycle missing: active local label has no fulfillment_outbox row and no shipment confirmation_status/,
  'shipping inspector must warn on #1149-style missing confirmation lifecycle',
);

const printQueue = readFileSync('src/services/print-queue.ts', 'utf8');
assert.match(printQueue, /ensureShipmentConfirmationLifecycle/, 'print queue existing-label path must call lifecycle repair helper');
assert.match(
  printQueue,
  /export async function addToQueue[\s\S]*await repairMissingConfirmationForQueuedLabel\(input\.orderId\)/,
  'central addToQueue must repair/process confirmation so direct /print-queue/add cannot bypass ShipStation mark-as-shipped',
);
assert.doesNotMatch(
  printQueue,
  /const queueableLabelUrl = normalizePrintQueueLabelUrl\(labelUrl\);\s*await repairMissingConfirmationForQueuedLabel\(order\.orderId\);/,
  'confirmation repair must not live only in processQueueSendOrder; direct addToQueue callers must be covered',
);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(
  pkg.scripts?.['marketplace:confirmation:repair'],
  'tsx scripts/repair-marketplace-confirmation.ts',
  'package.json must expose marketplace:confirmation:repair',
);
assert.equal(
  pkg.scripts?.['test:ps-064-confirmation-outbox'],
  'tsx scripts/ps-064-confirmation-outbox-guard.ts',
  'package.json must expose PS-064 guard',
);

console.log('PS-064 confirmation outbox guard passed');
