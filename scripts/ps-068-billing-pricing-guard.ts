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

// ─── 5) Manual box-override rows are excluded from price-staleness ───────────
// A package_cost row carrying a manual billing-line box override
// (billing_line_items.package_id != null, set via the Edit Billing Detail
// modal) holds a DELIBERATE operator cost — it is NOT a stale generated price.
// The diagnostic's "rows at old price" count must exclude these, else it
// false-positives on intentional edits (the real PS-068 case: HUGRAB order
// 1144598 overridden to pkg 212 "14x10x8" at $1.47, flagged as "stale" only
// because $1.47 != the 12x10x3 effective $1.17).
type BoxRow = { unitCost: number; isOverride: boolean };
function countStaleGeneratedRows(rows: BoxRow[], effective: number, eps = 0.005): number {
  return rows
    .filter((r) => !r.isOverride) // overrides are deliberate, never "stale"
    .filter((r) => Math.abs(r.unitCost - effective) > eps).length;
}
const boxRows: BoxRow[] = [
  { unitCost: 1.17, isOverride: false }, // current effective price -> not stale
  { unitCost: 1.12, isOverride: false }, // genuinely old generated price -> stale
  { unitCost: 1.47, isOverride: true }, // manual override (pkg 212) -> excluded
];
check('only the genuinely-old generated row is stale', countStaleGeneratedRows(boxRows, 1.17), 1);
check(
  'override row never counted, even when unit_cost != effective',
  countStaleGeneratedRows([{ unitCost: 1.47, isOverride: true }], 1.17),
  0,
);

// ─── 6) Cache consistency is PER WINDOW, never summed across windows ─────────
// billing_summary_metrics is keyed (client_id, period_from, period_to) and the
// app reads ONE exact window at a time. Consistency is therefore per-window:
// each cached package_total must equal the live SUM of package_cost rows whose
// ship_date falls in that window's [from, to] day range. Summing package_total
// across OVERLAPPING windows is meaningless and was the source of the old
// diagnostic's false "MISMATCH".
type WDetail = { shipDay: string; lineType: string; totalCost: number };
function livePackageTotalForWindow(rows: WDetail[], from: string, to: string): number {
  const sum = rows
    .filter((r) => r.lineType === 'package_cost' && r.shipDay >= from && r.shipDay <= to)
    .reduce((acc, r) => acc + r.totalCost, 0);
  return Number(sum.toFixed(2));
}
const wdetail: WDetail[] = [
  { shipDay: '2026-05-15', lineType: 'package_cost', totalCost: 1.17 },
  { shipDay: '2026-05-29', lineType: 'package_cost', totalCost: 1.47 }, // override row IS in the cache total
  { shipDay: '2026-06-03', lineType: 'package_cost', totalCost: 1.17 },
  { shipDay: '2026-05-15', lineType: 'shipping', totalCost: 9.99 }, // excluded from package_total
];
const winA = livePackageTotalForWindow(wdetail, '2026-05-01', '2026-05-31'); // 1.17 + 1.47
const winB = livePackageTotalForWindow(wdetail, '2026-05-01', '2026-06-03'); // + 1.17
check('per-window total A ([May1,May31])', winA, 2.64);
check('per-window total B ([May1,Jun3]) includes override row', winB, 3.81);
// Proof the OLD cross-window sum was wrong: A+B overstates the true union total
// (3.81) by double-counting the overlapping May rows.
const trueUnionTotal = livePackageTotalForWindow(wdetail, '2026-05-01', '2026-06-03');
check('cross-window sum overstates the true union (anti-pattern)', winA + winB > trueUnionTotal, true);

if (failures > 0) {
  console.error(`\nFAIL PS-068 billing pricing guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-068 billing pricing guard');
