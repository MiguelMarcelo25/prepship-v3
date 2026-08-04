import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dashboardPath = path.join(root, 'web/src/components/Views/DashboardView.tsx');
const packagePath = path.join(root, 'package.json');

const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
// PS-325/PS-336: reporting windows are backend-owned. Read the canonical owner so
// this guard can pin WHERE the trailing-seven window is computed, not just that
// some expression exists somewhere.
const reportingWindows = fs.readFileSync(
  path.join(root, 'src/services/reporting-window-presets.ts'),
  'utf8',
);

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

// Inverted 2026-08-04. This required DashboardView -- the FRONTEND -- to contain
//   const sevenFrom = dateOffsetFrom(currentTo, Math.min(6, rangeLengthDays - 1))
// i.e. the browser deriving a reporting window itself. PS-325 moved that to a
// named backend owner: src/services/reporting-window-presets.ts computes
// currentTrailingSeven as shiftDay(current.to, -(trailingDays - 1)), and
// dateOffsetFrom no longer exists in src at all. DashboardView now READS the
// backend window (dashboardWindowQuery.data.currentTrailingSeven.from) and
// relays it, which is display/intent rather than policy.
//
// Third guard in three batches found requiring the frontend to own a backend
// computation, after ps-166's rate builders and ps-150's reorder policy. All
// three were written when the frontend legitimately owned that work.
//
// Pin the rule as it now stands: the owner computes, the view does not.
assert(
  reportingWindows.includes('currentTrailingSeven') &&
    /shiftDay\(current\.to, -\(trailingDays - 1\)\)/.test(reportingWindows),
  'the trailing-seven window is computed by the canonical reporting-window owner',
);
assert(
  !dashboard.includes('dateOffsetFrom(currentTo'),
  'DashboardView never derives the seven-day reporting window itself',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
