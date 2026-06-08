/**
 * PS-072 guard — HUGRAB default $100 insurance resolver + parcelguard
 * normalization. Pure logic, no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-072-hugrab-insurance-guard.ts
 */
import {
  resolveEffectiveInsurance,
  isUpsGroundService,
  isUspsGroundService,
  isUpsGroundSaverOrSurePostService,
} from '../src/lib/shipping-service-eligibility';
import { normalizeInsurance } from '../src/lib/shipping-options';
import { buildSsLabelRequestBody } from '../src/lib/shipstation/labels';
import { rateCacheKey } from '../src/services/rates';
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
const OTHER = { clientId: 7, storeId: 999, clientName: 'KF Goods' };

const upsGround = { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' };
const uspsGround = { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage' };
const groundSaver = { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' };
const surePost = { carrierCode: 'ups', serviceCode: 'ups_surepost_1_lb_or_greater', serviceName: 'UPS Ground Saver (1 lb+)' };
const ups2day = { carrierCode: 'ups', serviceCode: 'ups_2nd_day_air', serviceName: 'UPS 2nd Day Air' };

const pick = (r: ReturnType<typeof resolveEffectiveInsurance>) => ({ p: r.insuranceProvider, v: r.insuredValue, s: r.source });

// --- service detectors ---
check('detect UPS Ground', isUpsGroundService(upsGround), true);
check('detect USPS Ground Advantage', isUspsGroundService(uspsGround), true);
check('UPS Ground Saver is NOT UPS Ground', isUpsGroundService(groundSaver), false);
check('SurePost is detected as GroundSaver/SurePost', isUpsGroundSaverOrSurePostService(surePost), true);
check('UPS 2nd Day is not ground', isUpsGroundService(ups2day), false);

// --- resolver: HUGRAB defaults ---
check('HUGRAB + UPS Ground, no operator -> parcelguard/100', pick(resolveEffectiveInsurance(HUGRAB, upsGround, null)), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB + USPS Ground, no operator -> parcelguard/100', pick(resolveEffectiveInsurance(HUGRAB, uspsGround, null)), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB + UPS Ground, operator none -> forced parcelguard/100', pick(resolveEffectiveInsurance(HUGRAB, upsGround, { insuranceProvider: 'none', insuredValue: null })), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB + UPS Ground, operator $250 -> parcelguard/250 (provider forced, value kept)', pick(resolveEffectiveInsurance(HUGRAB, upsGround, { insuranceProvider: 'carrier', insuredValue: 250 })), { p: 'parcelguard', v: 250, s: 'operator' });
check('HUGRAB + USPS Ground, operator $250 -> parcelguard/250 (provider forced, value kept)', pick(resolveEffectiveInsurance(HUGRAB, uspsGround, { insuranceProvider: 'shipsurance', insuredValue: 250 })), { p: 'parcelguard', v: 250, s: 'operator' });

// --- PS-057: Ground Saver/SurePost never defaulted ---
check('HUGRAB + Ground Saver, operator none -> passthrough none (PS-057)', pick(resolveEffectiveInsurance(HUGRAB, groundSaver, { insuranceProvider: 'none' })), { p: 'none', v: null, s: 'none' });
check('HUGRAB + SurePost -> not defaulted', pick(resolveEffectiveInsurance(HUGRAB, surePost, null)), { p: 'none', v: null, s: 'none' });

// --- non-HUGRAB unaffected ---
check('non-HUGRAB + UPS Ground -> no default', pick(resolveEffectiveInsurance(OTHER, upsGround, null)), { p: 'none', v: null, s: 'none' });
check('non-HUGRAB + UPS Ground, operator carrier/100 -> passthrough', pick(resolveEffectiveInsurance(OTHER, upsGround, { insuranceProvider: 'carrier', insuredValue: 100 })), { p: 'carrier', v: 100, s: 'operator' });

// --- HUGRAB non-ground service unaffected ---
check('HUGRAB + UPS 2nd Day -> no default', pick(resolveEffectiveInsurance(HUGRAB, ups2day, null)), { p: 'none', v: null, s: 'none' });

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

const ratesServiceSource = readFileSync('src/services/rates.ts', 'utf8');
check(
  'ShipStation rate default uses ParcelGuard when HUGRAB operator insurance is none',
  /operatorInsurance\.insuranceProvider === 'none'[\s\S]{0,300}insuranceProvider = 'parcelguard'/.test(ratesServiceSource),
  true,
);
check(
  'ShipStation HUGRAB auto-rate normalizes carrier insurance to ParcelGuard before ShipStation',
  /isHugrabShippingContext\(\{ clientId: context\.clientId, storeId: context\.storeId \}\)[\s\S]{0,420}else \{[\s\S]{0,120}insuranceProvider = 'parcelguard'/.test(ratesServiceSource),
  true,
);

if (failures > 0) {
  console.error(`\nFAIL PS-072 HUGRAB insurance guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-072 HUGRAB insurance guard');
