import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyShipStationAwaitingParity,
  shouldApplyShipStationAwaitingParityOverrideCandidate,
  shouldApplyShipStationAwaitingParityCandidate,
} from '../src/lib/shipstation-awaiting-parity.ts';
import { selectShipStationDeletedAwaitingCandidates } from '../src/services/shipstation-deleted-awaiting-policy.ts';

const liveAwaiting = [
  { externalOrderId: '286991416', orderNumber: '1001', storeId: 378060 },
  { externalOrderId: '287298498', orderNumber: '23-14636-63505', storeId: 356678 },
  { externalOrderId: '287241662', orderNumber: '200014491676217', storeId: 376661 },
  { externalOrderId: '287226234', orderNumber: '200014583978848', storeId: 376661 },
  { externalOrderId: '999', orderNumber: 'fresh-label', storeId: 111 },
  { externalOrderId: '1000', orderNumber: 'missing-local-row', storeId: 378060 },
];

const findings = classifyShipStationAwaitingParity(
  [
    {
      id: 1034347,
      orderNumber: '200014602719051',
      externalOrderId: '286930703',
      storeId: 376661,
      currentStatus: 'awaiting_shipment',
      duplicateTerminalStatus: 'shipped',
    },
    {
      id: 1041024,
      orderNumber: '1001',
      externalOrderId: '286991416',
      storeId: 378060,
      currentStatus: 'shipped',
      rawStatus: 'awaiting_shipment',
      externallyShipped: false,
      hasNonVoidedShipment: false,
      latestShipmentVoided: true,
      minutesSinceTerminal: 60,
    },
    {
      id: 969779,
      orderNumber: '12-14640-05489',
      externalOrderId: '286551428',
      storeId: 356678,
      currentStatus: 'awaiting_shipment',
    },
    {
      id: 1049000,
      orderNumber: 'fresh-label',
      externalOrderId: '999',
      storeId: 111,
      currentStatus: 'shipped',
      rawStatus: 'awaiting_shipment',
      externallyShipped: false,
      hasNonVoidedShipment: true,
      latestShipmentVoided: false,
      minutesSinceTerminal: 2,
    },
  ],
  liveAwaiting,
  { terminalToAwaitingGraceMinutes: 10 },
);

const byOrderNumber = new Map(findings.map((finding) => [finding.orderNumber, finding]));

const walmart = byOrderNumber.get('200014602719051');
assert.equal(walmart?.kind, 'awaiting_with_terminal_evidence');
assert.equal(walmart?.targetStatus, 'shipped');
assert.equal(shouldApplyShipStationAwaitingParityCandidate(walmart!), true);

const hugrab = byOrderNumber.get('1001');
assert.equal(hugrab?.kind, 'terminal_local_but_shipstation_awaiting');
assert.equal(hugrab?.targetStatus, 'awaiting_shipment');
assert.equal(hugrab?.eligibleWithOverride, true);
assert.equal(hugrab?.blockedByLockdown, true);
assert.equal(
  shouldApplyShipStationAwaitingParityCandidate(hugrab!),
  false,
  'terminal-to-awaiting correction must stay blocked without explicit shipped-data override',
);
assert.equal(
  shouldApplyShipStationAwaitingParityOverrideCandidate(hugrab!),
  true,
  'explicit override should allow the voided-label HUGRAB terminal-to-awaiting correction',
);

const ebay = byOrderNumber.get('12-14640-05489');
assert.equal(ebay?.kind, 'local_awaiting_missing_from_shipstation');
assert.equal(ebay?.targetStatus, null);
assert.equal(shouldApplyShipStationAwaitingParityCandidate(ebay!), false);

const freshLabel = byOrderNumber.get('fresh-label');
assert.equal(freshLabel?.kind, 'terminal_local_but_shipstation_awaiting');
assert.equal(freshLabel?.eligibleWithOverride, false);
assert.equal(shouldApplyShipStationAwaitingParityCandidate(freshLabel!), false);
assert.equal(shouldApplyShipStationAwaitingParityOverrideCandidate(freshLabel!), false);

const missingLocal = byOrderNumber.get('missing-local-row');
assert.equal(missingLocal?.id, null);
assert.equal(missingLocal?.kind, 'shipstation_awaiting_missing_from_prepship');
assert.equal(missingLocal?.targetStatus, null);
assert.equal(
  shouldApplyShipStationAwaitingParityCandidate(missingLocal!),
  false,
  'ShipStation-only awaiting rows must be reported but never auto-mutated',
);

