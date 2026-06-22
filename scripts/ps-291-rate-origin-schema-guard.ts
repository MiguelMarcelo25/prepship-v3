/**
 * PS-291 backend selected-origin schema guard.
 *
 * Proves the /rates/browse backend boundary accepts manual-order selected
 * origin fields and normalizes them into the canonical ShipStation Address
 * shape before rate quoting. Offline/static + pure helper only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { normalizeRateShipFromOrigin } from '../src/services/shipping-workflow/rate-ship-from-origin';

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

const ratesRoute = read('src/routes/rates.ts');
const helperSrc = read('src/services/shipping-workflow/rate-ship-from-origin.ts');
const helperRuntimeSrc = helperSrc.replace(/import type[^;]+;\s*/g, '');
const sharedApi = read('web/src/lib/v2-apiClient/shared.ts');
const modalSrc = read('web/src/components/NewOrderModal.tsx');
const statusDoc = read('docs/ps-tickets/ps-291-manual-order-preview-status.md');
const closeoutGuard = read('scripts/ps-291-manual-order-preview-closeout-guard.ts');
const packageJson = read('package.json');

const fromZipOnly = normalizeRateShipFromOrigin({
  weightOz: 16,
  fromZip: ' 90248 ',
  toZip: '19422',
});
check('fromZip-only request becomes canonical shipFrom postal code',
  fromZipOnly.shipFrom?.postal_code === '90248' &&
    fromZipOnly.shipFrom.country_code === 'US');

const camelShipFrom = normalizeRateShipFromOrigin({
  weightOz: 16,
  fromZip: '90001',
  shipFrom: {
    name: ' GWH ',
    company: ' DR Prepper ',
    street1: ' 123 Warehouse Ave ',
    street2: ' Suite 2 ',
    city: ' Gardena ',
    state: ' ca ',
    postalCode: ' 90249 ',
    country: ' us ',
    phone: ' 5551234567 ',
  },
  toZip: '19422',
});
check('camelCase selected origin normalizes to ShipStation Address shape',
  camelShipFrom.shipFrom?.name === 'GWH' &&
    camelShipFrom.shipFrom.company_name === 'DR Prepper' &&
    camelShipFrom.shipFrom.address_line1 === '123 Warehouse Ave' &&
    camelShipFrom.shipFrom.address_line2 === 'Suite 2' &&
    camelShipFrom.shipFrom.city_locality === 'Gardena' &&
    camelShipFrom.shipFrom.state_province === 'ca' &&
    camelShipFrom.shipFrom.postal_code === '90249' &&
    camelShipFrom.shipFrom.country_code === 'US' &&
    camelShipFrom.shipFrom.phone === '5551234567',
  camelShipFrom.shipFrom);

const snakeShipFrom = normalizeRateShipFromOrigin({
  weightOz: 16,
  shipFrom: {
    address_line1: '3820 Scadlock Ln',
    city_locality: 'Sherman Oaks',
    state_province: 'CA',
    postal_code: '91403',
    country_code: 'US',
    address_residential_indicator: 'no',
  },
  toZip: '19422',
});
check('existing canonical shipFrom remains canonical',
  snakeShipFrom.shipFrom?.address_line1 === '3820 Scadlock Ln' &&
    snakeShipFrom.shipFrom.postal_code === '91403' &&
    snakeShipFrom.shipFrom.address_residential_indicator === 'no');

const noOrigin = normalizeRateShipFromOrigin({ weightOz: 16, toZip: '19422' });
check('request without selected origin leaves shipFrom absent',
  !('shipFrom' in noOrigin));
const emptyShipFrom = normalizeRateShipFromOrigin({ weightOz: 16, shipFrom: {}, toZip: '19422' });
check('empty shipFrom without postal code does not override the default origin',
  !('shipFrom' in emptyShipFrom));

check('rates route schema accepts fromZip and shipFrom instead of stripping them',
  /fromZip:\s*z\.string\(\)\.min\(3\)\.optional\(\)/.test(ratesRoute) &&
    /shipFrom:\s*z\.object\(\{\}\)\.catchall\(z\.unknown\(\)\)\.optional\(\)/.test(ratesRoute));
check('rates route normalizes selected origin for both /rates and /rates/browse',
  (ratesRoute.match(/normalizeRateShipFromOrigin\(c\.req\.valid\('json'\)\)/g) ?? []).length >= 2);
check('rate origin helper is pure and provider/network free',
  /export function normalizeRateShipFromOrigin/.test(helperSrc) &&
    !/from ['"].*(db|schema|routes|connectors|shipstation|shipp|easypost|walmart|marketplace|print-queue)/i.test(helperRuntimeSrc) &&
    !/fetch\(|\.insert\(|\.update\(|\.delete\(/.test(helperRuntimeSrc));
check('frontend API translator preserves selected origin fields',
  /out\.fromZip\s*=\s*fromPostalCode\.trim\(\)/.test(sharedApi) &&
    /if \(input\.shipFrom && typeof input\.shipFrom === 'object'\) out\.shipFrom = input\.shipFrom/.test(sharedApi));
check('NewOrderModal still sends selected origin to rate preview',
  /fromPostalCode:\s*shipFromOrigin\.postalCode/.test(modalSrc) &&
    /shipFrom:\s*\{[\s\S]*postalCode:\s*shipFromOrigin\.postalCode/.test(modalSrc));
check('status and closeout evidence include the backend origin schema guard',
  statusDoc.includes('`test:ps-291-rate-origin-schema`') &&
    closeoutGuard.includes('test:ps-291-rate-origin-schema'));
check('package wires PS-291 backend origin schema guard',
  /"test:ps-291-rate-origin-schema"\s*:\s*"tsx scripts\/ps-291-rate-origin-schema-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL PS-291 backend selected-origin schema guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-291 backend selected-origin schema guard');
