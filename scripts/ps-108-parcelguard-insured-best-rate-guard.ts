/**
 * PS-108 guard (updated for PS-125) — ShipStation is the source of truth for the
 * insurance add-on; a positive estimate premium is included in the rate total before
 * best-rate selection and carried into the selected-rate proof. PS-125 supersedes the
 * earlier "block a zero-premium insured rate" rule: a $0 (or omitted) ShipStation
 * insurance add-on is now a VALID resolved $0.00 premium, so the insured rate stays
 * selectable and the real billed cost is reconciled by the shipped-cost backfill
 * planner (still correct + idempotent). Pure logic — no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-108-parcelguard-insured-best-rate-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  enrichRatesWithInsuranceCost,
  resolveRateInsurancePremium,
  insuranceCostConfigFingerprint,
  isRateInsuranceResolved,
} from '../src/services/shipping-workflow/insurance-cost';
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
} from '../src/services/order-rate-dto';
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
// ShipStation is the only source of truth for insurance premiums. PS-125: a zero/missing
// rate-time insurance amount is a VALID $0 add-on (not a block, and never a local
// ParcelGuard schedule). The insured rate stays selectable; purchased labels still use
// ShipStation's billed insurance_cost via the backfill reconciliation path.
delete process.env.PARCELGUARD_RATE_TIME_SOURCE;
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

// 1. PS-126: a zero ShipStation ParcelGuard estimate resolves via the SCHEDULE
//    (USPS $1.09/$100), never blocked.
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([groundAdvantage()], ctx100);
  check('enriched: zero ShipStation estimate is resolved (PS-126)', resolved.length === 1 && unresolved.length === 0, true);
  check('enriched: schedule-priced rate stays selectable', isRateInsuranceResolved(resolved[0]), true);
  check('enriched: USPS schedule premium stamped ($1.09)', resolved[0]?.insurance_amount?.amount, 1.09);
  check('enriched: insuranceCost meta records schedule premium', resolved[0]?.insuranceCost?.amount === 1.09 && resolved[0]?.insuranceCost?.provenance === 'parcelguard_schedule' && resolved[0]?.insuranceCost?.unresolved === false, true);
}

// 1b. A non-zero ShipStation estimate premium is trusted for every carrier.
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
  const shipstationPriced = [groundAdvantage(), upsGround, fedexGround].map((rate, index) => ({
    ...rate,
    insurance_amount: { currency: 'usd', amount: [1.09, 0.99, 0.99][index] },
  }));
  const { resolved, unresolved } = enrichRatesWithInsuranceCost(shipstationPriced, ctx100);
  check('shipstation estimate: all non-zero premiums resolve', resolved.length === 3 && unresolved.length === 0, true);
  check('shipstation estimate: USPS premium is API value', resolved.find((r) => r.carrier_code === 'stamps_com')?.insurance_amount?.amount, 1.09);
  check('shipstation estimate: UPS premium is API value', resolved.find((r) => r.carrier_code === 'ups')?.insurance_amount?.amount, 0.99);
  check('shipstation estimate: FedEx premium is API value', resolved.find((r) => r.carrier_code === 'fedex')?.insurance_amount?.amount, 0.99);
  check('shipstation estimate: provenance is ShipStation', resolved.every((r) => r.insuranceCost?.provenance === 'shipstation_estimate'), true);
}

// 2. PS-126: every insured rate competes on its insured total; cheapest wins. The USPS
//    schedule premium ($1.09) makes the $6.67 USPS rate $7.76, so the $7.50 UPS rate
//    (postage $7.00 + trusted $0.50 estimate) is the cheaper insured total.
{
  const uspsScheduled = groundAdvantage(); // $6.67 postage + $1.09 USPS schedule = $7.76
  const competitor = {
    rate_id: 'r-comp',
    carrier_id: 'se-565326',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    shipping_amount: { currency: 'usd', amount: 7.0 },
    insurance_amount: { currency: 'usd', amount: 0.5 }, // estimate already had a premium
  };
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([uspsScheduled, competitor], ctx100);
  const best = pickBest(resolved);
  check('best rate keeps every insured rate selectable (PS-126)', unresolved.length, 0);
  check('best rate is the cheapest insured total', best.carrier_code, 'ups');
  check('best rate total = postage + insured premium', Number(rateTotal(best).toFixed(2)), 7.5);
}

// 3. Selected-rate proof authority key carries the insured total (changes vs postage-only).
{
  const postageOnly = groundAdvantage();
  const { resolved } = enrichRatesWithInsuranceCost([{ ...groundAdvantage(), insurance_amount: { currency: 'usd', amount: 1.09 } }], ctx100);
  const keyPostageOnly = selectedRateAuthorityKey(postageOnly);
  const keyInsured = selectedRateAuthorityKey(resolved[0]);
  check('proof key differs once insured total is included', keyPostageOnly !== keyInsured, true);
  check('proof key encodes ShipStation insurance component', keyInsured.includes('1.0900'), true);
}

// 4. PS-126: a zero estimate resolves via the schedule and stays selectable (no block).
{
  const { resolved, unresolved } = enrichRatesWithInsuranceCost([groundAdvantage()], ctx100);
  check('insured rate is resolved and selectable', resolved.length === 1 && unresolved.length === 0, true);
  const best = pickBest(resolved);
  check('pickBest returns the resolved rate', best?.carrier_code, 'stamps_com');
  check('resolved rate carries the USPS schedule premium ($1.09)', best?.insurance_amount?.amount, 1.09);
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

// 6. Cache fingerprint reflects the PS-126 schedule policy (busts on schedule change).
{
  check('insurance fingerprint reflects PS-171 schedule policy', insuranceCostConfigFingerprint(), 'parcelguard-schedule-shipstation-parcelguard-2026-06-10-v2');
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

// 8. PS-126: runtime carries the carrier/country ParcelGuard SCHEDULE (the rate-time
//    premium source), and still does NOT read the removed flat per-100 env vars.
{
  const enricherSrc = readFileSync('src/services/shipping-workflow/insurance-cost.ts', 'utf8');
  check('runtime does not read flat PARCELGUARD_PREMIUM_PER_100', /PARCELGUARD_PREMIUM_PER_100/.test(enricherSrc), false);
  check('runtime does not read flat PARCELGUARD_PREMIUM_MIN', /PARCELGUARD_PREMIUM_MIN/.test(enricherSrc), false);
  check('runtime HAS the ParcelGuard schedule provenance', /parcelguard_schedule/.test(enricherSrc), true);
  check('runtime HAS the scheduled premium helper', /parcelGuardScheduledPremium/.test(enricherSrc), true);
  check('runtime HAS the USPS $1.09 schedule rate', /1\.09/.test(enricherSrc), true);
  check('runtime HAS the non-USPS $0.99 schedule rate', /0\.99/.test(enricherSrc), true);
  check('runtime HAS the international $1.39 schedule rate', /1\.39/.test(enricherSrc), true);
}

// 9. Backend DTOs expose ShipStation insurance add-ons for frontend display.
{
  const bestRateDto = normalizeOrderBestRateDto({
    carrier_code: 'stamps_com',
    service_code: 'usps_ground_advantage',
    shipping_amount: { currency: 'usd', amount: 6.67 },
    insurance_amount: { currency: 'usd', amount: 1.09 },
    insuranceCost: {
      amount: 1.09,
      provenance: 'shipstation_estimate',
      confirmed: true,
      unresolved: false,
    },
  });
  check('best-rate DTO preserves backend insurance add-on amount', bestRateDto?.insuranceCost, 1.09);
  check('best-rate DTO preserves backend insurance provenance', bestRateDto?.insuranceProvenance, 'shipstation_estimate');

  const selectedRateDto = normalizeOrderSelectedRateDto({
    providerAccountId: 123,
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    shipmentCost: 6.67,
    otherCost: 1.09,
    insuranceCost: 1.09,
    insuranceProvenance: 'shipstation_v2_label',
    totalCost: 7.76,
  });
  check('selected-rate DTO preserves backend billed insurance add-on', selectedRateDto?.insuranceCost, 1.09);
  check('selected-rate DTO preserves backend billed total', selectedRateDto?.totalCost, 7.76);

  const ordersViewSrc = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  check('OrdersView renders insurance add-on from backend DTO field', /insuranceCost/.test(ordersViewSrc) && /Insurance/.test(ordersViewSrc), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-108 ParcelGuard insured best-rate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-108 ParcelGuard insured best-rate guard');
