/**
 * PS-068 Guard: billing package-price correctness (pure logic, no DB).
 *
 * Locks the invariants behind "recalculate billing when client package prices
 * change". All assertions are pure replications of the production formulas in
 * src/services/billing.ts and the package_total refresh in
 * src/services/reporting-metrics.ts, plus the exported staleness helper.
 *
 *   npx tsx scripts/ps-068-billing-pricing-guard.ts
 *
 * Exits non-zero on any failure. Read-only: touches no DB, mutates nothing.
 */
import { billingNeedsRepriceForPriceChange } from '../src/services/billing';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want);
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ─── 1) Effective-price math ────────────────────────────────────────────────
// Mirror of billing.ts generateLineItems:
//   effectivePrice = basePrice * (1 + markupPct / 100); stored as toFixed(2).
function effectivePrice(basePrice: number, markupPct: number): string {
  return (basePrice * (1 + markupPct / 100)).toFixed(2);
}

// HUGRAB package "12x10x3": custom price 1.17, client markup 0.00% -> 1.17.
check('effective price 1.17 @ 0%', effectivePrice(1.17, 0), '1.17');
// 10% markup -> 1.287 -> rounds to 1.29 at toFixed(2).
check('effective price 1.17 @ 10%', effectivePrice(1.17, 10), '1.29');
// Prior price 1.12 @ 0% -> 1.12 (proves a price edit moves the emitted line).
check('effective price 1.12 @ 0%', effectivePrice(1.12, 0), '1.12');
// 100% markup doubles the base.
check('effective price 1.17 @ 100%', effectivePrice(1.17, 100), '2.34');

// ─── 2) Custom-vs-default rule ──────────────────────────────────────────────
// "Set default price" must only touch rows where isCustom=false. A client that
// has set its own custom price keeps it and is NOT overwritten by a default.
type PriceRow = { clientId: number; pkgId: number; price: number; isCustom: boolean };

function applyDefaultPrice(rows: PriceRow[], pkgId: number, defaultPrice: number): PriceRow[] {
  // Pure model of the set-default behavior: only non-custom rows are updated.
  return rows.map((r) =>
    r.pkgId === pkgId && !r.isCustom ? { ...r, price: defaultPrice } : { ...r },
  );
}

const sampleRows: PriceRow[] = [
  { clientId: 4, pkgId: 121, price: 1.17, isCustom: true }, // HUGRAB custom
  { clientId: 7, pkgId: 121, price: 0.9, isCustom: false }, // inherits default
];
const afterDefault = applyDefaultPrice(sampleRows, 121, 1.5);
const hugrab = afterDefault.find((r) => r.clientId === 4)!;
const inheritor = afterDefault.find((r) => r.clientId === 7)!;
check('custom price preserved on set-default', hugrab.price, 1.17);
check('custom flag preserved on set-default', hugrab.isCustom, true);
check('default applied to non-custom row', inheritor.price, 1.5);

// ─── 3) Stale detection (exported helper) ───────────────────────────────────
// A few cases not already covered by ps-billing-reprice-staleness-guard.ts.
const generatedAt = '2026-06-01T12:00:00.000Z';
// Price changed one second after generation -> stale.
check(
  'stale: change 1s after generation',
  billingNeedsRepriceForPriceChange(generatedAt, '2026-06-01T12:00:01.000Z'),
  true,
);
// Price changed one second before generation -> not stale.
check(
  'fresh: change 1s before generation',
  billingNeedsRepriceForPriceChange(generatedAt, '2026-06-01T11:59:59.000Z'),
  false,
);
// HUGRAB scenario: generated yesterday, price bumped today -> stale.
check(
  'stale: HUGRAB price bump after generation',
  billingNeedsRepriceForPriceChange('2026-06-01T06:18:00.000Z', '2026-06-02T05:30:00.000Z'),
  true,
);

// ─── 4) Summary/detail consistency invariant ────────────────────────────────
// refreshBillingSummaryMetrics computes:
//   package_total = SUM(total_cost) WHERE line_type='package_cost'
// The cached summary must equal the sum of the underlying detail rows.
type DetailRow = { lineType: string; totalCost: string };

function packageTotalFromDetail(rows: DetailRow[]): string {
  const sum = rows
    .filter((r) => r.lineType === 'package_cost')
    .reduce((acc, r) => acc + Number(r.totalCost), 0);
  return sum.toFixed(2);
}

const detailRows: DetailRow[] = [
  { lineType: 'package_cost', totalCost: effectivePrice(1.17, 0) }, // 1.17
  { lineType: 'package_cost', totalCost: effectivePrice(1.17, 0) }, // 1.17
  { lineType: 'package_cost', totalCost: effectivePrice(1.12, 0) }, // 1.12
  { lineType: 'shipping', totalCost: '9.99' }, // excluded from package_total
  { lineType: 'pick_pack', totalCost: '0.50' }, // excluded
];
// Detail-derived package_total must equal what a refresh would store: 3.46.
check('package_total = SUM(package_cost detail)', packageTotalFromDetail(detailRows), '3.46');
// Other line types do not leak into the package total.
check(
  'package_total ignores non-package lines',
  packageTotalFromDetail([
    { lineType: 'shipping', totalCost: '9.99' },
    { lineType: 'storage', totalCost: '4.00' },
  ]),
  '0.00',
);

if (failures > 0) {
  console.error(`\nFAIL PS-068 billing pricing guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-068 billing pricing guard');
