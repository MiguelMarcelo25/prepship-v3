/**
 * PS-275 — durable, idempotent, reversible store for the $0-shipping prep-fee
 * WAIVER decision. One row per order records whether the operator waived the
 * prep fee on that order (because it shipped for $0), who decided, when, an
 * optional note, and the ORIGINAL prep amount at decision time (so the waiver
 * is reversible — clearing it and regenerating restores the original charge).
 *
 * Runtime-DDL, additive, 500-safe (mirrors ensureDirectCarrierRateCacheSchema /
 * ensureAuditLogSchema): CREATE TABLE IF NOT EXISTS + ENABLE ROW LEVEL SECURITY
 * (RLS on, NO open policy — backend is the postgres owner and bypasses RLS; the
 * Supabase-auth frontend never reads this table). NOT in the drizzle schema
 * index — a bare drizzle select() over the index would otherwise emit the new
 * table and 500 prod before the migration runs.
 *
 * Default-inert: with NO waiver row for an order, billing is byte-identical to
 * today. The read helpers return null/empty on any error and never throw into
 * the billing hot path.
 */
import { sql as pg } from '../db/client';

export type FeeWaiverDecision = 'waived' | 'not_waived';

export type BillingFeeWaiverRow = {
  orderId: number;
  decision: FeeWaiverDecision;
  reviewer: string | null;
  reviewedAt: string | null;
  note: string | null;
  originalPrepAmount: number | null;
};

export type BillingFeeWaiverUpsert = {
  orderId: number;
  decision: FeeWaiverDecision;
  reviewer: string | null;
  note: string | null;
  /** The prep total at decision time, captured so the waiver is reversible. */
  originalPrepAmount: number | null;
};

let schemaEnsured: Promise<void> | null = null;

/** Memoized runtime DDL. Additive, 500-safe (mirrors the audit_log /
 * direct_carrier_rate_cache ensureX pattern). */
export async function ensureBillingFeeWaiverSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS billing_fee_waivers (
        order_id integer PRIMARY KEY,
        decision text NOT NULL,
        reviewer text,
        reviewed_at timestamptz NOT NULL DEFAULT now(),
        note text,
        original_prep_amount numeric(10, 2),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await pg`ALTER TABLE billing_fee_waivers ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

function rowDecision(value: unknown): FeeWaiverDecision {
  return value === 'waived' ? 'waived' : 'not_waived';
}

/**
 * Read every fee-waiver row for the given order ids. Returns a Map keyed by
 * order id. Empty Map when there are no ids, or on ANY error (default-inert:
 * billing then behaves exactly as it does today). Never throws.
 */
export async function readBillingFeeWaivers(
  orderIds: number[],
): Promise<Map<number, BillingFeeWaiverRow>> {
  const out = new Map<number, BillingFeeWaiverRow>();
  const ids = [...new Set(orderIds.filter((id) => Number.isFinite(id)))];
  if (!ids.length) return out;
  try {
    await ensureBillingFeeWaiverSchema();
    const rows = await pg<Array<{
      orderId: number;
      decision: string;
      reviewer: string | null;
      reviewedAt: string | null;
      note: string | null;
      originalPrepAmount: string | number | null;
    }>>`
      SELECT order_id AS "orderId", decision, reviewer,
             reviewed_at AS "reviewedAt", note,
             original_prep_amount AS "originalPrepAmount"
      FROM billing_fee_waivers
      WHERE order_id = ANY(${ids})
    `;
    for (const r of rows) {
      out.set(Number(r.orderId), {
        orderId: Number(r.orderId),
        decision: rowDecision(r.decision),
        reviewer: r.reviewer ?? null,
        reviewedAt: r.reviewedAt ?? null,
        note: r.note ?? null,
        originalPrepAmount:
          r.originalPrepAmount == null ? null : Number(r.originalPrepAmount),
      });
    }
  } catch (err) {
    console.warn(
      '[billing-fee-waiver-store] read skipped:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/** Read a single order's waiver row (or null). */
export async function readBillingFeeWaiver(
  orderId: number,
): Promise<BillingFeeWaiverRow | null> {
  const map = await readBillingFeeWaivers([orderId]);
  return map.get(orderId) ?? null;
}

/**
 * Record (insert or update) an order's fee-waiver decision. Idempotent — the
 * same decision can be re-recorded with no effect beyond updating the
 * reviewer/timestamp/note. Reversible — switching decision back to 'not_waived'
 * restores normal billing on the next regenerate. Best-effort: a failed write
 * is logged and rethrown to the route (the route owns the HTTP error), but it
 * never silently corrupts billing.
 */
export async function upsertBillingFeeWaiver(
  input: BillingFeeWaiverUpsert,
): Promise<void> {
  await ensureBillingFeeWaiverSchema();
  const original =
    input.originalPrepAmount == null ? null : input.originalPrepAmount.toFixed(2);
  await pg`
    INSERT INTO billing_fee_waivers
      (order_id, decision, reviewer, reviewed_at, note, original_prep_amount, updated_at)
    VALUES (
      ${input.orderId}, ${input.decision}, ${input.reviewer},
      now(), ${input.note}, ${original}::numeric, now()
    )
    ON CONFLICT (order_id) DO UPDATE
      SET decision = EXCLUDED.decision,
          reviewer = EXCLUDED.reviewer,
          reviewed_at = now(),
          note = EXCLUDED.note,
          original_prep_amount = EXCLUDED.original_prep_amount,
          updated_at = now()
  `;
}
