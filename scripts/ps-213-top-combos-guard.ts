/**
 * PS-213 guard — Dashboard multi-SKU combination sales (Combos tab).
 *
 * comboSales = ORDER count (an order with 2× A + 1× B contributes ONE sale to
 * the combo "a:2|b:1"). Normalization is owned by the PS-037 combo module —
 * the SAME identity client package defaults key on — so A+B ≡ B+A, SKUs are
 * case-insensitive/trimmed, duplicate lines sum, qty is part of the key, and
 * single-SKU orders are excluded. Scoping mirrors Top SKUs (PS-212 canonical
 * client filter), cache key dashboard.top-combos.v1.
 *
 *   npx tsx scripts/ps-213-top-combos-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateOrderComboSales } from '../src/services/combo-sales';

// ── The card's A/B-collapse + C-distinct matrix ─────────────────────────────
const rows = [
  // Order 101: A + B (canonical shapes)
  { orderId: 101, sku: 'SKU-A', quantity: 1, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 101, sku: 'SKU-B', quantity: 1, unitPrice: 5, name: 'Product Beta' },
  // Order 102: SAME combo — reversed line order, different case, padded
  // whitespace. MUST collapse into the order-101 combo.
  { orderId: 102, sku: 'sku-b', quantity: 1, unitPrice: 5, name: 'Product Beta Long Name' },
  { orderId: 102, sku: '  SKU-A  ', quantity: 1, unitPrice: 10, name: 'Alpha' },
  // Order 103: DISTINCT combo (A + C) — must NOT merge with A+B.
  { orderId: 103, sku: 'SKU-A', quantity: 1, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 103, sku: 'SKU-C', quantity: 1, unitPrice: 7, name: 'Product Gamma' },
  // Order 104: qty matters — A×2 + B×1 is a DIFFERENT combo from A×1 + B×1.
  { orderId: 104, sku: 'SKU-A', quantity: 2, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 104, sku: 'SKU-B', quantity: 1, unitPrice: 5, name: 'Product Beta' },
  // Order 105: single-SKU order (even via duplicate lines) — EXCLUDED.
  { orderId: 105, sku: 'SKU-A', quantity: 1, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 105, sku: 'sku-a', quantity: 2, unitPrice: 10, name: 'Product Alpha' },
  // Order 106: duplicate lines of A sum to qty 2 → joins the order-104 combo.
  { orderId: 106, sku: 'SKU-A', quantity: 1, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 106, sku: 'SKU-A', quantity: 1, unitPrice: 10, name: 'Product Alpha' },
  { orderId: 106, sku: 'SKU-B', quantity: 1, unitPrice: 5, name: 'Product Beta' },
];

const result = aggregateOrderComboSales(rows, { limit: 50 });

// 3 distinct combos: a:1|b:1 (orders 101+102), a:1|c:1 (103), a:2|b:1 (104+106).
assert.equal(result.totalCombos, 3, `expected 3 distinct combos, got ${result.totalCombos}`);
assert.equal(result.multiSkuOrders, 5, 'orders 101/102/103/104/106 form combos; 105 is single-SKU');

const ab = result.combos.find((c) => c.comboKey === 'sku-a:1|sku-b:1');
assert.ok(ab, 'the A+B combo must exist under the canonical sorted key');
assert.equal(ab!.comboSales, 2, 'reversed/case-different order 102 must collapse into the A+B combo');
assert.equal(ab!.units, 4, 'A+B combo units = 2 orders × 2 units');
assert.equal(ab!.skuCount, 2);
// Longest observed product name wins (Top SKUs SQL convention).
assert.equal(ab!.items.find((i) => i.sku === 'sku-b')!.name, 'Product Beta Long Name');
assert.equal(ab!.revenue, 30, 'A+B revenue = 2 × ($10 + $5)');

const a2b = result.combos.find((c) => c.comboKey === 'sku-a:2|sku-b:1');
assert.ok(a2b, 'qty must be part of the combo identity (A×2 + B ≠ A + B)');
assert.equal(a2b!.comboSales, 2, 'duplicate-line order 106 must sum to A×2 and join the combo');

const ac = result.combos.find((c) => c.comboKey === 'sku-a:1|sku-c:1');
assert.ok(ac && ac.comboSales === 1, 'the A+C combo stays DISTINCT from A+B');

assert.ok(!result.combos.some((c) => c.comboKey === 'sku-a:3' || c.skuCount < 2),
  'single-SKU orders must never appear as combos');

// Sort: most comboSales first; deterministic tiebreak.
assert.equal(result.combos[0]!.comboSales, 2);
// Limit honesty: limit=1 truncates but totalCombos stays 3.
const limited = aggregateOrderComboSales(rows, { limit: 1 });
assert.equal(limited.combos.length, 1);
assert.equal(limited.totalCombos, 3, 'totalCombos must report the pre-limit count');
// Financials gate: revenue nulls out, counts unchanged.
const noFin = aggregateOrderComboSales(rows, { limit: 50, includeRevenue: false });
assert.ok(noFin.combos.every((c) => c.revenue === null), 'revenue must be null without financials');
assert.equal(noFin.combos.find((c) => c.comboKey === 'sku-a:1|sku-b:1')!.comboSales, 2);

// ── Source pins ─────────────────────────────────────────────────────────────
const comboSvc = readFileSync('src/services/combo-sales.ts', 'utf8');
const analysis = readFileSync('src/routes/analysis.ts', 'utf8');
const dashboard = readFileSync('src/routes/dashboard.ts', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const dashboardView = readFileSync('web/src/components/Views/DashboardView.tsx', 'utf8');

// ONE normalization owner: the service delegates to the PS-037 combo module
// and re-implements none of it.
assert.ok(/from '\.\.\/lib\/package-combo'/.test(comboSvc),
  'combo-sales must import the PS-037 combo owner');
for (const ownerFn of ['computeComboKey(', 'normalizeComboItems(', 'isMultiSkuCombo(']) {
  assert.ok(comboSvc.includes(ownerFn), `combo-sales must delegate to ${ownerFn}`);
}
assert.ok(!/\.toLowerCase\(\)[\s\S]{0,80}sort\(/.test(comboSvc),
  'combo-sales must not re-implement the combo key normalization/sort');

// The SQL owner applies the SAME scope as Top SKUs: clientId predicate +
// restricted scope + active-client + the multi-SKU prefilter.
const comboQueryStart = analysis.indexOf('export async function getComboBreakdownFromOrderItems');
assert.ok(comboQueryStart > 0, 'analysis.ts must own getComboBreakdownFromOrderItems');
const comboQueryBlock = analysis.slice(comboQueryStart, comboQueryStart + 4000);
assert.ok(comboQueryBlock.includes('::int is null or o.client_id = '),
  'combos SQL must filter by the canonical clientId');
assert.ok(comboQueryBlock.includes('analysisOrderScopePredicate(q)'),
  'combos SQL must apply the restricted client/store scope');
assert.ok(comboQueryBlock.includes("activeClientPredicateSql('c')"),
  'combos SQL must exclude inactive clients like Top SKUs');
assert.ok(/having count\(distinct lower\(trim\(oi2\.sku\)\)\) >= 2/.test(comboQueryBlock),
  'combos SQL must prefilter to multi-SKU orders (optimization; TS owner is authoritative)');
assert.ok(comboQueryBlock.includes('aggregateOrderComboSales('),
  'the SQL owner must delegate aggregation to the pure combo-sales service');

// Dashboard route: canonical cache key + scope + financials gate.
assert.ok(dashboard.includes("analyticsCacheKey('dashboard.top-combos.v1'"),
  'route must cache under dashboard.top-combos.v1');
assert.ok(/getComboBreakdownFromOrderItems\(\{[\s\S]{0,200}clientId: q\.clientId/.test(dashboard),
  '/dashboard/top-combos must pass the request clientId into the combos owner');
const combosRouteStart = dashboard.indexOf("app.get('/top-combos'");
const combosRouteBlock = dashboard.slice(combosRouteStart, combosRouteStart + 2200);
assert.ok(combosRouteBlock.includes('canViewFinancials') && combosRouteBlock.includes('financials: canViewFinancials'),
  'combos route must gate + cache-key the financials visibility');
assert.ok(combosRouteBlock.includes('dashboardCallerCacheScope(c, scope)'),
  'combos cache key must segregate by caller scope');

// FE: the fetcher forwards the canonical client filter; the panel keeps Top
// SKUs intact and adds the Combos tab.
assert.ok(/fetchDashboardTopCombos\(query[\s\S]{0,1500}if \(query\.clientId !== undefined\) q\.clientId = query\.clientId/.test(apiClient),
  'fetchDashboardTopCombos must forward clientId');
assert.ok(apiClient.includes('/dashboard/top-combos'),
  'api client must call the backend combos endpoint');
assert.ok(/fetchDashboardTopCombos\(\{ from: dateRange\.from, to: dateRange\.to, limit: 50, clientId: cid/.test(dashboardView),
  'the Combos tab fetch must carry the canonical selectedClientId + date window');
assert.ok(dashboardView.includes("setSkuPanelTab('combos')") && dashboardView.includes("setSkuPanelTab('skus')"),
  'the panel must offer both tabs');
// Top SKUs preserved exactly (the PS-212 pin string still present).
assert.ok(dashboardView.includes('fetchDashboardTopSkus({ from: currentFrom, to: currentTo, limit: 200, clientId: cid'),
  'the existing Top SKUs fetch must stay untouched');
assert.ok(dashboardView.includes('topSkuRows.map((row, index)'),
  'the existing Top SKUs list rendering must stay untouched');
// The combos list re-fetches when the canonical filter or window changes.
// FE-2 (audit 2.2 slice 1): the effect became a React Query — the tab gates
// `enabled`, and the canonical filters ride the query key so a client/date
// change re-keys (and re-fetches) the combos exactly like the old deps array.
assert.ok(dashboardView.includes("enabled: skuPanelTab === 'combos'") &&
  /queryKey: \['dashboard', 'top-combos', dashboardScope\.currentFrom, dashboardScope\.currentTo, dashboardScope\.cid \?\? null\]/.test(dashboardView),
  'the combos query must gate on the combos tab and re-key on the canonical client filter + date window');
// Truncation honesty.
assert.ok(dashboardView.includes('Showing {topCombos.length} of {topCombosTotal} combos'),
  'the Combos tab must disclose truncation');

// npm wiring.
assert.ok(readFileSync('package.json', 'utf8').includes('"test:ps-213-top-combos"'),
  'guard must be wired into package.json');

console.log('PASS ps-213 top combos guard');
