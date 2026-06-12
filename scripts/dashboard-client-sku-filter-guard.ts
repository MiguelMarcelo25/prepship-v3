/**
 * PS-212 guard — Dashboard Top SKUs / heatmap / trend respect the ONE
 * canonical client filter.
 *
 * DJ report: with the client filter on HUGRAB, the Daily Orders Trend
 * re-scoped but Top 5 SKUs stayed global (KF Goods / Heritage Kids SKUs).
 * Root cause was NOT missing backend filtering — /dashboard/top-skus and
 * /dashboard/sku-trends already take clientId and the analysis SQL applies
 * it. The dashboard had TWO client filters: the chart-local `trendClientId`
 * override (deliberately scoped to the trend lines only) and the
 * dashboard-wide `selectedClientId`. DJ used the chart dropdown; everything
 * except the trend stayed global by design.
 *
 * Fix: the chart dropdown drives `selectedClientId` — one filter, one scoped
 * fetch pipeline, every client-scoped panel in agreement. This guard pins
 * the unification AND the backend scoping so neither can silently regress.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const dashboardRoute = read('src/routes/dashboard.ts');
const analysis = read('src/routes/analysis.ts');
const dashboardView = read('web/src/components/Views/DashboardView.tsx');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const pkg = read('package.json');

// ── Backend: the query layer owns the client filter ────────────────────────
assert.ok(/getSkuDailyFromOrderItems\(\{[\s\S]{0,200}clientId: q\.clientId/.test(dashboardRoute),
  '/dashboard/sku-trends must pass the request clientId into the SKU query owner');
assert.ok(/getSkuBreakdownFromOrderItems\(\{[\s\S]{0,200}clientId: q\.clientId/.test(dashboardRoute),
  '/dashboard/top-skus must pass the request clientId into the SKU query owner');
// Cache keys segregate by client so a HUGRAB response can never serve the
// global view (or vice versa).
const clientKeyedCaches = dashboardRoute.split('clientId: q.clientId ?? null').length - 1;
assert.ok(clientKeyedCaches >= 4,
  `dashboard analytics cache keys must include clientId (found ${clientKeyedCaches}, need >= 4)`);
// The SQL actually applies it (both helpers, all their queries).
const cidPredicates = analysis.split('::int is null or o.client_id = ').length - 1;
assert.ok(cidPredicates >= 5,
  `analysis SKU queries must filter by clientId (found ${cidPredicates} predicates, need >= 5)`);

// ── FE: ONE canonical filter; the chart dropdown drives it ─────────────────
assert.ok(!dashboardView.includes('const [trendClientId'),
  'the chart-local trendClientId override must stay deleted');
assert.ok(!dashboardView.includes('setTrendClientId('),
  'nothing may write a chart-local client filter');
// The trend-chart dropdown is bound to the canonical filter.
const trendSelectStart = dashboardView.indexOf('aria-label="Filter Daily Orders Trend by client"');
assert.ok(trendSelectStart > 0, 'the trend-chart client dropdown must exist');
const trendSelectBlock = dashboardView.slice(Math.max(0, trendSelectStart - 600), trendSelectStart);
assert.ok(trendSelectBlock.includes('value={selectedClientId ?? \'\'}') &&
  trendSelectBlock.includes('setSelectedClientId(event.target.value'),
  'the chart dropdown must read/write the canonical selectedClientId');

// The dashboard load passes the canonical filter to EVERY client-scoped
// panel fetch (KPIs/daily counts, summary, SKU trends, Top SKUs table).
for (const call of [
  'fetchDashboardDailyCounts({ from: currentFrom, to: currentTo, clientId: cid',
  'fetchDashboardSummary({ from: currentFrom, to: currentTo, sevenFrom, clientId: cid',
  'fetchDashboardSkuTrends({ from: currentFrom, to: currentTo, topN: 15, clientId: cid',
  'fetchDashboardTopSkus({ from: currentFrom, to: currentTo, limit: 200, clientId: cid',
]) {
  assert.ok(dashboardView.includes(call),
    `dashboard load must scope this fetch by the canonical filter: ${call.slice(0, 40)}…`);
}
// The dashboard reloads when the filter changes.
assert.ok(/\}, \[selectedClientId, dateRange\.from, dateRange\.to\]\)/.test(dashboardView),
  'the dashboard load effect must re-run on selectedClientId');
// Top SKUs panel + heatmap derive from the scoped sku-trends payload.
assert.ok(dashboardView.includes('buildHeatmap(currentSales, priorSales'),
  'the heatmap must derive from the scoped SKU sales payload (same client universe)');
// No leftover dedicated trend fetch (the deleted override machinery).
assert.ok(!dashboardView.includes('trendDailyCounts') || dashboardView.split('trendDailyCounts').length - 1 === 0,
  'the dedicated trend-override fetch state must stay deleted');

// FE api layer forwards clientId on both SKU fetchers.
const forwards = apiClient.split('if (query.clientId !== undefined) q.clientId = query.clientId').length - 1;
assert.ok(forwards >= 2,
  `fetchDashboardSkuTrends + fetchDashboardTopSkus must forward clientId (found ${forwards})`);

// npm wiring.
assert.ok(pkg.includes('"test:dashboard-client-sku-filter"'),
  'guard must be wired into package.json');

console.log('PASS ps-212 dashboard client SKU filter guard');
