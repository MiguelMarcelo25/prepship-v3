// PS-128 + PS-129 — forward-only reconciliation of a recorded upstream status event onto
// the matching local order. Invoked (best-effort, off the webhook response path) after the
// event is durably recorded in the ledger.
//
// Per user override unlock shipped data on 2026-07-16 (PS-424): candidate
// matching stays awaiting-only, while normalized terminal facts delegate to
// OrderLifecycleCommand. That owner atomically records status, provenance,
// exact claims, and durable work; it never reopens a terminal order.

import { sql as pg, db } from '../../db/client.js';
import {
  raiseReplacementOriginalOrderHoldsInTransaction,
  settleReplacementCancellationCredits,
} from '../replacement-original-order-hold.js';
import { replacementSchemaPresent } from '../replacement-schema-readiness.js';
import type { NormalizedWebhookEvent } from './webhook-providers.js';
import { applyOrderLifecycleCommand } from '../order-lifecycle-command.js';

export type UpstreamReconcileResult = {
  matchedOrderIds: number[];
  action: 'none' | 'cancelled' | 'external_shipped';
  /**
   * PS-502 AC-16. Additive: how many replacements were held because their SHIPPED original
   * was cancelled upstream. Separate from `action` because no order row changed — reporting
   * this as 'cancelled' would claim a status move that deliberately did not happen.
   */
  replacementHoldsRaised?: number;
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

  // ── PS-502 AC-16: the producer that actually fires ──────────────────────────────────
  //
  // The candidate query above is awaiting-only by design: a shipped order must never be
  // reopened or hard-cancelled. But an upstream cancellation of an order we ALREADY SHIPPED
  // is precisely the case AC-16 exists for, and until now that signal was durably recorded
  // in the ledger and then dropped on the floor.
  //
  // So this is a SECOND, replacement-scoped candidate query. It deliberately does not call
  // applyOrderLifecycleCommand and does not write canonical_status:
  //
  //   * the shipped -> cancelled invariant stays untouched — we DID ship, and the order row
  //     saying so remains true;
  //   * writing canonical_status = 'cancelled' would additionally zero the order's billing
  //     through the cancelled-no-charge predicate, turning a replacement question into
  //     silent revenue loss on the original.
  //
  // Only holds are raised. Every decision they imply belongs to a human.
  let replacementHoldsRaised = 0;
  // Same reason as the cancel branch: this query names `replacements`, and this reconciler
  // runs for every inbound webhook whether or not the feature has been migrated.
  if (event.canonicalStatus === 'cancelled' && await replacementSchemaPresent()) {
    const shippedWithReplacements = await pg<{ id: number }[]>`
      SELECT o.id FROM orders o
      WHERE o.order_status = 'shipped'
        AND EXISTS (SELECT 1 FROM replacements r WHERE r.order_id = o.id)
        AND (
          (${orderNumber ?? null}::text IS NOT NULL AND (o.order_number = ${orderNumber ?? null} OR o.source_order_number = ${orderNumber ?? null}))
          OR (${sourceId ?? null}::text IS NOT NULL AND (o.source_order_id = ${sourceId ?? null} OR o.external_order_id = ${sourceId ?? null}))
        )
      LIMIT 50
    `;

    if (shippedWithReplacements.length > 0) {
      // The evidence pointer. Matched on the same facts the ledger read uses rather than by
      // rebuilding the ledger's dedupe key here — a second copy of that key logic would be a
      // second thing to keep in step.
      //
      // If no ledger row can be found the hold is NOT raised. An unfalsifiable claim is worse
      // than a missing one, and this signal is durable: it will be reconciled again.
      const [ledgerRow] = await pg<{ id: number }[]>`
        SELECT id FROM webhook_events
        WHERE canonical_status = 'cancelled'
          AND status <> 'ignored'
          AND (
            (${event.externalEventId ?? null}::text IS NOT NULL AND external_event_id = ${event.externalEventId ?? null})
            OR (${orderNumber ?? null}::text IS NOT NULL AND source_order_number = ${orderNumber ?? null})
            OR (${sourceId ?? null}::text IS NOT NULL AND source_order_id = ${sourceId ?? null})
          )
        ORDER BY id DESC
        LIMIT 1
      `;
      if (ledgerRow) {
        for (const candidate of shippedWithReplacements) {
          const reason = `original order cancelled upstream by ${String(event.metadata.provider ?? 'unknown')}`;
          const actor = { type: 'system', email: null, permissions: [] };
          const swept = await db.transaction(async (tx) =>
            raiseReplacementOriginalOrderHoldsInTransaction(tx, {
              orderId: candidate.id,
              triggerKind: 'order_cancelled',
              evidence: { kind: 'webhook_event', webhookEventId: ledgerRow.id },
              reason,
              actor,
            }));
          replacementHoldsRaised += swept.outcomes.length;

          // AFTER the sweep has committed, never inside it. The reconciler takes the CLIENT
          // advisory lock and the sweep holds the ORDER one; nesting them in that order
          // deadlocks against the billing generator, which takes the client lock first.
          //
          // Until this existed, a cancellation removed a replacement's editable lines,
          // correctly preserved its invoiced ones, and left the client charged for them.
          if (swept.finalizedCreditPending.length > 0) {
            await settleReplacementCancellationCredits(swept.finalizedCreditPending, {
              reason,
              actor,
              // Derived from the ledger row, so a replayed webhook settles to the same key
              // and the reconciler refuses a second credit for the same finalization.
              idempotencySeed: `webhook:${ledgerRow.id}`,
            });
          }
        }
      }
    }
  }

  const firstMatchedId = matchedOrderIds[0];
  if (firstMatchedId === undefined) return { matchedOrderIds: [], action: 'none', replacementHoldsRaised };

  if (event.canonicalStatus === 'cancelled') {
    // PS-129: record a cancellation HOLD signal (forward-only). We set canonical_status —
    // NOT order_status — so we create a hold/review signal the guard blocks on, without
    // hard-cancelling the order row (avoids destructive cancelled-row side effects). Still
    // only awaiting rows.
    await Promise.all(candidates.map((candidate) =>
      applyOrderLifecycleCommand({
        orderId: candidate.id,
        commandKey: webhookCommandKey(event, candidate.id, 'cancelled'),
        transition: 'cancelled',
        source: `webhook:${String(event.metadata.provider ?? 'unknown')}`,
        effectiveAt: event.occurredAt ?? new Date(),
        canonicalStatus: 'cancelled',
        requireAwaitingOrderStatus: true,
        fulfillmentFacts: { kind: 'none' },
        provenance: event.metadata,
      })));
    await linkLedgerToOrder(event, firstMatchedId);
    return { matchedOrderIds, action: 'cancelled', replacementHoldsRaised };
  }

  // PS-128: flag external shipment (forward-only). externally_shipped is the existing
  // external-shipped signal; we surface it + its source so the order presents as "already
  // shipped in store" instead of allowing another label. Only awaiting rows.
  const provenanceSource = `webhook:${String(event.metadata.provider ?? 'unknown')}`;
  await Promise.all(candidates.map((candidate) =>
    applyOrderLifecycleCommand({
      orderId: candidate.id,
      commandKey: webhookCommandKey(event, candidate.id, 'external_shipped'),
      transition: 'external_shipped',
      source: provenanceSource,
      effectiveAt: event.occurredAt ?? new Date(),
      canonicalStatus: 'shipped',
      requireAwaitingOrderStatus: true,
      externallyShippedSource: provenanceSource,
      fulfillmentFacts: {
        kind: 'unavailable',
        description: 'Redacted webhook status did not contain exact fulfilled line quantities',
      },
      provenance: event.metadata,
    })));
  await linkLedgerToOrder(event, firstMatchedId);
  return { matchedOrderIds, action: 'external_shipped' };
}

function webhookCommandKey(
  event: NormalizedWebhookEvent,
  orderId: number,
  transition: 'cancelled' | 'external_shipped',
): string {
  const provider = String(event.metadata.provider ?? 'unknown');
  const eventIdentity =
    event.externalEventId ??
    `${event.eventType}:${event.sourceOrderId ?? event.sourceOrderNumber ?? 'unknown'}:${event.occurredAt?.toISOString() ?? 'undated'}`;
  return `lifecycle:webhook:${provider}:${eventIdentity}:order:${orderId}:${transition}`;
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
