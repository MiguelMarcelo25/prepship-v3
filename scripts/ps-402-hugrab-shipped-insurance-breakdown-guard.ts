/**
 * PS-402 guard - HUGRAB shipped selected-rate rows preserve and display the
 * insurance cost breakdown from backend DTO truth.
 *
 * Pins three boundaries:
 *   1. normalizeOrderSelectedRateDto preserves billed insurance cost/provenance,
 *      total, and backend-owned HUGRAB coverage status.
 *   2. GET /orders normalizes shipments.selected_rate_json through that owner
 *      with a HUGRAB context instead of spreading persisted JSON raw.
 *   3. The shipped "Selected Rate" cell renders the backend insurance add-on
 *      and coverage badge, without recomputing insurance truth in the frontend.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { normalizeOrderSelectedRateDto } from '../src/services/order-rate-dto';

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
  return readFileSync(path, 'utf8');
}

const shippedHugrabSelectedRate = normalizeOrderSelectedRateDto(
  {
    providerAccountId: 433542,
    shippingProviderId: 433542,
    providerAccountNickname: 'USPS Chase x7439',
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    serviceName: 'USPS Ground Advantage',
    shipmentCost: 6.67,
    otherCost: 1.09,
    totalCost: 7.76,
    insuranceProvider: 'parcelguard',
    insuredValue: 100,
    insuranceCost: 1.09,
    insuranceProvenance: 'shipstation_v2_label',
  },
  undefined,
  'ps402.selectedRate',
  { isHugrab: true },
);

assert.ok(shippedHugrabSelectedRate, 'selected-rate DTO should normalize');
check('selected-rate DTO keeps postage-only shipment cost',
  shippedHugrabSelectedRate.shipmentCost === 6.67,
  shippedHugrabSelectedRate);
check('selected-rate DTO keeps insurance add-on separate',
  shippedHugrabSelectedRate.insuranceCost === 1.09 && shippedHugrabSelectedRate.otherCost === 1.09,
  shippedHugrabSelectedRate);
check('selected-rate DTO keeps billed total including insurance',
  shippedHugrabSelectedRate.totalCost === 7.76,
  shippedHugrabSelectedRate);
check('selected-rate DTO preserves insurance provenance',
  shippedHugrabSelectedRate.insuranceProvenance === 'shipstation_v2_label',
  shippedHugrabSelectedRate);
check('selected-rate DTO stamps HUGRAB coverage included from backend owner',
  shippedHugrabSelectedRate.insuranceCoverageStatus === 'included' &&
    shippedHugrabSelectedRate.insuranceBadgeLabel === '$100 INS. INCL.',
  shippedHugrabSelectedRate);

const ordersRoute = read('src/routes/orders.ts');
check('orders route imports the HUGRAB context owner',
  /\bisHugrabShippingContext\b/.test(ordersRoute));
check('orders route computes rowIsHugrab before selected-rate normalization',
  /const\s+rowIsHugrab\s*=\s*isHugrabShippingContext\(/.test(ordersRoute));
check('shipments.selected_rate_json branch delegates to normalizeOrderSelectedRateDto',
  /selectedRateJsonRecord\s*\?\s*normalizeOrderSelectedRateDto\(/.test(ordersRoute));
check('selected_rate_json normalization receives HUGRAB context',
  /normalizeOrderSelectedRateDto\([\s\S]{0,1400}isHugrab:\s*rowIsHugrab/.test(ordersRoute));
check('selected_rate_json normalization keeps persisted insurance fields in the DTO path',
  /normalizeOrderSelectedRateDto\([\s\S]{0,900}insuranceCost\/provenance\/total[\s\S]{0,500}\.\.\.selectedRateJsonRecord/i.test(ordersRoute));

const orderCells = read('web/src/components/Views/orders/cells/order-cells.tsx');
check('shipped Selected Rate cell renders backend row-money insurance add-on',
  /shippedBackendMoney\.insuranceAddOn/.test(orderCells) &&
    /renderRateAmountWithMarkup\([\s\S]{0,220}shippedBackendMoney\.insuranceAddOn/.test(orderCells));
check('shipped Selected Rate fallback renders selectedRate insurance add-on',
  /getBackendInsuranceAddOn\(displayOrder\.selectedRate\)/.test(orderCells));
check('shipped Selected Rate cell renders backend coverage badge from selectedRate DTO',
  /getRowInsuranceCoverage\(displayOrder\.selectedRate\)/.test(orderCells));
check('frontend cells do not call the HUGRAB coverage resolver',
  !/resolveInsuranceCoverageStatus\s*\(/.test(orderCells));

const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
check('money renderer displays a separate Insurance add-on line',
  /Insurance\s+\{formatMoney\(insuranceAddOn\)\}/.test(rowDisplay));
check('money renderer renders backend insurance coverage badge',
  /renderInsuranceCoverageBadge\(coverage\)/.test(rowDisplay));

const pkg = read('package.json');
check('package.json wires the PS-402 guard',
  pkg.includes('"test:ps-402-hugrab-shipped-insurance-breakdown": "tsx scripts/ps-402-hugrab-shipped-insurance-breakdown-guard.ts"'));

if (failures > 0) {
  console.error(`\nFAIL PS-402 HUGRAB shipped insurance breakdown guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-402 HUGRAB shipped insurance breakdown guard');
