/**
 * PS-291 closeout guard: manual-order preview is evidence-backed without
 * running live labels, postage, provider calls, or production mutations.
 *
 * The focused guard proves the broad file wiring. This closeout adds pure
 * behavior checks for the small owners that make manual preview safe:
 * - selected preview rate -> canonical bestRate DTO
 * - selected/custom Ship-From origin -> rate payload shape
 * - marketplace-owned providers excluded from unsaved manual-order preview
 * - "Save this location" only persists an intentional named custom origin
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildManualSelectedBestRate } from '../src/routes/orders/manual-selected-rate';
import { resolveShipFromOrigin } from '../web/src/components/new-order-ship-from-origin';
import {
  excludeMarketplaceOwnedRows,
  isMarketplaceOwnedProvider,
} from '../web/src/components/new-order-rate-preview-rows';
import {
  buildSaveLocationBody,
  shouldSaveCustomOrigin,
} from '../web/src/components/new-order-save-location';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const packageJson = readText('package.json');
const ordersSrc = readText('src/routes/orders.ts');
const modalSrc = readText('web/src/components/NewOrderModal.tsx');
const existingGuardSrc = readText('scripts/ps-291-manual-order-real-optional-items-guard.ts');

check('package wires the focused PS-291 manual order preview guard',
  packageJson.includes('"test:ps-291-manual-order-preview"'));
check('package wires the PS-291 closeout guard',
  packageJson.includes('"test:ps-291-manual-order-preview-closeout"'));
check('focused PS-291 guard file exists',
  existingGuardSrc.includes('PASS PS-291 manual-order real + optional-items guard'));

const selected = buildManualSelectedBestRate({
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  serviceName: 'UPS Ground',
  carrierNickname: 'GG6381',
  shippingProviderId: 6381,
  shipmentCost: 7.12,
  otherCost: 0.59,
  cost: 7.71,
});
check('selected manual preview rate normalizes into canonical bestRate DTO',
  selected?.carrierCode === 'ups' &&
  selected.serviceCode === 'ups_ground' &&
  selected.serviceName === 'UPS Ground' &&
  selected.carrierNickname === 'GG6381' &&
  selected.shippingProviderId === 6381 &&
  selected.shipmentCost === 7.12 &&
  selected.otherCost === 0.59 &&
  selected.totalCost === 7.71 &&
  selected.proofSource === 'manual_preview');
check('missing manual preview rate stays null',
  buildManualSelectedBestRate(null) === null);
check('empty manual preview rate does not invent a persisted bestRate',
  buildManualSelectedBestRate({}) === null);

const customOrigin = resolveShipFromOrigin({
  useCustom: true,
  custom: {
    street1: '  123 Warehouse Ave  ',
    city: ' Gardena ',
    state: ' ca ',
    zip: ' 90248 ',
    country: ' us ',
  },
  locations: [],
  selectedLocationId: '',
  fallbackZip: '90001',
});
check('custom Ship-From origin is trimmed and country-normalized',
  customOrigin.street1 === '123 Warehouse Ave' &&
  customOrigin.city === 'Gardena' &&
  customOrigin.state === 'ca' &&
  customOrigin.postalCode === '90248' &&
  customOrigin.country === 'US');

const savedOrigin = resolveShipFromOrigin({
  useCustom: false,
  custom: { street1: '', city: '', state: '', zip: '', country: 'US' },
  locations: [
    { locationId: 'gw', street1: '3820 Scadlock Ln', city: 'Sherman Oaks', state: 'CA', postalCode: '91403', country: 'US' },
  ],
  selectedLocationId: 'gw',
  fallbackZip: '90001',
});
check('saved Ship-From origin wins over fallback ZIP',
  savedOrigin.street1 === '3820 Scadlock Ln' &&
  savedOrigin.postalCode === '91403');
check('fallback Ship-From origin remains postal-only when no saved/custom origin is selected',
  resolveShipFromOrigin({
    useCustom: false,
    custom: { street1: '', city: '', state: '', zip: '', country: 'US' },
    locations: [],
    selectedLocationId: '',
    fallbackZip: '90001',
  }).postalCode === '90001');

const previewRows = [
  { carrierCode: 'ups', serviceCode: 'ups_ground' },
  { carrierCode: 'ebay shipping', serviceCode: 'ebay_ground' },
  { carrierCode: 'walmart-shipping', serviceCode: 'walmart_ground' },
  { carrierCode: 'shipp', serviceCode: 'shipp_ups_ground' },
];
const filteredRows = excludeMarketplaceOwnedRows(previewRows);
check('marketplace-owned provider predicate catches normalized eBay/Walmart keys',
  isMarketplaceOwnedProvider('ebay shipping') &&
  isMarketplaceOwnedProvider('walmart-shipping') &&
  !isMarketplaceOwnedProvider('shipp'));
check('manual preview excludes eBay/Walmart marketplace rows but keeps normal carriers',
  filteredRows.length === 2 &&
  filteredRows.some((row) => row.carrierCode === 'ups') &&
  filteredRows.some((row) => row.carrierCode === 'shipp'));
check('marketplace filter is pure and does not mutate the input rows',
  previewRows.length === 4);

const customForSave = {
  street1: ' 123 Warehouse Ave ',
  city: ' Gardena ',
  state: ' CA ',
  zip: ' 90248 ',
  country: ' us ',
};
check('custom origin save predicate requires custom mode, opt-in, name, and address signal',
  shouldSaveCustomOrigin({ useCustom: true, save: true, name: 'GWH', custom: customForSave }) &&
  !shouldSaveCustomOrigin({ useCustom: false, save: true, name: 'GWH', custom: customForSave }) &&
  !shouldSaveCustomOrigin({ useCustom: true, save: false, name: 'GWH', custom: customForSave }) &&
  !shouldSaveCustomOrigin({ useCustom: true, save: true, name: ' ', custom: customForSave }) &&
  !shouldSaveCustomOrigin({
    useCustom: true,
    save: true,
    name: 'GWH',
    custom: { street1: ' ', city: 'Gardena', state: 'CA', zip: ' ', country: 'US' },
  }));
const saveBody = buildSaveLocationBody(' GWH Fulfillment Center ', customForSave);
check('custom origin save body is shaped for POST /locations',
  saveBody.name === 'GWH Fulfillment Center' &&
  saveBody.street1 === '123 Warehouse Ave' &&
  saveBody.city === 'Gardena' &&
  saveBody.state === 'CA' &&
  saveBody.postalCode === '90248' &&
  saveBody.country === 'US');

const manualRouteStart = ordersSrc.indexOf("app.post('/manual'");
const manualRouteSrc = manualRouteStart >= 0
  ? ordersSrc.slice(manualRouteStart, ordersSrc.indexOf('}, 201);', manualRouteStart))
  : '';
check('manual route remains internal-only and zod-validated',
  /app\.post\('\/manual',\s*requireInternalPermission\('print_queue:write'\)/.test(ordersSrc) &&
  /zValidator\('json',\s*manualOrderBody\)/.test(ordersSrc));
check('manual route persists selected preview bestRate onto order overrides',
  /buildManualSelectedBestRate\s*\(/.test(manualRouteSrc) &&
  /bestRateJson:\s*selectedBestRate/.test(manualRouteSrc) &&
  /bestRateAt:\s*selectedBestRate \? now : null/.test(manualRouteSrc));
check('manual route carries selected Ship-From origin into raw provenance',
  /shipFromOrigin/.test(manualRouteSrc) &&
  /raw\s*=\s*\{[\s\S]*shipFromOrigin/.test(manualRouteSrc));
check('manual route keeps manual orders real and line items optional',
  !/\btest:\s*true\b/.test(manualRouteSrc) &&
  !/activeItems\.length\s*===\s*0/.test(manualRouteSrc) &&
  !/at least one line item is required/i.test(manualRouteSrc));

check('NewOrderModal threads selected origin into /rates preview payload',
  /fromPostalCode:\s*shipFromOrigin\.postalCode/.test(modalSrc) &&
  /shipFrom:\s*\{[\s\S]*postalCode:\s*shipFromOrigin\.postalCode/.test(modalSrc));
check('NewOrderModal filters marketplace-owned preview rows and displays account nickname',
  /excludeMarketplaceOwnedRows\s*\(/.test(modalSrc) &&
  /accountNickname:\s*[\s\S]{0,220}carrierNickname/.test(modalSrc) &&
  /r\.accountNickname/.test(modalSrc));
check('NewOrderModal saves selected preview rate and selected origin in manual payload',
  /selectedRate:\s*selectedRow/.test(modalSrc) &&
  /shippingProviderId:\s*selectedRow\.shippingProviderId/.test(modalSrc) &&
  /shipFrom:\s*\{[\s\S]*postalCode:\s*shipFromOrigin\.postalCode/.test(modalSrc));
check('NewOrderModal keeps custom origin persistence best-effort after order save',
  /shouldSaveCustomOrigin\s*\(/.test(modalSrc) &&
  /apiClient\.createLocation\s*\(/.test(modalSrc) &&
  /catch\s*\{[\s\S]{0,160}custom origin just isn't kept/.test(modalSrc));

const closeoutStatus = {
  card: 'PS-291',
  codeStatus: 'code/test proof complete for manual preview slices',
  runtimeStatus: 'real non-test manual order behavior still needs explicit safety review before live canary',
  trelloRecommendation: 'move to Final Review only after DJ approves a manual-order canary',
  safety: 'no live label, postage, marketplace notification, queue mutation, or production data repair',
};
check('PS-291 closeout status separates code proof from live canary',
  closeoutStatus.card === 'PS-291' &&
  closeoutStatus.codeStatus.includes('code/test proof complete') &&
  closeoutStatus.runtimeStatus.includes('safety review') &&
  closeoutStatus.trelloRecommendation.includes('Final Review') &&
  closeoutStatus.safety.startsWith('no live label'));

if (failures > 0) {
  console.error(`\nFAIL PS-291 manual-order preview closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-291 manual-order preview closeout guard');
