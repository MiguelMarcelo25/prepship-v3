import { sql as pg } from '../db/client.js';
import {
  classifyUnattributedShipmentAudit,
  type UnattributedShipmentAuditReason,
} from './shipment-sync-unattributed.js';

/**
 * PS-467: answer "which shipments could not be attributed, and why?" without persisting
 * anything.
 *
 * The card asked for a typed, queryable state with a reason. It does not have to be a
 * stored column: every input the rule needs is already in the rows. Deriving it avoids a
 * migration on the locked `shipments` table, avoids a 790-row write to shipped data, and
 * cannot go stale when a sibling is voided or re-linked.
 *
 * This module is the ONLY place that reads the rows; the rule itself lives in
 * shipment-sync-unattributed.ts and is pure, so the classification can be tested without
 * a database. Same split as PS-477's disclosure reducer + loader.
 */

export type UnattributedShipmentAuditRow = {
  shipmentId: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  reason: UnattributedShipmentAuditReason;
  /** The linked shipment carrying the same tracking number, when one exists. */
  duplicateOfShipmentId: number | null;
  /** The order that sibling belongs to. Present for evidence, NOT a repair target. */
  duplicateOfOrderId: number | null;
};

type AuditQueryRow = {
  id: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  duplicateOfShipmentId: number | null;
  duplicateOfOrderId: number | null;
};

/**
 * Every unattributed shipment with the reason it could not be attributed.
 *
 * The LATERAL picks the OLDEST linked row sharing the tracking number, because that is
 * the label-purchase write -- the orphan is the later sync re-ingest. Ordering by
 * created_at makes the pairing deterministic when an order somehow has several.
 */
export async function loadUnattributedShipmentAudit(
  conn: typeof pg = pg,
): Promise<UnattributedShipmentAuditRow[]> {
  const rows = await conn<AuditQueryRow[]>`
    SELECT
      s.id,
      s.order_number      AS "orderNumber",
      s.tracking_number   AS "trackingNumber",
      dup.id              AS "duplicateOfShipmentId",
      dup.order_id        AS "duplicateOfOrderId"
    FROM shipments s
    LEFT JOIN LATERAL (
      SELECT x.id, x.order_id
      FROM shipments x
      WHERE x.order_id IS NOT NULL
        AND x.source IS DISTINCT FROM 'replacement'
        AND x.tracking_number = s.tracking_number
        AND s.tracking_number IS NOT NULL
      ORDER BY x.created_at
      LIMIT 1
    ) dup ON true
    WHERE s.order_id IS NULL
      AND s.source IS DISTINCT FROM 'replacement'
    ORDER BY s.id
  `;

  return rows.map((row) => ({
    shipmentId: row.id,
    orderNumber: row.orderNumber,
    trackingNumber: row.trackingNumber,
    duplicateOfShipmentId: row.duplicateOfShipmentId,
    duplicateOfOrderId: row.duplicateOfOrderId,
    reason: classifyUnattributedShipmentAudit({
      orderNumber: row.orderNumber,
      duplicateOfShipmentId: row.duplicateOfShipmentId,
    }),
  }));
}

/** Counts per reason, for the operator-facing "how bad is it" answer. */
export async function summarizeUnattributedShipments(
  conn: typeof pg = pg,
): Promise<Record<UnattributedShipmentAuditReason, number>> {
  const rows = await loadUnattributedShipmentAudit(conn);
  const summary: Record<UnattributedShipmentAuditReason, number> = {
    duplicate_of_shipment: 0,
    blank_order_number: 0,
    excluded_store: 0,
    unmatched_order_number: 0,
  };
  for (const row of rows) summary[row.reason] += 1;
  return summary;
}
