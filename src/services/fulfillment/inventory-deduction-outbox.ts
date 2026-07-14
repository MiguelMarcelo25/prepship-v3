// Per user override unlock shipped data on 2026-07-14: durable inventory-deduction
// lane. This module records/retries intent only and delegates all stock math,
// kill-switch behavior, and ledger idempotency to fulfillment-deductions.ts.
import { sql as pg } from '../../db/client.js';
import { deductInventoryForOrder } from '../fulfillment-deductions.js';

export const INVENTORY_DEDUCTION_OUTBOX_EVENT = 'inventory_deduction_requested';
const INVENTORY_DEDUCTION_PROVIDER = 'inventory';
const RECOVERY_LOOKBACK_HOURS = 72;

export function isInventoryDeductionOutboxEvent(eventType: string): boolean {
  return eventType === INVENTORY_DEDUCTION_OUTBOX_EVENT;
}

type InventoryDeductionOrderRef = {
  id: number;
};

export type InventoryDeductionOutboxInput = {
  shipmentId?: number | null;
  source: string;
};

export async function enqueueInventoryDeduction(
  order: InventoryDeductionOrderRef,
  input: InventoryDeductionOutboxInput,
): Promise<void> {
  const dedupeKey = `${INVENTORY_DEDUCTION_OUTBOX_EVENT}:${order.id}`;
  const payload = {
    orderId: order.id,
    shipmentId: input.shipmentId ?? null,
    source: input.source,
  };

  await pg`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    VALUES (
      ${order.id}, ${input.shipmentId ?? null}, ${INVENTORY_DEDUCTION_OUTBOX_EVENT},
      ${INVENTORY_DEDUCTION_PROVIDER}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb,
      'pending', 0, NOW(), NOW()
    )
    ON CONFLICT (dedupe_key) DO NOTHING
  `;
}

/**
 * Repair the only gap an outbox insert cannot close by itself: a process dying
 * after the shipped transition commits but before the event insert commits.
 * The scan is bounded to recent shipped rows and only creates missing intent;
 * the canonical deduction owner remains idempotent at the ledger boundary.
 */
export async function enqueueMissingInventoryDeductions(
  limit = 100,
): Promise<number> {
  const rows = await pg<Array<{ id: number }>>`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    SELECT
      o.id,
      latest_shipment.id,
      ${INVENTORY_DEDUCTION_OUTBOX_EVENT},
      ${INVENTORY_DEDUCTION_PROVIDER},
      ${INVENTORY_DEDUCTION_OUTBOX_EVENT} || ':' || o.id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'orderId', o.id,
        'shipmentId', latest_shipment.id,
        'source', 'inventory_outbox_recovery'
      )),
      'pending',
      0,
      NOW(),
      NOW()
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT s.id
      FROM shipments s
      WHERE s.order_id = o.id
        AND s.voided = false
      ORDER BY s.id DESC
      LIMIT 1
    ) latest_shipment ON true
    WHERE o.order_status = 'shipped'
      AND o.updated_at >= NOW() - (${RECOVERY_LOOKBACK_HOURS} || ' hours')::interval
      AND NOT EXISTS (
        SELECT 1
        FROM fulfillment_outbox existing
        WHERE existing.dedupe_key = ${INVENTORY_DEDUCTION_OUTBOX_EVENT} || ':' || o.id::text
      )
    ORDER BY o.updated_at ASC, o.id ASC
    LIMIT ${Math.max(1, Math.min(limit, 500))}
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  return rows.length;
}

export async function processInventoryDeductionOutboxEvent(row: {
  orderId: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  const [order] = await pg<Array<{
    id: number;
    clientId: number | null;
    orderNumber: string | null;
    orderDate: Date | string | null;
    items: unknown[] | null;
  }>>`
    SELECT
      id,
      client_id AS "clientId",
      order_number AS "orderNumber",
      order_date AS "orderDate",
      items
    FROM orders
    WHERE id = ${row.orderId}
    LIMIT 1
  `;
  if (!order) throw new Error(`Inventory deduction order ${row.orderId} no longer exists`);

  const shipmentId = Number(row.payload.shipmentId ?? 0);
  await deductInventoryForOrder(
    { ...order, items: Array.isArray(order.items) ? order.items : [] },
    {
      shipmentId: Number.isInteger(shipmentId) && shipmentId > 0 ? shipmentId : undefined,
      source: String(row.payload.source ?? 'inventory_outbox'),
    },
  );
}
