/**
 * PS-406 boundary guard for the read-only ShipStation duplicate-label audit.
 * Offline only: no HTTP, database connection, postage, provider mutation, or PII output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  auditShipStationDuplicateLabels,
  normalizeShipStationAuditLabel,
  type ShipStationAuditLabel,
  type ShipStationLocalLabelEvidence,
} from '../src/services/shipstation-duplicate-label-audit';

const AS_OF = new Date('2026-07-10T12:00:00.000Z');

function label(
  id: string,
  overrides: Partial<ShipStationAuditLabel> = {},
): ShipStationAuditLabel {
  return {
    labelId: id,
    shipmentId: `shipment-${id}`,
    externalOrderId: 'order-1001',
    trackingNumber: `tracking-${id}`,
    createdAt: '2026-07-10T11:45:00.000Z',
    shipDate: '2026-07-10T00:00:00.000Z',
    carrierId: 'se-100',
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    shipmentCost: 12.5,
    insuranceCost: 0,
    voided: false,
    voidedAt: null,
    refundStatus: null,
    chargeEvent: 'label_creation',
    labelDownloadPresent: true,
    packageCount: 1,
    totalWeightOz: 16,
    dimensions: { length: 10, width: 8, height: 4 },
    isReturnLabel: false,
    recipient: {
      name: 'Private Customer',
      city: 'Gardena',
      state: 'CA',
      postalCode: '90247',
      countryCode: 'US',
    },
    tracking: { statusCode: 'NY', statusDescription: 'Not Yet In System', eventCount: 0 },
    ...overrides,
  };
}

function local(overrides: Partial<ShipStationLocalLabelEvidence> = {}): ShipStationLocalLabelEvidence {
  return {
    localShipmentId: 41,
    orderId: 101,
    orderNumber: '1001',
    externalOrderId: 'order-1001',
    sourceOrderId: null,
    sourceOrderNumber: '1001',
    clientId: 4,
    clientName: 'HUGRAB',
    providerLabelId: null,
    labelShipmentId: null,
    trackingNumber: null,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    weightOz: 16,
    dimensions: { length: 10, width: 8, height: 4 },
    recipient: {
      name: 'Private Customer',
      city: 'Gardena',
      state: 'CA',
      postalCode: '90247',
      countryCode: 'US',
    },
    ...overrides,
  };
}

function audit(labels: ShipStationAuditLabel[], evidence = [local()]) {
  return auditShipStationDuplicateLabels({
    labels,
    localEvidence: evidence,
    asOf: AS_OF,
    duplicateWindowMinutes: 60,
  });
}

{
  const normalized = normalizeShipStationAuditLabel({
    label_id: 'se-normalized',
    shipment_id: 'se-shipment-normalized',
    external_order_id: 'normalized-order',
    tracking_number: 'normalized-tracking',
    created_at: '2026-07-10T11:45:00.000Z',
    carrier_id: 'se-carrier',
    carrier_code: 'usps',
    service_code: 'usps_ground_advantage',
    shipment_cost: { amount: 8.25, currency: 'usd' },
    insurance_cost: { amount: 1.5, currency: 'usd' },
    label_download: { pdf: 'https://example.test/label.pdf' },
    packages: [{
      weight: { value: 2, unit: 'pound' },
      dimensions: { length: 12, width: 9, height: 4, unit: 'inch' },
    }],
    ship_to: {
      name: 'Normalized Private Customer',
      city_locality: 'Gardena',
      state_province: 'CA',
      postal_code: '90247',
      country_code: 'US',
    },
  }, { status_code: 'NY', status_description: 'Not Yet In System', events: [] });
  assert.equal(normalized?.shipmentCost, 8.25);
  assert.equal(normalized?.insuranceCost, 1.5);
  assert.equal(normalized?.labelDownloadPresent, true);
  assert.equal(normalized?.totalWeightOz, 32);
  assert.deepEqual(normalized?.dimensions, { length: 12, width: 9, height: 4 });
  assert.equal(normalized?.tracking?.statusCode, 'NY');
}

{
  const report = audit([
    label('used', { tracking: { statusCode: 'DE', statusDescription: 'Delivered', eventCount: 4 } }),
    label('unused'),
  ]);
  assert.equal(report.groups[0]?.classification, 'HIGH_CONFIDENCE');
  assert.equal(report.groups[0]?.labels.find((row) => row.labelId === 'used')?.action, 'KEEP_USED');
  assert.equal(
    report.groups[0]?.labels.find((row) => row.labelId === 'unused')?.action,
    'VOID_CANDIDATE_DJ_REVIEW',
  );
}

{
  const report = audit([
    label('shipstation-only-a', { externalOrderId: 'unmatched-order' }),
    label('shipstation-only-b', { externalOrderId: 'unmatched-order' }),
  ], []);
  assert.equal(report.groups[0]?.classification, 'SHIPSTATION_ONLY_DUPLICATE_CANDIDATE');
}

{
  const report = audit([label('unscanned-a'), label('unscanned-b')]);
  assert.ok(report.groups[0]?.labels.every((row) => row.action === 'REVIEW_ALL_UNSCANNED'));
}

{
  const report = audit([
    label('multi-used', {
      packageCount: 2,
      tracking: { statusCode: 'DE', statusDescription: 'Delivered', eventCount: 3 },
    }),
    label('multi-review', { packageCount: 2 }),
  ]);
  assert.equal(
    report.groups[0]?.labels.find((row) => row.labelId === 'multi-review')?.action,
    'REVIEW_MULTI_PACKAGE_OR_REPLACEMENT',
  );
}

{
  const report = audit([
    label('used', { tracking: { statusCode: 'AC', statusDescription: 'Accepted', eventCount: 1 } }),
    label('voided', { voided: true, voidedAt: '2026-07-10T11:50:00.000Z' }),
  ]);
  assert.equal(
    report.groups[0]?.labels.find((row) => row.labelId === 'voided')?.action,
    'IGNORE_ALREADY_VOIDED',
  );
}

{
  const report = audit([
    label('used', { tracking: { statusCode: 'IT', statusDescription: 'In Transit', eventCount: 2 } }),
    label('post-billed', { chargeEvent: 'carrier_pickup' }),
  ]);
  assert.equal(
    report.groups[0]?.labels.find((row) => row.labelId === 'post-billed')?.action,
    'POST_BILLED_REPORTING_ONLY',
  );
}

{
  const report = audit([
    label('usps-used', {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      tracking: { statusCode: 'DE', statusDescription: 'Delivered', eventCount: 4 },
    }),
    label('refund-assist', {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      refundStatus: 'request_scheduled',
    }),
  ], [local({ carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage' })]);
  const candidate = report.groups[0]?.labels.find((row) => row.labelId === 'refund-assist');
  assert.equal(candidate?.action, 'WAIT_REFUND_ASSIST');
  assert.equal(candidate?.withinUsps28DayWindow, true);
  assert.equal(candidate?.manualVoidWouldDisqualifyRefundAssist, true);
}

{
  const report = audit([
    label('scanned-a', { tracking: { statusCode: 'AC', statusDescription: 'Accepted', eventCount: 1 } }),
    label('scanned-b', { tracking: { statusCode: 'IT', statusDescription: 'In Transit', eventCount: 2 } }),
  ]);
  assert.ok(
    report.groups[0]?.labels.every(
      (row) => row.action === 'KEEP_USED' || row.action === 'DO_NOT_VOID_SCANNED',
    ),
    'scanned labels must never be refund/void candidates',
  );
}

{
  const report = audit([label('redacted-a'), label('redacted-b')]);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('Private Customer'));
  assert.ok(!serialized.includes('90247'));
  assert.match(report.groups[0]?.labels[0]?.redactedRecipient ?? '', /^P\*\*\* \/ \*\*\*\d{2} \/ CA$/);
}

const source = readFileSync('src/lib/shipstation/duplicate-label-audit-source.ts', 'utf8');
const cli = readFileSync('scripts/audit-shipstation-duplicate-labels.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

assert.ok(source.includes("label_status', status") && source.includes("page_size', '500'"));
assert.ok(source.includes('/track'));
assert.ok(!/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/.test(source));
assert.ok(!/\/void\b|cancel_refund|request_refund/.test(source));
assert.ok(!/\.(?:insert|update|delete)\s*\(/.test(cli));
assert.ok(cli.includes("arg === '--apply'") && cli.includes('has no mutation mode'));
assert.ok(!/willApply|confirm-production|function\s+apply/i.test(cli));
assert.ok(pkg.includes('"audit:shipstation-duplicate-labels"'));
assert.ok(pkg.includes('"test:ps-406-duplicate-label-audit"'));

console.log('PASS ps-406 read-only duplicate label audit guard');
