/**
 * PS-273 — pure planner for the Shipp brokered-account nickname backfill.
 *
 * Root cause: Shipp-brokered labels were persisted with a synthetic provider id
 * (10_000_000 + carrier_accounts.id) but NO shipments.provider_account_nickname.
 * With no stored truth, readers fell back to carrier family and fabricated a
 * direct UPS account (GG6381) the label was never bought on. The forward fix
 * (labels-direct.ts / labels.ts) now writes "Shipp" at purchase time; this
 * module plans the HISTORY correction for rows created before that fix.
 *
 * This file is PURE (no DB, no network) so the guard can unit-test the
 * eligibility + derived-nickname rule offline. The script that owns the DB read
 * and the (double-gated) write is scripts/ps-273-backfill-shipp-account-nickname.ts.
 */

/** Literal label a Shipp-brokered shipment's account should display. */
export const SHIPP_BROKERED_ACCOUNT_LABEL = 'Shipp';

/** A Shipp-brokered service code is ALWAYS shipp_-prefixed by the connector
 *  (src/connectors/carrier/shipp.ts shippServiceCodeForRate). */
export function isShippBrokeredServiceCode(serviceCode: string | null | undefined): boolean {
  return typeof serviceCode === 'string' && /^shipp_/i.test(serviceCode.trim());
}

/** Minimal shipment shape the planner inspects (snake_case as read from SQL). */
export type ShippNicknameBackfillRow = {
  shipmentId: number;
  orderId: number | null;
  orderNumber: string | null;
  serviceCode: string | null;
  source: string | null;
  providerAccountNickname: string | null;
};

export type ShippNicknameBackfillPlan = {
  shipmentId: number;
  orderId: number | null;
  orderNumber: string | null;
  /** true only when this row is a brokered Shipp label MISSING a nickname. */
  affected: boolean;
  /** human-readable reason (for the dry-run report). */
  reason: string;
  /** the value that WOULD be written — only present when affected. */
  nickname: string | null;
};

/**
 * Decide whether a row needs the Shipp nickname backfill, and what value to
 * write. ONLY brokered Shipp labels (shipp_* service code, or source='shipp')
 * that have NO existing provider_account_nickname are affected. Idempotent:
 * a row that already carries any nickname is left untouched.
 */
export function planShippNicknameBackfillRow(
  row: ShippNicknameBackfillRow,
): ShippNicknameBackfillPlan {
  const base = {
    shipmentId: row.shipmentId,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
  };
  const isBrokered =
    isShippBrokeredServiceCode(row.serviceCode) ||
    (typeof row.source === 'string' && row.source.trim().toLowerCase() === 'shipp');
  if (!isBrokered) {
    return { ...base, affected: false, reason: 'not a Shipp-brokered label', nickname: null };
  }
  const existing = (row.providerAccountNickname ?? '').trim();
  if (existing) {
    return {
      ...base,
      affected: false,
      reason: `already has nickname "${existing}"`,
      nickname: null,
    };
  }
  return {
    ...base,
    affected: true,
    reason: 'brokered Shipp label missing provider_account_nickname',
    nickname: SHIPP_BROKERED_ACCOUNT_LABEL,
  };
}

export function summarizeShippNicknamePlans(plans: ShippNicknameBackfillPlan[]) {
  return {
    total: plans.length,
    affected: plans.filter((p) => p.affected).length,
    skipped: plans.filter((p) => !p.affected).length,
  };
}
