import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  filterEligibleShippingServices,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
} from '../src/lib/shipping-service-eligibility';
// PS-165: carrier display precedence moved to its canonical owner (verbatim).
import { resolveDisplayCarrierCode } from '../web/src/components/Views/order-shipping-display';

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
  // Repointed (guard rot): ranking gained a deterministic internal-cost tiebreaker.
  // Primary basis is still rateTotal (canonical customer money via the normalizer);
  // rateCostTotal breaks ties only.
  /function pickBestRate/.test(rates) &&
  /\.sort\(\(a, b\) => \(rateTotal\(a\) - rateTotal\(b\)\) \|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)\)\)\[0\]/.test(rates));
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
// PS-135: the panel-live (forceLive) refresh path also derives completeness from the backend
// (its bestRate.isComplete stamp, else carrierStatuses) — a carrier that errors/loads during a
// panel fetch must NOT be stamped complete, matching the passive path above.
check('PS-135: panel-live best rate derives completeness from the backend (not hardcoded isComplete: true)',
  ordersView.includes('isComplete: deriveBackendBestRateComplete(response, bestRate),') &&
  ordersView.includes("matchType: 'panel-live'"));
// PS-165/PS-166: the carrier display precedence is owned VERBATIM by
// resolveDisplayCarrierCode (order-shipping-display.ts). The OrdersView-facing
// wrapper getCarrierCodeForDisplay moved to orders-display-state.ts (PS-166 Wave
// 2a) and OrdersView now consumes THAT wrapper. Assert the BEHAVIOR at the pure
// owner (awaiting prefers bestRate over canonical/selected; shipped prefers
// canonical) + that the wrapper delegates to it + that OrdersView uses the wrapper.
const displayState = readFileSync('web/src/components/Views/orders-display-state.ts', 'utf8');
// PS-166/PS-306/PS-258 (Wave 2): the Carrier leaf cell (which consumes the
// getCarrierCodeForDisplay wrapper) moved VERBATIM from OrdersView into
// ./orders/cells/order-cells; assert the cell module now uses the wrapper.
const orderCells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
const ps165CarrierBase = { isTest: false, bestRateCarrierCode: 'ups', canonicalCarrierCode: 'fedex', selectedRateCarrierCode: 'usps', bestRateNickname: null, bestRateNicknameIsKnownCarrier: false };
check('Awaiting carrier column prefers the bestRate carrier over canonical/selected',
  resolveDisplayCarrierCode({ ...ps165CarrierBase, isAwaiting: true }) === 'ups' &&
  resolveDisplayCarrierCode({ ...ps165CarrierBase, isAwaiting: false }) === 'fedex' &&
  // getCarrierCodeForDisplay delegates to the pure owner, preferring bestRate when awaiting.
  /export function getCarrierCodeForDisplay/.test(displayState) &&
  /return resolveDisplayCarrierCode\(/.test(displayState) &&
  /bestRateCarrierCode: toStringValue\(\(order\.bestRate as LooseBestRate \| undefined\)\?\.carrierCode\)/.test(displayState) &&
  /getCarrierCodeForDisplay\(/.test(orderCells));
check('Awaiting shipping-account column prefers the bestRate account nickname',
  // getShipAccountDisplay (orders-display-state.ts) — awaiting prefers the bestRate nickname.
  /order\.orderStatus === 'awaiting_shipment' && order\.bestRate\)\s*\{[\s\S]{0,260}?\(order\.bestRate as LooseBestRate\)\.carrierNickname/.test(displayState));
// RETIRED (was: DECISION (DJ, 2026-06-04) bounded skip with no carrier accounts).
// PS-345 deleted the OrdersView page-mount passive auto-rating worker entirely, so
// the bounded-skip site no longer exists; refresh is backend-owned (rates-backfill,
// bounded concurrency/timeouts). Anti-reintroduction is pinned by the PS-345
// rate-loading SOT guard and the PS-293 supersession guard.

// ── (4) PS-135: proof helpers are canonical-lib-owned; no FE client-side best-rate selector ─
const rateProofLib = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
check('PS-135: rate-proof helpers live in the canonical lib (rate-proof.ts)',
  /export function rateProofFingerprint/.test(rateProofLib) &&
    /export function selectProofFromCandidates/.test(rateProofLib) &&
    ordersView.includes("from '../../lib/rate-proof'"));
check('PS-135: frontend has no client-side pickBestRate selector (backend owns selection)',
  !existsSync('web/src/utils/markups.ts'));

if (failures > 0) {
  console.error(`\nFAIL PS-079 best-rate source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-079 best-rate source-of-truth guard');
