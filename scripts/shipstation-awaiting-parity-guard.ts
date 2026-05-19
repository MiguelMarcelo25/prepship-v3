import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyShipStationAwaitingParity,
  shouldApplyShipStationAwaitingParityCandidate,
} from '../api/_lib/shipstation-awaiting-parity.ts';

const liveAwaiting = [
  { externalOrderId: '286991416', orderNumber: '1001', storeId: 378060 },
  { externalOrderId: '287298498', orderNumber: '23-14636-63505', storeId: 356678 },
  { externalOrderId: '287241662', orderNumber: '200014491676217', storeId: 376661 },
  { externalOrderId: '287226234', orderNumber: '200014583978848', storeId: 376661 },
  { externalOrderId: '999', orderNumber: 'fresh-label', storeId: 111 },
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

const ebay = byOrderNumber.get('12-14640-05489');
assert.equal(ebay?.kind, 'local_awaiting_missing_from_shipstation');
assert.equal(ebay?.targetStatus, null);
assert.equal(shouldApplyShipStationAwaitingParityCandidate(ebay!), false);

const freshLabel = byOrderNumber.get('fresh-label');
assert.equal(freshLabel?.kind, 'terminal_local_but_shipstation_awaiting');
assert.equal(freshLabel?.eligibleWithOverride, false);
assert.equal(shouldApplyShipStationAwaitingParityCandidate(freshLabel!), false);

const pkg = readFileSync('package.json', 'utf8');
assert.match(pkg, /shipstation:awaiting:diff/);
assert.match(pkg, /shipstation:awaiting:reconcile/);
assert.match(pkg, /shipstation:awaiting:reconcile:apply/);

const script = readFileSync('scripts/reconcile-shipstation-awaiting.ts', 'utf8');
assert.match(script, /Dry run only/);
assert.match(script, /blocked by shipped\/cancelled lockdown/);
assert.match(script, /Only awaiting_shipment rows can be updated without the shipped-data override/);

console.log('ShipStation awaiting parity guard passed');
