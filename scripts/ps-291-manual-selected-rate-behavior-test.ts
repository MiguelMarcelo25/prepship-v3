/**
 * PS-291 — REAL EXECUTION test for the manual New-Order selected-rate builder.
 *
 * The existing ps-291 guards regex the route SOURCE; they never EXECUTE the flow, so a
 * behavioral regression (wrong cost fallback, dropped provenance, a hand-rolled bestRate that
 * skips the canonical normalizer) would pass them. This test INVOKES
 * buildManualSelectedBestRate with representative modal selections and asserts the resulting
 * canonical OrderBestRateDto — the bestRateJson that Create Label / Print Queue later reuse
 * WITHOUT a silent re-rate (card DoD item 6).
 *
 * Pure + deterministic (no DB / server). Run: npm run test:ps-291-manual-selected-rate-behavior
 */
import { buildManualSelectedBestRate } from '../src/routes/orders/manual-selected-rate';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// 1. No selection → no best rate (never invents one).
check('null selection returns null', buildManualSelectedBestRate(null) === null);
check('undefined selection returns null', buildManualSelectedBestRate(undefined) === null);

// 2. Empty/meaningless selection → null (the normalizer's meaningful-field gate; the builder
//    must not persist an all-null/$0 "rate" that would mislead Create Label).
check('empty selection returns null (no usable carrier/service/cost)',
  buildManualSelectedBestRate({}) === null);

// 3. Full selection → canonical DTO carrying the operator's chosen rate verbatim.
const full = buildManualSelectedBestRate({
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  serviceName: 'UPS Ground',
  carrierNickname: 'Main UPS',
  shippingProviderId: 42,
  shipmentCost: 8.5,
  otherCost: 1.25,
});
check('full selection returns a DTO', full != null);
check('full: carrierCode echoed verbatim', full?.carrierCode === 'ups', full?.carrierCode);
check('full: serviceCode echoed verbatim', full?.serviceCode === 'ups_ground', full?.serviceCode);
check('full: carrierNickname (Rate Browser parity) preserved', full?.carrierNickname === 'Main UPS', full?.carrierNickname);
check('full: shippingProviderId preserved for label reuse', full?.shippingProviderId === 42, full?.shippingProviderId);
check('full: shipmentCost is the quoted postage (not recomputed)', full?.shipmentCost === 8.5, full?.shipmentCost);
check('full: otherCost is the quoted surcharge', full?.otherCost === 1.25, full?.otherCost);
check('full: totalCost = shipmentCost + otherCost', full?.totalCost === 9.75, full?.totalCost);

// 4. Provenance — the persisted rate is stamped manual_preview (NOT rate_browser / null), so
//    downstream readers know it came from the confirmed modal preview, not a re-rate.
check('full: proofSource provenance is manual_preview', full?.proofSource === 'manual_preview', full?.proofSource);

// 5. Delegation — the DTO carries the canonical normalizer's derived fields
//    (cShippingRateAmount / selectedRateCost — renamed from customerRateAmount /
//    rateCostAmount by e9762409). A hand-rolled object would lack them; their
//    presence proves the builder delegates to normalizeOrderBestRateDto (ARCHITECTURE.md:
//    rate truth lives in order-rate-dto.ts; callers must not re-derive).
check('full: delegates to the canonical normalizer (cShippingRateAmount derived)',
  full?.cShippingRateAmount === 9.75, full?.cShippingRateAmount);
check('full: delegates to the canonical normalizer (selectedRateCost derived)',
  full?.selectedRateCost === 9.75, full?.selectedRateCost);

// 6. Cost fallback — when the modal carried only the summed `cost` (no split shipmentCost),
//    the postage falls back to that total so the rate is still usable.
const costOnly = buildManualSelectedBestRate({
  carrierCode: 'usps',
  serviceCode: 'usps_priority',
  cost: 7.3,
});
check('cost-only selection returns a DTO', costOnly != null);
check('cost-only: shipmentCost falls back to the summed total', costOnly?.shipmentCost === 7.3, costOnly?.shipmentCost);
check('cost-only: otherCost defaults to 0', costOnly?.otherCost === 0, costOnly?.otherCost);
check('cost-only: totalCost equals the carried total', costOnly?.totalCost === 7.3, costOnly?.totalCost);
check('cost-only: proofSource provenance is manual_preview', costOnly?.proofSource === 'manual_preview', costOnly?.proofSource);

if (failures > 0) {
  console.error(`\nPS-291 manual selected-rate behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-291 manual selected-rate behavior test passed.');
