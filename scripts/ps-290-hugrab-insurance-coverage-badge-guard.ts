/**
 * PS-290 (slice 1) guard — HUGRAB Best Rate $100-insurance COVERAGE STATUS is backend-owned.
 *
 * The coverage VERDICT (included / not_included / unknown / unsupported / not_required) is decided
 * by the pure resolver and carried on the DTO; the FE only RENDERS it. This guard pins:
 *   (1) resolveInsuranceCoverageStatus — the behavioral rules per the card:
 *         HUGRAB USPS $100 + ParcelGuard premium      -> included / green
 *         HUGRAB direct-UPS $0 carrier-declared $100   -> included / green
 *         HUGRAB explicit no-insurance                 -> not_included / red
 *         HUGRAB requested-but-uncertain               -> unknown / amber
 *         HUGRAB below the $100 floor                   -> unknown / amber
 *         non-HUGRAB                                    -> not_required (no badge)
 *   (2) order-rate-dto carries insuranceCoverageStatus + insuranceBadgeLabel + insuranceBadgeTone
 *       and populates them by DELEGATING to the resolver (not a re-derivation).
 *   (3) orders-row-display reads insuranceCoverageStatus / insuranceBadgeTone off the backend DTO
 *       (a pure pass-through), NOT a FE recompute of the coverage verdict.
 *
 *   npx tsx scripts/ps-290-hugrab-insurance-coverage-badge-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  resolveInsuranceCoverageStatus,
  HUGRAB_REQUIRED_INSURED_VALUE,
} from '../src/services/shipping-workflow/insurance-coverage-status';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── (1) resolver behavior: HUGRAB $100 coverage verdict ───────────────────────

// HUGRAB USPS $100 with a positive ParcelGuard premium -> the biller charged for coverage -> included.
const uspsParcelGuard = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 1.09,
  insuranceProvenance: 'parcelguard_schedule',
});
check('HUGRAB USPS $100 + ParcelGuard premium -> included', uspsParcelGuard.status === 'included');
check('HUGRAB USPS $100 + ParcelGuard premium -> green', uspsParcelGuard.badgeTone === 'green');
check('included badge label is the $100 INS. INCL. copy', uspsParcelGuard.badgeLabel === '$100 INS. INCL.');

// HUGRAB direct-UPS $0 carrier-declared value for the first $100 -> included (free, proven by provenance).
const directUps = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'carrier',
  insuredValue: 100,
  insuranceCost: 0,
  insuranceProvenance: 'carrier_declared_value',
});
check('HUGRAB direct-UPS $0 declared $100 -> included', directUps.status === 'included');
check('HUGRAB direct-UPS $0 declared $100 -> green', directUps.badgeTone === 'green');

// HUGRAB explicit no-insurance -> not_included / red (the mandatory $100 was NOT applied).
const noneProvider = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'none',
  insuredValue: 0,
});
check('HUGRAB insuranceProvider none -> not_included', noneProvider.status === 'not_included');
check('HUGRAB explicit no-insurance -> red', noneProvider.badgeTone === 'red');
check('not_included badge label is NO INSURANCE', noneProvider.badgeLabel === 'NO INSURANCE');
check('HUGRAB insuredValue 0 (any provider) -> not_included',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'parcelguard', insuredValue: 0 }).status === 'not_included');
check('HUGRAB certainty not_included -> not_included',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'parcelguard', insuredValue: 100, insuranceCertainty: 'not_included' }).status
    === 'not_included');

// HUGRAB requested-but-uncertain (Shipp-brokered declared value) -> unknown / amber.
const uncertain = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCertainty: 'requested_application_uncertain',
});
check('HUGRAB requested_application_uncertain -> unknown', uncertain.status === 'unknown');
check('HUGRAB uncertain -> amber', uncertain.badgeTone === 'amber');
check('unknown badge label is INSURANCE UNKNOWN', uncertain.badgeLabel === 'INSURANCE UNKNOWN');
check('HUGRAB proof_unavailable -> unknown',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'parcelguard', insuredValue: 100, insuranceCertainty: 'proof_unavailable' }).status
    === 'unknown');

// HUGRAB below the $100 floor -> unknown (requested but the mandate is not met / unproven).
check('HUGRAB insured value below the $100 floor -> unknown',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'parcelguard', insuredValue: 50, insuranceCost: 0.99, insuranceProvenance: 'parcelguard_schedule' }).status
    === 'unknown');
check('HUGRAB_REQUIRED_INSURED_VALUE is the $100 mandate', HUGRAB_REQUIRED_INSURED_VALUE === 100);

// HUGRAB blocked -> unsupported (never falsely included).
check('HUGRAB unsupported provenance -> unsupported',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'parcelguard', insuredValue: 100, insuranceProvenance: 'unsupported' }).status
    === 'unsupported');
check('HUGRAB certainty unsupported -> unsupported',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuredValue: 100, insuranceCertainty: 'unsupported' }).status === 'unsupported');

// non-HUGRAB -> not_required (the badge does not apply; the FE renders nothing).
const nonHugrab = resolveInsuranceCoverageStatus({
  isHugrab: false,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 1.09,
  insuranceProvenance: 'parcelguard_schedule',
});
check('non-HUGRAB -> not_required', nonHugrab.status === 'not_required');
check('not_required carries an empty badge label (renders nothing)', nonHugrab.badgeLabel === '');
check('isHugrab omitted -> not_required',
  resolveInsuranceCoverageStatus({ insuranceProvider: 'parcelguard', insuredValue: 100 }).status === 'not_required');

// HUGRAB certainty explicitly_included -> included even without provenance.
check('HUGRAB certainty explicitly_included -> included',
  resolveInsuranceCoverageStatus({ isHugrab: true, insuranceProvider: 'carrier', insuredValue: 100, insuranceCertainty: 'explicitly_included' }).status
    === 'included');

// ── (2) order-rate-dto carries + delegates the 3 coverage fields ──────────────
const dto = read('src/services/order-rate-dto.ts');
check('order-rate-dto imports resolveInsuranceCoverageStatus',
  dto.includes('resolveInsuranceCoverageStatus'));
check('order-rate-dto OrderBestRateDto declares insuranceCoverageStatus',
  /insuranceCoverageStatus:\s*InsuranceCoverageStatus/.test(dto));
check('order-rate-dto declares insuranceBadgeLabel + insuranceBadgeTone',
  /insuranceBadgeLabel:\s*string/.test(dto) && /insuranceBadgeTone:\s*InsuranceCoverageBadgeTone/.test(dto));
check('order-rate-dto populates the coverage triple via the resolver (delegation, not re-derivation)',
  /resolveCoverageFields\(/.test(dto) && /resolveInsuranceCoverageStatus\(\{/.test(dto));
check('order-rate-dto threads an isHugrab signal into the coverage resolution',
  /isHugrab/.test(dto));

// ── (3) orders-row-display READS the backend DTO fields (no FE recompute) ──────
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
check('orders-row-display reads insuranceCoverageStatus off the DTO',
  rowDisplay.includes('insuranceCoverageStatus'));
check('orders-row-display reads insuranceBadgeTone off the DTO',
  rowDisplay.includes('insuranceBadgeTone'));
check('orders-row-display reads insuranceBadgeLabel off the DTO',
  rowDisplay.includes('insuranceBadgeLabel'));
check('orders-row-display exposes a pure best-rate coverage reader',
  /export function getBestRateInsuranceCoverage\(/.test(rowDisplay));
check('orders-row-display renders the coverage badge in the money renderer',
  /renderInsuranceCoverageBadge\(/.test(rowDisplay) && /renderRateAmountWithMarkup\(/.test(rowDisplay));
const orderCells = read('web/src/components/Views/orders/cells/order-cells.tsx');
check('Awaiting Best Rate cell keeps backend coverage visible on HOUSE/Shipp rows',
  /renderRateAmountWithMarkup\(\s*bestRatePriceDisplay\.baseAmount,\s*bestRatePriceDisplay\.primaryAmount,\s*bestRatePriceDisplay\.insuranceAddOn,\s*[\s\S]*getBestRateInsuranceCoverage\(displayOrder\)/.test(orderCells) &&
  !/showHouseBadge\s*\?\s*null\s*:\s*getBestRateInsuranceCoverage/.test(orderCells));
// No FE heuristic: the row display must NOT re-derive the verdict — it may NAME the canonical
// owner in a comment, but it must never CALL the resolver or do its own $100 floor math.
check('orders-row-display does NOT call the resolver (no FE recompute)',
  !/resolveInsuranceCoverageStatus\s*\(/.test(rowDisplay));
check('orders-row-display does NOT do its own $100 floor math (no insuredValue comparison)',
  !/insuredValue\s*[<>=]/.test(rowDisplay));

// ── (4) Rate Browser per-rate row renders the SAME backend verdict as Awaiting ──
// PS-290 (slice 2): RateRowItem.tsx must render the HUGRAB $100 coverage badge with the SAME
// backend-owned reader + renderer the Awaiting column uses (getRowInsuranceCoverage +
// renderInsuranceCoverageBadge in orders-row-display) — TRUE parity, not a fork. The FE renders
// the backend verdict verbatim; it must NEVER call the resolver or do its own coverage/$100 math.
const rateRowItem = read('web/src/components/RateRowItem.tsx');
check('RateRowItem imports the SHARED Awaiting coverage reader (getRowInsuranceCoverage)',
  /getRowInsuranceCoverage/.test(rateRowItem));
check('RateRowItem imports the SHARED Awaiting coverage renderer (renderInsuranceCoverageBadge)',
  /renderInsuranceCoverageBadge/.test(rateRowItem));
check('RateRowItem reads the backend coverage verdict off the rate (pure pass-through)',
  /getRowInsuranceCoverage\(/.test(rateRowItem));
check('RateRowItem renders the coverage badge in the row',
  /renderInsuranceCoverageBadge\(/.test(rateRowItem));
check('RateRowItem does NOT call the resolver (no FE recompute)',
  !/resolveInsuranceCoverageStatus\s*\(/.test(rateRowItem));
check('RateRowItem does NOT do its own $100 floor math (no insuredValue comparison)',
  !/insuredValue\s*[<>=]/.test(rateRowItem));
// Parity is by CONSTRUCTION: both surfaces import the same reader + renderer from the single
// orders-row-display owner, so the Rate Browser badge can never diverge from the Awaiting badge.
check('RateRowItem sources the coverage reader/renderer from orders-row-display (one owner, no fork)',
  /from\s+['"]\.\/Views\/orders-row-display['"]/.test(rateRowItem));

if (failures > 0) {
  console.error(`\nFAIL PS-290 HUGRAB insurance-coverage-badge guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-290 HUGRAB insurance-coverage-badge guard');
