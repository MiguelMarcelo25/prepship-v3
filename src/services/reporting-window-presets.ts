import { CALIFORNIA_TIME_ZONE } from '../lib/time/california';

export type ReportingDateRange = { from: string; to: string };
export type DashboardReportingWindow = {
  current: ReportingDateRange;
  prior: ReportingDateRange;
  currentTrailingSeven: ReportingDateRange;
  priorTrailingSeven: ReportingDateRange;
  rangeDays: number;
};
export type BillingWindowPreset = 'all' | 'this_month' | 'last_month' | 'last_30' | 'last_90';
export type ReportingPickerPreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last15'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'last90'
  | 'ytd';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CA_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: CALIFORNIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parts(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, offset: number): string {
  const [year, month, date] = parts(day);
  return formatUtcDay(new Date(Date.UTC(year, month - 1, date + offset)));
}

function monthStart(day: string, offset: number): string {
  const [year, month] = parts(day);
  return formatUtcDay(new Date(Date.UTC(year, month - 1 + offset, 1)));
}

function monthEnd(day: string, offset: number): string {
  const [year, month] = parts(day);
  return formatUtcDay(new Date(Date.UTC(year, month + offset, 0)));
}

export function californiaReportingDay(now = new Date()): string {
  const values = Object.fromEntries(CA_DAY.formatToParts(now).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function resolveLastDaysReportingWindow(days: number, now = new Date()): ReportingDateRange {
  const to = californiaReportingDay(now);
  if (days === 0) return { from: '', to };
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('Reporting preset days must be an integer from 0 through 3650.');
  }
  return { from: shiftDay(to, -(days - 1)), to };
}

export function resolveBillingPresetWindow(
  preset: BillingWindowPreset,
  now = new Date(),
): ReportingDateRange {
  const today = californiaReportingDay(now);
  switch (preset) {
    case 'all':
      return { from: '2020-01-01', to: today };
    case 'this_month':
      return { from: monthStart(today, 0), to: monthEnd(today, 0) };
    case 'last_month':
      return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case 'last_30':
      return resolveLastDaysReportingWindow(30, now);
    case 'last_90':
      return resolveLastDaysReportingWindow(90, now);
  }
}

export function resolveReportingPickerPreset(
  preset: ReportingPickerPreset,
  now = new Date(),
): ReportingDateRange {
  const today = californiaReportingDay(now);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = shiftDay(today, -1);
      return { from: day, to: day };
    }
    case 'last7':
      return resolveLastDaysReportingWindow(7, now);
    case 'last15':
      return resolveLastDaysReportingWindow(15, now);
    case 'last30':
      return resolveLastDaysReportingWindow(30, now);
    case 'thisMonth':
      return { from: monthStart(today, 0), to: today };
    case 'lastMonth':
      return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case 'last90':
      return resolveLastDaysReportingWindow(90, now);
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export function resolvePriorReportingWindow(range: ReportingDateRange): ReportingDateRange {
  if (!DAY_RE.test(range.from) || !DAY_RE.test(range.to) || range.from > range.to) {
    throw new Error('Reporting range must contain ordered YYYY-MM-DD dates.');
  }
  const [fromYear, fromMonth, fromDate] = parts(range.from);
  const [toYear, toMonth, toDate] = parts(range.to);
  const days = Math.round(
    (Date.UTC(toYear, toMonth - 1, toDate) - Date.UTC(fromYear, fromMonth - 1, fromDate)) / 86_400_000,
  ) + 1;
  const to = shiftDay(range.from, -1);
  return { from: shiftDay(to, -(days - 1)), to };
}

export function resolveDashboardReportingWindow(current: ReportingDateRange): DashboardReportingWindow {
  const prior = resolvePriorReportingWindow(current);
  const [fromYear, fromMonth, fromDate] = parts(current.from);
  const [toYear, toMonth, toDate] = parts(current.to);
  const rangeDays = Math.round(
    (Date.UTC(toYear, toMonth - 1, toDate) - Date.UTC(fromYear, fromMonth - 1, fromDate)) / 86_400_000,
  ) + 1;
  const trailingDays = Math.min(7, rangeDays);
  return {
    current,
    prior,
    currentTrailingSeven: { from: shiftDay(current.to, -(trailingDays - 1)), to: current.to },
    priorTrailingSeven: { from: shiftDay(prior.to, -(trailingDays - 1)), to: prior.to },
    rangeDays,
  };
}
