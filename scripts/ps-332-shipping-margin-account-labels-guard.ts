/**
 * PS-332 - shipping-margin account display labels.
 *
 * Offline guard only: no DB, no providers, no labels/postage, no queue jobs,
 * no billing regeneration, and no production shipment/order mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildShippingMarginAnalytics,
  buildShippingMarginRow,
  type ShippingMarginInputRow,
} from '../src/services/shipping-margin-analytics';
import { resolveShippingMarginAccountLabels } from '../src/services/shipping-margin-account-labels';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function row(overrides: Partial<ShippingMarginInputRow> = {}): ShippingMarginInputRow {
  return {
    clientId: 4,
    clientName: 'HUGRAB',
    shipmentId: 332001,
    orderId: 1900,
    orderNumber: 'PS-332-fixture',
    shipDate: '2026-06-26T00:00:00.000Z',
    shipmentCost: '8.00',
    shipmentLabelCost: null,
    shipmentOtherCost: '0.50',
    billingLineItemId: 9001,
    billingTotalCost: '12.00',
    projectedBillableAmount: null,
    projectedBillableSource: null,
    houseCustomerRate: null,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    trackingNumber: '1ZORION1234567890',
    providerAccountId: 607855,
    providerAccountNickname: null,
    ...overrides,
  } as ShippingMarginInputRow;
}

const shipmentNickname = buildShippingMarginRow(row({
  providerAccountId: 607857,
  providerAccountNickname: 'ROCEL C81F70',
}));
check('row with stored shipment nickname exposes accountDisplayName from backend row owner',
  (shipmentNickname as any).accountDisplayName === 'ROCEL C81F70' &&
  (shipmentNickname as any).accountDisplaySource === 'shipment_nickname',
  shipmentNickname);

const resolverNickname = buildShippingMarginRow(row({
  providerAccountNickname: null,
  ...( { resolvedProviderAccountNickname: 'UPS Direct / GG6381' } as any),
}));
check('row with providerAccountId but missing nickname can consume backend-resolved safe label',
  (resolverNickname as any).accountDisplayName === 'UPS Direct / GG6381' &&
  (resolverNickname as any).accountDisplaySource === 'carrier_resolver',
  resolverNickname);

const liveStyleResolvedRows = await resolveShippingMarginAccountLabels([
  row({
    providerAccountId: 596001,
    providerAccountNickname: null,
    resolvedProviderAccountNickname: null,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    trackingNumber: '1ZR05H19YW39876873',
  }),
], async (providerAccountId, carrierCode, trackingNumber, clientId) => {
  return providerAccountId === 596001 &&
    carrierCode === 'ups' &&
    trackingNumber === '1ZR05H19YW39876873' &&
    clientId === 4
    ? 'ORION'
    : null;
});
const liveStyleResolvedRow = buildShippingMarginRow(liveStyleResolvedRows[0]!);
check('live-style row with known providerAccountId and missing persisted nickname resolves through backend account resolver',
  liveStyleResolvedRow.accountDisplayName === 'ORION' &&
  liveStyleResolvedRow.accountDisplaySource === 'carrier_resolver',
  liveStyleResolvedRow);

const shippBrokered = buildShippingMarginRow(row({
  providerAccountId: 10000025,
  providerAccountNickname: null,
  serviceCode: 'shipp_ups_ground',
}));
check('Shipp-brokered row gets safe Shipp display label without raw provider id',
  (shippBrokered as any).accountDisplayName === 'Shipp' &&
  (shippBrokered as any).accountDisplaySource === 'shipp_policy' &&
  !String((shippBrokered as any).accountDisplayName).includes('10000025'),
  shippBrokered);

const unresolvedWithProvider = buildShippingMarginRow(row({
  providerAccountId: 607855,
  providerAccountNickname: null,
}));
check('providerAccountId without any resolvable label is explicit Unresolved account, never blank or raw id',
  (unresolvedWithProvider as any).accountDisplayName === 'Unresolved account' &&
  (unresolvedWithProvider as any).accountDisplaySource === 'unknown' &&
  !String((unresolvedWithProvider as any).accountDisplayName).includes('607855'),
  unresolvedWithProvider);

const unknownNoProvider = buildShippingMarginRow(row({
  carrierCode: null,
  serviceCode: null,
  providerAccountId: null,
  providerAccountNickname: null,
}));
check('row without account identity is explicit Unknown account, not a dash',
  (unknownNoProvider as any).accountDisplayName === 'Unknown account' &&
  (unknownNoProvider as any).accountDisplaySource === 'unknown',
  unknownNoProvider);

const grouped = buildShippingMarginAnalytics([
  shipmentNickname,
  buildShippingMarginRow(row({
    shipmentId: 332002,
    providerAccountId: 607855,
    providerAccountNickname: null,
    ...( { resolvedProviderAccountNickname: 'UPS Direct / GG6381' } as any),
  })),
  buildShippingMarginRow(row({
    shipmentId: 332003,
    providerAccountId: 607856,
    providerAccountNickname: null,
    ...( { resolvedProviderAccountNickname: 'UPS Direct / ORION' } as any),
  })),
], { dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-07-01T00:00:00.000Z' });
const carrierLabels = grouped.carriers.map((carrier) => (carrier as any).accountDisplayName);
check('carrier rollups expose distinct backend accountDisplayName values for duplicate carrier/service accounts',
  carrierLabels.includes('ROCEL C81F70') &&
  carrierLabels.includes('UPS Direct / GG6381') &&
  carrierLabels.includes('UPS Direct / ORION') &&
  new Set(carrierLabels).size === 3,
  grouped.carriers);
check('PS-332 account labels do not change PS-296 shipping-margin totals',
  grouped.summary.actualShippingTotal === 25.5 &&
  grouped.summary.billableShippingTotal === 36 &&
  grouped.summary.marginTotal === 10.5 &&
  grouped.summary.marginRowCount === 3,
  grouped.summary);

const serviceSrc = read('src/services/shipping-margin-analytics.ts');
const tableSrc = read('web/src/components/Views/BillingCarrierMarginTable.tsx');
const packageJson = read('package.json');

check('backend owner defines accountDisplayName/accountDisplaySource on row and carrier DTOs',
  serviceSrc.includes('accountDisplayName') &&
  serviceSrc.includes('accountDisplaySource') &&
  serviceSrc.includes('resolvedProviderAccountNickname'));
check('shipping-margin read query resolves account labels read-time without writing shipments',
  /resolvedProviderAccountNickname/.test(serviceSrc) &&
  /resolveShippingMarginAccountLabels/.test(serviceSrc) &&
  !/\.insert\(|\.update\(|\.delete\(/.test(serviceSrc));
check('shared Dashboard/Billing table renders backend accountDisplayName before legacy nickname',
  /accountDisplayName/.test(tableSrc) &&
  /row\.accountDisplayName/.test(tableSrc) &&
  tableSrc.indexOf('row.accountDisplayName') < tableSrc.indexOf('row.providerAccountNickname'));
check('shared table does not display raw providerAccountId as the Account label',
  !/providerAccountId[^;]*(?:Account|account)/.test(tableSrc));
check('package wires PS-332 focused guard',
  packageJson.includes('"test:ps-332-shipping-margin-account-labels"'));

if (failures > 0) {
  console.error(`\nFAIL PS-332 shipping-margin account labels guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-332 shipping-margin account labels guard');
