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

assert(
  dashboard.includes("finishPanels(['metrics'])"),
  'critical summary load finishes the metrics panel before non-critical work',
);

assert(
  dashboard.includes("finishPanels(['trend', 'topSkus', 'heatmap'])") &&
    dashboard.includes("finishPanels(['inventory'])") &&
    dashboard.includes("finishPanels(['table'])"),
  'trend/topSkus/heatmap, inventory, and table panels finish independently',
);

const metricsIndex = indexOfOrEnd("finishPanels(['metrics'])");
const loadingFalseIndex = indexOfOrEnd('setLoading(false)');
const scheduleIndex = indexOfOrEnd('scheduleDashboardNonCriticalWork(runNonCriticalDashboardWork');

assert(
  metricsIndex < loadingFalseIndex && loadingFalseIndex < scheduleIndex,
  'initial load clears global loading after metrics and before scheduling non-critical work',
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
