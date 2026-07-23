/**
 * PS-434 — canonical billing-calendar policy.
 *
 * This module is the only owner of actual activity day -> effective billing
 * day mapping. Callers persist its result and readers use the persisted
 * effective day; routes and React never calculate weekend rollover.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  BILLING_LOS_ANGELES_TIME_ZONE,
  billingDayOf,
} from '../lib/time/billing-day.js';

export const BILLING_POLICY_LEGACY = 'legacy_calendar_v1' as const;
export const BILLING_POLICY_WEEKEND_ROLLFORWARD =
  'weekday_weekend_rollforward_v2' as const;

export type BillingPolicyVersion =
  | typeof BILLING_POLICY_LEGACY
  | typeof BILLING_POLICY_WEEKEND_ROLLFORWARD;

export type BillingCalendarResolution = {
  actualActivityDay: string;
  billingEffectiveDay: string;
  policyVersion: BillingPolicyVersion;
  rolledFromWeekend: boolean;
};

export const BILLING_WEEKEND_OPERATION_BLOCKED_CODE =
  'BILLING_WEEKEND_OPERATION_BLOCKED';

export class BillingCalendarPolicyError extends Error {
  readonly status = 409;
  readonly code = BILLING_WEEKEND_OPERATION_BLOCKED_CODE;

  constructor(readonly operationDay: string) {
    super(
      `Billing generation and finalization are blocked on California weekends (${operationDay}). Retry on the next weekday.`,
    );
    this.name = 'BillingCalendarPolicyError';
  }
}

function exactDay(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  const normalized = billingDayOf(trimmed);
  if (normalized !== trimmed) return null;
  const instant = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function addCalendarDays(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, date! + amount));
  return shifted.toISOString().slice(0, 10);
}

function calendarWeekday(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay();
}

/** Extract a YYYY-MM-DD calendar day from a real instant in Los Angeles. */
export function billingLosAngelesDayForInstant(value: Date | string): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error('A valid activity instant is required');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BILLING_LOS_ANGELES_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Pure calendar-day mapping. A missing cutoff is intentionally legacy/default
 * off. Pre-cutoff activity is also legacy so regeneration cannot rebucket
 * historical weekends.
 */
export function resolveBillingCalendarDay(input: {
  actualActivityDay: string;
  effectiveDate?: string | null;
}): BillingCalendarResolution {
  const actualActivityDay = exactDay(input.actualActivityDay);
  if (!actualActivityDay) throw new Error('actualActivityDay must be YYYY-MM-DD');
  const effectiveDate = input.effectiveDate == null
    ? null
    : exactDay(input.effectiveDate);
  if (input.effectiveDate != null && !effectiveDate) {
    throw new Error('effectiveDate must be YYYY-MM-DD');
  }

  if (!effectiveDate || actualActivityDay < effectiveDate) {
    return {
      actualActivityDay,
      billingEffectiveDay: actualActivityDay,
      policyVersion: BILLING_POLICY_LEGACY,
      rolledFromWeekend: false,
    };
  }

  const weekday = calendarWeekday(actualActivityDay);
  const daysForward = weekday === 6 ? 2 : weekday === 0 ? 1 : 0;
  return {
    actualActivityDay,
    billingEffectiveDay: addCalendarDays(actualActivityDay, daysForward),
    policyVersion: BILLING_POLICY_WEEKEND_ROLLFORWARD,
    rolledFromWeekend: daysForward > 0,
  };
}

/**
 * Timestamp boundary used by generation. Legacy activity stays on its prior
 * UTC calendar-day contract; post-cutoff activity uses its California day.
 */
export function resolveBillingActivityInstant(input: {
  activityAt: Date | string;
  effectiveDate?: string | null;
}): BillingCalendarResolution {
  const instant = input.activityAt instanceof Date
    ? input.activityAt
    : new Date(input.activityAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error('A valid activity instant is required');
  }
  const legacyDay = instant.toISOString().slice(0, 10);
  const losAngelesDay = billingLosAngelesDayForInstant(instant);
  const effectiveDate = input.effectiveDate == null
    ? null
    : exactDay(input.effectiveDate);
  if (input.effectiveDate != null && !effectiveDate) {
    throw new Error('effectiveDate must be YYYY-MM-DD');
  }
  return effectiveDate && losAngelesDay >= effectiveDate
    ? resolveBillingCalendarDay({ actualActivityDay: losAngelesDay, effectiveDate })
    : resolveBillingCalendarDay({ actualActivityDay: legacyDay });
}

/**
 * SQL projection paired with resolveBillingActivityInstant. Keeping both
 * projections in this owner prevents generation's range predicate from
 * drifting away from the values it persists.
 */
