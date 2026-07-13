import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dashboardPath = path.join(root, 'web/src/components/Views/DashboardView.tsx');
const packageJsonPath = path.join(root, 'package.json');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function indexOfOrEnd(needle) {
  const index = dashboard.indexOf(needle);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

assert(
  dashboard.includes('function scheduleDashboardNonCriticalWork') ||
    dashboard.includes('const scheduleDashboardNonCriticalWork'),
  'DashboardView defines scheduleDashboardNonCriticalWork',
);

assert(
  dashboard.includes('requestIdleCallback') && dashboard.includes('setTimeout'),
  'scheduleDashboardNonCriticalWork uses requestIdleCallback with a setTimeout fallback',
);

assert(
  dashboard.includes('runNonCriticalDashboardWork'),
  'DashboardView separates non-critical dashboard work from the critical first paint path',
);

// FE-2 (audit 2.2 slice 1): the imperative loadDashboard pipeline became
// React Query queries. The staging invariant is unchanged — the critical
// metrics aggregate paints first, and the heavy panel queries (sku-trends,
// inventory-risk pageSize:300, top-skus limit:200) stay parked behind an
// idle-scheduled gate that opens only after the metrics query settles.
assert(
  dashboard.includes('const metricsSettled = !metricsQuery.isPending'),
  'the non-critical gate keys off the critical metrics query settling',
);

assert(
  dashboard.includes('if (nonCriticalReady || !metricsSettled) return') &&
    dashboard.includes('scheduleDashboardNonCriticalWork(runNonCriticalDashboardWork)'),
  'non-critical work is scheduled on browser idle only after metrics settle',
);

const gateCount = dashboard.split('enabled: nonCriticalReady').length - 1;
assert(
  gateCount >= 3,
  `sku-trends, inventory-risk, and top-skus queries defer behind the idle gate (found ${gateCount}, need >= 3)`,
);

// The critical metrics query itself must never sit behind a gate.
const metricsBlock = dashboard.slice(
  indexOfOrEnd('const metricsQuery = useQuery'),
  indexOfOrEnd('const shippingMarginQuery = useQuery'),
);
assert(
  metricsBlock.length > 0 && !metricsBlock.includes('enabled:'),
  'the critical metrics query is ungated (critical first paint)',
);

// Panels still load/finish independently — per-query status, not one blob
// (the React Query form of the old finishPanels(['metrics']) /
// finishPanels(['trend', 'topSkus', 'heatmap']) / (['inventory']) /
// (['table']) groups).
assert(
  dashboard.includes('metrics: metricsQuery.isPending') &&
    dashboard.includes('trend: skuTrendsQuery.isPending') &&
    dashboard.includes('inventory: inventoryRiskQuery.isPending') &&
    dashboard.includes('table: topSkusQuery.isPending'),
  'metrics, trend/topSkus/heatmap, inventory, and table panels finish independently',
);

assert(
  !dashboard.includes('await Promise.allSettled([clientsPromise, corePromise, inventoryPromise, analysisPromise])'),
  'initial first paint no longer waits for all dashboard panels',
);

assert(
  packageJson.scripts?.['test:dashboard-first-paint'] === 'node scripts/dashboard-first-paint-guard.mjs',
  'package.json exposes test:dashboard-first-paint',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
