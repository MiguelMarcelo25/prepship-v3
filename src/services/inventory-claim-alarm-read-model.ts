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
  const windowHours = options.windowHours ?? 24;
  const baselineHours = options.baselineHours ?? 24 * 7;

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
