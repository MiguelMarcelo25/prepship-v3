import { CALIFORNIA_TIME_ZONE, californiaWallClockToUtc } from './california';

// Fulfillment-day metrics answer: "How many orders came in early enough to
// prepare and hand off to the carrier today?" Normal weekdays use 12pm CA
// yesterday through 12pm CA today before 6pm, then roll to today noon through
// tomorrow noon after 6pm. Weekends match v2 by holding Friday noon through
// Monday noon until Monday's 6pm rollover.
//
// Boundaries are TRUE noon-Pacific moments expressed in UTC (noon = 19:00 UTC
// in PDT, 20:00 UTC in PST). This matches the standardized storage convention:
// `orders.order_date` now holds real UTC instants (ShipStation v1 timestamps
// are parsed as account-local Pacific and converted to UTC at sync time, and
// legacy rows were repaired the same way). See `src/lib/time/california.ts`.

const FULFILLMENT_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CALIFORNIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

export interface FulfillmentDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

export function getFulfillmentDateParts(now = new Date()): FulfillmentDateParts {
  const parts = FULFILLMENT_DATE_PARTS.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
  };
}

export function addCalendarDaysUtc(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function californiaNoonUtcForFulfillmentDate(year: number, month: number, day: number): Date {
  // Per user override unlock shipped data on 2026-05-29: return the UTC instant
  // for 12:00 *Pacific* on the given calendar date, DST-aware via the shared
  // `californiaWallClockToUtc` primitive. Previously this returned literal
  // noon-UTC (Date.UTC(y, m, d, 12, 0, 0)), which was only correct under the
  // old "PT-clock-stamped-Z" storage. Now that `orders.order_date` holds true
  // UTC instants, noon-UTC bounded ~5am PT and silently misattributed the
  // 5am–noon PT window to the wrong fulfillment day. This is a read-only
  // analytics boundary; no shipped/cancelled mutation is involved.
  return californiaWallClockToUtc(year, month, day, 12, 0, 0);
}

export function computeFulfillmentShiftWindow(now = new Date()): { from: Date; to: Date } {
  const ptNow = getFulfillmentDateParts(now);
  const dow = new Date(Date.UTC(ptNow.year, ptNow.month - 1, ptNow.day)).getUTCDay();
  const isAfterRollover = ptNow.hour >= 18;
  let startCalendarDate: { year: number; month: number; day: number };
  let endCalendarDate: { year: number; month: number; day: number };

  if (dow === 6) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -1);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 2);
  } else if (dow === 0) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -2);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 1);
  } else if (dow === 1 && !isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -3);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
  } else if (dow === 5 && isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 3);
  } else if (isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 1);
  } else {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -1);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
  }

  return {
    from: californiaNoonUtcForFulfillmentDate(
      startCalendarDate.year,
      startCalendarDate.month,
      startCalendarDate.day
    ),
    to: californiaNoonUtcForFulfillmentDate(
      endCalendarDate.year,
      endCalendarDate.month,
      endCalendarDate.day
    ),
  };
}

// v2-parity label — "Apr 21, 12pm PT" (comma, lowercase am/pm, no space).
// Reads the boundary in California time because the Date is now a true UTC
// instant for noon Pacific (not a UTC-clock proxy). The frontend normalizes
// the "PT" suffix to "CA" for display.
export function formatFulfillmentBoundaryLabel(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CALIFORNIA_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const hour24 = Number(get('hour'));
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? 'pm' : 'am';
  return `${month} ${day}, ${hour12}${suffix} PT`;
}
