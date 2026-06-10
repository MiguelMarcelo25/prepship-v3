/**
 * PS-126 guard — when ShipStation's /v2/rates/estimate returns insurance_amount: 0 for
 * ParcelGuard (which it always does), PrepShip supplies the rate-time premium from the
 * verified carrier/country ParcelGuard SCHEDULE: USPS domestic $1.09/$100, non-USPS
 * domestic $0.99/$100, international $1.39/$100. A positive ShipStation estimate is
 * still trusted verbatim. Insured rates are never blocked. Pure logic — no DB, no
 * network, no postage, no labels, no order mutation.
 *
 *   npx tsx scripts/ps-126-parcelguard-schedule-premium-guard.ts
 */
import {
  resolveRateInsurancePremium,
  enrichRatesWithInsuranceCost,
  isRateInsuranceResolved,
  insuranceCostConfigFingerprint,
  parcelGuardScheduledPremium,
} from '../src/services/shipping-workflow/insurance-cost';

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

const us100 = { insuranceProvider: 'parcelguard', insuredValue: 100, toCountry: 'US' };
const usps = (): any => ({ carrier_code: 'usps', insurance_amount: { currency: 'usd', amount: 0 } });
const stamps = (): any => ({ carrier_code: 'stamps_com', insurance_amount: { currency: 'usd', amount: 0 } });
const ups = (): any => ({ carrier_code: 'ups', insurance_amount: { currency: 'usd', amount: 0 } });
const fedex = (): any => ({ carrier_code: 'fedex', insurance_amount: { currency: 'usd', amount: 0 } });
const amountOf = (r: any) => (r.status === 'resolved' ? r.amount : r.status);

// 1. Schedule by carrier/country (estimate 0 -> computed premium)
check('USPS $100 -> $1.09', amountOf(resolveRateInsurancePremium(us100, usps())), 1.09);
check('stamps_com $100 -> $1.09 (USPS family)', amountOf(resolveRateInsurancePremium(us100, stamps())), 1.09);
check('UPS $100 -> $0.99 (non-USPS)', amountOf(resolveRateInsurancePremium(us100, ups())), 0.99);
check('FedEx $100 -> $0.99 (non-USPS)', amountOf(resolveRateInsurancePremium(us100, fedex())), 0.99);
check('International $100 -> $1.39', amountOf(resolveRateInsurancePremium({ ...us100, toCountry: 'CA' }, ups())), 1.39);

// 1b. PS-171 — service-aware: FedEx Ground Economy / Parcel Select / SmartPost bill at the postal/economy
// $1.09 tier, NOT the generic non-USPS $0.99 — even though carrier_code is 'fedex'. Normal FedEx Ground
// must stay $0.99 (no over-match).
const fedexGroundEconomy = (): any => ({ carrier_code: 'fedex', service_code: 'fedex_ground_economy_parcel_select', service_name: 'FedEx Ground® Economy Parcel Select', insurance_amount: { currency: 'usd', amount: 0 } });
const fedexGroundEconomyWalmart = (): any => ({ carrier_code: 'fedex', service_code: 'walmart_shipping_fedex_fedex_ground_economy', service_name: 'FedEx FedEx Ground Economy', insurance_amount: { currency: 'usd', amount: 0 } });
const fedexSmartPost = (): any => ({ carrier_code: 'fedex', service_code: 'easypost_fedex_fedexdefault_smart_post', service_name: 'FedExDefault SMART_POST', insurance_amount: { currency: 'usd', amount: 0 } });
const fedexGroundNormal = (): any => ({ carrier_code: 'fedex', service_code: 'fedex_ground', service_name: 'FedEx Ground', insurance_amount: { currency: 'usd', amount: 0 } });
check('FedEx Ground Economy Parcel Select $100 -> $1.09 (postal/economy tier)', amountOf(resolveRateInsurancePremium(us100, fedexGroundEconomy())), 1.09);
check('FedEx Ground Economy (Walmart) $100 -> $1.09', amountOf(resolveRateInsurancePremium(us100, fedexGroundEconomyWalmart())), 1.09);
check('FedEx SmartPost $100 -> $1.09', amountOf(resolveRateInsurancePremium(us100, fedexSmartPost())), 1.09);
check('normal FedEx Ground $100 -> $0.99 (NOT over-matched)', amountOf(resolveRateInsurancePremium(us100, fedexGroundNormal())), 0.99);
// #1440 screenshot parity: base $7.07 + ParcelGuard $1.09 = $8.16 (was $8.06 under the $0.99 bug).
check('FedEx Ground Economy rate-total: 7.07 + 1.09 = 8.16', Number((7.07 + Number(amountOf(resolveRateInsurancePremium(us100, fedexGroundEconomy())))).toFixed(2)), 8.16);

// 2. Increments: ceil(value/100) * perHundred
check('USPS $250 -> $3.27 (3 x 1.09)', amountOf(resolveRateInsurancePremium({ ...us100, insuredValue: 250 }, usps())), 3.27);
check('UPS $201 -> $2.97 (3 x 0.99)', amountOf(resolveRateInsurancePremium({ ...us100, insuredValue: 201 }, ups())), 2.97);

// 3. Provenance + confirmed flag for scheduled premium
{
  const r: any = resolveRateInsurancePremium(us100, usps());
  check('scheduled premium provenance', r.provenance, 'parcelguard_schedule');
  check('scheduled premium is unconfirmed (estimate)', r.confirmed, false);
}

// 4. Positive ShipStation estimate is trusted verbatim (NOT overwritten by schedule)
check('positive estimate trusted ($2.50)', amountOf(resolveRateInsurancePremium(us100, { ...usps(), insurance_amount: { currency: 'usd', amount: 2.5 } })), 2.5);

// 5. Non-ParcelGuard provider with zero estimate -> $0 (no schedule applied)
check('carrier provider zero -> $0 (no schedule)', amountOf(resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 100 }, usps())), 0);

// 6. Not insured -> none
check('not insured -> none', resolveRateInsurancePremium({ insuranceProvider: 'none', insuredValue: 0 }, usps()).status, 'none');

// 7. enrich: all insured rates resolved with their schedule premium, none excluded
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([usps(), ups(), fedex()], us100);
  check('enrich: all resolved, none excluded', resolved.length === 3 && unresolved.length === 0, true);
  check('enrich: all selectable', resolved.every((r: any) => isRateInsuranceResolved(r)), true);
  check('enrich: USPS stamped $1.09', resolved.find((r: any) => r.carrier_code === 'usps')?.insurance_amount?.amount, 1.09);
  check('enrich: UPS stamped $0.99', resolved.find((r: any) => r.carrier_code === 'ups')?.insurance_amount?.amount, 0.99);
}

// 8. Helper guards (edge cases never throw / never negative)
check('schedule: value <= 0 -> null', parcelGuardScheduledPremium(0, usps(), 'US'), null);
check('schedule: missing carrier -> null', parcelGuardScheduledPremium(100, {}, 'US'), null);

// 9. Fingerprint reflects the schedule policy (cache busts on schedule change)
check('fingerprint is the PS-171 schedule policy (bumped to bust stale $0.99 FedEx-economy cache)', insuranceCostConfigFingerprint(), 'parcelguard-schedule-shipstation-parcelguard-2026-06-10-v2');

if (failures > 0) {
  console.error(`\nFAIL PS-126 ParcelGuard schedule premium guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-126 ParcelGuard schedule premium guard');
