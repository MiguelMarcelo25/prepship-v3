// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears stale pgboss active rows only, never shipped/cancelled order/shipment data.
//
// PS-272 — default-OFF "stuck-active pgboss job reaper".
//
// Diagnosis: jobs freeze in state='active' for days when the worker process dies mid-job during a
// Render redeploy, and pg-boss's expireInMinutes:30 reap isn't firing for those orphaned rows. The
// stuck 'active' rows hold the per-process active lane's logical slot and block the heavy
// syncs from draining their 'created' backlog — so shipped orders never get a shipments row
// ("Shipment sync error"). This reaper clears stale 'active' rows so the backlog drains.
//
// ENV-GATED, default OFF (SYNC_STUCK_JOB_REAPER). The OFF path is a TRUE no-op: it returns
// immediately with zeros, NO DB access, NO mutation, zero cost. DJ flips it on Render.
//
// Best-effort everywhere: never throws into the worker boot/scheduler hot path — on any error it
// logs '[stuck-reaper]' and returns zeros. Mirrors the runtime raw-SQL + swallow-errors pattern of
// direct-carrier-rate-cache.ts (import { sql as pg } from '../db/client.js').
//
// SAFETY: this NEVER touches the orders or shipments tables, never marketplace ship-confirms. It
// only flips orphaned pgboss queue rows for an explicit ALLOW-LIST of idempotent, side-effect-free
// sync jobs from 'active' → 'failed' (which lets pg-boss requeue the next cadence tick). Jobs with
// real side effects (marketplace confirmations, order-state mutation) are EXCLUDED on purpose.
import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';

/**
 * Allow-list of pgboss queue names the reaper may clear. These are idempotent, watermark-based,
 * side-effect-free sync/reporting/tracking jobs — re-running a tick loses nothing.
 *
 * EXCLUDED on purpose (side effects):
 *   - 'prepship.sync.fulfillment-outbox'                 (real marketplace ship-confirmations)
 *   - 'prepship.shipping.external-shipped-classifier'    (mutates order state)
 *   - 'prepship.fees.walmart-sync'
 */
export const REAPER_SAFE_JOB_NAMES: readonly string[] = [
  'prepship.sync.orders',
  'prepship.sync.shipments',
  'prepship.sync.inventory-import',
  'prepship.sync.products',
  'prepship.sync.rate-backfill',
  'prepship.reporting.refresh',
  'prepship.tracking.poll',
];

/**
 * Minimum age an 'active' row must have before it is considered stuck. Well above the in-process
 * JOB_HANDLER_TIMEOUT (10 min default, capped 25 min) and pg-boss expireInMinutes (30), so a
 * legitimately-running long tick is never reaped — only orphans whose worker process is gone.
 */
export const REAPER_MIN_ACTIVE_AGE_MS = 15 * 60_000;

type StuckJobRow = {
  id: string;
  name: string;
  state: string;
  started_on: string | Date | null;
};

/**
 * PURE selector — no I/O, no Date.now() (take nowMs as a param). Returns the subset of rows that are
 * safe to reap: state==='active' AND name is in the allow-list AND started_on is non-null AND the row
 * has been active for at least minActiveAgeMs.
 */
export function selectStuckActiveJobs(
  jobs: ReadonlyArray<StuckJobRow>,
  opts: { nowMs: number; minActiveAgeMs: number },
): Array<{ id: string; name: string }> {
  const safe = new Set(REAPER_SAFE_JOB_NAMES);
  const out: Array<{ id: string; name: string }> = [];
  for (const job of jobs) {
    if (job.state !== 'active') continue;
    if (!safe.has(job.name)) continue;
    if (job.started_on == null) continue;
    const startedMs =
      job.started_on instanceof Date ? job.started_on.getTime() : Date.parse(String(job.started_on));
    if (!Number.isFinite(startedMs)) continue;
    if (opts.nowMs - startedMs < opts.minActiveAgeMs) continue;
    out.push({ id: job.id, name: job.name });
  }
  return out;
}

export type ReapResult = {
  enabled: boolean;
  scanned: number;
  reaped: number;
  names: string[];
};

/**
 * EFFECTFUL reaper. NO-OP when the flag is OFF (no DB, no mutation). When ON: reads 'active' rows
 * from the pgboss schema's job table (filtered to the safe allow-list in SQL too — belt-and-
 * suspenders with the pure selector), then flips the genuinely-stuck ones to 'failed'. Best-effort:
 * never throws — on any error logs '[stuck-reaper]' and returns zeros.
 */
export async function reapStuckActiveJobs(): Promise<ReapResult> {
  // DEFAULT-OFF: fully inert — no DB access, no mutation.
  if (!env.SYNC_STUCK_JOB_REAPER) {
    return { enabled: false, scanned: 0, reaped: 0, names: [] };
  }

  try {
    // Schema name comes from trusted config (env.PG_BOSS_SCHEMA). postgres-js renders a SINGLE
    // dotted string via the Identifier path (escapeIdentifier splits on '.') → "schema"."job".
    // NOTE: the two-arg form pg(schema, 'job') is WRONG — it goes through the Builder, which has no
    // FROM/UPDATE keyword handler and comma-joins the identifiers, throwing at runtime. Verified
    // against node_modules/postgres/cjs/src/{index,types}.js. All data values stay parameterized.
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const rows = await pg<StuckJobRow[]>`
      SELECT id::text AS id, name, state, started_on
      FROM ${pg(jobTable)}
      WHERE state = 'active'
        AND name = ANY(${REAPER_SAFE_JOB_NAMES as string[]})
    `;

    const stuck = selectStuckActiveJobs(rows, {
      nowMs: Date.now(),
      minActiveAgeMs: REAPER_MIN_ACTIVE_AGE_MS,
    });

    if (stuck.length === 0) {
      return { enabled: true, scanned: rows.length, reaped: 0, names: [] };
    }

    const ids = stuck.map((s) => s.id);
    await pg`
      UPDATE ${pg(jobTable)}
      SET state = 'failed',
          completed_on = now(),
          output = '{"reason":"PS-272 stuck-active reaper"}'::jsonb
      WHERE id = ANY(${ids})
        AND state = 'active'
        AND name = ANY(${REAPER_SAFE_JOB_NAMES as string[]})
    `;

    return {
      enabled: true,
      scanned: rows.length,
      reaped: stuck.length,
      names: stuck.map((s) => s.name),
    };
  } catch (err) {
    console.warn('[stuck-reaper] reap skipped:', err instanceof Error ? err.message : err);
    return { enabled: false, scanned: 0, reaped: 0, names: [] };
  }
}
