/**
 * PS-262b guard — a direct carrier that can't buy insurance never ships uninsured.
 *
 * ParcelGuard is a ShipStation-only product; a direct (non-ShipStation) carrier must
 * not resolve to it. Walmart Shipping hardcodes insurance:false, so it would silently
 * ship an insured (HUGRAB) order UNINSURED. Now: the capability resolver returns
 * 'blocked' for Walmart Shipping, and eligibility refuses an INSURED order on a
 * blocked-capability carrier (rather than shipping uninsured / faking ParcelGuard).
 *
 * Scope note: Shipp/EasyPost (they DO insure) + direct FedEx (self-blocks via its
 * connector assert; bare `fedex` can't be told from ShipStation FedEx by code alone)
 * are intentionally deferred to PS-261's per-provider proof+pricing model. This guard
 * pins the Walmart-Shipping safety fix only.
 *
 *   npx tsx scripts/ps-262b-direct-carrier-insurance-guard.ts
 */
import { resolveAccountInsuranceCapability } from '../src/lib/carrier-account-registry';
import { evaluateShippingServiceEligibility } from '../src/lib/shipping-service-eligibility';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── Capability resolver ──────────────────────────────────────────────────────
check('Walmart Shipping resolves to blocked (never parcelguard)',
  resolveAccountInsuranceCapability({ carrierCode: 'walmart_shipping' }).required === 'blocked');
check('direct UPS stays carrier', resolveAccountInsuranceCapability({ carrierCode: 'ups' }).required === 'carrier');
check('ShipStation-brokered ups_walleted stays parcelguard',
  resolveAccountInsuranceCapability({ carrierCode: 'ups_walleted' }).required === 'parcelguard');
check('Ground Saver still blocked',
  resolveAccountInsuranceCapability({ carrierCode: 'ups', serviceCode: 'ups_ground_saver' }).required === 'blocked');
// Deferred-to-PS-261 carriers still insure (not blocked, not broken).
check('Shipp not blocked (deferred to PS-261)', resolveAccountInsuranceCapability({ carrierCode: 'shipp' }).required !== 'blocked');

// ── Eligibility enforcement ──────────────────────────────────────────────────
const svc = (carrierCode: string) => ({ carrierCode, carrierId: null, serviceCode: 'std' });
const insured = { insuranceProvider: 'parcelguard', insuredValue: 100 };
const uninsured = { insuranceProvider: 'none', insuredValue: 0 };

const wmInsured = evaluateShippingServiceEligibility(null, svc('walmart_shipping') as never, insured as never);
check('INSURED order on Walmart Shipping is BLOCKED',
  wmInsured.allowed === false && wmInsured.ruleId === 'insurance-unsupported-carrier');

const wmUninsured = evaluateShippingServiceEligibility(null, svc('walmart_shipping') as never, uninsured as never);
check('UNINSURED order on Walmart Shipping is allowed', wmUninsured.allowed === true);

const upsInsured = evaluateShippingServiceEligibility(null, svc('ups') as never, insured as never);
check('INSURED order on direct UPS is allowed (it insures)', upsInsured.allowed === true);

const shippInsured = evaluateShippingServiceEligibility(null, svc('shipp') as never, insured as never);
check('INSURED order on Shipp is allowed (deferred, still insures)', shippInsured.allowed === true);

if (failures > 0) {
  console.error(`\nFAIL PS-262b direct-carrier insurance guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-262b direct-carrier insurance guard');
