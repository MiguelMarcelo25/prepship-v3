/**
 * order-rate-job-status.ts — PS-120 per-order backend rate-job status (pending / rating).
 *
 * Canonical owner of "what is the backend doing about this order's rate right now?". The
 * backend rate-backfill (the PRODUCER, on the worker) sets `pending` on enqueue and `rating`
 * on pickup, and clears the row when the rate resolves. The API /orders payload (the READER)
 * looks the row up and ONLY overrides the displayed bestRateState when the stored fingerprint
 * matches the order's CURRENT fingerprint AND there is no fresh displayable saved rate.
 *
 * ADDITIVE GUARANTEE: when no job row exists, the fingerprint is stale, or a fresh saved rate
 * exists, resolveRateJobWorkflowOverride() returns null and the orders payload is unchanged
 * (byte-identical to before this table existed). The new states only ever APPEAR; they never
 * change an existing terminal state (fresh/stale/missing/blocked/...) or any money/proof/
 * selection logic.
 *
 * Worker (set/clear) and API (read) MUST share one fingerprint so they match. Both compute it
 * via computeOrderRateJobFingerprint() from the SAME raw order columns — decoupled from the
 * expensive resolved money cacheKey (which only exists after a live rate call). It pins
 * dims/weight/zip so a dims/weight/zip change invalidates the job (spec requirement #1).
 *
 * The DB writers below are the only impure functions; the fingerprint + override decision are
 * pure so the offline guard (scripts/ps-120-producer-guard.ts) can test them without a DB.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql as pg } from '../../db/client';
import { orderRateJobs } from '../../db/schema/order-rate-jobs';

export type OrderRateJobState = 'pending' | 'rating';

// ── Runtime schema ensure (matches the project's CREATE TABLE IF NOT EXISTS pattern, e.g.
// src/services/fulfillment/webhook-ledger.ts). Mirrors drizzle/0041_order_rate_jobs.sql so the
// table exists across the worker (producer) / API (reader) split even before a migration runs.
let schemaEnsured: Promise<void> | null = null;

export async function ensureOrderRateJobsSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS order_rate_jobs (
        order_id integer PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        state text NOT NULL,
        request_fingerprint text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await pg`CREATE INDEX IF NOT EXISTS order_rate_jobs_updated_idx ON order_rate_jobs (updated_at DESC)`;
    await pg`ALTER TABLE order_rate_jobs ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

// ── Shared lightweight fingerprint (pure) ────────────────────────────────────────────────
// NOTE: this is the JOB fingerprint, NOT the money rate cacheKey. It exists purely to detect
// "did the inputs that the backend queued/rated for change?". It uses the same raw columns the
// /orders reader and the backfill SELECT both already have, so the two sides always agree.

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type OrderRateJobFingerprintInput = {
  orderId: number;
  weightOz: number | null;
  shipToPostalCode: string | null;
  shipToState?: string | null;
  shipToCity?: string | null;
  /** order_overrides.rate_dims_l/w/h (operator-entered dims win). */
  rateDimsL?: number | null;
  rateDimsW?: number | null;
  rateDimsH?: number | null;
  /** orders.raw, used for shipTo.country/residential + raw dimensions fallback. */
  raw?: Record<string, unknown> | null;
};

/**
 * Stable per-order rate-job fingerprint. Identical inputs -> identical string on both the
 * worker (setter) and the API (reader). Dims/weight/zip/country/residential are included so a
 * change to any of them yields a new fingerprint, which makes a previously-set pending/rating
 * row stale (the reader then ignores it and the existing terminal state shows through).
 */
