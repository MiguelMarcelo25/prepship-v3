import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildReportingDateBuckets,
  buildReportingWindow,
  projectAnalysisSkuFinancials,
  projectAnalysisSkuTotals,
  reportingOrderShipmentProjectionJoinSql,
} from '../src/services/reporting-projection';

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
  return readFileSync(path, 'utf8');
}

function method(source: string, name: string): string {
  const start = source.indexOf(`async ${name}`);
  if (start < 0) return '';
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const springForward = buildReportingWindow({ from: '2026-03-08', to: '2026-03-08' });
const fallBack = buildReportingWindow({ from: '2026-11-01', to: '2026-11-01' });
check(
  'California spring-forward reporting day is exactly one 23-hour business day',
  Date.parse(springForward.dateToExclusive) - Date.parse(springForward.dateFrom) === 23 * 60 * 60 * 1000,
  springForward,
);
check(
  'California fall-back reporting day is exactly one 25-hour business day',
  Date.parse(fallBack.dateToExclusive) - Date.parse(fallBack.dateFrom) === 25 * 60 * 60 * 1000,
  fallBack,
);
const thirtyDays = buildReportingWindow({ from: '2026-06-11', to: '2026-07-10' });
check(
  'reporting buckets preserve the requested inclusive 30-day calendar range',
  buildReportingDateBuckets(thirtyDays).length === 30,
);

const completeRow = {
  orders: 1,
  pending: 0,
  ext_shipped: 0,
  total_qty: 2,
  std_ship_count: 1,
  exp_ship_count: 0,
  std_qty_total: 2,
  exp_qty_total: 0,
  std_total: '8.00',
  exp_total: '0.00',
  total_shipping: '8.00',
  ship_count_with_cost: 1,
  total_revenue: '30.00',
  total_selling_fee: '3.00',
  selling_fee_complete: true,
};
const complete = projectAnalysisSkuFinancials(completeRow, true);
check(
  'backend projection owns SKU averages and contribution profit',
  complete.financialsState === 'available'
    && complete.standardAvgShipping === 4
    && complete.avgSellingPrice === 15
    && complete.profit === 19,
  complete,
);

const incomplete = projectAnalysisSkuFinancials(
  { ...completeRow, selling_fee_complete: false },
  true,
);
check(
  'missing fee sync remains explicitly unavailable instead of becoming a false zero profit',
  incomplete.financialsState === 'incomplete'
    && incomplete.totalSellingFee === null
    && incomplete.profit === null,
  incomplete,
);
const incompleteTotals = projectAnalysisSkuTotals(
  [
    { ...completeRow, ...complete },
    { ...completeRow, ...incomplete },
  ],
  true,
);
check(
  'one incomplete row keeps aggregate fee and profit totals unavailable',
  incompleteTotals.financialsState === 'incomplete'
    && incompleteTotals.totalSellingFee === null
    && incompleteTotals.totalProfit === null,
  incompleteTotals,
);
const forbidden = projectAnalysisSkuFinancials(completeRow, false);
check(
  'financial permission redaction is explicit',
  forbidden.financialsState === 'forbidden'
    && forbidden.totalShipping === null
    && forbidden.profit === null,
  forbidden,
);
const renderedShipmentProjection = new PgDialect().sqlToQuery(sql`
  select * from orders o
  ${reportingOrderShipmentProjectionJoinSql(sql`o.id`, 'ls')}
`).sql;
check(
  'per-order shipment projection renders one valid lateral join with split service costs',
  renderedShipmentProjection.includes('left join lateral')
    && renderedShipmentProjection.includes('as expedited_cost')
    && renderedShipmentProjection.includes('as standard_cost')
    && renderedShipmentProjection.includes(') ls on true'),
  renderedShipmentProjection,
);

const analysis = read('src/routes/analysis.ts');
const inventory = read('src/routes/inventory.ts');
const dashboard = read('src/routes/dashboard.ts');
const reportingOwner = read('src/services/reporting-projection.ts');
const api = read('web/src/lib/v2-apiClient.ts');
const sharedApi = read('web/src/lib/v2-apiClient/shared.ts');
const analysisView = read('web/src/components/Views/AnalysisView.tsx');
const analysisTable = read('web/src/components/Views/AnalysisDataTable.tsx');
const analysisParity = read('web/src/components/Views/analysis-parity.ts');

check(
  'Dashboard and Analysis delegate calendar ranges to the same California reporting owner',
  analysis.includes('buildReportingWindow')
    && dashboard.includes('buildReportingWindow')
    && sharedApi.includes('const toDay =')
    && !method(sharedApi, 'normalizeAnalysisRange').includes('new Date('),
);
check(
  'requested client/store filters narrow authorization scope with a separate AND predicate',
  analysis.includes('analysisOrderScopePredicate(q)')
    && analysis.includes('analysisSelectedOrderPredicate(q)')
    && /sql\.join\(predicates, sql` and `\)/.test(analysis),
);
check(
  'shared SKU inventory identity includes client id and never joins by SKU alone',
  analysis.includes('distinct on (inv.client_id, lower(inv.sku))')
    && analysis.includes('inv.client_id is not distinct from a.client_id')
    && analysis.includes('sdj.client_id is not distinct from a.client_id'),
);
check(
  'inventory SKU order detail is bound to the selected inventory row client',
  inventory.includes('o.client_id is not distinct from ${row.clientId}::int'),
);
check(
  'Analysis and Inventory use the shared purchased-cost and service-class projection',
  (analysis.match(/reportingShipmentCostJoinSql\('s'\)/g) ?? []).length >= 2
    && analysis.includes("reportingOrderShipmentProjectionJoinSql(sql`o.id`, 'ls')")
    && (inventory.match(/reportingOrderShipmentProjectionJoinSql\(sql`o\.id`, 'ls'\)/g) ?? []).length >= 2
    && reportingOwner.includes('as expedited_cost')
    && reportingOwner.includes('as standard_cost')
    && analysis.includes('REPORTING_EXPEDITED_SERVICES_SQL')
    && inventory.includes('standard_label_cost'),
);

const strictReportingMethods = [
  'fetchDashboardDailyCounts',
  'fetchDashboardDailyRevenueByClient',
  'fetchDashboardSummary',
  'fetchDashboardSkuTrends',
  'fetchDashboardTopSkus',
  'fetchDashboardTopCombos',
  'fetchDashboardInventoryRisk',
  'fetchAnalysisDailySales',
  'fetchAnalysisSkus',
];
check(
  'reporting transport rejects endpoint failures instead of returning safe zero/empty payloads',
  strictReportingMethods.every((name) => {
    const source = method(api, name);
    return source.length > 0 && !source.includes('safe(') && !source.includes('cachedSafe(');
  }),
);
check(
  'Analysis renders backend totals and projections without frontend financial formulas',
  analysisView.includes('totals: skuData.totals || null')
    && analysisView.includes('Sales trend unavailable: {dataState.chartError}')
    && !analysisView.includes('buildAnalysisTotals')
    && analysisTable.includes('row as { profit?: number | null }')
    && analysisTable.includes('totals.avgSellingPrice')
    && !/revenue\s*-\s*shipping\s*-\s*fees/.test(analysisTable)
    && !/totalRevenue\s*\/\s*totalQty/.test(`${analysisTable}\n${analysisParity}`)
    && !analysisParity.includes('buildAnalysisTotals'),
);

if (failures > 0) {
  console.error(`\nPS-418 reporting projection guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-418 reporting projection guard passed.');
