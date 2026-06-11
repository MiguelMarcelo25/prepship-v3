/**
 * PS-170 guard — account-capability HUGRAB insurance resolver (ParcelGuard vs direct-UPS
 * carrier declared value). Pure logic: no DB, no network, no postage, no order mutation.
 *
 * Proves:
 *   1. Account capability classification (direct UPS vs ShipStation-brokered vs blocked).
 *   2. THE VERIFY GATE: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED is ON (DJ-enabled 2026-06-11).
 *      Direct UPS resolves to carrier declared value ($0, insured $100); brokered accounts
 *      STILL ParcelGuard; Ground Saver/SurePost stay blocked; NO path is ever uninsured.
 *   3. The HUGRAB forcing is owned in ONE place (request-level + per-service), and rates.ts
 *      delegates (no inline duplicate).
 *   4. Per-candidate enrichment: a direct-UPS candidate gets $0 carrier declared value and
 *      the cheapest INSURED total wins; an operator's explicit `carrier`/`shipsurance`
 *      choice is never overridden.
 *   5. Label parity: the direct-UPS HUGRAB label carries carrier declared value at $100;
 *      a brokered (USPS) label still carries ParcelGuard. No uninsured label is producible.
 *
 *   npx tsx scripts/ps-170-account-capability-insurance-guard.ts
 */
import {
  resolveAccountInsuranceCapability,
  effectiveInsuranceProviderForAccount,
  DIRECT_UPS_CARRIER_INSURANCE_VERIFIED,
} from '../src/lib/carrier-account-registry';
import {
  resolveEffectiveInsurance,
  resolveHugrabRequestInsurance,
} from '../src/lib/shipping-service-eligibility';
import {
  resolveRateInsurancePremium,
  enrichRatesWithInsuranceCost,
} from '../src/services/shipping-workflow/insurance-cost';
import { buildSsLabelRequestBody } from '../src/lib/shipstation/labels';
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

// ─── 1. Capability classification ────────────────────────────────────────────
const cap = (input: Parameters<typeof resolveAccountInsuranceCapability>[0]) =>
  ({ r: resolveAccountInsuranceCapability(input).required, p: resolveAccountInsuranceCapability(input).carrierPurchasable });

// Direct UPS contracts (operator's own accounts) — required 'carrier', purchasable gated.
check('direct UPS by provider id 604209 (ROCEL)', cap({ shippingProviderId: 604209 }), { r: 'carrier', p: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED });
check('direct UPS by provider id 596001 (ORION)', cap({ shippingProviderId: 596001 }), { r: 'carrier', p: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED });
check('direct UPS by carrier_code ups', cap({ carrierCode: 'ups' }), { r: 'carrier', p: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED });
check('direct UPS by carrier_id se-565326', cap({ shippingProviderId: 'se-565326' }), { r: 'carrier', p: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED });

// ShipStation-brokered — ParcelGuard only, never carrier-purchasable.
check('ups_walleted (SS wallet 433543) -> parcelguard', cap({ shippingProviderId: 433543 }), { r: 'parcelguard', p: false });
check('ups_walleted by code -> parcelguard', cap({ carrierCode: 'ups_walleted' }), { r: 'parcelguard', p: false });
check('stamps_com (USPS via SS) -> parcelguard', cap({ shippingProviderId: 433542 }), { r: 'parcelguard', p: false });
check('fedex direct -> parcelguard (UPS-only gate)', cap({ shippingProviderId: 598840 }), { r: 'parcelguard', p: false });
check('fedex_walleted -> parcelguard', cap({ carrierCode: 'fedex_walleted' }), { r: 'parcelguard', p: false });
check('unknown account -> parcelguard', cap({ carrierCode: 'dhl_ecommerce' }), { r: 'parcelguard', p: false });

// Ground Saver / SurePost — insurance blocked (PS-057), regardless of carrier.
check('UPS Ground Saver service -> blocked', cap({ carrierCode: 'ups', serviceCode: 'ups_ground_saver' }), { r: 'blocked', p: false });
check('UPS SurePost service -> blocked', cap({ carrierCode: 'ups', serviceCode: 'ups_surepost_1_lb_or_greater' }), { r: 'blocked', p: false });
check('EasyPost UPS GroundSaver alias -> blocked', cap({ carrierCode: 'ups', serviceCode: 'easypost_ups_upsdap_upsgroundsavergreaterthan1lb' }), { r: 'blocked', p: false });

