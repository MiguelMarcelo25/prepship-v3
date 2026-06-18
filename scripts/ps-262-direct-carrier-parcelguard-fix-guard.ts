/**
 * PS-262 guard — a DIRECT (non-ShipStation) carrier NEVER resolves to ParcelGuard.
 *
 * ParcelGuard is a ShipStation-only product; resolving a direct carrier to it would
 * silently ship an insured (HUGRAB) order UNINSURED. This guard pins the canary
 * generalization of the PS-262b Walmart point fix:
 *   - When DIRECT_CARRIER_PARCELGUARD_FIX is ON, every direct carrier resolves to
 *     'carrier' (audited to insure) or 'blocked' (cannot) — never 'parcelguard'.
 *   - ShipStation-brokered accounts (*_walleted / stamps_com / usps) STILL resolve
 *     to 'parcelguard' unchanged.
 *   - When the flag is OFF, the resolver output is BYTE-IDENTICAL to today (PS-262b
 *     Walmart block + PS-170 UPS gate + ParcelGuard fallback).
 *
 * Pure / offline — passes explicit flags, never touches env/DB/providers.
 *
 *   npx tsx scripts/ps-262-direct-carrier-parcelguard-fix-guard.ts
 */
import {
  resolveAccountInsuranceCapability,
  type AccountInsuranceCapability,
  type DirectCarrierParcelGuardFlags,
} from '../src/lib/carrier-account-registry';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const OFF: DirectCarrierParcelGuardFlags = {
  directCarrierParcelGuardFix: false,
  easyPostInsuranceVerified: false,
  shippInsuranceVerified: false,
};
const ON_UNVERIFIED: DirectCarrierParcelGuardFlags = {
  directCarrierParcelGuardFix: true,
  easyPostInsuranceVerified: false,
  shippInsuranceVerified: false,
};
const ON_VERIFIED: DirectCarrierParcelGuardFlags = {
  directCarrierParcelGuardFix: true,
  easyPostInsuranceVerified: true,
  shippInsuranceVerified: true,
};

// Direct (non-ShipStation) carrier codes the audit covers / the connector registry knows.
const DIRECT_CARRIER_CODES = [
  'shipp',
  'easypost',
  'walmart_shipping',
  'ebay_shipping',
  'amazon_shipping',
];

// ShipStation-brokered / non-direct accounts that must KEEP ParcelGuard.
const BROKERED_CODES = ['ups_walleted', 'fedex_walleted', 'stamps_com', 'usps'];

const insuredHugrab = { carrierCode: '', serviceCode: 'std' };

// ── 1. Flag ON: every direct carrier resolves in {carrier, blocked}, NEVER parcelguard ──
for (const code of DIRECT_CARRIER_CODES) {
  const cap = resolveAccountInsuranceCapability({ carrierCode: code, serviceCode: 'std' }, ON_VERIFIED);
  check(`ON: direct '${code}' resolves to carrier|blocked, never parcelguard`,
    (cap.required === 'carrier' || cap.required === 'blocked') && cap.required !== 'parcelguard');
}
// Unverified ON: the audited-insuring connectors fall to BLOCKED (never parcelguard, never silent).
check('ON+unverified: easypost is blocked (not parcelguard)',
  resolveAccountInsuranceCapability({ carrierCode: 'easypost' }, ON_UNVERIFIED).required === 'blocked');
check('ON+unverified: shipp is blocked (not parcelguard)',
  resolveAccountInsuranceCapability({ carrierCode: 'shipp' }, ON_UNVERIFIED).required === 'blocked');
// Verified ON: they earn 'carrier'.
check('ON+verified: easypost resolves to carrier',
  resolveAccountInsuranceCapability({ carrierCode: 'easypost' }, ON_VERIFIED).required === 'carrier');
check('ON+verified: shipp resolves to carrier',
  resolveAccountInsuranceCapability({ carrierCode: 'shipp' }, ON_VERIFIED).required === 'carrier');
// Walmart family stays blocked (audit: insurance:false) regardless of verify flags.
check('ON: walmart_shipping is blocked',
  resolveAccountInsuranceCapability({ carrierCode: 'walmart_shipping' }, ON_VERIFIED).required === 'blocked');

