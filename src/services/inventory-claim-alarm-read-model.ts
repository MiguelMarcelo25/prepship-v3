/**
 * PS-497 — measure what the alarm policy needs, and nothing else.
 *
 * The policy in `inventory-claim-review-alarm.ts` is pure and decides nothing about where
 * numbers come from. This module supplies them: per lifecycle source, how much deduction
 * work was processed in a window, and how much of it stranded a claim in `review`.
 *
 * Executor is injected, exactly like `inventory-claim-review-health.ts`, so the same code
 * path runs against production and against PGlite in a test. That was not a style choice —
 * the first guard on this card asserted SQL source text and was defeated by appending
 * `and false`; a query you cannot execute in a test is a query you cannot trust.
 *
 * ── Two measurement decisions worth stating ───────────────────────────────────────────
 *
 * DENOMINATOR IS DEDUCTION WORK, NOT ALL EVENTS. Only `shipped` and `external_shipped`
 * transitions create a deduction (`order-lifecycle-command.ts` `createsDeduction`).
 * Production carries `cancelled` events on the same sources; counting those would inflate
 * the denominator and quietly shrink every ratio, making a worsening leak look stable.
 *
 * NUMERATOR IS EVENTS THAT STRANDED, NOT CLAIMS. One event can mint several claims, so
 * counting claims would let a single multi-line order look like several failures. The
 * question the alarm asks is "how much of the work stranded", so the unit must match the
 * denominator.
 */

import {
  evaluateInventoryClaimReviewAlarm,
  CLAIM_SOURCE_POLICIES,
  type ClaimSourcePolicy,
  type ClaimSourceWindow,
  type InventoryClaimReviewAlarmVerdict,
} from './inventory-claim-review-alarm';

/** Minimal `postgres`-style tagged-template executor. Values ARE interpolated here. */
export type ClaimAlarmQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>;

export type InventoryClaimAlarmReading = {
  windowHours: number;
  baselineHours: number;
  windows: ClaimSourceWindow[];
  /** Trailing review-events-per-deduction-event, per source, excluding the current window. */
  baselines: Record<string, number>;
  verdict: InventoryClaimReviewAlarmVerdict;
};

/**
 * The measurement contract, exported so a change is visible in review rather than buried in
 * a default argument.
 *
 * Seven days is an operational decision, not an incidental number: it is long enough to
 * average out a single bad sync run and short enough that a genuine shift in behaviour
 * reaches the baseline. Changing it means changing this constant, the fixture boundaries and
 * the explicit assertion together — which is the point.
 */
export const DEFAULT_CLAIM_ALARM_WINDOW_HOURS = 24;
export const DEFAULT_CLAIM_ALARM_BASELINE_HOURS = 24 * 7;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Measure one window, plus a trailing baseline window that EXCLUDES it.
 *
 * The baseline must exclude the current window or a slow ratio rise pulls its own threshold
 * up behind it and never trips — the leak would normalise itself into looking healthy.
 */
