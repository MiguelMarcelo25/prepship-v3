/**
 * PS-325 (slice 3b) guard — per-SKU units summing is backend-owned + byte-identical.
 *
 * The Dashboard per-SKU units30/units7/priorUnits30 (source-1 of the 3-source merge) used to be the
 * FRONTEND re-summing the /dashboard/sku-trends daily series. This guard pins:
 *  1. src/lib/sku-units.ts owns sumSkuUnits + sumLastNSkuUnits with the byte-identical Number(x)||0
 *     coercion + last-N semantics (BEHAVIORAL, hard-coded expectations so a mutation is caught).
 *  2. /dashboard/sku-trends emits per-SKU units30/units7 computed from result.days via the owner —
 *     NOT from total_qty (which diverges on the TZ boundary and would shift numbers).
 *  3. The FE mapper surfaces unitsBySku, and DashboardView PREFERS it, delegating the fallback to the
 *     same shared owner (so source-1 is backend-owned + byte-identical).
 *
 * Offline/static + pure-unit.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { sumSkuUnits, sumLastNSkuUnits } from '../src/lib/sku-units';

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`); }
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// 1. Behavioral parity (hard-coded — NOT circular) ----------------------------------------------
check('sumSkuUnits sums finite numbers', () => assert.strictEqual(sumSkuUnits([2, 3, 5]), 10));
check('sumSkuUnits of empty is 0', () => assert.strictEqual(sumSkuUnits([]), 0));
check('sumSkuUnits coerces with Number(x)||0 (string/null/undefined/0 -> number/0)', () =>
  assert.strictEqual(sumSkuUnits([1, '2', null, undefined, 0, 4]), 7));
check('sumSkuUnits maps non-numeric + NaN to 0', () => assert.strictEqual(sumSkuUnits(['x', Number.NaN]), 0));
check('sumLastNSkuUnits sums the LAST n entries (most-recent), not the first', () =>
  assert.strictEqual(sumLastNSkuUnits([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 7), 49)); // 4..10
check('sumLastNSkuUnits with the leading spike proves last-7 (not first-7, not all)', () =>
  // [10,1,1,1,1,1,1,1]: last-7 = 7; first-7 = 16; all = 17. Only last-7 passes.
  assert.strictEqual(sumLastNSkuUnits([10, 1, 1, 1, 1, 1, 1, 1], 7), 7));
check('sumLastNSkuUnits with n > length sums all', () => assert.strictEqual(sumLastNSkuUnits([1, 2, 3], 7), 6));
check('sumLastNSkuUnits with n = 0 is 0', () => assert.strictEqual(sumLastNSkuUnits([1, 2, 3, 4, 5], 0), 0));
// Parity with the FE reference (sumValues(num)/last) over a finite-number series:
check('sumSkuUnits == the FE series-sum reference; sumLastNSkuUnits == last-7 reference', () => {
  const series = [3, 0, 5, 2, 7, 0, 1, 9, 4, 6];
  const refSum = (v: number[]) => v.reduce((s, x) => s + (Number(x) || 0), 0);
  const refLast = (v: number[], n: number) => refSum(v.slice(Math.max(0, v.length - n)));
  assert.strictEqual(sumSkuUnits(series), refSum(series));
  assert.strictEqual(sumLastNSkuUnits(series, 7), refLast(series, 7));
});

// 2. Owner + backend route static pins ----------------------------------------------------------
const owner = read('src/lib/sku-units.ts');
check('owner exports sumSkuUnits + sumLastNSkuUnits with Number(x)||0 coercion', () => {
  assert.ok(/export function sumSkuUnits/.test(owner));
  assert.ok(/export function sumLastNSkuUnits/.test(owner));
  assert.ok(/Number\(value\) \|\| 0/.test(owner));
});
const route = read('src/routes/dashboard.ts');
check('the /sku-trends route emits per-SKU units from result.days via the owner (NOT total_qty)', () => {
  assert.ok(/import \{ sumSkuUnits, sumLastNSkuUnits \} from '\.\.\/lib\/sku-units'/.test(route));
  assert.ok(/units30: sumSkuUnits\(series\)/.test(route));
  assert.ok(/units7: sumLastNSkuUnits\(series, 7\)/.test(route));
  assert.ok(/result\.days\.map\(\(d\) =>[^\n]*\[t\.sku\]\)/.test(route));
  // anti-trap: units30 must NOT be reused from total_qty
  assert.ok(!/units30: [^\n]*total_qty/.test(route));
});

// 3. FE surfaces + prefers the backend units (delegating the fallback) --------------------------
const api = read('web/src/lib/v2-apiClient.ts');
check('FE sku-trends mapper surfaces backend unitsBySku without recomputing it', () => {
  assert.ok(/unitsBySku\[units\.sku\] = \{/.test(api));
  assert.ok(/units30: requiredReportingNumber\(units\.units30/.test(api));
  assert.ok(/units7: requiredReportingNumber\(units\.units7/.test(api));
});
const dash = read('web/src/components/Views/DashboardView.tsx');
check('DashboardView imports the shared owner', () =>
  assert.ok(/from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/sku-units'/.test(dash)));
check('the 3 map builders PREFER backend units then fall back to the shared owner (anti-vacuous)', () => {
  assert.ok(/currentSales\.unitsBySku\?\.\[sku\]\?\.units7 \?\? sumLastNSkuUnits\(series\[sku\] \?\? \[\], 7\)/.test(dash));
  assert.ok(/currentSales\.unitsBySku\?\.\[sku\]\?\.units30 \?\? sumSkuUnits\(series\[sku\] \?\? \[\]\)/.test(dash));
  assert.ok(/priorSales\.unitsBySku\?\.\[sku\]\?\.units30 \?\? sumSkuUnits\(series\[sku\] \?\? \[\]\)/.test(dash));
});

if (failures > 0) {
  console.error(`\nPS-325 sku-units guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-325 sku-units guard passed.');