// ── 2. HUGRAB direct order stays insured ('carrier') OR blocked — never silent parcelguard ──
for (const code of DIRECT_CARRIER_CODES) {
  const cap = resolveAccountInsuranceCapability({ ...insuredHugrab, carrierCode: code }, ON_VERIFIED);
  check(`ON: HUGRAB on direct '${code}' is insured-or-blocked (never parcelguard)`,
    cap.required === 'carrier' || cap.required === 'blocked');
}

// ── 3. ShipStation-brokered accounts STILL resolve to parcelguard (flag ON) ──
for (const code of BROKERED_CODES) {
  const cap = resolveAccountInsuranceCapability({ carrierCode: code }, ON_VERIFIED);
  check(`ON: brokered '${code}' stays parcelguard`, cap.required === 'parcelguard');
}

// ── 4. Flag OFF: resolver output is BYTE-IDENTICAL to today's behavior ──
// Frozen snapshot of the CURRENT (pre-flag) resolver output. Any drift fails the guard.
const eq = (a: AccountInsuranceCapability, b: AccountInsuranceCapability) =>
  a.required === b.required && a.carrierPurchasable === b.carrierPurchasable && a.reason === b.reason;

const OFF_EXPECTED: Array<{ input: Parameters<typeof resolveAccountInsuranceCapability>[0]; expected: AccountInsuranceCapability }> = [
  { input: { carrierCode: 'ups' }, expected: { required: 'carrier', carrierPurchasable: true, reason: 'Direct UPS account — carrier declared value purchasable' } },
  { input: { carrierCode: 'walmart_shipping' }, expected: { required: 'blocked', carrierPurchasable: false, reason: 'Walmart Shipping cannot purchase insurance (insurance:false) — insured shipping blocked' } },
  { input: { carrierCode: 'shipp' }, expected: { required: 'parcelguard', carrierPurchasable: false, reason: 'shipp — ShipStation-brokered or non-direct account, ParcelGuard only' } },
  { input: { carrierCode: 'easypost' }, expected: { required: 'parcelguard', carrierPurchasable: false, reason: 'easypost — ShipStation-brokered or non-direct account, ParcelGuard only' } },
  { input: { carrierCode: 'ups_walleted' }, expected: { required: 'parcelguard', carrierPurchasable: false, reason: 'upswalleted — ShipStation-brokered or non-direct account, ParcelGuard only' } },
  { input: { carrierCode: 'stamps_com' }, expected: { required: 'parcelguard', carrierPurchasable: false, reason: 'stampscom — ShipStation-brokered or non-direct account, ParcelGuard only' } },
  { input: { carrierCode: 'ups', serviceCode: 'ups_ground_saver' }, expected: { required: 'blocked', carrierPurchasable: false, reason: 'Ground Saver / SurePost — insurance unavailable (PS-057)' } },
  { input: { carrierCode: '' }, expected: { required: 'parcelguard', carrierPurchasable: false, reason: 'Unknown account — ParcelGuard only' } },
];

for (const { input, expected } of OFF_EXPECTED) {
  const explicit = resolveAccountInsuranceCapability(input, OFF);
  check(`OFF (explicit): '${input.carrierCode}'${input.serviceCode ? '/' + input.serviceCode : ''} byte-identical`, eq(explicit, expected));
}

// Also assert the env-default path (no flags injected, flag unset in env) matches OFF.
const priorFix = process.env.DIRECT_CARRIER_PARCELGUARD_FIX;
delete process.env.DIRECT_CARRIER_PARCELGUARD_FIX;
for (const { input, expected } of OFF_EXPECTED) {
  const viaEnv = resolveAccountInsuranceCapability(input);
  check(`OFF (env-default): '${input.carrierCode}'${input.serviceCode ? '/' + input.serviceCode : ''} byte-identical`, eq(viaEnv, expected));
}
if (priorFix !== undefined) process.env.DIRECT_CARRIER_PARCELGUARD_FIX = priorFix;

if (failures > 0) {
  console.error(`\nFAIL PS-262 direct-carrier ParcelGuard fix guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-262 direct-carrier ParcelGuard fix guard');
