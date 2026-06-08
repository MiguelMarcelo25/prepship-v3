/**
 * PS-108 guard — ParcelGuard premium is included in the rate total BEFORE best-rate
 * selection, the selected-rate proof carries the insured total, unprovable insurance
 * blocks rather than selecting raw postage, and the shipped-cost backfill planner is
 * correct + idempotent. Pure logic — no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-108-parcelguard-insured-best-rate-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  enrichRatesWithInsuranceCost,
  resolveRateInsurancePremium,
  parcelGuardScheduledPremium,
  insuranceCostConfigFingerprint,
  isRateInsuranceResolved,
} from '../src/services/shipping-workflow/insurance-cost';
import { planParcelGuardBackfillRow } from '../src/services/shipping-workflow/parcelguard-backfill';
import { selectedRateAuthorityKey } from '../src/services/shipping-workflow/rate-fingerprint';

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

// Local mirror of rates.ts rateTotal() — the same insurance-aware sum used by pickBestRate.
function rateTotal(rate: any): number {
  return (
    Number(rate.shipping_amount?.amount ?? 0) +
    Number(rate.confirmation_amount?.amount ?? 0) +
    Number(rate.insurance_amount?.amount ?? 0) +
    Number(rate.other_amount?.amount ?? 0)
  );
}
// Mirror of pickBestRate(): cheapest by insured total, EXCLUDING unresolved-insurance rates.
function pickBest(rates: any[]): any {
  const selectable = rates.filter((r) => isRateInsuranceResolved(r));
  if (!selectable.length) return null;
  return [...selectable].sort((a, b) => rateTotal(a) - rateTotal(b))[0];
}

// ── Observed seed: USPS Ground Advantage, $6.67 postage, estimate insurance_amount=0 ──
// ShipStation's documented ParcelGuard schedule is carrier/category-specific. The
// runtime must not depend on a flat .env premium: USPS domestic is $1.09/$100, while
// non-USPS domestic (UPS/FedEx) is $0.99/$100 and international is $1.39/$100.
process.env.PARCELGUARD_RATE_TIME_SOURCE = 'schedule';
delete process.env.PARCELGUARD_PREMIUM_PER_100;
delete process.env.PARCELGUARD_PREMIUM_MIN;

const groundAdvantage = () => ({
  rate_id: 'r-ground',
  carrier_id: 'se-433542',
  carrier_code: 'stamps_com',
  service_code: 'usps_ground_advantage',
  service_type: 'USPS Ground Advantage',
  shipping_amount: { currency: 'usd', amount: 6.67 },
  insurance_amount: { currency: 'usd', amount: 0 }, // ShipStation estimate omits ParcelGuard
});

const ctx100 = { insuranceProvider: 'parcelguard', insuredValue: 100 };

// 1. Enrichment populates the authoritative premium → total becomes $7.76, not $6.67.
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([groundAdvantage()], ctx100);
  check('enriched: rate is resolved (not blocked)', resolved.length === 1 && unresolved.length === 0, true);
  check('enriched: insurance_amount populated to $1.09', resolved[0]!.insurance_amount?.amount, 1.09);
  check('enriched: insured total via rateTotal = $7.76', Number(rateTotal(resolved[0]).toFixed(2)), 7.76);
  check('enriched: audit provenance present', resolved[0]!.insuranceCost?.provenance, 'parcelguard_schedule');
  check('enriched: not flagged unresolved', isRateInsuranceResolved(resolved[0]), true);
}

// 1b. ParcelGuard schedule is carrier/category-aware and does not rely on .env.
{
  const upsGround = {
    ...groundAdvantage(),
    rate_id: 'r-ups-ground',
    carrier_id: 'se-ups',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
  };
  const fedexGround = {
    ...groundAdvantage(),
    rate_id: 'r-fedex-ground',
    carrier_id: 'se-fedex',
    carrier_code: 'fedex',
    service_code: 'fedex_ground',
    service_type: 'FedEx Ground',
  };
  const { resolved } = enrichRatesWithInsuranceCost([groundAdvantage(), upsGround, fedexGround], ctx100);
  check('schedule: USPS domestic $100 -> $1.09', resolved.find((r) => r.carrier_code === 'stamps_com')?.insurance_amount?.amount, 1.09);
  check('schedule: UPS domestic $100 -> $0.99', resolved.find((r) => r.carrier_code === 'ups')?.insurance_amount?.amount, 0.99);
  check('schedule: FedEx domestic $100 -> $0.99', resolved.find((r) => r.carrier_code === 'fedex')?.insurance_amount?.amount, 0.99);

  const international = enrichRatesWithInsuranceCost([groundAdvantage()], { ...ctx100, toCountry: 'CA' });
  check('schedule: international $100 -> $1.39', international.resolved[0]?.insurance_amount?.amount, 1.39);
}

// 2. pickBestRate must NOT pick a raw postage-only insured rate over the insured total.
//    A competing carrier returns $7.00 postage WITH a real estimate premium already → $7.00.
{
  const cheapPostageNoPremium = groundAdvantage(); // $6.67 postage, ParcelGuard, premium hidden
  const competitor = {
    rate_id: 'r-comp',
    carrier_id: 'se-565326',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    shipping_amount: { currency: 'usd', amount: 7.0 },
    insurance_amount: { currency: 'usd', amount: 0.5 }, // estimate already had a premium
  };
  const { resolved } = enrichRatesWithInsuranceCost([cheapPostageNoPremium, competitor], ctx100);
  const best = pickBest(resolved);
  // ground advantage insured total = 7.76; competitor insured total = 7.50 → competitor wins.
  check('best rate compares INSURED totals (competitor $7.50 < $7.76)', best.carrier_code, 'ups');
  check('best rate is NOT the raw-postage $6.67 illusion', Number(rateTotal(best).toFixed(2)), 7.5);
}

// 3. Selected-rate proof authority key carries the insured total (changes vs postage-only).
{
  const postageOnly = groundAdvantage();
  const { resolved } = enrichRatesWithInsuranceCost([groundAdvantage()], ctx100);
  const keyPostageOnly = selectedRateAuthorityKey(postageOnly);
  const keyInsured = selectedRateAuthorityKey(resolved[0]);
  check('proof key differs once insured total is included', keyPostageOnly !== keyInsured, true);
  check('proof key encodes the $1.09 insurance component', keyInsured.includes('1.0900'), true);
}

// 4. Unprovable insurance BLOCKS the rate (no raw-postage fallback) — requirement #6.
{
  process.env.PARCELGUARD_RATE_TIME_SOURCE = 'block';
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([groundAdvantage()], ctx100);
  check('block mode: insured rate is unresolved, not selectable', resolved.length === 0 && unresolved.length === 1, true);
  check('block mode: pickBest returns null (blocked, not raw postage)', pickBest(resolved), null);
  check('block mode: unresolved carries an explicit error', typeof unresolved[0]!.insuranceCostError === 'string' && unresolved[0]!.insuranceCostError.length > 0, true);
  process.env.PARCELGUARD_RATE_TIME_SOURCE = 'schedule';
}

// 5. Non-insured rates are untouched; estimate-provided premiums are trusted.
{
  const noneCtx = { insuranceProvider: 'none', insuredValue: null };
  const r = resolveRateInsurancePremium(noneCtx, groundAdvantage());
  check('no insurance context -> status none', r.status, 'none');
  const trusted = resolveRateInsurancePremium(ctx100, {
    insurance_amount: { currency: 'usd', amount: 2.25 },
  });
  check('non-zero estimate premium is trusted (shipstation_estimate)', trusted.status === 'resolved' && (trusted as any).amount === 2.25 && (trusted as any).provenance === 'shipstation_estimate', true);
}

// 6. Schedule math + cache-bust fingerprint.
{
  check('schedule: USPS $100 -> 1 increment @1.09', parcelGuardScheduledPremium(100, { carrier_code: 'stamps_com' }), 1.09);
  check('schedule: UPS $250 -> 3 increments @0.99', parcelGuardScheduledPremium(250, { carrier_code: 'ups' }), Number((3 * 0.99).toFixed(2)));
  check('schedule: international $250 -> 3 increments @1.39', parcelGuardScheduledPremium(250, { carrier_code: 'ups' }, 'CA'), Number((3 * 1.39).toFixed(2)));
  const fpA = insuranceCostConfigFingerprint();
  process.env.PARCELGUARD_RATE_TIME_SOURCE = 'block';
  const fpB = insuranceCostConfigFingerprint();
  check('config fingerprint busts cache when source mode changes', fpA !== fpB, true);
  process.env.PARCELGUARD_RATE_TIME_SOURCE = 'schedule';
}

// 7. Backfill planner — seed order #1247 / se-292074298, idempotent.
{
  const localRow = {
    shipmentId: 5001,
    orderId: 1203003,
    orderNumber: '1247',
    ssShipmentId: 292074298,
    cost: 6.67,
    otherCost: 0,
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
  };
  const billed = { postageAmount: 6.67, insuranceAmount: 1.09, totalAmount: 7.76, provenance: 'shipstation_v1_shipment' as const };
  const plan = planParcelGuardBackfillRow(localRow, billed);
  check('backfill: seed #1247 is affected', plan.affected, true);
  check('backfill: would set otherCost to 1.09', plan.updates?.otherCost, '1.09');
  check('backfill: patch totalCost 7.76', plan.updates?.selectedRateJsonPatch.totalCost, 7.76);

  const reconciled = planParcelGuardBackfillRow({ ...localRow, otherCost: 1.09 }, billed);
  check('backfill: idempotent — already reconciled is not affected', reconciled.affected, false);
  check('backfill: already_reconciled reason', reconciled.reason, 'already_reconciled');

  const noPremium = planParcelGuardBackfillRow(localRow, { postageAmount: 6.67, insuranceAmount: 0, totalAmount: 6.67, provenance: 'shipstation_v1_shipment' });
  check('backfill: no premium -> not affected', noPremium.affected, false);
}

// 8. Guardrail: runtime must not read one flat premium env var for all carriers.
{
  const enricherSrc = readFileSync('src/services/shipping-workflow/insurance-cost.ts', 'utf8');
  check('runtime no longer reads flat PARCELGUARD_PREMIUM_PER_100', /PARCELGUARD_PREMIUM_PER_100/.test(enricherSrc), false);
  check('runtime no longer reads flat PARCELGUARD_PREMIUM_MIN', /PARCELGUARD_PREMIUM_MIN/.test(enricherSrc), false);
}

if (failures > 0) {
  console.error(`\nFAIL PS-108 ParcelGuard insured best-rate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-108 ParcelGuard insured best-rate guard');
