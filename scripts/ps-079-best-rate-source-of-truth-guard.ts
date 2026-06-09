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
// DECISION (DJ, 2026-06-04): Best Rate is the cheapest CUSTOMER price (selected
// POST-markup), so the displayed Best Rate and the selected rate stay consistent.
// Do NOT switch selection to raw carrier cost without DJ's sign-off.
check('DECISION: best rate is selected POST-markup / cheapest customer price (applyMarkups before pickBestRate)',
  /const rates = applyMarkups\(/.test(rates) || /applyMarkups\(cachedRaw/.test(rates));
check('cache key embeds the eligibility version (rules change → cache invalidates)',
  /eligibility=\$\{SHIPPING_SERVICE_ELIGIBILITY_VERSION\}/.test(rates));

// ── (3) Frontend consumes backend bestRate + Awaiting shows the exact rate ───
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-111 supersede: the frontend now consumes the backend bestRate DIRECTLY as the
// source of truth (no divergent client-side pick at all — stronger than the prior
// `responseBestRate ?? pickBestPanelRate` fallback), and completeness is backend-owned.
check('frontend uses the backend bestRate as source of truth (no divergent client pick)',
  /const bestRate = toRecord\(response\?\.bestRate\)/.test(ordersView));
check('PS-111: passive auto-rating derives completeness from the backend, not hardcoded true',
  /isComplete: backendComplete/.test(ordersView) && /deriveBackendBestRateComplete\(response/.test(ordersView));
// PS-105/carrier-nickname refactor: getCarrierCodeForDisplay now resolves the
// awaiting carrier into a `const carrierCode = toStringValue(order.bestRate?.carrierCode) ?? …`
// (bestRate carrier still FIRST/preferred), then falls back to a known-carrier
// nickname for blank-carrierCode aggregator rates. The bestRate-first preference
// is unchanged; only the surrounding shape changed.
check('Awaiting carrier column prefers the bestRate carrier over canonical/selected',
  /order\.orderStatus === 'awaiting_shipment'\)\s*\{\s*const carrierCode =\s*toStringValue\(order\.bestRate\?\.carrierCode\)/.test(ordersView));
check('Awaiting shipping-account column prefers the bestRate account nickname',
  /order\.orderStatus === 'awaiting_shipment' && order\.bestRate\)\s*\{[\s\S]{0,260}?order\.bestRate\.carrierNickname/.test(ordersView));
// DECISION (DJ, 2026-06-04): keep the BOUNDED SKIP when carrier accounts aren't
// loaded yet (it re-rates once they load; it is not an infinite spinner). Do NOT
// switch to "call backend without carrierIds" without DJ's sign-off.
check('DECISION: passive auto-rating is a bounded skip with no carrier accounts (no infinite spinner)',
  /carrierIds\.length === 0\) return null/.test(ordersView));

// ── (4) PS-135: proof helpers are canonical-lib-owned; no FE client-side best-rate selector ─
const rateProofLib = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
const markups = readFileSync('web/src/utils/markups.ts', 'utf8');
check('PS-135: rate-proof helpers live in the canonical lib (rate-proof.ts)',
  /export function rateProofFingerprint/.test(rateProofLib) &&
    /export function selectProofFromCandidates/.test(rateProofLib) &&
    ordersView.includes("from '../../lib/rate-proof'"));
check('PS-135: frontend has no client-side pickBestRate selector (backend owns selection)',
  !/export function pickBestRate/.test(markups));

if (failures > 0) {
  console.error(`\nFAIL PS-079 best-rate source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-079 best-rate source-of-truth guard');
