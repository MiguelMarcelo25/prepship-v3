/**
 * Guard: the Daily Orders Trend (All Clients) chart includes an aggregate
 * "Total orders across all stores" line in addition to the per-client lines.
 *
 * The DashboardView pivot sums every client's daily order count into the shared
 * TOTAL_TREND_SERIES_KEY and prepends a "Total (all stores)" series; the chart
 * renders that key as a thick dark line that is never dimmed by per-client focus.
 */
import { readFileSync } from 'node:fs';
import { TOTAL_TREND_SERIES_KEY } from '../web/src/components/Views/dashboard-trend-constants';

const view = readFileSync('web/src/components/Views/DashboardView.tsx', 'utf8');
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

check("shared key is '__total__'", TOTAL_TREND_SERIES_KEY === '__total__');

// DashboardView pivot: per-day total summed across clients + leading total series.
check(
  'pivot accumulates a per-day total across all clients',
  /dayTotal \+= value/.test(view) &&
    /row\[TOTAL_TREND_SERIES_KEY\] = dayTotal/.test(view),
);
check(
  'pivot prepends a "Total (all stores)" series to the legend',
  /key: TOTAL_TREND_SERIES_KEY, name: 'Total \(all stores\)'/.test(view),
);
check(
  'DashboardView imports the shared total key',
  /import \{ TOTAL_TREND_SERIES_KEY \} from '\.\/dashboard-trend-constants'/.test(view),
);

// DashboardCharts: distinct styling, never dimmed.
check(
  'chart maps a stable color per series (total dark, clients palette)',
  /function buildSeriesColorMap/.test(charts) &&
    /s\.key === TOTAL_TREND_SERIES_KEY/.test(charts) &&
    /const TOTAL_STROKE = '#0f172a'/.test(charts),
);
check(
  'total line is never dimmed by per-client focus',
  /const isDimmed = !isTotal && focusedKey != null && !isFocused/.test(charts),
);
check(
  'total line is drawn thicker / on top',
  /strokeWidth=\{isTotal \?/.test(charts) &&
    /x\.s\.key === TOTAL_TREND_SERIES_KEY \? 2 :/.test(charts),
);

if (failures > 0) {
  console.error(`\nFAIL Daily Orders Trend total-line guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS Daily Orders Trend total-line guard');
