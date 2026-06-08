/**
 * PS-125 guard — a $0 (or omitted) ShipStation ParcelGuard insurance add-on is a VALID
 * resolved premium for HUGRAB best-rate selection, NOT an unresolved/excluded error.
 * A positive estimate is still trusted. Explicit zero must never be unresolved, and the
 * insured rate must remain selectable with the $0 add-on preserved for display/proof.
 * Pure logic — no DB, no network, no postage, no labels, no order mutation.
 *
 *   npx tsx scripts/ps-125-hugrab-zero-insurance-premium-guard.ts
 */
import { readFileSync } from 'node:fs';
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
// USPS Ground Advantage, $6.67 postage — ShipStation estimate typically omits the
// ParcelGuard add-on (returns 0 / nothing) for this insured rate.
const base = (): any => ({
  rate_id: 'r-ground',
  carrier_id: 'se-433542',
  carrier_code: 'stamps_com',
  service_code: 'usps_ground_advantage',
  service_type: 'USPS Ground Advantage',
  shipping_amount: { currency: 'usd', amount: 6.67 },
});

// 1. explicit numeric 0 -> resolved $0
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: { currency: 'usd', amount: 0 } });
  check('explicit 0 -> resolved', r.status, 'resolved');
  check('explicit 0 -> amount 0', r.status === 'resolved' ? r.amount : r.status, 0);
}
// 2. string '0' -> resolved $0
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: { currency: 'usd', amount: '0' as any } });
  check("'0' -> resolved $0", r.status === 'resolved' ? r.amount : r.status, 0);
}
// 3. 0.00 -> resolved $0
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: { currency: 'usd', amount: 0.0 } });
  check('0.00 -> resolved $0', r.status === 'resolved' ? r.amount : r.status, 0);
}
// 4. omitted insurance_amount -> resolved $0 (documented: no add-on at rate time)
{
  const r = resolveRateInsurancePremium(ctx100, base());
  check('omitted amount -> resolved $0', r.status === 'resolved' ? r.amount : r.status, 0);
}
// 5. null insurance_amount -> resolved $0
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: null });
  check('null amount -> resolved $0', r.status === 'resolved' ? r.amount : r.status, 0);
}
// 6. positive estimate is still trusted as-is
{
  const r = resolveRateInsurancePremium(ctx100, { ...base(), insurance_amount: { currency: 'usd', amount: 1.09 } });
  check('positive -> resolved 1.09', r.status === 'resolved' ? r.amount : r.status, 1.09);
  check('positive -> provenance shipstation_estimate', r.status === 'resolved' ? r.provenance : r.status, 'shipstation_estimate');
}
// 7. not insured is unchanged
{
  const r = resolveRateInsurancePremium({ insuranceProvider: 'none', insuredValue: 0 }, base());
  check('not insured -> none', r.status, 'none');
}
// 8. enrich keeps a zero-premium insured rate selectable (NOT excluded)
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([{ ...base(), insurance_amount: { currency: 'usd', amount: 0 } }], ctx100);
  check('enrich: zero-premium NOT excluded', resolved.length === 1 && unresolved.length === 0, true);
  check('enrich: zero-premium selectable', isRateInsuranceResolved(resolved[0]), true);
  check('enrich: $0 add-on stamped on insurance_amount', resolved[0]?.insurance_amount?.amount, 0);
  check('enrich: meta records $0 add-on, not unresolved', resolved[0]?.insuranceCost?.amount === 0 && resolved[0]?.insuranceCost?.unresolved === false, true);
}
// 9. best-rate total includes the $0 add-on with no NaN/null/unavailable
{
  const { resolved } = enrichRatesWithInsuranceCost([{ ...base(), insurance_amount: { currency: 'usd', amount: 0 } }], ctx100);
  const total = Number(resolved[0]?.shipping_amount?.amount ?? NaN) + Number(resolved[0]?.insurance_amount?.amount ?? NaN);
  check('best total = postage + $0 (finite)', Number.isFinite(total) ? Number(total.toFixed(2)) : 'NaN', 6.67);
}
// 10. saved best-rate DTO preserves the $0 add-on (folded into otherCost = +0, no double count)
{
  const dto = normalizeOrderBestRateDto({
    carrier_code: 'stamps_com',
    service_code: 'usps_ground_advantage',
    shipping_amount: { currency: 'usd', amount: 6.67 },
    insurance_amount: { currency: 'usd', amount: 0 },
  });
  check('DTO shipmentCost 6.67', dto?.shipmentCost, 6.67);
  check('DTO otherCost includes $0 insurance', dto?.otherCost, 0);
  check('DTO total = 6.67 (no NaN)', dto ? Number((dto.shipmentCost + dto.otherCost).toFixed(2)) : null, 6.67);
}
// 11. non-HUGRAB / other insured provider: positive estimate still trusted
{
  const r = resolveRateInsurancePremium({ insuranceProvider: 'carrier', insuredValue: 200 }, { ...base(), insurance_amount: { currency: 'usd', amount: 3.5 } });
  check('other provider positive -> resolved 3.5', r.status === 'resolved' ? r.amount : r.status, 3.5);
}
// 12. consistency: runtime carries no local ParcelGuard schedule + fingerprint is the zero-ok policy
{
  const src = readFileSync('src/services/shipping-workflow/insurance-cost.ts', 'utf8');
  check('runtime has no scheduled premium helper', /parcelGuardScheduledPremium/.test(src), false);
  check('runtime has no schedule provenance', /parcelguard_schedule/.test(src), false);
  check('fingerprint is PS-125 zero-ok policy', insuranceCostConfigFingerprint(), 'shipstation-api-insurance-v2-zero-ok');
}

if (failures > 0) {
  console.error(`\nFAIL PS-125 HUGRAB zero insurance premium guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-125 HUGRAB zero insurance premium guard');
