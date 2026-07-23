/**
 * PS-399 guard — ShipStation void must address labels by label_id and expose
 * provider failure detail.
 *
 * Offline only: no HTTP, no DB writes, no postage, no live voids.
 *
 *   npx tsx scripts/ps-399-shipstation-void-label-id-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveLabelVoidDispatch,
  type LabelVoidRowFacts,
} from '../src/services/label-void-policy';

const row = (overrides: Partial<LabelVoidRowFacts> = {}): LabelVoidRowFacts => ({
  source: 'prepship_v2',
  labelShipmentId: 300875110,
  voided: false,
  trackingNumber: '9434650206217246635711',
  providerLabelId: 'se-161791532',
  clientIsTest: false,
  ...overrides,
});

assert.deepEqual(
  resolveLabelVoidDispatch(row()),
  {
    kind: 'provider',
    provider: 'shipstation',
    voidKey: 'se-161791532',
    voidKeySource: 'provider_label_id',
  },
  'ShipStation void must prefer selectedRateJson.providerLabelId / label_id over labelShipmentId',
);

{
  const dispatch = resolveLabelVoidDispatch(row({ providerLabelId: null }));
  assert.equal(dispatch.kind, 'not_voidable', 'ShipStation rows missing label_id must not void by shipment id');
  assert.match(
    (dispatch as { reason: string }).reason,
    /label id/i,
    'missing-label-id reason should tell the operator what is missing',
  );
}

assert.deepEqual(
  resolveLabelVoidDispatch(row({ source: 'shipp', providerLabelId: 'shp_label_8842' })),
  { kind: 'provider', provider: 'shipp', voidKey: 'shp_label_8842', voidKeySource: 'provider_label_id' },
  'direct provider void routing must still use the owning provider label id',
);

assert.deepEqual(
  resolveLabelVoidDispatch(row({ source: 'walmart_shipping', providerLabelId: null })),
  {
    kind: 'provider',
    provider: 'walmart_shipping',
    voidKey: '9434650206217246635711',
    voidKeySource: 'tracking_number',
  },
  'direct provider legacy fallback to tracking number must remain unchanged',
);

const ssConnector = readFileSync('src/connectors/carrier/shipstation.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const labelsSvc = readFileSync('src/services/labels.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

assert.ok(
  /ssVoidLabel/.test(ssConnector) && /await ssVoidLabel\(\s*raw,[\s\S]*input\.signal/.test(ssConnector),
  'ShipStation connector must void provider label ids through ssVoidLabel(label_id)',
);
assert.ok(
  !/await ssVoidShipment\(/.test(ssConnector),
  'ShipStation connector must not use the shipment void endpoint for label voids',
);
assert.ok(
  /function sanitizeProviderVoidError\(/.test(labelsSvc),
  'voidLabelV2 must sanitize provider failure detail before returning it',
);
assert.ok(
  /code:\s*'LABEL_VOID_PROVIDER_FAILED'/.test(labelsRoute) &&
    /error:\s*result\.message/.test(labelsRoute),
  'provider_failed route response must expose sanitized detail in error/code fields for ApiRequestError',
);
assert.ok(
  /status === 502[\s\S]{0,300}error instanceof Error \? error\.message/.test(ordersView),
  'Void Label UI must surface the sanitized backend provider failure message on 502',
);
assert.ok(
  pkg.includes('"test:ps-399-shipstation-void-label-id"'),
  'package.json must wire the PS-399 guard',
);

console.log('PASS ps-399 shipstation void label_id guard');
