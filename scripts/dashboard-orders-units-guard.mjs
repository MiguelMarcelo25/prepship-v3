import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dashboardPath = path.join(root, 'web/src/components/Views/DashboardView.tsx');
const packagePath = path.join(root, 'package.json');

const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  pkg.scripts?.['test:dashboard-orders-units'] === 'node scripts/dashboard-orders-units-guard.mjs',
  'package.json exposes test:dashboard-orders-units',
);

assert(
  dashboard.includes('formatOrdersUnits('),
  'dashboard formats KPI values as Orders / Units',
);

assert(
  dashboard.includes('currentOrders7') && dashboard.includes('currentOrdersRange'),
  'dashboard computes 7-day and selected-range order totals',
);

assert(
  dashboard.includes('Last 7 Days Orders / Units'),
  'first KPI card is explicitly labeled Orders / Units for the last 7 days',
);

assert(
  dashboard.includes('`${rangeLabel} Orders / Units`'),
  'selected-range KPI card label follows the active range instead of hardcoding 30 days',
);

assert(
  !dashboard.includes('rangeLengthDays * 0.25'),
  '7-day KPI is not calculated as 25% of the selected range',
);

assert(
  dashboard.includes('const sevenFrom = dateOffsetFrom(currentTo, Math.min(6, rangeLengthDays - 1))'),
  '7-day summary window uses the last seven calendar days, bounded by selected range length',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