export async function readInventoryClaimAlarm(
  query: ClaimAlarmQuery,
  options: { windowHours?: number; baselineHours?: number } = {},
): Promise<InventoryClaimAlarmReading> {
  const windowHours = options.windowHours ?? DEFAULT_CLAIM_ALARM_WINDOW_HOURS;
  const baselineHours = options.baselineHours ?? DEFAULT_CLAIM_ALARM_BASELINE_HOURS;

  const currentRows = await query`
    select e.source as source,
           count(*)::int as deduction_events,
           count(*) filter (
             where exists (
               select 1 from fulfillment_line_claims c
               where c.lifecycle_event_id = e.id and c.status = 'review'
             )
           )::int as stranded_events
    from order_lifecycle_events e
    where e.transition in ('shipped', 'external_shipped')
      and e.created_at > now() - make_interval(hours => ${windowHours})
    group by e.source
  `;

  const baselineRows = await query`
    select e.source as source,
           count(*)::int as deduction_events,
           count(*) filter (
             where exists (
               select 1 from fulfillment_line_claims c
               where c.lifecycle_event_id = e.id and c.status = 'review'
             )
           )::int as stranded_events
    from order_lifecycle_events e
    where e.transition in ('shipped', 'external_shipped')
      and e.created_at > now() - make_interval(hours => ${baselineHours})
      and e.created_at <= now() - make_interval(hours => ${windowHours})
    group by e.source
  `;

  const windows: ClaimSourceWindow[] = currentRows.map((row) => ({
    source: String(row.source ?? ''),
    reviewClaims: num(row.stranded_events),
    shippedEvents: num(row.deduction_events),
  }));

  const baselines: Record<string, number> = {};
  for (const row of baselineRows) {
    const events = num(row.deduction_events);
    if (events <= 0) continue; // no work, no baseline — never divide by zero into a threshold
    baselines[String(row.source ?? '')] = num(row.stranded_events) / events;
  }

  return {
    windowHours,
    baselineHours,
    windows,
    baselines,
    verdict: evaluateInventoryClaimReviewAlarm(windows, baselines),
  };
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Detector inputs.
 *
 * The detector (`inventory-claim-alarm-detector.mjs`) is a pure policy that needs three
 * things this module measures: completed-day windows per source, an absolute severity
 * snapshot, and the immediate findings that must page without waiting for a day to complete.
 *
 * It is deliberately NOT called here. The detector is stateful across runs, and the watchdog
 * already owns a durable state file; running it here would need a second state store inside a
 * read-only route. So the route ships measurements plus the policy table, and the watchdog
 * — the process that already persists state and delivers alerts — runs the decision.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** One COMPLETED UTC day for one source. `windowKey` makes the EWMA advance idempotent. */
export type CompletedClaimWindow = ClaimSourceWindow & { windowKey: string };

export type ClaimAlarmSeverity = {
  /** Every claim currently stranded in review. */
  reviewCount: number;
  /** Age of the oldest stranded claim, in days. */
  oldestAgeDays: number;
  /** Stranded events in the last 24h from acknowledged (open-incident) sources only. */
  acknowledgedNewEvents24h: number;
};

export type ClaimAlarmDetectionInputs = {
  completedWindows: CompletedClaimWindow[];
  severity: ClaimAlarmSeverity;
  immediateReasons: Array<{ code: string; source?: string; message: string }>;
  policies: Readonly<Record<string, ClaimSourcePolicy>>;
  completedDays: number;
};

export const DEFAULT_CLAIM_ALARM_COMPLETED_DAYS = 14;

/**
 * Completed UTC days only — today is excluded because it is still filling.
 *
 * Completed days rather than rolling windows because an hourly watchdog re-reading an
 * overlapping 24h window counts nearly the same events repeatedly, giving the estimator an
 * unpredictable effective weight. A day either happened or it did not.
 *
 * The day boundary is computed in UTC and converted back to `timestamptz` explicitly rather
 * than left to an implicit cast, so the result does not depend on the session's TimeZone
 * setting — the API and a psql session need not agree for the alarm to mean the same thing.
 */
export async function readCompletedClaimWindows(
  query: ClaimAlarmQuery,
  days: number = DEFAULT_CLAIM_ALARM_COMPLETED_DAYS,
): Promise<CompletedClaimWindow[]> {
  const rows = await query`
    select e.source as source,
           to_char(date_trunc('day', e.created_at at time zone 'UTC'), 'YYYY-MM-DD') as window_key,
           count(*)::int as deduction_events,
           count(*) filter (
             where exists (
               select 1 from fulfillment_line_claims c
               where c.lifecycle_event_id = e.id and c.status = 'review'
             )
           )::int as stranded_events
    from order_lifecycle_events e
    where e.transition in ('shipped', 'external_shipped')
      and e.created_at >= ((date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
                            - make_interval(days => ${days}))
      and e.created_at < (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
    group by 1, 2
    order by 2 asc, 1 asc
  `;

  // Ascending by day: the EWMA is order-dependent, so replaying days out of order would
  // produce a different estimate from the same facts.
  return rows.map((row) => ({
    source: String(row.source ?? ''),
    windowKey: String(row.window_key ?? ''),
    reviewClaims: num(row.stranded_events),
    shippedEvents: num(row.deduction_events),
  }));
}

/**
 * The absolute snapshot that still detects worsening when the ratio is saturated.
 *
 * `acknowledgedNewEvents24h` is summed in TypeScript from the current-window measurement
 * rather than filtered in SQL, so the source-class decision stays in CLAIM_SOURCE_POLICIES
 * instead of being duplicated as a literal list inside a query.
 */
export async function readClaimAlarmSeverity(
  query: ClaimAlarmQuery,
  currentWindows: readonly ClaimSourceWindow[],
  policies: Readonly<Record<string, ClaimSourcePolicy>> = CLAIM_SOURCE_POLICIES,
): Promise<ClaimAlarmSeverity> {
  const rows = await query`
    select count(*)::int as review_count,
           coalesce(
             max(extract(epoch from (now() - created_at))) / 86400.0,
             0
           )::float8 as oldest_age_days
    from fulfillment_line_claims
    where status = 'review'
  `;
  const row = rows[0] ?? {};

  const acknowledgedNewEvents24h = currentWindows
    .filter((w) => policies[w.source]?.class === 'open_incident')
    .reduce((total, w) => total + w.reviewClaims, 0);

  return {
    reviewCount: num(row.review_count),
    oldestAgeDays: num(row.oldest_age_days),
    acknowledgedNewEvents24h,
  };
}

/**
 * Assemble everything the detector needs.
 *
 * `immediateReasons` carries ONLY fixed-path regressions and unclassified sources. Those are
 * the findings that must page the moment they appear, without waiting for a day to complete —
 * one stranded event on a repaired path is the 22-day outage on day one.
 *
 * Acknowledged sources are deliberately excluded here even when the legacy rollup marks them
 * `worsening`. That verdict comes from the trailing-baseline 1.5x rule which review proved
 * unreachable; feeding it in would re-import the defect the detector exists to replace. Those
 * sources are judged by the detector's committed-baseline EWMA and absolute severity instead.
 */
export async function readClaimAlarmDetectionInputs(
  query: ClaimAlarmQuery,
  options: { completedDays?: number; windowHours?: number } = {},
): Promise<ClaimAlarmDetectionInputs & { reading: InventoryClaimAlarmReading }> {
  const completedDays = options.completedDays ?? DEFAULT_CLAIM_ALARM_COMPLETED_DAYS;
  const reading = await readInventoryClaimAlarm(query, { windowHours: options.windowHours });
  const completedWindows = await readCompletedClaimWindows(query, completedDays);
  const severity = await readClaimAlarmSeverity(query, reading.windows);

  const immediateReasons = reading.verdict.sources
    .filter((s) => s.alert && (s.class === 'fixed' || s.class === 'unknown'))
    .map((s) => ({
      code: s.class === 'fixed'
        ? `inventory_claim.fixed_regression.${s.source}`
        : `inventory_claim.unclassified.${s.source}`,
      source: s.source,
      message: s.reason,
    }));

  return {
    completedWindows,
    severity,
    immediateReasons,
    policies: CLAIM_SOURCE_POLICIES,
    completedDays,
    reading,
  };
}
