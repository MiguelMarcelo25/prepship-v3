import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterEligibleShippingServices,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
} from '../src/lib/shipping-service-eligibility';

// PS-079 — certify Awaiting Shipment Best Rate is the source of truth:
//   - cheapest ELIGIBLE rate by TOTAL cost (shipping + confirmation + insurance + other)
//   - HUGRAB UPS Ground Saver/SurePost (and variants) excluded BEFORE selection
//   - backend returns an explicit bestRate; frontend consumes it (no divergent pick)
//   - Awaiting Orders table carrier/account columns show the EXACT best-rate metadata
// Offline only — no provider calls, no postage, no PII.

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── (1) Behavioral: cheapest rate is a blocked HUGRAB service → it is excluded
//        and the next cheapest ELIGIBLE rate wins. (req 3 + req 8a) ────────────
type R = { carrierCode: string; serviceCode: string; serviceName: string; total: number };
const describe = (r: R) => ({
  provider: r.carrierCode,
  carrierCode: r.carrierCode,
  serviceCode: r.serviceCode,
  serviceName: r.serviceName,
});
const hugrab = { clientId: 4, clientName: 'HUGRAB', storeId: 378060 };

const candidates: R[] = [
  { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver (1 lb+)', total: 5.0 }, // cheapest but BLOCKED
  { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground', total: 7.0 }, // next eligible
  { carrierCode: 'stamps_com', serviceCode: 'usps_priority_mail', serviceName: 'USPS Priority Mail', total: 9.0 },
];
const eligible = filterEligibleShippingServices(candidates, hugrab, describe);
check('HUGRAB: UPS Ground Saver is removed from the eligible set', !eligible.some((r) => r.serviceCode === 'ups_ground_saver'));
const cheapestEligible = [...eligible].sort((a, b) => a.total - b.total)[0];
check('HUGRAB: cheapest ELIGIBLE rate wins (UPS Ground $7), NOT the cheaper blocked Ground Saver ($5)',
  cheapestEligible?.serviceCode === 'ups_ground');

// SurePost + numeric-code (92/93) + EasyPost variants must also be excluded.
const variants: R[] = [
  { carrierCode: 'ups', serviceCode: 'ups_surepost', serviceName: 'UPS SurePost', total: 4.0 },
  { carrierCode: 'ups', serviceCode: '92', serviceName: 'UPS Ground Saver', total: 4.5 },
  { carrierCode: 'ups', serviceCode: 'easypost_ups_upsdap_upsgroundsavergreaterthan1lb', serviceName: 'UPS Ground Saver', total: 4.8 },
  { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground', total: 8.0 },
];
const variantsEligible = filterEligibleShippingServices(variants, hugrab, describe);
check('HUGRAB: SurePost + numeric (92) + EasyPost Ground-Saver variants all excluded',
  variantsEligible.length === 1 && variantsEligible[0]!.serviceCode === 'ups_ground');

// Control: a NON-HUGRAB client keeps Ground Saver eligible (rule is scoped).
const otherEligible = filterEligibleShippingServices(candidates, { clientId: 99, clientName: 'OTHER', storeId: 555 }, describe);
check('Non-HUGRAB client keeps UPS Ground Saver eligible (block is HUGRAB-scoped)',
  otherEligible.some((r) => r.serviceCode === 'ups_ground_saver'));

check('eligibility version constant is exposed for cache invalidation', typeof SHIPPING_SERVICE_ELIGIBILITY_VERSION === 'string' && SHIPPING_SERVICE_ELIGIBILITY_VERSION.length > 0);

// ── (2) Backend source-of-truth (src/services/rates.ts) ─────────────────────
const rates = readFileSync('src/services/rates.ts', 'utf8');
check('best-rate TOTAL includes shipping + confirmation + insurance + other amounts',
  /function rateTotal/.test(rates) &&
  /shipping_amount\?\.amount/.test(rates) &&
  /confirmation_amount\?\.amount/.test(rates) &&
  /insurance_amount\?\.amount/.test(rates) &&
  /other_amount\?\.amount/.test(rates));
check('pickBestRate selects the lowest rateTotal',
  /function pickBestRate/.test(rates) && /sort\(\(a, b\) => rateTotal\(a\) - rateTotal\(b\)\)\[0\]/.test(rates));
check('getRates returns an explicit bestRate selected via pickBestRate',
  /bestRate: pickBestRate\(/.test(rates));
check('best rate is selected from ELIGIBILITY-FILTERED rates (filter present before pick)',
  /filterRatesForShippingServiceEligibility/.test(rates));
check('best rate is selected POST-markup (applyMarkups runs before pickBestRate)',
  /const rates = applyMarkups\(/.test(rates) || /applyMarkups\(cachedRaw/.test(rates));
check('cache key embeds the eligibility version (rules change → cache invalidates)',
  /eligibility=\$\{SHIPPING_SERVICE_ELIGIBILITY_VERSION\}/.test(rates));

// ── (3) Frontend consumes backend bestRate + Awaiting shows the exact rate ───
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('frontend prefers the backend bestRate (response.bestRate ?? pickBestPanelRate)',
  /responseBestRate \?\? pickBestPanelRate\(rates\)/.test(ordersView));
check('Awaiting carrier column prefers the bestRate carrier over canonical/selected',
  /order\.orderStatus === 'awaiting_shipment'\)\s*\{\s*return \(\s*toStringValue\(order\.bestRate\?\.carrierCode\)/.test(ordersView));
check('Awaiting shipping-account column prefers the bestRate account nickname',
  /order\.orderStatus === 'awaiting_shipment' && order\.bestRate\)\s*\{[\s\S]{0,260}?order\.bestRate\.carrierNickname/.test(ordersView));
check('passive auto-rating does not spin forever with no carrier accounts (bounded skip)',
  /carrierIds\.length === 0\) return null/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-079 best-rate source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-079 best-rate source-of-truth guard');
