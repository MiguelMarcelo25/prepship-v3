/**
 * PS-072 guard — HUGRAB default $100 insurance resolver + parcelguard
 * normalization. Pure logic, no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-072-hugrab-insurance-guard.ts
 */
import {
  resolveEffectiveInsurance,
  resolveHugrabRequestInsurance,
  isHugrabDefaultInsuranceRequired,
  isUpsGroundService,
  isUspsGroundService,
  isUpsGroundSaverOrSurePostService,
} from '../src/lib/shipping-service-eligibility';
import { normalizeInsurance } from '../src/lib/shipping-options';
import { buildSsLabelRequestBody } from '../src/lib/shipstation/labels';
import { rateCacheKey } from '../src/services/rates';
import { parseHugrabDefaultInsuranceEnabled } from '../src/services/shipping-workflow/hugrab-insurance-policy';
import {
  hugrabDefaultInsuranceFromRequestFingerprint,
  shippingRateFingerprintMatchesCurrentFacts,
} from '../src/services/shipping-workflow/rate-fingerprint';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const HUGRAB = { clientId: 4, storeId: 378060, clientName: 'HUGRAB' };
const HUGRAB_DISABLED = { ...HUGRAB, hugrabDefaultInsuranceEnabled: false };
const OTHER = { clientId: 7, storeId: 999, clientName: 'KF Goods' };