// ─── 2. THE VERIFY GATE — ENABLED 2026-06-11 (DJ confirmed direct-UPS $100 insured) ─────
check('verify gate is ON (DJ-enabled 2026-06-11)', DIRECT_UPS_CARRIER_INSURANCE_VERIFIED, true);
check('gate ON -> direct UPS effective provider is carrier (declared value)', effectiveInsuranceProviderForAccount({ carrierCode: 'ups' }), 'carrier');
check('gate ON -> direct UPS by id effective provider is carrier', effectiveInsuranceProviderForAccount({ shippingProviderId: 604209 }), 'carrier');
check('gate ON -> stamps_com (brokered) effective provider STILL ParcelGuard', effectiveInsuranceProviderForAccount({ carrierCode: 'stamps_com' }), 'parcelguard');
// SAFETY INVARIANT (must hold in EITHER gate state): a direct-UPS account is NEVER uninsured.
// Gate ON -> 'carrier' (insured via declared value); gate OFF -> 'parcelguard'. Never 'none'.
check('direct UPS provider is never "none" (always insured)', effectiveInsuranceProviderForAccount({ carrierCode: 'ups' }) === 'none', false);
check('direct UPS provider is one of carrier|parcelguard (insured)', ['carrier', 'parcelguard'].includes(effectiveInsuranceProviderForAccount({ carrierCode: 'ups' })), true);
// PS-170 FREE-TIER CAP: carrier declared value covers only the first $100. Within the cap a
// direct-UPS account uses carrier ($0); above it, ParcelGuard (correctly priced, fully insured).
check('gate ON -> direct UPS at $100 is carrier', effectiveInsuranceProviderForAccount({ carrierCode: 'ups', insuredValue: 100 }), 'carrier');
check('gate ON -> direct UPS ABOVE $100 cap falls back to parcelguard', effectiveInsuranceProviderForAccount({ carrierCode: 'ups', insuredValue: 250 }), 'parcelguard');

