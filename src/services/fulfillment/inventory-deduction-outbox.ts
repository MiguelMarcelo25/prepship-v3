// Per user override unlock shipped data on 2026-07-14: durable inventory-deduction
// lane. This module records/retries intent only and delegates all stock math,
// kill-switch behavior, and ledger idempotency to fulfillment-deductions.ts.
import { db, sql as pg } from '../../db/client.js';
import { fulfillmentOutbox } from '../../db/schema/fulfillment-outbox.js';
import {
  applyInventoryClaimsForLifecycleEvent,
  deductInventoryForOrder,
} from '../fulfillment-deductions.js';

export const INVENTORY_DEDUCTION_OUTBOX_EVENT = 'inventory_deduction_requested';
const INVENTORY_DEDUCTION_PROVIDER = 'inventory';
const RECOVERY_LOOKBACK_HOURS = 72;

export function isInventoryDeductionOutboxEvent(eventType: string): boolean {
  return eventType === INVENTORY_DEDUCTION_OUTBOX_EVENT;
}

type InventoryDeductionOrderRef = {
  id: number;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InventoryDeductionOutboxExecutor = typeof db | DbTransaction;

export type InventoryDeductionOutboxInput = {
  shipmentId?: number | null;
  source: string;
};

export async function enqueueInventoryClaimDeduction(
  input: {
    lifecycleEventId: number;
    orderId: number;
    shipmentId?: number | null;
    source: string;
  },
  executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  const dedupeKey = `${INVENTORY_DEDUCTION_OUTBOX_EVENT}:lifecycle:${input.lifecycleEventId}`;
  await executor
    .insert(fulfillmentOutbox)
    .values({
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      eventType: INVENTORY_DEDUCTION_OUTBOX_EVENT,
      provider: INVENTORY_DEDUCTION_PROVIDER,
      dedupeKey,
      payload: {
        lifecycleEventId: input.lifecycleEventId,
        orderId: input.orderId,
        shipmentId: input.shipmentId ?? null,
        source: input.source,
      },
      status: 'pending',
      attempts: 0,
      nextRunAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: fulfillmentOutbox.dedupeKey });
}

export async function enqueueInventoryDeduction(
  order: InventoryDeductionOrderRef,
  input: InventoryDeductionOutboxInput,
  executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  const dedupeKey = `${INVENTORY_DEDUCTION_OUTBOX_EVENT}:${order.id}`;
  const payload = {
    orderId: order.id,
    shipmentId: input.shipmentId ?? null,
    source: input.source,
  };

  // Per user override unlock shipped data on 2026-07-15: callers that own a
  // shipped transition pass their transaction here, so the status change and
  // durable deduction intent either commit together or both roll back. This
  // still records intent only; stock math and the kill switch remain in the
  // canonical fulfillment-deductions owner.
  await executor
    .insert(fulfillmentOutbox)
    .values({
      orderId: order.id,
      shipmentId: input.shipmentId ?? null,
      eventType: INVENTORY_DEDUCTION_OUTBOX_EVENT,
      provider: INVENTORY_DEDUCTION_PROVIDER,
      dedupeKey,
      payload,
      status: 'pending',
      attempts: 0,
      nextRunAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: fulfillmentOutbox.dedupeKey });
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
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const lifecycleRows = await pg<Array<{ id: number }>>`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    SELECT
      event.order_id,
      event.shipment_id,
      ${INVENTORY_DEDUCTION_OUTBOX_EVENT},
      ${INVENTORY_DEDUCTION_PROVIDER},
      ${INVENTORY_DEDUCTION_OUTBOX_EVENT} || ':lifecycle:' || event.id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'lifecycleEventId', event.id,
        'orderId', event.order_id,
        'shipmentId', event.shipment_id,
        'source', 'inventory_claim_outbox_recovery'
      )),
      'pending',
      0,
      NOW(),
      NOW()
    FROM order_lifecycle_events event
    WHERE EXISTS (
      SELECT 1
      FROM fulfillment_line_claims claim
      WHERE claim.lifecycle_event_id = event.id
        AND claim.status = 'pending'
    )
      AND NOT EXISTS (
        SELECT 1
        FROM fulfillment_outbox existing
        WHERE existing.dedupe_key =
          ${INVENTORY_DEDUCTION_OUTBOX_EVENT} || ':lifecycle:' || event.id::text
      )
    ORDER BY event.id ASC
    LIMIT ${boundedLimit}
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;

  const legacyRows = await pg<Array<{ id: number }>>`
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
        FROM order_lifecycle_events lifecycle
        WHERE lifecycle.order_id = o.id
          AND lifecycle.transition IN ('shipped', 'external_shipped')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM fulfillment_outbox existing
        WHERE existing.dedupe_key = ${INVENTORY_DEDUCTION_OUTBOX_EVENT} || ':' || o.id::text
      )
    ORDER BY o.updated_at ASC, o.id ASC
    LIMIT ${boundedLimit}
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  return lifecycleRows.length + legacyRows.length;
}

export async function processInventoryDeductionOutboxEvent(row: {
  orderId: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  const lifecycleEventId = Number(row.payload.lifecycleEventId ?? 0);
  if (Number.isInteger(lifecycleEventId) && lifecycleEventId > 0) {
    const result = await applyInventoryClaimsForLifecycleEvent(lifecycleEventId);
    if (result.lockedDown) {
      // Keep the durable event retryable. Settling it while claims remain
      // pending would lose the work when the emergency switch is re-enabled.
      throw new Error('INVENTORY_AUTO_DEDUCT is disabled; fulfillment claims remain pending');
    }
    return;
  }

  // Compatibility only for events created before PS-424. New lifecycle
  // writers must enqueue lifecycleEventId and never re-read mutable order JSON.
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
