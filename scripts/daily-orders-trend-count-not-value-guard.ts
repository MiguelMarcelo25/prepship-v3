/**
 * Guard: the "Daily Orders Trend" multi-line ("All Clients") chart plots ORDER
 * COUNT, not order value.
 *
 * The panel is titled "Daily Orders Trend" but the All-Clients multi-line view
 * was plotting per-client revenue with a $-formatted axis. This guard locks the
 * full stack to order count: the backend returns a per-client daily count, the
 * frontend pivots on it, and the chart axis/tooltip are no longer money.
 */
import { readFileSync } from 'node:fs';

const route = readFileSync('src/routes/dashboard.ts', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const dashboardView = readFileSync('web/src/components/Views/DashboardView.tsx', 'utf8');
const charts = readFileSync('web/src/components/Views/DashboardCharts.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Backend: per-client daily aggregate returns an order count.
check(
  'backend daily-revenue-by-client selects count(*) as count',
  /count\(\*\)::int as count/.test(route),
);
check(
  'backend payload type includes count',
  /data: Array<\{ day: string; clientId: number \| null; revenue: number; count: number \}>/.test(route),
);
check(
  'backend cache key bumped so stale countless rows are not served',
  route.includes("'dashboard.daily-revenue-by-client.v2'"),
);

// apiClient: count is part of the typed contract.
check(
  'apiClient fetchDashboardDailyRevenueByClient returns count',
  /fetchDashboardDailyRevenueByClient[\s\S]{0,400}?clientId: number \| null; revenue: number; count: number/.test(apiClient),
);

// DashboardView: the multi-line pivot reads order count, not revenue.
check(
  'DashboardView pivots per-client lines on row.count',
  /countByDayClient\.set\(`\$\{row\.day\}\|\$\{clientKey\}`, num\(row\.count\)\)/.test(dashboardView),
);
check(
  'DashboardView no longer pivots the multi-line chart on row.revenue',
  !/\brevenue\.set\(`\$\{row\.day\}\|\$\{clientKey\}`/.test(dashboardView),
);

// DashboardCharts: the multi-client axis + tooltip are counts, not money.
// Bound the slice to the MultiClientChart function only — the single-client
// dual-axis chart below it legitimately keeps a $-formatted order-value line.
const multi = charts.slice(
  charts.indexOf('function MultiClientChart'),
  charts.indexOf('export default'),
);
check(
  'multi-client Y-axis tick is a plain integer (no $)',
  /tickFormatter=\{\(value: number\) => formatInt\(value\)\}/.test(multi),
);
check(
  'multi-client tooltip is a plain integer (no $)',
  /formatter=\{\(value: number, name: string\) => \[formatInt\(num\(value\)\), name\]\}/.test(multi),
);
check(
  'multi-client chart has no $-formatted value strings left',
  !/`\$\$\{formatInt/.test(multi) && !multi.includes('`$${formatInt'),
);

if (failures > 0) {
  console.error(`\nFAIL Daily Orders Trend count-not-value guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS Daily Orders Trend count-not-value guard');