export function billingSourceCalendarSql(input: {
  sourceTimestamp: SQLWrapper;
  legacyActivityDay: SQLWrapper;
  effectiveDate?: string | null;
}): {
  actualActivityDay: SQL<Date | null>;
  billingEffectiveDay: SQL<Date | null>;
  policyVersion: SQL<BillingPolicyVersion>;
} {
  const effectiveDate = input.effectiveDate == null
    ? null
    : exactDay(input.effectiveDate);
  if (input.effectiveDate != null && !effectiveDate) {
    throw new Error('effectiveDate must be YYYY-MM-DD');
  }
  if (!effectiveDate) {
    return {
      actualActivityDay: sql<Date | null>`${input.legacyActivityDay}`,
      billingEffectiveDay: sql<Date | null>`${input.legacyActivityDay}`,
      policyVersion: sql<BillingPolicyVersion>`${BILLING_POLICY_LEGACY}`,
    };
  }

  const laDate = sql`(${input.sourceTimestamp} at time zone ${BILLING_LOS_ANGELES_TIME_ZONE})::date`;
  const usesRollforward = sql`${laDate} >= ${effectiveDate}::date`;
  const actualActivityDay = sql<Date | null>`case
    when ${usesRollforward}
      then (${laDate}::timestamp at time zone 'UTC')
    else ${input.legacyActivityDay}
  end`;
  const billingEffectiveDay = sql<Date | null>`case
    when ${usesRollforward} then (
      case extract(isodow from ${laDate})::int
        when 6 then (${laDate} + 2)
        when 7 then (${laDate} + 1)
        else ${laDate}
      end::timestamp at time zone 'UTC'
    )
    else ${input.legacyActivityDay}
  end`;
  return {
    actualActivityDay,
    billingEffectiveDay,
    policyVersion: sql<BillingPolicyVersion>`case
      when ${usesRollforward} then ${BILLING_POLICY_WEEKEND_ROLLFORWARD}
      else ${BILLING_POLICY_LEGACY}
    end`,
  };
}

/** Canonical legacy-compatible billing range key for persisted line items. */
export function billingLineEffectiveDaySql(
  billingEffectiveDate: SQLWrapper,
  shipDate: SQLWrapper,
): SQL<Date | null> {
  return sql<Date | null>`coalesce(${billingEffectiveDate}, ${shipDate})`;
}

/**
 * Canonical inclusive/exclusive range predicate for persisted billing days.
 *
 * Drizzle SQL expressions do not retain a timestamp column encoder. Passing a
 * Date through gte()/lt() therefore reaches postgres.js as a raw Date, which
 * its parameter writer rejects. Normalize the bounds to ISO strings here and
 * cast them explicitly so every query-builder caller uses the same safe
 * effective-day boundary.
 */
export function billingLineEffectiveDayRangeSql(
  billingEffectiveDate: SQLWrapper,
  shipDate: SQLWrapper,
  dateFrom: string | Date,
  dateTo: string | Date,
): SQL {
  const effectiveDay = billingLineEffectiveDaySql(billingEffectiveDate, shipDate);
  const fromIso = (dateFrom instanceof Date ? dateFrom : new Date(dateFrom)).toISOString();
  const toIso = (dateTo instanceof Date ? dateTo : new Date(dateTo)).toISOString();
  return sql`${effectiveDay} >= ${fromIso}::timestamptz and ${effectiveDay} < ${toIso}::timestamptz`;
}

/**
 * Provider payloads mix true instants with date-only activity values. Preserve
 * a date-only value as a California calendar day by anchoring it at UTC noon;
 * only timestamp-shaped values are interpreted as real instants.
 */
export function billingProviderActivityTimestampSql(
  rawValue: SQLWrapper,
): SQL<Date | null> {
  return sql<Date | null>`case
    when coalesce(${rawValue}, '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
      then ((${rawValue})::date::timestamp + interval '12 hours') at time zone 'UTC'
    when coalesce(${rawValue}, '') ~ '^\\d{4}-\\d{2}-\\d{2}'
      then (${rawValue})::timestamptz
    else null
  end`;
}

export function assertBillingWeekdayOperationAllowed(input: {
  effectiveDate?: string | null;
  now?: Date;
}): void {
  if (!input.effectiveDate) return;
  const operationDay = billingLosAngelesDayForInstant(input.now ?? new Date());
  const resolution = resolveBillingCalendarDay({
    actualActivityDay: operationDay,
    effectiveDate: input.effectiveDate,
  });
  if (
    resolution.policyVersion === BILLING_POLICY_WEEKEND_ROLLFORWARD &&
    calendarWeekday(operationDay) % 6 === 0
  ) {
    throw new BillingCalendarPolicyError(operationDay);
  }
}

export function isBillingCalendarPolicyError(
  error: unknown,
): error is BillingCalendarPolicyError {
  return error instanceof BillingCalendarPolicyError;
}
