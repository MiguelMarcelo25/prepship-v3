/**
 * PS-258 — daily-stats rollover helpers extraction guard (BEHAVIORAL + STATIC).
 *
 * Imports the REAL pure functions extracted VERBATIM out of OrdersView.tsx
 * (web/src/components/Views/daily-stats-rollover.ts) and pins their behavior so
 * the extraction is proven importable, pure, and byte-identical in result.
 *
 * The rollover boundary is 6 PM America/Los_Angeles. getMsUntilNextDailyStats-
 * Rollover(now) returns the ms until the next 6 PM PT (DST-aware), clamped to a
 * minimum of ~1s and padded by 1s. The helper math is pure: same `now` in →
 * same number out, no env/state/clock dependence beyond the passed Date.
 *
 * STATIC pins: OrdersView imports getMsUntilNextDailyStatsRollover from the new
 * module and no longer defines any of the five locals or the two rollover
 * constants; the new module exports the five functions.
 *
 *   npx tsx scripts/ps-258-daily-stats-rollover-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  getDailyStatsRolloverParts,
  addCalendarDays,
  getTimeZoneOffsetMs,
  zonedDateToUtcDate,
  getMsUntilNextDailyStatsRollover,
} from '../web/src/components/Views/daily-stats-rollover';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/daily-stats-rollover.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';
const PT = 'America/Los_Angeles';

// ── getDailyStatsRolloverParts: PT calendar parts for a known instant ──
// 2026-06-16T12:00:00Z is 05:00 PDT (UTC-7) on Jun 16 in Los Angeles.
const partsMidday = getDailyStatsRolloverParts(new Date('2026-06-16T12:00:00Z'));
check('rollover parts give the PT calendar day for a UTC-noon instant',
  partsMidday.year === 2026 && partsMidday.month === 6 && partsMidday.day === 16);
// 2026-06-16T03:00:00Z is 20:00 PDT on Jun 15 (the previous PT day).
const partsLateNight = getDailyStatsRolloverParts(new Date('2026-06-16T03:00:00Z'));
check('rollover parts roll back to the prior PT day before PT midnight',
  partsLateNight.year === 2026 && partsLateNight.month === 6 && partsLateNight.day === 15);
// default arg path executes without throwing and yields a sane shape.
const partsNow = getDailyStatsRolloverParts();
check('rollover parts default-arg yields a plausible date shape',
  Number.isInteger(partsNow.year) && partsNow.month >= 1 && partsNow.month <= 12 && partsNow.day >= 1 && partsNow.day <= 31);

// ── addCalendarDays: pure UTC calendar arithmetic incl. month/year rollover ──
check('addCalendarDays advances within a month',
  JSON.stringify(addCalendarDays(2026, 6, 16, 1)) === JSON.stringify({ year: 2026, month: 6, day: 17 }));
check('addCalendarDays rolls over a month boundary',
  JSON.stringify(addCalendarDays(2026, 6, 30, 1)) === JSON.stringify({ year: 2026, month: 7, day: 1 }));
check('addCalendarDays rolls over a year boundary',
  JSON.stringify(addCalendarDays(2026, 12, 31, 1)) === JSON.stringify({ year: 2027, month: 1, day: 1 }));
check('addCalendarDays handles a zero delta (identity)',
  JSON.stringify(addCalendarDays(2026, 2, 15, 0)) === JSON.stringify({ year: 2026, month: 2, day: 15 }));
check('addCalendarDays handles a negative delta back over a month boundary',
  JSON.stringify(addCalendarDays(2026, 3, 1, -1)) === JSON.stringify({ year: 2026, month: 2, day: 28 }));

// ── getTimeZoneOffsetMs: PT offsets (PDT = -7h in summer, PST = -8h in winter) ──
const HOUR = 60 * 60 * 1000;
check('PT offset is -7h (PDT) in summer',
  getTimeZoneOffsetMs(new Date('2026-06-16T12:00:00Z'), PT) === -7 * HOUR);
check('PT offset is -8h (PST) in winter',
  getTimeZoneOffsetMs(new Date('2026-01-16T12:00:00Z'), PT) === -8 * HOUR);
check('UTC offset is zero',
  getTimeZoneOffsetMs(new Date('2026-06-16T12:00:00Z'), 'UTC') === 0);

// ── zonedDateToUtcDate: a PT wall-clock maps to the right UTC instant ──
// 6 PM PT on Jun 16 (PDT, UTC-7) == 2026-06-17T01:00:00Z.
check('6 PM PDT maps to the correct UTC instant',
  zonedDateToUtcDate(2026, 6, 16, 18, 0, 0, PT).toISOString() === '2026-06-17T01:00:00.000Z');
// 6 PM PT on Jan 16 (PST, UTC-8) == 2026-01-17T02:00:00Z.
check('6 PM PST maps to the correct UTC instant',
  zonedDateToUtcDate(2026, 1, 16, 18, 0, 0, PT).toISOString() === '2026-01-17T02:00:00.000Z');

// ── getMsUntilNextDailyStatsRollover: the public scheduler value ──
// 10:00 PDT Jun 16 → next 6 PM PT is the SAME day, 8h ahead (+1s pad).
const beforeRollover = new Date('2026-06-16T17:00:00Z'); // 10:00 PDT
check('ms-until counts down to the same-day 6 PM PT (+1s pad)',
  getMsUntilNextDailyStatsRollover(beforeRollover) === 8 * HOUR + 1000);
// 19:00 PDT Jun 16 (past 6 PM) → next 6 PM PT is TOMORROW (Jun 17), 23h ahead.
const afterRollover = new Date('2026-06-17T02:00:00Z'); // 19:00 PDT Jun 16
check('ms-until rolls to the NEXT day once past 6 PM PT',
  getMsUntilNextDailyStatsRollover(afterRollover) === 23 * HOUR + 1000);
// exactly at the boundary (<=) → rolls to tomorrow.
const atRollover = new Date('2026-06-17T01:00:00Z'); // 18:00 PDT Jun 16
check('ms-until at exactly 6 PM PT rolls to the next day (boundary is <=)',
  getMsUntilNextDailyStatsRollover(atRollover) === 24 * HOUR + 1000);
// purity: identical `now` in → identical number out.
check('ms-until is pure (same Date in → same value out)',
  getMsUntilNextDailyStatsRollover(new Date('2026-06-16T17:00:00Z')) ===
  getMsUntilNextDailyStatsRollover(new Date('2026-06-16T17:00:00Z')));
// clamp floor: result is always at least 1000ms.
check('ms-until never returns below the 1000ms floor',
  getMsUntilNextDailyStatsRollover(new Date('2026-06-17T00:59:59.999Z')) >= 1000);

// ── STATIC: the new module exports the five functions ──
const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
for (const fn of [
  'getDailyStatsRolloverParts',
  'addCalendarDays',
  'getTimeZoneOffsetMs',
  'zonedDateToUtcDate',
  'getMsUntilNextDailyStatsRollover',
]) {
  check(`module exports ${fn}`, new RegExp(`export function ${fn}\\b`).test(moduleSrc));
}
check('module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(moduleSrc));

// ── STATIC: OrdersView imports the public fn and no longer defines the locals ──
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
check('OrdersView imports getMsUntilNextDailyStatsRollover from ./daily-stats-rollover',
  /import \{ getMsUntilNextDailyStatsRollover \} from '\.\/daily-stats-rollover'/.test(ordersView));
check('OrdersView no longer defines function getMsUntilNextDailyStatsRollover',
  !/function getMsUntilNextDailyStatsRollover\b/.test(ordersView));
check('OrdersView no longer defines function getDailyStatsRolloverParts',
  !/function getDailyStatsRolloverParts\b/.test(ordersView));
check('OrdersView no longer defines function addCalendarDays',
  !/function addCalendarDays\b/.test(ordersView));
check('OrdersView no longer defines function getTimeZoneOffsetMs',
  !/function getTimeZoneOffsetMs\b/.test(ordersView));
check('OrdersView no longer defines function zonedDateToUtcDate',
  !/function zonedDateToUtcDate\b/.test(ordersView));
check('OrdersView no longer declares the DAILY_STATS_ROLLOVER_* constants',
  !/const DAILY_STATS_ROLLOVER_TIME_ZONE\b/.test(ordersView) &&
  !/const DAILY_STATS_ROLLOVER_HOUR\b/.test(ordersView));
check('OrdersView still calls getMsUntilNextDailyStatsRollover() (the rollover effect)',
  /getMsUntilNextDailyStatsRollover\(\)/.test(ordersView));

check('package.json wires test:ps-258-daily-stats-rollover',
  /test:ps-258-daily-stats-rollover/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-258 daily-stats rollover guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 daily-stats rollover guard');
