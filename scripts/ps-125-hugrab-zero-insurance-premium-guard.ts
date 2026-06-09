/**
 * PS-125 guard — an insured (ParcelGuard/HUGRAB) rate is NEVER blocked/excluded for a
 * zero/omitted ShipStation estimate: it always RESOLVES (never `unresolved`), stays
 * selectable, and carries a finite premium for display/proof so the best-rate total is
 * never NaN/null/unavailable.
 *
 * The SPECIFIC premium amount is owned by PS-126 (the ParcelGuard carrier/country
 * schedule) and asserted in the PS-126 guard. PS-125 here only protects the anti-block
 * invariant — amount-agnostic — so a future amount-policy change can't reintroduce
 * excluded/blocked insured rates. Pure logic — no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-125-hugrab-zero-insurance-premium-guard.ts
 */
import {
  resolveRateInsurancePremium,
  enrichRatesWithInsuranceCost,
  isRateInsuranceResolved,
  insuranceCostConfigFingerprint,
} from '../src/services/shipping-workflow/insurance-cost';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';

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

const ctx100 = { insuranceProvider: 'parcelguard', insuredValue: 100, toCountry: 'US' };
const base = (): any => ({
  rate_id: 'r-ground',
  carrier_id: 'se-433542',
  carrier_code: 'stamps_com',
  service_code: 'usps_ground_advantage',
  service_type: 'USPS Ground Advantage',
  shipping_amount: { currency: 'usd', amount: 6.67 },
});
const resolvedFinite = (r: any): boolean =>
  r.status === 'resolved' && typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount >= 0;

// 1-5. zero / '0' / 0.00 / omitted / null insured estimate -> ALWAYS resolved (never
//      unresolved), with a finite >= 0 premium. Amount value is PS-126's concern.
const zeroish: Array<[string, any]> = [
  ['explicit 0', { currency: 'usd', amount: 0 }],
  ["string '0'", { currency: 'usd', amount: '0' }],
  ['0.00', { currency: 'usd', amount: 0.0 }],
  ['omitted', undefined],
  ['null', null],
];
for (const [label, ins] of zeroish) {
  const rate = ins === undefined ? base() : { ...base(), insurance_amount: ins };
  const r = resolveRateInsurancePremium(ctx100, rate);
  check(`${label} -> resolved (never unresolved)`, r.status, 'resolved');
  check(`${label} -> finite premium >= 0`, resolvedFinite(r), true);
}

// 6. positive estimate is trusted verbatim
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: { currency: 'usd', amount: 2.25 } });
  check('positive estimate trusted', r.status === 'resolved' ? r.amount : r.status, 2.25);
  check('positive provenance shipstation_estimate', r.status === 'resolved' ? r.provenance : r.status, 'shipstation_estimate');
}

// 7. not insured -> none
{
  const r = resolveRateInsurancePremium({ insuranceProvider: 'none', insuredValue: 0 }, base());
  check('not insured -> none', r.status, 'none');
}

// 8. enrich NEVER excludes an insured rate (the core PS-125 anti-block guarantee)
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([{ ...base(), insurance_amount: { currency: 'usd', amount: 0 } }], ctx100);
  check('enrich: insured rate NOT excluded', resolved.length === 1 && unresolved.length === 0, true);
  check('enrich: selectable', isRateInsuranceResolved(resolved[0]), true);
  check('enrich: meta resolved (not unresolved), finite amount', resolved[0]?.insuranceCost?.unresolved === false && typeof resolved[0]?.insuranceCost?.amount === 'number', true);
  check('enrich: insurance_amount stamped (finite)', typeof resolved[0]?.insurance_amount?.amount === 'number' && Number.isFinite(resolved[0]?.insurance_amount?.amount), true);
}

// 9. best-rate total is finite (no NaN/null/unavailable) regardless of premium
{
  const { resolved } = enrichRatesWithInsuranceCost([{ ...base(), insurance_amount: { currency: 'usd', amount: 0 } }], ctx100);
  const total = Number(resolved[0]?.shipping_amount?.amount ?? NaN) + Number(resolved[0]?.insurance_amount?.amount ?? NaN);
  check('best total finite (no NaN)', Number.isFinite(total), true);
}

// 10. saved best-rate DTO folds the insurance add-on into otherCost (no double-count / NaN)
{
  const dto = normalizeOrderBestRateDto({
    carrier_code: 'stamps_com',
    service_code: 'usps_ground_advantage',
    shipping_amount: { currency: 'usd', amount: 6.67 },
    insurance_amount: { currency: 'usd', amount: 1.09 },
  });
  check('DTO shipmentCost 6.67', dto?.shipmentCost, 6.67);
  check('DTO otherCost folds insurance (1.09)', dto?.otherCost, 1.09);
  check('DTO total finite (7.76)', dto ? Number((dto.shipmentCost + dto.otherCost).toFixed(2)) : null, 7.76);
}

// 11. other insured provider: positive estimate trusted
{
  const r = resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 200 }, { ...base(), insurance_amount: { currency: 'usd', amount: 3.5 } });
  check('other provider positive trusted', r.status === 'resolved' ? r.amount : r.status, 3.5);
}

// 12. fingerprint is a non-empty policy string (busts the cache on policy change)
{
  const fp = insuranceCostConfigFingerprint();
  check('fingerprint is a non-empty policy string', typeof fp === 'string' && fp.length > 0, true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-125 insured-rate anti-block guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-125 insured-rate anti-block guard');
