/**
 * PS-373 — prorated cubic-foot-day storage billing guard (offline, no db).
 *
 * Proves the ledger-based storage calculator (src/services/billing-storage.ts)
 * against every scenario the card requires, and pins billing.ts to delegate to it.
 *
 *   npx tsx scripts/ps-373-prorated-storage-billing-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  computeClientStorageBilling,
  computeSkuStorageCuFtDays,
  dedupeShipMovements,
  type StorageLedgerMovement,
} from '../src/services/billing-storage';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number, b: number, eps = 0.005) => Math.abs(a - b) < eps;

// Movement helper. qty is a SIGNED delta (receive +, ship −), matching applyMovement.
const mv = (type: string, qty: number, day: string, orderId: number | null = null): StorageLedgerMovement =>
  ({ type, qty, orderId, createdAt: `${day}T12:00:00.000Z` });

const JAN = { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }; // 31 days
const FEB = { start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' }; // 28 days
const RATE = 0.5; // $/cuft/month

function skuBilling(cuFtPerUnit: number, movements: StorageLedgerMovement[], period = JAN, rate = RATE) {
  return computeClientStorageBilling({
    skus: [{ inventoryId: 1, sku: 'A', cuFtPerUnit, movements }],
    storageFeePerCuFtMonth: rate,
    periodStart: period.start,
    periodEnd: period.end,
  });
}

// ── 1) 100 units received day 1, 1 cuft/unit, $0.50/mo, no shipments => FULL month ──
{
  const b = skuBilling(1, [mv('receive', 100, '2026-01-01')]);
  check('(1) full-month: 100u × 31 days = 3100 cuft-days', approx(b.totalCuFtDays, 3100));
  check('(1) full-month charge = units × monthlyRate ($50.00)', b.amount === 50.0, `got ${b.amount}`);
  check('(1) uses actual 31 days in the month', b.daysInMonth === 31);
}

// ── 2) 100 received day 1, 1 shipped mid-month (day 16) => 99 bill after the ship ──
{
  const b = skuBilling(1, [mv('receive', 100, '2026-01-01'), mv('ship', -1, '2026-01-16', 900)]);
  const proof = b.skuProofs[0];
  check('(2) two segments: 100u before the ship, 99u after', proof?.segments.length === 2 &&
    proof.segments[0].billedQty === 100 && proof.segments[1].billedQty === 99);
  check('(2) cuft-days = 100×15 + 99×16 = 3084', approx(b.totalCuFtDays, 3084), `got ${b.totalCuFtDays}`);
  check('(2) prorated charge < full month', b.amount < 50.0 && approx(b.amount, 49.74), `got ${b.amount}`);
}

// ── 3) multi-SKU order deducts EACH sku's own quantities (not once per SKU) ──
{
  const b = computeClientStorageBilling({
    skus: [
      { inventoryId: 1, sku: 'A', cuFtPerUnit: 2, movements: [mv('receive', 5, '2026-01-01'), mv('ship', -5, '2026-01-11', 999)] },
      { inventoryId: 2, sku: 'B', cuFtPerUnit: 3, movements: [mv('receive', 10, '2026-01-01'), mv('ship', -10, '2026-01-11', 999)] },
    ],
    storageFeePerCuFtMonth: RATE, periodStart: JAN.start, periodEnd: JAN.end,
  });
  const a = b.skuProofs.find((p) => p.sku === 'A');
  const bb = b.skuProofs.find((p) => p.sku === 'B');
  // A: 5u × 10 days × 2 cuft = 100; B: 10u × 10 days × 3 cuft = 300. Both go to 0 after the shared order 999 ships.
  check('(3) SKU A deducted its own 5 units (100 cuft-days)', approx(a?.cuFtDays ?? -1, 100));
  check('(3) SKU B deducted its own 10 units (300 cuft-days)', approx(bb?.cuFtDays ?? -1, 300));
  check('(3) both SKUs zero out after the shared multi-SKU order ships',
    a?.segments.at(-1)?.billedQty === 0 && bb?.segments.at(-1)?.billedQty === 0);
}

// ── 4) SKU with cuFtPerUnit <= 0 creates NO storage billing ──
{
  const zero = skuBilling(0, [mv('receive', 100, '2026-01-01')]);
  check('(4) zero-volume SKU bills nothing', zero.amount === 0 && zero.skuProofs.length === 0);
  const negDims = computeSkuStorageCuFtDays({ inventoryId: 1, sku: 'A', cuFtPerUnit: -1, movements: [mv('receive', 100, '2026-01-01')], periodStart: JAN.start, periodEnd: JAN.end });
  check('(4) negative-volume SKU yields 0 cuft-days', negDims.cuFtDays === 0);
}

// ── 5) retroactive receive bills from the ENTERED received date, not month start ──
{
  const b = skuBilling(1, [mv('receive', 100, '2026-01-10')]); // received (retroactively) on day 10
  // days 1–9 hold 0; days 10–31 hold 100 = 22 days.
  check('(5) retroactive receive bills 22 days (from day 10), not 31', approx(b.totalCuFtDays, 2200), `got ${b.totalCuFtDays}`);
  check('(5) first segment before the receive holds 0', b.skuProofs[0]?.segments[0]?.billedQty === 0);
}

// ── 6) actual days in month: Feb (28) proration differs from a 31-day month ──
{
  const febFull = skuBilling(1, [mv('receive', 100, '2026-02-01')], FEB);
  check('(6) Feb full month uses 28 days', febFull.daysInMonth === 28 && approx(febFull.totalCuFtDays, 2800));
  check('(6) Feb full-month charge still = units × monthlyRate ($50.00)', febFull.amount === 50.0);
  const febPartial = skuBilling(1, [mv('receive', 100, '2026-02-01'), mv('ship', -1, '2026-02-15', 900)], FEB);
  const janPartial = skuBilling(1, [mv('receive', 100, '2026-01-01'), mv('ship', -1, '2026-01-15', 900)], JAN);
  check('(6) same-shape partial differs across a 28- vs 31-day month (actual days used)',
    febPartial.amount !== janPartial.amount, `feb=${febPartial.amount} jan=${janPartial.amount}`);
}

// ── 7) negative inventory clamps billable qty at 0 AND surfaces an admin exception ──
{
  const b = skuBilling(1, [mv('receive', 5, '2026-01-01'), mv('ship', -10, '2026-01-10', 999)]);
  const proof = b.skuProofs[0];
  check('(7) over-ship drives the balance negative but bills the post-ship segment at 0',
    proof?.segments.at(-1)?.balance === -5 && proof?.segments.at(-1)?.billedQty === 0);
  check('(7) only the pre-ship days bill (5u × 9 days = 45 cuft-days)', approx(b.totalCuFtDays, 45), `got ${b.totalCuFtDays}`);
  check('(7) the negative balance is reported as an admin exception (not silently dropped)',
    b.exceptions.length === 1 && b.exceptions[0].sku === 'A' && b.exceptions[0].negativeDays === 22);
}

// ── 8) the one storage line total EQUALS the sum of the per-SKU proof rows ──
{
  const b = computeClientStorageBilling({
    skus: [
      { inventoryId: 1, sku: 'A', cuFtPerUnit: 1.37, movements: [mv('receive', 7, '2026-01-03'), mv('ship', -2, '2026-01-19', 51)] },
      { inventoryId: 2, sku: 'B', cuFtPerUnit: 0.42, movements: [mv('receive', 40, '2026-01-01'), mv('ship', -13, '2026-01-22', 52)] },
      { inventoryId: 3, sku: 'C', cuFtPerUnit: 3.10, movements: [mv('receive', 3, '2026-01-11')] },
    ],
    storageFeePerCuFtMonth: 0.73, periodStart: JAN.start, periodEnd: JAN.end,
  });
  const sumOfRows = round2(b.skuProofs.reduce((acc, p) => acc + p.amount, 0));
  check('(8) storage line total === Σ per-SKU proof amounts (exact reconciliation)',
    b.amount === sumOfRows, `line=${b.amount} rows=${sumOfRows}`);
}

// ── ship de-dupe: an order's ship recorded twice counts ONCE (min qty per order) ──
{
  const deduped = dedupeShipMovements([
    mv('receive', 100, '2026-01-01'),
    mv('ship', -1, '2026-01-16', 900),
    mv('ship', -1, '2026-01-17', 900), // idempotent double-write of the SAME order
  ]);
  const shipTotal = deduped.filter((d) => d.qty < 0).reduce((a, d) => a + d.qty, 0);
  check('ship de-dupe: double-recorded order ship counts once (−1, not −2)', shipTotal === -1);
  const b = skuBilling(1, [mv('receive', 100, '2026-01-01'), mv('ship', -1, '2026-01-16', 900), mv('ship', -1, '2026-01-17', 900)]);
  check('ship de-dupe: balance drops by 1 (not 2) after the deduped ship', b.skuProofs[0]?.segments.at(-1)?.billedQty === 99);
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ── source pin: billing.ts delegates the storage line to this owner ──
const billing = readFileSync('src/services/billing.ts', 'utf8');
check('billing.ts imports the storage owner (computeClientStorageBilling)',
  /import \{[^}]*computeClientStorageBilling[^}]*\} from '\.\/billing-storage'/.test(billing));
check('billing.ts delegates the storage line to computeClientStorageBilling (no inline Σ stock_qty × cuFt snapshot)',
  /computeClientStorageBilling\(/.test(billing) &&
  !/select\s*\n?\s*coalesce\(sum\(\s*\n?\s*case\s*\n?\s*when coalesce\(cu_ft_override/.test(billing));

if (failures > 0) {
  console.error(`\nPS-373 prorated storage billing guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-373 prorated storage billing guard passed.');