export function computeOrderRateJobFingerprint(input: OrderRateJobFingerprintInput): string {
  const raw = record(input.raw) ?? {};
  const shipTo = record(raw.shipTo) ?? {};
  const rawDims = record(raw.dimensions) ?? {};
  const country = String(shipTo.country ?? 'US').trim().toUpperCase() || 'US';
  const residential =
    shipTo.residential === true ? '1' : shipTo.residential === false ? '0' : '';
  const length = positive(input.rateDimsL) ?? positive(rawDims.length);
  const width = positive(input.rateDimsW) ?? positive(rawDims.width);
  const height = positive(input.rateDimsH) ?? positive(rawDims.height);
  const weight = positive(input.weightOz);
  const zip = String(input.shipToPostalCode ?? '').trim().toUpperCase();
  const state = String(input.shipToState ?? '').trim().toUpperCase();
  const city = String(input.shipToCity ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  const parts = [
    `o=${input.orderId}`,
    `w=${weight != null ? Math.round(weight * 10) : ''}`,
    `z=${zip}`,
    `co=${country}`,
    `st=${state}`,
    `ci=${city}`,
    `r=${residential}`,
    `l=${length != null ? Math.round(length * 10) : ''}`,
    `dw=${width != null ? Math.round(width * 10) : ''}`,
    `h=${height != null ? Math.round(height * 10) : ''}`,
  ];
  return parts.join('|');
}

// ── PURE override decision (no DB) ───────────────────────────────────────────────────────

export type RateJobWorkflowOverride = {
  /** The state to OVERRIDE bestRateState to. */
  bestRateState: OrderRateJobState;
  /** now - row.updated_at, ms — the FE watchdog uses this to bound the spinner. */
  bestRateStateAgeMs: number;
};

export type ResolveRateJobWorkflowOverrideInput = {
  /** The stored job row state, or null when no row exists for this order. */
  jobState: OrderRateJobState | string | null | undefined;
  /** The stored job row request fingerprint, or null when no row exists. */
  jobFingerprint: string | null | undefined;
  /** The order's CURRENT job fingerprint (computeOrderRateJobFingerprint). */
  currentFingerprint: string | null | undefined;
  /**
   * Whether the order already has a FRESH displayable saved rate. When true the override is a
   * no-op — a resolved/fresh order must never be shown as pending/rating.
   */
  hasFreshRate: boolean;
  /** row.updated_at as epoch ms. */
  jobUpdatedAtMs: number | null | undefined;
  /** Date.now() at read time. */
  nowMs: number;
};

/**
 * The single additive decision: should the orders payload OVERRIDE the derived bestRateState
 * with a backend pending/rating? Returns the override, or null to leave the existing state
 * untouched (the byte-identical / harm-free path).
 *
 * Returns null (no-op) when ANY of these holds — i.e. the common case:
 *   - no job row (jobState/jobFingerprint absent),
 *   - the job state is not one of the in-progress states,
 *   - the order has a fresh displayable saved rate AND the job is only QUEUED
 *     ('pending' defers to fresh; an ACTIVE 'rating' overrides even fresh — the
 *     Recalculate All visibility rule),
 *   - there is no current fingerprint to compare against, or
 *   - the stored fingerprint != the order's current fingerprint (stale job; inputs changed).
 *
 * The FE classifier independently bounds the spinner with bestRateStateAgeMs (watchdog), so a
 * stuck job can never render an infinite spinner even though this stays an override.
 */
export function resolveRateJobWorkflowOverride(
  input: ResolveRateJobWorkflowOverrideInput,
): RateJobWorkflowOverride | null {
  const state = input.jobState;
  if (state !== 'pending' && state !== 'rating') return null;
  // A fresh order never spins for a QUEUED stamp — a leftover `pending` row from
  // a dead job must not haunt resolved orders. But an ACTIVE `rating` is the
  // worker re-rating this order RIGHT NOW (Recalculate All forces re-rates of
  // fresh rows by design), so it overrides even a fresh rate; the operator sees
  // the recalculation happen instead of a silently unchanged row. A stuck
  // `rating` row is bounded by the FE watchdog (bestRateStateAgeMs).
  if (input.hasFreshRate && state === 'pending') return null;
  const current = input.currentFingerprint;
  if (!current) return null;
  if (!input.jobFingerprint || input.jobFingerprint !== current) return null;
  const updatedAt = input.jobUpdatedAtMs;
  const ageMs =
    typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      ? Math.max(0, input.nowMs - updatedAt)
      : 0;
  return { bestRateState: state, bestRateStateAgeMs: ageMs };
}

// ── DB writers (impure; used by the worker backfill) ─────────────────────────────────────

async function upsertOrderRateJob(
  orderId: number,
  state: OrderRateJobState,
  requestFingerprint: string,
): Promise<void> {
  await ensureOrderRateJobsSchema();
  const now = new Date();
  await db
    .insert(orderRateJobs)
    .values({ orderId, state, requestFingerprint, updatedAt: now })
    .onConflictDoUpdate({
      target: orderRateJobs.orderId,
      set: { state, requestFingerprint, updatedAt: now },
    });
}

/** Mark an order as QUEUED for backend backfill rating. */
export async function setOrderRatePending(
  orderId: number,
  requestFingerprint: string,
): Promise<void> {
  await upsertOrderRateJob(orderId, 'pending', requestFingerprint);
}

/** Mark an order as ACTIVELY being rated by the backfill job right now. */
export async function setOrderRateRating(
  orderId: number,
  requestFingerprint: string,
): Promise<void> {
  await upsertOrderRateJob(orderId, 'rating', requestFingerprint);
}

/**
 * Clear the in-progress job row for an order (called when the rate RESOLVES — best rate saved,
 * empty result, skipped, or errored — so a resolved order never lingers as pending/rating).
 * Best-effort: a clear failure must not break rating, so callers swallow errors.
 */
export async function clearOrderRateJob(orderId: number): Promise<void> {
  await ensureOrderRateJobsSchema();
  await db.delete(orderRateJobs).where(eq(orderRateJobs.orderId, orderId));
}

/**
 * RC4: refresh updated_at for the still-QUEUED ('pending') stamps among `orderIds`, so a large backfill
 * burst can't age its own waiting tail past the reader's stale-display window (RATE_JOB_STALE_MS) and flip
 * a legitimately-queued row to "Rate unavailable" before a worker even reaches it. ONLY touches 'pending'
 * rows — a 'rating' or already-cleared row is never resurrected. Best-effort; returns the count refreshed.
 * `conn` defaults to the real db; an injected conn (pglite) is used as-is for tests.
 */
export async function touchPendingOrderRateJobs(
  orderIds: number[],
  conn: typeof db = db,
): Promise<number> {
  if (!orderIds.length) return 0;
  if (conn === db) await ensureOrderRateJobsSchema();
  const touched = await conn
    .update(orderRateJobs)
    .set({ updatedAt: new Date() })
    .where(and(eq(orderRateJobs.state, 'pending'), inArray(orderRateJobs.orderId, orderIds)))
    .returning({ orderId: orderRateJobs.orderId });
  return touched.length;
}