// ─── 3. Single-owner HUGRAB forcing (request-level + per-service) ──────────────
const req = (sel: any) => {
  const r = resolveHugrabRequestInsurance(HUGRAB, sel);
  return { p: r.insuranceProvider, v: r.insuredValue, s: r.source };
};
check('HUGRAB request, operator none -> parcelguard/100', req({ insuranceProvider: 'none', insuredValue: null }), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB request, operator carrier -> normalized to parcelguard/100', req({ insuranceProvider: 'carrier', insuredValue: 100 }), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
check('HUGRAB request, operator $250 -> parcelguard/250 (value kept)', req({ insuranceProvider: 'parcelguard', insuredValue: 250 }), { p: 'parcelguard', v: 250, s: 'operator' });
// PS-170 floor alignment: a sub-$100 HUGRAB selection is floored to $100 (matches the label).
check('HUGRAB request, operator $50 -> floored to parcelguard/100', req({ insuranceProvider: 'parcelguard', insuredValue: 50 }), { p: 'parcelguard', v: 100, s: 'hugrab-default' });
// Non-HUGRAB passes operator intent through (no forcing).
check('non-HUGRAB request -> passthrough none', req.call(null, { insuranceProvider: 'none' }) && { p: resolveHugrabRequestInsurance(OTHER, { insuranceProvider: 'none' }).insuranceProvider }, { p: 'none' });

// Per-service (label-time) — gate ON: direct-UPS HUGRAB ground resolves to carrier $100
// (insured, $0); USPS (brokered) STILL ParcelGuard $100. Ground/SurePost handled in §1.
const upsGroundDirect = { carrierId: 'se-604209', carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' };
const uspsGround = { carrierId: 'se-433542', carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage' };
const effUps = resolveEffectiveInsurance(HUGRAB, upsGroundDirect, null);
check('gate ON -> HUGRAB UPS Ground (direct) label is carrier/100', { p: effUps.insuranceProvider, v: effUps.insuredValue }, { p: 'carrier', v: 100 });
const effUsps = resolveEffectiveInsurance(HUGRAB, uspsGround, null);
check('gate ON -> HUGRAB USPS Ground label STILL parcelguard/100', { p: effUsps.insuranceProvider, v: effUsps.insuredValue }, { p: 'parcelguard', v: 100 });

// rates.ts delegates to the single owner (no inline forcing duplicate left behind).
const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
check('rates.ts delegates request insurance to resolveHugrabRequestInsurance', /resolveHugrabRequestInsurance\(/.test(ratesSrc), true);
check('rates.ts no longer hardcodes inline parcelguard forcing', /insuranceProvider = 'parcelguard'/.test(ratesSrc), false);
check('rates.ts passes per-candidate provider to enrichment', /effectiveInsuranceProviderForAccount\(/.test(ratesSrc), true);

// ─── 4. Per-candidate enrichment + cheapest-insured-wins ──────────────────────
type R = { carrier_id: string; carrier_code: string; service_code: string; shipping_amount: { currency: string; amount: number } };
const upsRate: R = { carrier_id: 'se-604209', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { currency: 'usd', amount: 9.20 } };
const uspsRate: R = { carrier_id: 'se-433542', carrier_code: 'stamps_com', service_code: 'usps_ground_advantage', shipping_amount: { currency: 'usd', amount: 9.00 } };
const ctx = { insuranceProvider: 'parcelguard', insuredValue: 100, toCountry: 'US' };
const amountOf = (r: any) => r?.insurance_amount?.amount;
const provOf = (r: any) => r?.insuranceCost?.provenance;
const totalOf = (r: any) => Number((r.shipping_amount.amount + (amountOf(r) ?? 0)).toFixed(2));

// 4a. Realistic gate-ON resolver (the one rates.ts uses) -> direct UPS = $0 carrier declared
// value, USPS = ParcelGuard $1.09, and the cheapest INSURED total wins (UPS 9.20 < USPS 10.09).
const liveResolver = (r: R) => effectiveInsuranceProviderForAccount({ shippingProviderId: r.carrier_id, carrierCode: r.carrier_code, serviceCode: r.service_code });
{
  const { resolved } = enrichRatesWithInsuranceCost([upsRate, uspsRate], ctx, undefined, liveResolver);
  const ups = resolved.find((r: any) => r.carrier_code === 'ups');
  const usps = resolved.find((r: any) => r.carrier_code === 'stamps_com');
  check('gate ON (live) -> direct UPS candidate is $0 carrier declared value', amountOf(ups), 0);
  check('gate ON (live) -> direct UPS provenance is carrier_declared_value', provOf(ups), 'carrier_declared_value');
  check('gate ON (live) -> USPS candidate stays ParcelGuard $1.09', amountOf(usps), 1.09);
  const cheapest = [...resolved].sort((a: any, b: any) => totalOf(a) - totalOf(b))[0] as any;
  check('gate ON (live) -> cheapest INSURED total is the direct-UPS carrier candidate', cheapest.carrier_code, 'ups');
  check('gate ON (live) -> winning insured total is 9.20', totalOf(cheapest), 9.20);
}

// 4b. Simulate the gate ON via an injected resolver (proves the machinery + selection).
const enabledResolver = (r: R) => (r.carrier_code === 'ups' ? 'carrier' : 'parcelguard');
{
  const { resolved } = enrichRatesWithInsuranceCost([upsRate, uspsRate], ctx, undefined, enabledResolver);
  const ups = resolved.find((r: any) => r.carrier_code === 'ups');
  const usps = resolved.find((r: any) => r.carrier_code === 'stamps_com');
  check('gate ON -> direct UPS candidate is $0 carrier declared value', amountOf(ups), 0);
  check('gate ON -> direct UPS provenance is carrier_declared_value', provOf(ups), 'carrier_declared_value');
  check('gate ON -> USPS candidate stays ParcelGuard $1.09', amountOf(usps), 1.09);
  // Cheapest INSURED total wins: UPS 9.20 + 0 = 9.20 beats USPS 9.00 + 1.09 = 10.09.
  const cheapest = [...resolved].sort((a, b) => totalOf(a) - totalOf(b))[0] as any;
  check('gate ON -> cheapest INSURED total is the direct-UPS carrier candidate', cheapest.carrier_code, 'ups');
  check('gate ON -> winning insured total is 9.20', totalOf(cheapest), 9.20);
}

// 4c. Operator-explicit provider is NEVER overridden by the per-candidate hook.
{
  // ctx provider is 'carrier' (operator chose it) — hook returns 'parcelguard' but must be ignored.
  const carrierCtx = { insuranceProvider: 'carrier', insuredValue: 100, toCountry: 'US' };
  const { resolved } = enrichRatesWithInsuranceCost([upsRate], carrierCtx, undefined, () => 'parcelguard');
  check('operator-explicit carrier is preserved ($0 declared value, not re-priced to parcelguard)', amountOf(resolved[0]), 0);
  check('operator-explicit carrier provenance stays carrier_declared_value', provOf(resolved[0]), 'carrier_declared_value');
}

// 4d. resolveRateInsurancePremium carrier branch directly.
{
  const res = resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 100, toCountry: 'US' }, upsRate);
  check('carrier premium resolution: $0', res.status === 'resolved' ? res.amount : res.status, 0);
  check('carrier premium provenance', res.status === 'resolved' ? res.provenance : null, 'carrier_declared_value');
  check('carrier premium is confirmed (free first $100 is real, not an estimate)', res.status === 'resolved' ? res.confirmed : null, true);
}

// 4e. Defense-in-depth: resolveRateInsurancePremium prices carrier ABOVE the $100 free tier
// as ParcelGuard (never $0 for >$100 declared value) — no undercharge/under-insurance.
{
  const res = resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 250, toCountry: 'US' }, upsRate);
  check('carrier >$100 -> NOT carrier_declared_value (capped to parcelguard schedule)', res.status === 'resolved' ? res.provenance : null, 'parcelguard_schedule');
  check('carrier >$100 -> premium is > 0 (excess declared value is priced, not free)', res.status === 'resolved' ? res.amount > 0 : false, true);
}

// ─── 5. Label parity ──────────────────────────────────────────────────────────
const labelInput = (insuranceProvider: string, insuredValue: number | null) => ({
  apiKeyV2: 'test',
  carrierId: 'se-604209',
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
  orderNumber: '170',
});

// Gate ON: effUps resolved to 'carrier', so the direct-UPS HUGRAB label carries carrier
// declared value at $100 — insured for $0. The label is never uninsured (insured_value present).
const gatedBody = buildSsLabelRequestBody(labelInput(effUps.insuranceProvider, effUps.insuredValue)) as any;
check('gate ON -> HUGRAB direct-UPS label insurance_provider is carrier', gatedBody.shipment.insurance_provider, 'carrier');
check('gate ON -> HUGRAB direct-UPS label is NEVER uninsured (insured_value present)', !!gatedBody.shipment.packages[0].insured_value, true);
check('gate ON -> direct-UPS label package insured_value is $100', gatedBody.shipment.packages[0].insured_value, { amount: 100, currency: 'usd' });
// The gate enabled ONLY direct UPS: a brokered (USPS) HUGRAB label still carries ParcelGuard $100.
const uspsBody = buildSsLabelRequestBody({ ...labelInput(effUsps.insuranceProvider, effUsps.insuredValue), carrierId: 'se-433542', serviceCode: 'usps_ground_advantage' }) as any;
check('gate ON -> HUGRAB USPS (brokered) label STILL parcelguard', uspsBody.shipment.insurance_provider, 'parcelguard');
check('gate ON -> HUGRAB USPS label insured_value is $100', uspsBody.shipment.packages[0].insured_value, { amount: 100, currency: 'usd' });

// Builder mechanism: once the gate flips and the resolver returns 'carrier', the payload
// carries carrier declared value at the package level (parity with what was selected).
const carrierBody = buildSsLabelRequestBody(labelInput('carrier', 100)) as any;
check('builder carries carrier provider when selected', carrierBody.shipment.insurance_provider, 'carrier');
check('builder carries carrier declared value at package level', carrierBody.shipment.packages[0].insured_value, { amount: 100, currency: 'usd' });

if (failures > 0) {
  console.error(`\nFAIL PS-170 account-capability insurance guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-170 account-capability insurance guard');