const deletedCandidates = selectShipStationDeletedAwaitingCandidates(
  [
    {
      id: 1,
      externalOrderId: '302521806',
      orderStatus: 'awaiting_shipment',
      canonicalStatus: null,
      externallyShipped: false,
      sourceProvider: 'shipstation',
      hasActiveShipment: false,
    },
    {
      id: 2,
      externalOrderId: 'still-live',
      orderStatus: 'awaiting_shipment',
      canonicalStatus: null,
      externallyShipped: false,
      sourceProvider: 'shipstation',
      hasActiveShipment: false,
    },
    {
      id: 3,
      externalOrderId: '123',
      orderStatus: 'awaiting_shipment',
      canonicalStatus: null,
      externallyShipped: false,
      sourceProvider: 'shipstation',
      hasActiveShipment: true,
    },
    {
      id: 4,
      externalOrderId: '456',
      orderStatus: 'shipped',
      canonicalStatus: null,
      externallyShipped: false,
      sourceProvider: 'shipstation',
      hasActiveShipment: false,
    },
  ],
  new Set(['still-live']),
  5,
);
assert.deepEqual(
  deletedCandidates.map((row) => row.id),
  [1],
  'only numeric ShipStation awaiting rows absent from a complete live snapshot and without an active label are eligible for exact-id verification',
);

const pkg = readFileSync('package.json', 'utf8');
assert.match(pkg, /shipstation:awaiting:diff/);
assert.match(pkg, /shipstation:awaiting:reconcile/);
assert.match(pkg, /shipstation:awaiting:reconcile:apply/);

const script = readFileSync('scripts/reconcile-shipstation-awaiting.ts', 'utf8');
assert.match(script, /Dry run only/);
assert.match(script, /blocked by shipped\/cancelled lockdown/);
assert.match(script, /Only awaiting_shipment rows can be updated without the shipped-data override/);
assert.match(script, /allow-shipped-override/);
assert.match(script, /Per user override `unlock shipped data`/);
assert.match(script, /shipstation_awaiting_parity\.last_run/);
assert.match(script, /persistParityRunStatus/);
assert.match(script, /updatedSafe/);
assert.match(script, /updatedOverride/);
assert.match(script, /getShipStationOrderExistence/);
assert.doesNotMatch(script, /fetch\(`https:\/\/ssapi\.shipstation\.com\/orders\/\$\{/);

const connector = readFileSync('src/connectors/store/shipstation.ts', 'utf8');
assert.match(connector, /export async function getShipStationOrderExistence/);
assert.match(connector, /error instanceof ShipStationError && error\.status === 404/);

const v1Client = readFileSync('src/lib/shipstation/v1-client.ts', 'utf8');
assert.match(v1Client, /async function readErrorBody/);
assert.match(v1Client, /const text = await res\.text\(\)/);
assert.doesNotMatch(
  v1Client,
  /await res\.json\(\)[\s\S]{0,120}await res\.text\(\)/,
  'a non-JSON error body must be consumed once so an empty ShipStation 404 remains classifiable',
);

const deletedReconciliation = readFileSync(
  'src/services/shipstation-deleted-awaiting-reconciliation.ts',
  'utf8',
);
assert.match(deletedReconciliation, /MAX_VERIFIED_DELETIONS_PER_TARGET = 1/);
assert.match(deletedReconciliation, /getShipStationOrderExistence/);
assert.match(deletedReconciliation, /eq\(orders\.orderStatus, 'awaiting_shipment'\)/);
assert.match(deletedReconciliation, /noActiveShipment/);
assert.match(deletedReconciliation, /orderStatus: 'cancelled'/);
assert.match(
  deletedReconciliation,
  /Per user override unlock shipped data on 2026-07-14/,
);

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
assert.match(orderSync, /reconcileDeletedShipStationAwaiting/);
assert.match(
  orderSync,
  /target\.storeId !== undefined\s*&&\s*result\.complete\s*&&\s*result\.startPage === 1/,
  'deleted-order verification must run only after a complete page-1-started awaiting snapshot for a known store',
);

const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
assert.match(ordersRoute, /visibleAwaitingOrdersPredicate/);
assert.doesNotMatch(ordersRoute, /walmartDirectDuplicateSuppressionPredicate/);
assert.match(ordersRoute, /external_order_id.+ebay-%/s);
assert.doesNotMatch(ordersRoute, /real_marketplace_order/s);

const initRoute = readFileSync('src/routes/init.ts', 'utf8');
assert.match(initRoute, /visibleAwaitingOrdersPredicate/);
assert.doesNotMatch(initRoute, /walmartDirectDuplicateSuppressionPredicate/);
assert.match(initRoute, /external_order_id.+ebay-%/s);
assert.doesNotMatch(initRoute, /real_marketplace_order/s);

const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');
assert.match(
  shipmentSync,
  /values\.voided === false[\s\S]+values\.isReturn === false[\s\S]+shippedOrderIds\.push/,
  'shipment sync must not mark orders shipped from voided or return shipments',
);
assert.match(shipmentSync, /Per user override `unlock shipped data`/);
assert.match(
  shipmentSync,
  /prepshipOrderIds\.has\(ord\.id\)[\s\S]+Boolean\(s\.voided\) === false[\s\S]+Boolean\(s\.isReturnLabel\) === false[\s\S]+shippedOrderIds\.push\(ord\.id\)[\s\S]+continue;/,
  'PrepShip-duplicate shipment rows must promote only active outbound awaiting labels before skipping insertion',
);

console.log('ShipStation awaiting parity guard passed');
