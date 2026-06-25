/**
 * PS-325 (slice 3) guard — the Dashboard Sales-Performance heatmap deviation/tone is BACKEND-OWNED.
 *
 * buildHeatmap() + heatmapTone() (the per-SKU per-day baseline, deviation %, and asymmetric tone
 * banding) used to be DEFINED inside DashboardView — the frontend owned the rule for what counts as a
 * hot/cold cell. They now live in src/lib/sales-heatmap-deviation.ts (pure, shared FE+backend). This
 * guard pins:
 *  1. The owner exports buildHeatmap + heatmapTone and contains the exact tone bands + baseline/
 *     deviation formula literals (so the policy can't silently drift).
 *  2. DashboardView IMPORTS buildHeatmap from the owner, still CALLS it, and no longer DEFINES
 *     buildHeatmap/heatmapTone locally (anti-vacuous).
 *  3. A BEHAVIORAL parity table (imports the lib, runs heatmapTone on every band boundary + buildHeatmap
 *     on a fixture) — locks byte-identical output, catching any future edit to the moved math.
 *
 * Offline/static + pure-unit. No network/clock/locale.
 */
import { readFileSync } from 'node:fs';
import { buildHeatmap, heatmapTone } from '../src/lib/sales-heatmap-deviation';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// 1. Canonical owner: exports + literal policy pins ---------------------------------------------
const owner = read('src/lib/sales-heatmap-deviation.ts');
check('owner exports buildHeatmap + heatmapTone',
  /export function buildHeatmap/.test(owner) && /export function heatmapTone/.test(owner));
check('owner pins the exact asymmetric tone bands (>=20 high / >=10 mid / >-10 flat / >-20 dip / low)',
  /if \(deviation >= 20\) return 'high'/.test(owner) &&
  /if \(deviation >= 10\) return 'mid'/.test(owner) &&
  /if \(deviation > -10\) return 'flat'/.test(owner) &&
  /if \(deviation > -20\) return 'dip'/.test(owner) &&
  /return 'low'/.test(owner));
check('owner pins the baseline / fallback / deviation formulas byte-identical',
  /sumValues\(bucket\.prior\) \/ Math\.max\(1, bucket\.prior\.length\)/.test(owner) &&
  /sumValues\(bucket\.current\) \/ Math\.max\(1, bucket\.current\.length\) \|\| 1/.test(owner) &&
  /compareTo > 0 \? \(\(qty - compareTo\) \/ compareTo\) \* 100 : 0/.test(owner));

// 2. DashboardView delegates -------------------------------------------------------------------
const dash = read('web/src/components/Views/DashboardView.tsx');
check('DashboardView imports buildHeatmap from the canonical owner',
  /import \{[^}]*\bbuildHeatmap\b[^}]*\} from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/sales-heatmap-deviation['"]/.test(dash));
check('DashboardView no longer DEFINES buildHeatmap / heatmapTone locally (anti-vacuous)',
  !/function buildHeatmap\(/.test(dash) && !/function heatmapTone\(/.test(dash));
check('DashboardView still CALLS buildHeatmap(currentSales, priorSales ...) (the move is consumed)',
  /buildHeatmap\(currentSales, priorSales/.test(dash));

// 3. Behavioral parity — lock byte-identical output --------------------------------------------
const toneCases: Array<[number, string]> = [
  [1000, 'high'], [20, 'high'], [10, 'mid'], [9.99, 'flat'], [0, 'flat'],
  [-9.99, 'flat'], [-10, 'dip'], [-19.99, 'dip'], [-20, 'low'], [-1000, 'low'],
];
for (const [dev, expected] of toneCases) {
  check(`heatmapTone(${dev}) === '${expected}'`, heatmapTone(dev) === expected, heatmapTone(dev));
}

// Fixture: 15-day window so the dates.length-15 cell index is clean (offset 0..14).
const dates = Array.from({ length: 15 }, (_, i) => `d${i}`);
const current = {
  dates,
  topSkus: [{ sku: 'A', name: 'Apple' }, { sku: 'B', name: 'Banana' }],
  series: { A: dates.map(() => 10), B: dates.map(() => 2) },
};
const prior = { dates, topSkus: [], series: { A: dates.map(() => 5), B: dates.map(() => 4) } };

const rows = buildHeatmap(current, prior, 2);
check('buildHeatmap returns 2 rows ranked by current total desc (Apple before Banana)',
  rows.length === 2 && rows[0]?.label === 'Apple' && rows[1]?.label === 'Banana');
const aCell = rows[0]?.cells[0];
check('row Apple: 15 cells, baseline 5, qty 10, deviation +100, tone high',
  rows[0]?.cells.length === 15 && aCell?.qty === 10 && aCell?.baseline === 5 &&
  aCell?.deviation === 100 && aCell?.tone === 'high');
const bCell = rows[1]?.cells[0];
check('row Banana: baseline 4, qty 2, deviation -50, tone low',
  bCell?.baseline === 4 && bCell?.qty === 2 && bCell?.deviation === -50 && bCell?.tone === 'low');
const limited = buildHeatmap(current, prior, 1);
check('limit slices to top-N by total (limit 1 -> Apple only)',
  limited.length === 1 && limited[0]?.label === 'Apple');

if (failures > 0) {
  console.error(`\nPS-325 dashboard heatmap deviation guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-325 dashboard heatmap deviation guard passed.');
