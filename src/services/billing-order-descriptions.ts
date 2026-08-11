/**
 * PS-498 — the canonical owner of an order's operator-authored billing DESCRIPTION.
 *
 * One row per order holding the sentence the operator wrote to explain why that
 * order's invoice line was corrected ("DHL eCommerce Parcel Direct to Gatineau,
 * Quebec"). Captured per row by the Import Box Size & Shipping paste grid, read
 * back READ-ONLY in the Edit Billing Detail modal with author and timestamp.
 *
 * THE RULE THIS FILE OWNS, and the reason it is a file rather than four lines in
 * the route: an ABSENT description means "leave the stored one alone".
 *
 * Every other operator-note column in billing — billing_manual_overrides.note,
 * billing_box_resolutions.note, billing_fee_waivers.note — is synthesized from
 * the edit `reason` on EVERY save (`body.note ?? \`${body.reason} (${label})\``).
 * That is correct for those columns and must not change. But it means a later
 * manual edit through the Edit Billing Detail modal, which sends `reason` and
 * never a description, would silently overwrite an imported description with the
 * new edit's reason. Two lifecycles cannot share one column, so this one gets its
 * own table and its own rule, and the rule is expressed as a pure decision that a
 * guard can execute — not as an `if` buried in a 400-line route handler.
 *
 * There is deliberately NO way to clear a description. Blank never overwrites;
 * that IS the defence. The correction path is re-importing the order with new
 * text, which overwrites and re-stamps author/timestamp. A future "clear" needs
 * an explicit sentinel and a deliberate UI, not an empty string.
 *
 * Not a money input: generateLineItems never reads this table, and range
 * regeneration (which deletes and recreates billing_line_items) must never touch
 * it. Migration-owned by 0091_billing_order_descriptions.sql and RLS-protected.
 */
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

/** Mirrors the DB CHECK. Kept here so the refusal is testable without a database. */
export const BILLING_ORDER_DESCRIPTION_MAX_LENGTH = 500;

export type BillingOrderDescriptionRow = {
  orderId: number;
  description: string;
  savedBy: string | null;
  /** ISO string, never a Date — TEXT_CARRY_FIELDS drops non-strings. See below. */
  savedAt: string | null;
};

export type BillingOrderDescriptionPatch = {
  orderId: number;
  /**
   * `undefined` means the caller is not touching the description. It is NOT the
   * same as an empty string, which is a caller bug and throws.
   */
  orderDescription?: string | undefined;
  savedBy: string | null;
};

export type BillingOrderDescriptionExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

/** Migration readiness for durable per-order billing descriptions. */
export async function ensureBillingOrderDescriptionsSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

/**
 * Readiness is a property of the PRODUCTION singleton, not of an arbitrary
 * connection. A guard driving these functions against in-memory Postgres has
 * already created the schema by executing the migration file, and must not be
 * routed into `assertRuntimeSchemaReady`, which would query the real database.
 * The `executor === db` test also guarantees the reverse: a test connection can
 * never be mistaken for the production one.
 */
async function ensureFor(executor: BillingOrderDescriptionExecutor): Promise<void> {
  if (executor === (db as unknown as BillingOrderDescriptionExecutor)) {
    await ensureBillingOrderDescriptionsSchema();
  }
}

/** postgres-js returns an array; PGlite returns { rows }. Same shape either way. */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Decide whether a request changes the stored description, and what to store.
 *
 * PURE and synchronous on purpose: this is the clobber rule, and a guard must be
 * able to assert `decideBillingOrderDescriptionWrite(undefined).write === false`
 * by EXECUTING it. A regex asserting that the route contains
 * `if (body.orderDescription !== undefined)` proves the text exists, not that the
 * behaviour holds — that is the failure class this repo has already been bitten
 * by more than once.
 */
export function decideBillingOrderDescriptionWrite(
  raw: string | undefined,
): { write: false } | { write: true; description: string } {
  if (raw === undefined) return { write: false };
  if (typeof raw !== 'string') {
    throw new Error('Billing order description must be a string when supplied');
  }
  const description = raw.trim();
  if (!description) {
    // Not silently ignored: a caller that sends '' is asking to clear, which this
    // feature does not support. Failing loudly beats a no-op the caller misreads
    // as a successful clear.
    throw new Error('Billing order description cannot be blank — omit the field to leave it unchanged');
  }
  if (description.length > BILLING_ORDER_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `Billing order description exceeds ${BILLING_ORDER_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return { write: true, description };
}

/**
 * Read every description row for the given order ids, keyed by order id.
 *
 * `saved_at` is cast to text so the DTO carries an ISO STRING. This is not
 * cosmetic: `carryText` in billing-detail-row-sot.ts is `typeof value === 'string'`
 * gated, so a Date would survive today only by the first-line spread and would
 * vanish the day the merge path mattered — a latent bug with no obvious cause.
 */
export async function readBillingOrderDescriptions(
  orderIds: number[],
  executor: BillingOrderDescriptionExecutor = db,
): Promise<Map<number, BillingOrderDescriptionRow>> {
  const out = new Map<number, BillingOrderDescriptionRow>();
  const ids = [...new Set(orderIds.filter((id) => Number.isFinite(id)))];
  if (!ids.length) return out;
  await ensureFor(executor);
  const result = await executor.execute(drizzleSql`
    SELECT order_id AS "orderId",
           description,
           saved_by AS "savedBy",
           saved_at::text AS "savedAt"
    FROM billing_order_descriptions
    WHERE order_id IN ${ids}
  `);
  const rows = resultRows<{
    orderId: number | string;
    description: string;
    savedBy: string | null;
    savedAt: string | null;
  }>(result);
  for (const row of rows) {
    const orderId = Number(row.orderId);
    if (!Number.isFinite(orderId)) continue;
    out.set(orderId, {
      orderId,
      description: String(row.description ?? ''),
      savedBy: row.savedBy ?? null,
      savedAt: row.savedAt ?? null,
    });
  }
  return out;
}

/**
 * Apply a patch's description, if it carries one. Returns whether it wrote.
 *
 * When the field is absent this builds NO SQL AT ALL — there is no
 * `SET description = COALESCE($1, description)` that could get its fallback
 * wrong, because no statement is issued. That is the whole defence, and it is
 * why the decision is taken before the query rather than inside it.
 */
export async function applyBillingOrderDescriptionPatch(
  input: BillingOrderDescriptionPatch,
  executor: BillingOrderDescriptionExecutor = db,
): Promise<boolean> {
  const decision = decideBillingOrderDescriptionWrite(input.orderDescription);
  if (!decision.write) return false;
  await ensureFor(executor);
  await executor.execute(drizzleSql`
    INSERT INTO billing_order_descriptions
      (order_id, description, saved_by, saved_at, updated_at)
    VALUES (${input.orderId}, ${decision.description}, ${input.savedBy}, now(), now())
    ON CONFLICT (order_id) DO UPDATE
      SET description = EXCLUDED.description,
          saved_by = EXCLUDED.saved_by,
          saved_at = now(),
          updated_at = now()
  `);
  return true;
}
