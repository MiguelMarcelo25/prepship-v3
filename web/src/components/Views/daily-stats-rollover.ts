// PS-258 (slice): the daily-stats rollover scheduling math, extracted VERBATIM
// from OrdersView.tsx. These are PURE functions — output depends only on their
// arguments (plus the two rollover constants below). No React, no state, no
// fetch, no side effects. OrdersView's effect imports getMsUntilNextDailyStats-
// Rollover() to schedule the next refresh of the daily-stats strip.
//
// The daily stats strip rolls over at 6 PM America/Los_Angeles (the operator's
// business day boundary). These helpers compute the ms until the next rollover,
// DST-aware, from any `now`.

const DAILY_STATS_ROLLOVER_TIME_ZONE = 'America/Los_Angeles'
const DAILY_STATS_ROLLOVER_HOUR = 18

interface RolloverDateParts {
  year: number
  month: number
  day: number
}

export function getDailyStatsRolloverParts(now: Date = new Date()): RolloverDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DAILY_STATS_ROLLOVER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
  }
}

export function addCalendarDays(year: number, month: number, day: number, days: number): RolloverDateParts {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  const zonedAsUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second'))
  )

  return zonedAsUtc - date.getTime()
}

export function zonedDateToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const firstPass = new Date(utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), timeZone))
  return new Date(utcGuess - getTimeZoneOffsetMs(firstPass, timeZone))
}

export function getMsUntilNextDailyStatsRollover(now: Date = new Date()): number {
  const today = getDailyStatsRolloverParts(now)
  let target = zonedDateToUtcDate(
    today.year,
    today.month,
    today.day,
    DAILY_STATS_ROLLOVER_HOUR,
    0,
    0,
    DAILY_STATS_ROLLOVER_TIME_ZONE
  )

  if (target.getTime() <= now.getTime()) {
    const tomorrow = addCalendarDays(today.year, today.month, today.day, 1)
    target = zonedDateToUtcDate(
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      DAILY_STATS_ROLLOVER_HOUR,
      0,
      0,
      DAILY_STATS_ROLLOVER_TIME_ZONE
    )
  }

  return Math.max(1000, target.getTime() - now.getTime() + 1000)
}