const upsGround = { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' };
const uspsGround = { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage' };
const groundSaver = { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' };
const surePost = { carrierCode: 'ups', serviceCode: 'ups_surepost_1_lb_or_greater', serviceName: 'UPS Ground Saver (1 lb+)' };
const ups2day = { carrierCode: 'ups', serviceCode: 'ups_2nd_day_air', serviceName: 'UPS 2nd Day Air' };

const pick = (r: ReturnType<typeof resolveEffectiveInsurance>) => ({ p: r.insuranceProvider, v: r.insuredValue, s: r.source });

// --- persisted policy input fails safe to today's enabled behavior ---
check('missing HUGRAB insurance setting defaults enabled', parseHugrabDefaultInsuranceEnabled(null), true);
check('malformed HUGRAB insurance setting defaults enabled', parseHugrabDefaultInsuranceEnabled('maybe'), true);
check('enabled HUGRAB insurance setting stays enabled', parseHugrabDefaultInsuranceEnabled('enabled'), true);
check('only explicit disabled turns the policy off', parseHugrabDefaultInsuranceEnabled('disabled'), false);
check('HUGRAB default insurance required by default', isHugrabDefaultInsuranceRequired(HUGRAB), true);
check('HUGRAB default insurance not required when disabled', isHugrabDefaultInsuranceRequired(HUGRAB_DISABLED), false);

// --- service detectors ---
check('detect UPS Ground', isUpsGroundService(upsGround), true);
check('detect USPS Ground Advantage', isUspsGroundService(uspsGround), true);
check('UPS Ground Saver is NOT UPS Ground', isUpsGroundService(groundSaver), false);
check('SurePost is detected as GroundSaver/SurePost', isUpsGroundSaverOrSurePostService(surePost), true);
check('UPS 2nd Day is not ground', isUpsGroundService(ups2day), false);

// --- resolver: HUGRAB defaults (PS-170 verify gate ON 2026-06-11) ---
// Direct UPS at the $100 free tier -> carrier declared value ($0). USPS (brokered) stays
// ParcelGuard. Above the $100 cap, direct UPS falls back to ParcelGuard (correctly priced).
check('HUGRAB + UPS Ground (direct), no operator -> carrier/100 (gate ON, free declared value)', pick(resolveEffectiveInsurance(HUGRAB, upsGround, null)), { p: 'carrier', v: 100, s: 'hugrab-default' });
check('HUGRAB + USPS Ground (brokered), no operator -> parcelguard/100', pick(resolveEffectiveInsurance(HUGRAB, uspsGround, null)), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB + UPS Ground (direct), operator none -> carrier/100 (gate ON)', pick(resolveEffectiveInsurance(HUGRAB, upsGround, { insuranceProvider: 'none', insuredValue: null })), { p: 'carrier', v: 100, s: 'hugrab-default' });
check('HUGRAB + UPS Ground (direct), operator $250 -> parcelguard/250 (PS-170 >$100 cap: carrier free tier is only $100)', pick(resolveEffectiveInsurance(HUGRAB, upsGround, { insuranceProvider: 'carrier', insuredValue: 250 })), { p: 'parcelguard', v: 250, s: 'operator' });
check('HUGRAB + USPS Ground (brokered), operator $250 -> parcelguard/250 (provider forced, value kept)', pick(resolveEffectiveInsurance(HUGRAB, uspsGround, { insuranceProvider: 'shipsurance', insuredValue: 250 })), { p: 'parcelguard', v: 250, s: 'operator' });

// --- persisted policy OFF: operator intent passes through, including none ---
check('disabled HUGRAB policy + no operator -> no insurance', pick(resolveEffectiveInsurance(HUGRAB_DISABLED, uspsGround, null)), { p: 'none', v: null, s: 'none' });
check('disabled HUGRAB policy + operator carrier/250 -> passthrough', pick(resolveEffectiveInsurance(HUGRAB_DISABLED, upsGround, { insuranceProvider: 'carrier', insuredValue: 250 })), { p: 'carrier', v: 250, s: 'operator' });
const disabledRequest = resolveHugrabRequestInsurance(HUGRAB_DISABLED, { insuranceProvider: 'none', insuredValue: null });
check('disabled HUGRAB request does not force ParcelGuard', { p: disabledRequest.insuranceProvider, v: disabledRequest.insuredValue, s: disabledRequest.source }, { p: 'none', v: null, s: 'none' });

// --- PS-057: Ground Saver/SurePost never defaulted ---
check('HUGRAB + Ground Saver, operator none -> passthrough none (PS-057)', pick(resolveEffectiveInsurance(HUGRAB, groundSaver, { insuranceProvider: 'none' })), { p: 'none', v: null, s: 'none' });
check('HUGRAB + SurePost -> not defaulted', pick(resolveEffectiveInsurance(HUGRAB, surePost, null)), { p: 'none', v: null, s: 'none' });

// --- non-HUGRAB unaffected ---
check('non-HUGRAB + UPS Ground -> no default', pick(resolveEffectiveInsurance(OTHER, upsGround, null)), { p: 'none', v: null, s: 'none' });
check('non-HUGRAB + UPS Ground, operator carrier/100 -> passthrough', pick(resolveEffectiveInsurance(OTHER, upsGround, { insuranceProvider: 'carrier', insuredValue: 100 })), { p: 'carrier', v: 100, s: 'operator' });

// --- PS-214 re-anchor: HUGRAB policy is $100 on EVERY service ---
// The old case here certified "non-ground services get no default" — exactly
// the gap that let order #1476 ship a Shipp/FedEx label uninsured while its
// rate fingerprint said parcelguard/$100. DJ's policy: $100 coverage
// required, full stop (Ground Saver/SurePost excepted — PS-057, pinned
// above). UPS 2nd Day on the direct-UPS account resolves to carrier declared
// value within the free $100 tier; non-UPS carriers resolve to ParcelGuard
// (third-party — needs no carrier support).
check('HUGRAB + UPS 2nd Day -> $100 default (PS-214: every service)', pick(resolveEffectiveInsurance(HUGRAB, ups2day, null)), { p: 'carrier', v: 100, s: 'hugrab-default' });
const shippGroundLike = { carrierCode: 'shipp', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground (Shipp)' };
check('HUGRAB + Shipp/FedEx ground-like -> parcelguard/100 (the order-#1476 class)', pick(resolveEffectiveInsurance(HUGRAB, shippGroundLike, null)), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB + Shipp, operator none -> still parcelguard/100', pick(resolveEffectiveInsurance(HUGRAB, shippGroundLike, { insuranceProvider: 'none', insuredValue: null })), { p: 'parcelguard', v: 100, s: 'hugrab-default' });

// --- parcelguard normalization survives + does not collapse ---
check('normalize parcelguard/100', normalizeInsurance({ insuranceProvider: 'parcelguard', insuredValue: 100 }), { insuranceProvider: 'parcelguard', insuredValue: 100 });
check('normalize "Parcel Guard"/100', normalizeInsurance({ insuranceProvider: 'Parcel Guard', insuredValue: 100 }), { insuranceProvider: 'parcelguard', insuredValue: 100 });
check('parcelguard survives double-normalize', normalizeInsurance(normalizeInsurance({ insuranceProvider: 'parcelguard', insuredValue: 100 })), { insuranceProvider: 'parcelguard', insuredValue: 100 });
check('parcelguard with no value collapses to none', normalizeInsurance({ insuranceProvider: 'parcelguard', insuredValue: 0 }), { insuranceProvider: 'none', insuredValue: null });

// --- ShipStation v2 label payload SHAPE (offline, no network) ---
const labelInput = (insuranceProvider: string, insuredValue: number | null) => ({
  apiKeyV2: 'test',
  carrierId: 'se-1',
  serviceCode: 'ups_ground',
  packageCode: 'package',
  weightOz: 16,
  length: 12,
  width: 10,
  height: 3,
  shipTo: { name: 'A', street1: '1 St', city: 'LA', state: 'CA', postalCode: '90001', country: 'US' },
  shipFrom: { name: 'B', street1: '2 St', city: 'LA', state: 'CA', postalCode: '90002', country: 'US' },
  confirmation: 'none',
  insuranceProvider,
  insuredValue,
  ssOrderId: 1,
  orderNumber: '123',
});

const carrierBody = buildSsLabelRequestBody(labelInput('carrier', 100)) as any;
check('label: insured_value is PACKAGE-level', carrierBody.shipment.packages[0].insured_value, { amount: 100, currency: 'usd' });
check('label: insurance_provider is shipment-level', carrierBody.shipment.insurance_provider, 'carrier');
check('label: NO shipment-level insured_value', (carrierBody.shipment as any).insured_value, undefined);

const pgBody = buildSsLabelRequestBody(labelInput('parcelguard', 100)) as any;
check('label: parcelguard provider survives to payload', pgBody.shipment.insurance_provider, 'parcelguard');
check('label: parcelguard package insured_value', pgBody.shipment.packages[0].insured_value, { amount: 100, currency: 'usd' });

const noneBody = buildSsLabelRequestBody(labelInput('none', null)) as any;
check('label: no insurance_provider when none', noneBody.shipment.insurance_provider, undefined);
check('label: no package insured_value when none', noneBody.shipment.packages[0].insured_value, undefined);

// --- rate cache fingerprint differs for none / $100 / $250 ---
const baseRate = { weightOz: 16, toZip: '90001' };
const keyNone = rateCacheKey({ ...baseRate, insuranceProvider: 'none', insuredValue: null });
const key100 = rateCacheKey({ ...baseRate, insuranceProvider: 'parcelguard', insuredValue: 100 });
const key250 = rateCacheKey({ ...baseRate, insuranceProvider: 'parcelguard', insuredValue: 250 });
check('rate key: none != $100', keyNone !== key100, true);
check('rate key: $100 != $250', key100 !== key250, true);
check('rate key: $100 includes ip+iv', key100.includes('ip=parcelguard') && key100.includes('iv=10000'), true);
const keyPolicyOn = rateCacheKey({ ...baseRate, clientId: 4, hugrabDefaultInsuranceEnabled: true });
const keyPolicyOff = rateCacheKey({ ...baseRate, clientId: 4, hugrabDefaultInsuranceEnabled: false });
check('rate key: HUGRAB policy on != off', keyPolicyOn !== keyPolicyOff, true);
check('rate key: HUGRAB policy on is explicit', hugrabDefaultInsuranceFromRequestFingerprint(keyPolicyOn), true);
check('rate key: HUGRAB policy off is explicit', hugrabDefaultInsuranceFromRequestFingerprint(keyPolicyOff), false);
check('saved HUGRAB rate matches current ON policy', shippingRateFingerprintMatchesCurrentFacts(keyPolicyOn, { hugrabDefaultInsuranceEnabled: true }), true);
check('saved HUGRAB rate is stale after policy changes OFF', shippingRateFingerprintMatchesCurrentFacts(keyPolicyOn, { hugrabDefaultInsuranceEnabled: false }), false);
check('legacy HUGRAB rate without policy proof is stale', shippingRateFingerprintMatchesCurrentFacts(key100, { hugrabDefaultInsuranceEnabled: true }), false);

// PS-170: the HUGRAB request-level forcing moved from an inline block in rates.ts to its
// single owner resolveHugrabRequestInsurance (shipping-service-eligibility). Assert the
// BEHAVIOR at the owner (stronger than the old source-regex) + that rates.ts delegates.
const ratesServiceSource = readFileSync('src/services/rates.ts', 'utf8');
const labelsServiceSource = readFileSync('src/services/labels.ts', 'utf8');
const ordersViewSource = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const settingsCardSource = readFileSync('web/src/components/Settings/HugrabInsurancePolicyCard.tsx', 'utf8');
const userSettingPolicySource = readFileSync('src/services/user-setting-policy.ts', 'utf8');
const ordersRouteSource = readFileSync('src/routes/orders.ts', 'utf8');
const reqNone = resolveHugrabRequestInsurance(HUGRAB, { insuranceProvider: 'none', insuredValue: null });
check(
  'ShipStation rate default uses ParcelGuard when HUGRAB operator insurance is none',
  reqNone.insuranceProvider === 'parcelguard' && reqNone.insuredValue === 100,
  true,
);
const reqCarrier = resolveHugrabRequestInsurance(HUGRAB, { insuranceProvider: 'carrier', insuredValue: 100 });
check(
  'ShipStation HUGRAB auto-rate normalizes carrier insurance to ParcelGuard before ShipStation',
  reqCarrier.insuranceProvider === 'parcelguard',
  true,
);
const reqOther = resolveHugrabRequestInsurance(OTHER, { insuranceProvider: 'none', insuredValue: null });
check('non-HUGRAB request passes operator selection through (no forcing)', reqOther.insuranceProvider, 'none');
check(
  'rates.ts delegates HUGRAB request insurance to the single owner (no inline duplicate)',
  /resolveHugrabRequestInsurance\(/.test(ratesServiceSource) &&
    !/insuranceProvider = 'parcelguard'/.test(ratesServiceSource),
  true,
);
check(
  'label purchase loads the backend policy and rejects a quote from another policy state',
  /loadHugrabDefaultInsuranceEnabled\(\)/.test(labelsServiceSource) &&
    /RATE_LABEL_INSURANCE_POLICY_MISMATCH/.test(labelsServiceSource) &&
    /isHugrab:\s*hugrabDefaultInsuranceRequired/.test(labelsServiceSource),
  true,
);
check(
  'OrdersView seeds UX from the persisted policy without owning label truth',
  /fetchHugrabDefaultInsurancePolicy\(\)/.test(ordersViewSource) &&
    /hugrabDefaultInsuranceEnabled/.test(ordersViewSource),
  true,
);
check(
  'Settings exposes an explicit HUGRAB enable-disable control',
  /HUGRAB automatic insurance/.test(settingsCardSource) &&
    /saveHugrabDefaultInsurancePolicy/.test(settingsCardSource),
  true,
);
check(
  'generic settings API explicitly allows the HUGRAB policy key',
  /['"]hugrab_default_insurance['"]/.test(userSettingPolicySource),
  true,
);
check(
  'orders read model invalidates saved HUGRAB rates after a policy change',
  /hugrabDefaultInsuranceEnabled:\s*rowIsHugrab\s*\?/.test(ordersRouteSource),
  true,
);

if (failures > 0) {
  console.error(`\nFAIL PS-072 HUGRAB insurance guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-072 HUGRAB insurance guard');
