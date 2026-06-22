/**
 * PS-166 / PS-258 - OrdersView daily strip render parity guard.
 *
 * Server-renders the already-extracted daily stats strip and pins its data,
 * loading, refresh-failed, and hard-error branches without touching OrdersView.tsx.
 * Offline only: no browser, network, labels, queues, order mutation, shipment
 * mutation, marketplace calls, or shipped/cancelled data changes.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { OrdersDailyStrip } = await import('../web/src/components/Views/OrdersDailyStrip');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const noop = () => {};

function renderDailyStrip(overrides: Partial<React.ComponentProps<typeof OrdersDailyStrip>> = {}): string {
  return renderToStaticMarkup(React.createElement(OrdersDailyStrip, {
    shouldShowDailyStrip: true,
    dailyStatsForStrip: {
      totalOrders: 26,
      needToShip: 5,
      upcomingOrders: 1,
    },
    dailyStripProgress: {
      shipped: 21,
      pct: 81,
      barFill: 81,
      barColor: '#e07a00',
      needToShipColor: '#e07a00',
      upcomingColor: '#03A9F4',
    },
    dailyStatsFromLabel: 'Jun 18, 12pm CA',
    dailyStatsToLabel: 'Jun 19, 12pm CA',
    dailyStatsLoadingWithoutData: false,
    dailyStatsRefreshFailedWithData: false,
    dailyStatsErroredWithoutData: false,
    dailyStatsError: null,
    loadDailyStats: noop,
    ...overrides,
  }));
}

const hiddenRender = renderDailyStrip({ shouldShowDailyStrip: false });
const dataRender = renderDailyStrip();
const loadingRender = renderDailyStrip({
  dailyStatsForStrip: null,
  dailyStripProgress: null,
  dailyStatsLoadingWithoutData: true,
});
const refreshFailedWithDataRender = renderDailyStrip({
  dailyStatsRefreshFailedWithData: true,
  dailyStatsError: 'daily stats failed',
});
const hardErrorRender = renderDailyStrip({
  dailyStatsForStrip: null,
  dailyStripProgress: null,
  dailyStatsLoadingWithoutData: false,
  dailyStatsErroredWithoutData: true,
  dailyStatsError: 'daily stats failed',
});

check('OrdersDailyStrip hidden branch renders nothing',
  hiddenRender === '');
check('OrdersDailyStrip data branch keeps the public strip anchor and stat labels',
  /id="daily-strip"/.test(dataRender) &&
    /Total Orders/.test(dataRender) &&
    /Need to Ship/.test(dataRender) &&
    /Upcoming/.test(dataRender) &&
    /21 of 26 shipped/.test(dataRender) &&
    /81%/.test(dataRender));
check('OrdersDailyStrip data branch carries the date labels',
  /Jun 18, 12pm CA/.test(dataRender) &&
    /Jun 19, 12pm CA/.test(dataRender));
check('OrdersDailyStrip loading branch keeps aria-busy and skeletons without error copy',
  /id="daily-strip"/.test(loadingRender) &&
    /aria-busy="true"/.test(loadingRender) &&
    /animate-pulse/.test(loadingRender) &&
    !/Daily stats unavailable/.test(loadingRender));
check('OrdersDailyStrip refresh-failed-with-data branch keeps data plus retry affordance',
  /21 of 26 shipped/.test(refreshFailedWithDataRender) &&
    /Refresh failed - retry/.test(refreshFailedWithDataRender) &&
    /title="daily stats failed"/.test(refreshFailedWithDataRender));
check('OrdersDailyStrip hard-error branch renders retry affordance without fake stats',
  /Daily stats unavailable - retry/.test(hardErrorRender) &&
    /title="daily stats failed"/.test(hardErrorRender) &&
    !/21 of 26 shipped/.test(hardErrorRender));

const packageJson = readFileSync('package.json', 'utf8');
const statusDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-status.md', 'utf8');
const certificationDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-certification.md', 'utf8');
const closeoutGuard = readFileSync('scripts/ps-166-ps-258-decomposition-closeout-guard.ts', 'utf8');

check('package wires PS-166/258 daily strip render parity guard',
  packageJson.includes('"test:ps-166-ps-258-orders-daily-strip-render-parity"'));
check('status docs list PS-166/258 daily strip render parity guard',
  statusDoc.includes('`test:ps-166-ps-258-orders-daily-strip-render-parity`') &&
    certificationDoc.includes('`test:ps-166-ps-258-orders-daily-strip-render-parity`'));
check('closeout guard tracks PS-166/258 daily strip render parity guard',
  closeoutGuard.includes('test:ps-166-ps-258-orders-daily-strip-render-parity'));
check('status docs keep PS-166/258 below Final Review after daily strip render parity',
  /PS-166 76%, PS-258 82%/.test(statusDoc) &&
    /not Final Review-ready/.test(statusDoc) &&
    /PS-166 76%, PS-258 82%/.test(certificationDoc) &&
    /not Final Review-ready/.test(certificationDoc));
check('status docs preserve no-live/no-mutation safety',
  /does not change runtime UI behavior/.test(certificationDoc) &&
    /shipped\/cancelled data/.test(certificationDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 Orders daily strip render parity guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 Orders daily strip render parity guard');
