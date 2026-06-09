// PS-128 + PS-129 — forward-only reconciliation of a recorded upstream status event onto
// the matching local order. Invoked (best-effort, off the webhook response path) after the
// event is durably recorded in the ledger.
//
// Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): this is the ONLY
// place under these tickets that writes order columns, and it is STRICTLY FORWARD-ONLY:
//   - it updates rows that are still order_status = 'awaiting_shipment' ONLY,
//   - it sets a HOLD/EXTERNAL signal (canonical_status / externally_shipped), it does NOT
//     flip order_status, and it NEVER reopens or rewrites a shipped/cancelled row.
// The hard ship/label block is enforced separately by shipping-safety.ts reading these
// signals + the ledger, so even if this reconcile no-ops the order is still protected.

import { sql as pg } from '../../db/client.js';
import type { NormalizedWebhookEvent } from './webhook-providers.js';

export type UpstreamReconcileResult = {
  matchedOrderIds: number[];
  action: 'none' | 'hold_cancelled' | 'flagged_external_shipped';
};

/**
 * Apply a normalized terminal event to the local awaiting order(s) it references. Returns
 * the matched order ids (for linking the ledger row). Best-effort: callers should not block
 * the webhook response on this and must tolerate it throwing (it is wrapped upstream).
 */
export async function reconcileOrderFromUpstreamEvent(
  event: NormalizedWebhookEvent,
): Promise<UpstreamReconcileResult> {
  if (event.canonicalStatus !== 'cancelled' && event.canonicalStatus !== 'shipped') {
    return { matchedOrderIds: [], action: 'none' };
  }
  const orderNumber = event.sourceOrderNumber;
  const sourceId = event.sourceOrderId;
  if (!orderNumber && !sourceId) return { matchedOrderIds: [], action: 'none' };

  // Match candidate AWAITING orders by order number or source id. Forward-only guard:
  // order_status = 'awaiting_shipment' ensures we never touch a shipped/cancelled row.
  const candidates = await pg<{ id: number }[]>`
    SELECT id FROM orders
    WHERE order_status = 'awaiting_shipment'
      AND (
        (${orderNumber ?? null}::text IS NOT NULL AND (order_number = ${orderNumber ?? null} OR source_order_number = ${orderNumber ?? null}))
        OR (${sourceId ?? null}::text IS NOT NULL AND (source_order_id = ${sourceId ?? null} OR external_order_id = ${sourceId ?? null}))
      )
    LIMIT 50
  `;
  const matchedOrderIds = candidates.map((r) => r.id);
  const firstMatchedId = matchedOrderIds[0];
  if (firstMatchedId === undefined) return { matchedOrderIds: [], action: 'none' };

  if (event.canonicalStatus === 'cancelled') {
    // PS-129: record a cancellation HOLD signal (forward-only). We set canonical_status —
    // NOT order_status — so we create a hold/review signal the guard blocks on, without
    // hard-cancelling the order row (avoids destructive cancelled-row side effects). Still
    // only awaiting rows.
    await pg`
      UPDATE orders
      SET canonical_status = 'cancelled', updated_at = NOW()
      WHERE id = ANY(${matchedOrderIds}) AND order_status = 'awaiting_shipment'
    `;
    await linkLedgerToOrder(event, firstMatchedId);
    return { matchedOrderIds, action: 'hold_cancelled' };
  }

  // PS-128: flag external shipment (forward-only). externally_shipped is the existing
  // external-shipped signal; we surface it + its source so the order presents as "already
  // shipped in store" instead of allowing another label. Only awaiting rows.
  await pg`
    UPDATE orders
    SET externally_shipped = true,
        externally_shipped_source = ${`webhook:${event.metadata.provider ?? 'unknown'}`},
        updated_at = NOW()
    WHERE id = ANY(${matchedOrderIds}) AND order_status = 'awaiting_shipment'
  `;
  await linkLedgerToOrder(event, firstMatchedId);
  return { matchedOrderIds, action: 'flagged_external_shipped' };
}

async function linkLedgerToOrder(event: NormalizedWebhookEvent, orderId: number): Promise<void> {
  const orderNumber = event.sourceOrderNumber;
  const sourceId = event.sourceOrderId;
  try {
    await pg`
      UPDATE webhook_events
      SET related_order_id = ${orderId}, status = 'processed', processed_at = NOW()
      WHERE related_order_id IS NULL
        AND canonical_status = ${event.canonicalStatus}
        AND (
          (${orderNumber ?? null}::text IS NOT NULL AND source_order_number = ${orderNumber ?? null})
          OR (${sourceId ?? null}::text IS NOT NULL AND source_order_id = ${sourceId ?? null})
        )
    `;
  } catch {
    /* best-effort link; the guard also matches by source number/id so this is non-critical */
  }
}
