/**
 * PS-214 guard — HUGRAB $100 coverage on EVERY quoted and purchased rate,
 * across ShipStation and direct carrier paths.
 *
 * Order #1476 evidence: the selected Best Rate fingerprint said
 * ip=parcelguard/iv=10000, but the shipped Shipp/FedEx label persisted no
 * insurance (otherCost=0.00, no insurance fields) — because
 * resolveEffectiveInsurance only forced the default for UPS Ground + USPS
 * Ground and passed everything else through as the operator's "none".
 *
 * Policy (DJ): $100 coverage required on every HUGRAB label — NOT "only
 * insure UPS/USPS", NOT "silently quote uninsured direct rates". ParcelGuard
 * is THIRD-PARTY coverage (no carrier support needed); carrier declared
 * value is used only where the capability resolver verifies it (direct UPS,
 * free $100 tier). Ground Saver/SurePost stays blocked (PS-057).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  resolveEffectiveInsurance,
  resolveHugrabRequestInsurance,
  isUpsGroundSaverOrSurePostService,
} from '../src/lib/shipping-service-eligibility';
import { resolveRateInsurancePremium } from '../src/services/shipping-workflow/insurance-cost';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const HUGRAB = { clientId: 4, storeId: 378060, clientName: 'HUGRAB' };
const OTHER = { clientId: 7, storeId: 999, clientName: 'KF Goods' };
const pick = (r: ReturnType<typeof resolveEffectiveInsurance>) => ({
  p: r.insuranceProvider,
  v: r.insuredValue,
  s: r.source,
});

// ── The card's carrier-path matrix ──────────────────────────────────────────
// 1. ShipStation-native USPS ground → ParcelGuard $100.
assert.deepEqual(
  pick(resolveEffectiveInsurance(HUGRAB, { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage' }, null)),
  { p: 'parcelguard', v: 100, s: 'hugrab-default' },
);
// 2. ShipStation walleted/brokered FedEx ground-like → $100 coverage (was the
//    passthrough gap).
assert.deepEqual(
  pick(resolveEffectiveInsurance(HUGRAB, { carrierCode: 'fedex_walleted', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground' }, null)),
  { p: 'parcelguard', v: 100, s: 'hugrab-default' },
);
// 3. Direct UPS non-ground service → carrier declared value within the free
//    $100 tier (capability-resolved, $0 premium).
const ups2day = resolveEffectiveInsurance(HUGRAB, { carrierCode: 'ups', serviceCode: 'ups_2nd_day_air', serviceName: 'UPS 2nd Day Air' }, null);
assert.deepEqual(pick(ups2day), { p: 'carrier', v: 100, s: 'hugrab-default' });
assert.deepEqual(
  resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 100 }, { carrier_code: 'ups', service_code: 'ups_2nd_day_air' }).status,
  'resolved',
);
// 4. Shipp/FedEx (the #1476 class) → ParcelGuard $100 with a REAL schedule
//    premium priced into the comparable/persisted total.
const shipp = resolveEffectiveInsurance(HUGRAB, { carrierCode: 'shipp', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground (Shipp)' }, null);
assert.deepEqual(pick(shipp), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
const shippPremium = resolveRateInsurancePremium(
  { insuranceProvider: shipp.insuranceProvider, insuredValue: shipp.insuredValue },
  { carrier_code: 'shipp', service_code: 'fedex_ground' },
);
assert.equal(shippPremium.status, 'resolved');
assert.ok('amount' in shippPremium && (shippPremium as { amount: number }).amount > 0,
  'a ParcelGuard-insured Shipp/FedEx rate must carry a schedule premium > $0');
assert.equal((shippPremium as { provenance?: string }).provenance, 'parcelguard_schedule');
// 5. No HUGRAB candidate can resolve uninsured — across a sweep of service
//    shapes (incl. unknown carriers), only Ground Saver/SurePost passes
//    through (and eligibility blocks the service itself for HUGRAB).
for (const svc of [
  { carrierCode: 'easypost', serviceCode: 'first', serviceName: 'EasyPost First' },
  { carrierCode: 'shipengine', serviceCode: 'whatever_express', serviceName: 'Express' },
  { carrierCode: 'walmart_shipping', serviceCode: 'fedex_home', serviceName: 'FedEx Home' },
  { carrierCode: 'unknown_carrier', serviceCode: 'mystery', serviceName: 'Mystery' },
  { carrierCode: 'ups_walleted', serviceCode: 'ups_next_day_air', serviceName: 'UPS Next Day Air' },
]) {
  const resolved = resolveEffectiveInsurance(HUGRAB, svc, { insuranceProvider: 'none', insuredValue: null });
  assert.notEqual(resolved.insuranceProvider, 'none',
    `HUGRAB + ${svc.carrierCode}/${svc.serviceCode} must never resolve uninsured`);
  assert.ok((resolved.insuredValue ?? 0) >= 100,
    `HUGRAB + ${svc.carrierCode} must carry >= $100`);
}
// 6. Ground Saver/SurePost stays blocked from defaulting (PS-057).
const saver = { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' };
assert.ok(isUpsGroundSaverOrSurePostService(saver));
assert.deepEqual(pick(resolveEffectiveInsurance(HUGRAB, saver, null)), { p: 'none', v: null, s: 'none' });
// 7. Non-HUGRAB orders keep operator/default behavior — never forced.
assert.deepEqual(
  pick(resolveEffectiveInsurance(OTHER, { carrierCode: 'shipp', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground' }, null)),
  { p: 'none', v: null, s: 'none' },
);
assert.deepEqual(
  pick(resolveEffectiveInsurance(OTHER, { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' }, { insuranceProvider: 'carrier', insuredValue: 50 })),
  { p: 'carrier', v: 50, s: 'operator' },
);
// Operator-higher value preserved on any HUGRAB service.
assert.deepEqual(
  pick(resolveEffectiveInsurance(HUGRAB, { carrierCode: 'shipp', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground' }, { insuranceProvider: 'shipsurance', insuredValue: 250 })),
  { p: 'parcelguard', v: 250, s: 'operator' },
);
// Request-level resolver (every quote fan-out) stays $100-floored ParcelGuard.
const req = resolveHugrabRequestInsurance(HUGRAB, { insuranceProvider: 'none', insuredValue: null });
assert.equal(req.insuranceProvider, 'parcelguard');
assert.equal(req.insuredValue, 100);
// Defense in depth: carrier declared value above the $100 free cap re-prices
// as ParcelGuard instead of under-insuring.
const overCap = resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 250 }, { carrier_code: 'ups', service_code: 'ups_ground' });
assert.equal((overCap as { insuranceProvider?: string }).insuranceProvider, 'parcelguard');

// ── Source pins ─────────────────────────────────────────────────────────────
const eligibility = read('src/lib/shipping-service-eligibility.ts');
const labelsSvc = read('src/services/labels.ts');
const labelsDirect = read('src/services/labels-direct.ts');
const ratesSvc = read('src/services/rates.ts');

// The old ground-only narrowing is GONE from the label-side resolver.
assert.ok(!eligibility.includes('if (!upsGround && !uspsGround) return passthrough'),
  'resolveEffectiveInsurance must cover EVERY HUGRAB service — the ground-only narrowing stays deleted');

// One resolve feeds BOTH purchase branches; the SS connector input and the
// shared persist tail carry the effective values.
assert.ok(labelsSvc.includes('const effectiveInsurance = resolveEffectiveInsurance('),
  'createLabelV2 must resolve effective insurance once for the purchase');
assert.ok((labelsSvc.match(/insuranceProvider: options\.insuranceProvider/g) ?? []).length >= 2,
  'the effective insurance must ride the connector input AND the persist tail');
// The belt-and-braces purchase block.
assert.ok(labelsSvc.includes("err.code = 'HUGRAB_INSURANCE_REQUIRED'"),
  'a HUGRAB label resolving uninsured must block BEFORE postage');
// Direct labels persist the schedule premium when the connector reports none.
assert.ok(labelsSvc.includes('parcelGuardScheduledPremium(insuredValue'),
  'the persist tail must price the ParcelGuard schedule premium for direct labels');
assert.ok(labelsSvc.includes("'parcelguard_schedule'") && labelsSvc.includes("'carrier_declared_value'"),
  'persisted insuranceProvenance must distinguish schedule vs declared-value vs ShipStation-billed');
// Direct connector inputs carry the normalized shipping options (insurance).
assert.ok(labelsDirect.includes('shippingOptions: args.shippingOptions'),
  'direct connector input must carry the normalized insurance options');
// Every quote pipeline candidate gets premium enrichment.
assert.ok(ratesSvc.includes('enrichRatesWithInsuranceCost('),
  'the quote pipeline must enrich candidates with the resolved premium');
assert.ok(ratesSvc.includes('resolveHugrabRequestInsurance'),
  'rate requests must resolve HUGRAB insurance through the single owner');

// npm wiring.
assert.ok(read('package.json').includes('"test:ps-214-hugrab-universal-insurance"'),
  'guard must be wired into package.json');

console.log('PASS ps-214 HUGRAB universal insurance guard');
