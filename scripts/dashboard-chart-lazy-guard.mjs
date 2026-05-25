import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dashboardPath = path.join(root, 'web/src/components/Views/DashboardView.tsx');
const chartsPath = path.join(root, 'web/src/components/Views/DashboardCharts.tsx');
const packageJsonPath = path.join(root, 'package.json');

const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const charts = fs.existsSync(chartsPath) ? fs.readFileSync(chartsPath, 'utf8') : '';
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  dashboard.includes("import { lazy, Suspense") || dashboard.includes("import { Suspense, lazy"),
  'DashboardView imports lazy and Suspense from React',
);

assert(
  dashboard.includes("const DashboardCharts = lazy(() => import('./DashboardCharts'))"),
  'DashboardView lazy-loads DashboardCharts',
);

assert(
  !dashboard.includes("from 'recharts'") && !dashboard.includes('from "recharts"'),
  'DashboardView does not import Recharts directly',
);

assert(
  dashboard.includes('<Suspense fallback={') && dashboard.includes('<DashboardCharts'),
  'Daily Orders Trend renders DashboardCharts inside Suspense',
);

assert(
  charts.includes("from 'recharts'") || charts.includes('from "recharts"'),
  'DashboardCharts owns the Recharts import',
);

assert(
  charts.includes('ResponsiveContainer') &&
    charts.includes('LineChart') &&
    charts.includes('dataKey="current"') &&
    charts.includes('dataKey="currentRevenue"') &&
    charts.includes('yAxisId="orders"') &&
    charts.includes('yAxisId="revenue"'),
  'DashboardCharts preserves the Daily Orders Trend chart series and axes',
);

assert(
  charts.includes('overflow-hidden rounded-md') &&
    charts.includes('[&_.recharts-wrapper]:!overflow-hidden') &&
    charts.includes('[&_.recharts-surface]:!overflow-hidden'),
  'DashboardCharts clips the trend chart so lines and dots cannot spill outside the panel',
);

assert(
  charts.includes('type="linear"') &&
    !charts.includes('type="monotone"') &&
    charts.includes("domain={[0, 'dataMax']}"),
  'DashboardCharts avoids smoothed-line overshoot and keeps both Y axes bounded at zero',
);

assert(
  packageJson.scripts?.['test:dashboard-chart-lazy'] === 'node scripts/dashboard-chart-lazy-guard.mjs',
  'package.json exposes test:dashboard-chart-lazy',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
