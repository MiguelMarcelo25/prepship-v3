/**
 * PS-325 (slice 4) guard — the bare dashboard DTOs carry BACKEND-OWNED provenance, and the FE labels
 * freshness honestly (never the browser wall-clock).
 *
 * Pins:
 *  1. src/lib/analytics-provenance.ts owns the DashboardProvenance envelope + buildProvenance + markCached
 *     (with a behavioral check: live stamping, cache relabel preserving computedAt/window, null passthrough).
 *  2. /dashboard/summary + /dashboard/daily-counts stamp `meta` (computedAt above the cache read, folded
 *     into the payload before the cache write) and relabel a cache hit via markCached.
 *  3. The FE mappers pass `meta` through, AND the inventory-risk mapper restores the previously-dropped
 *     backend `snapshot` (so slice-1 provenance reaches the view).
 *  4. ANTI-VACUOUS: the "Data as of" header reads the BACKEND computedAt (formatDataFreshness(summaryMeta)),
 *     not formatDataTimestamp()/new Date() — i.e. the fabricated wall-clock is gone, and missing
 *     provenance is labeled "freshness unknown", never invented.
 *
 * Offline/static + pure-unit.
 */
import { readFileSync } from 'node:fs';
import { buildProvenance, markCached } from '../src/lib/analytics-provenance';

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

// 1. Owner: exports + behavioral contract -------------------------------------------------------
const owner = read('src/lib/analytics-provenance.ts');
check('owner exports DashboardProvenance + buildProvenance + markCached',
  /export type DashboardProvenance/.test(owner) &&
  /export function buildProvenance/.test(owner) &&
  /export function markCached/.test(owner));

const live = buildProvenance({ from: '2026-06-01', to: '2026-06-25', computedAt: '2026-06-25T12:00:00.000Z' });
check('buildProvenance stamps source=live + window + computedAt (default tz CA)',
  live.source === 'live' && live.computedAt === '2026-06-25T12:00:00.000Z' &&
  live.window.from === '2026-06-01' && live.window.to === '2026-06-25' && live.window.tz === 'America/Los_Angeles');
const cached = markCached(live);
check('markCached flips source=cache, preserving computedAt + window',
  cached.source === 'cache' && cached.computedAt === live.computedAt &&
  cached.window.from === live.window.from && cached.window.to === live.window.to);
check('buildProvenance passes a null computedAt through (unknown, never fabricated)',
  buildProvenance({ from: 'a', to: 'b', computedAt: null }).computedAt === null);

// 2. Backend routes stamp + relabel -------------------------------------------------------------
const route = read('src/routes/dashboard.ts');
check('dashboard route imports the provenance owner',
  /import \{ buildProvenance, markCached.*\} from '\.\.\/lib\/analytics-provenance'/.test(route));
check('the compute instant is stamped (new Date().toISOString())', /const computedAt = new Date\(\)\.toISOString\(\)/.test(route));
// All 6 bare DTO routes stamp meta (slice 4a: summary + daily-counts; slice 4b: sku-trends, top-skus,
// daily-revenue-by-client, top-combos). /shipping-margin + /inventory-risk already had provenance.
const stampCount = (route.match(/meta: buildProvenance\(/g) ?? []).length;
check('all 6 bare dashboard routes stamp meta via buildProvenance (>= 6)', stampCount >= 6, { stampCount });
const markCount = (route.match(/markCached\(cached\.meta\)/g) ?? []).length;
check('all 6 bare dashboard routes relabel the cache hit via markCached (>= 6)', markCount >= 6, { markCount });

// 3. FE mappers pass provenance through + restore the dropped snapshot ---------------------------
const api = read('web/src/lib/v2-apiClient.ts');
const passCount = (api.match(/meta: \(res\?\.meta as DashboardProvenance \| undefined\) \?\? null/g) ?? []).length;
check('FE summary + daily-counts mappers pass meta through (>= 2)', passCount >= 2, { passCount });
check('FE inventory-risk mapper restores the dropped backend snapshot (slice-1 fix)',
  /snapshot: res\?\.snapshot \?\? null/.test(api));

// 4. FE labels honestly (anti-vacuous) ----------------------------------------------------------
const dash = read('web/src/components/Views/DashboardView.tsx');
check('Dashboard header reads BACKEND provenance (formatDataFreshness(summaryMeta)), not the wall-clock',
  /formatDataFreshness\(summaryMeta\)/.test(dash) && !/formatDataTimestamp/.test(dash));
check('the freshness helper formats the backend computedAt and labels the missing case',
  /formatCaDateTime\(new Date\(meta\.computedAt\)\)/.test(dash) &&
  /return 'Data freshness unknown'/.test(dash));
// FE-2 (audit 2.2 slice 1): the provenance now travels through the metrics
// React Query cache — queryFn passthrough + derived read — instead of a
// useState setter. Same invariant: the fetched meta is kept, not dropped.
check('Dashboard stores the summary provenance from the fetch',
  /summaryMeta: \(\(currentOrderAggRes as \{ meta\?: DashboardProvenance \| null \}\)\?\.meta \?\? null\)/.test(dash) &&
  /const summaryMeta = metricsQuery\.data\?\.summaryMeta \?\? null/.test(dash));

if (failures > 0) {
  console.error(`\nPS-325 dashboard provenance guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-325 dashboard provenance guard passed.');
