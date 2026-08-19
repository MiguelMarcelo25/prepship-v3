// PS-128 + PS-129 — forward-only reconciliation of a recorded upstream status event onto
// the matching local order. Invoked synchronously after the event is durably recorded; a
// failed reconcile returns a retryable webhook response and a deduped delivery resumes it.
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
import {
  bindWebhookEventToOrderIdentity,
  markWebhookEventStatus,
} from './webhook-ledger.js';
import { buildOrderSourceIdentity } from '../order-source-identity.js';

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

export class UpstreamReconcileIdentityError extends Error {
  readonly code = 'UPSTREAM_WEBHOOK_IDENTITY_AMBIGUOUS';
  readonly httpStatus = 409;

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamReconcileIdentityError';
  }
}

type ExactOrderCandidate = {
  id: number;
  orderStatus: string;
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: string;
};

/**
 * Resolve one signed event onto one canonical order-source tuple.
 *
 * A provider order id is not globally unique. If the event omits the account component we
 * permit the database to supply it only when `(provider, sourceOrderId)` has exactly one
 * complete local candidate. Two accounts is an explicit failure, never two held tenants.
 */
async function resolveExactOrderCandidate(
  event: NormalizedWebhookEvent,
): Promise<ExactOrderCandidate | null> {
  const provider = String(event.metadata.provider ?? '').trim().toLowerCase();
  const sourceOrderId = event.sourceOrderId?.trim() ?? '';
  if (!provider || !sourceOrderId) {
    throw new UpstreamReconcileIdentityError(
      'Terminal webhook is missing provider/account-scoped source order identity',
    );
  }

  const hinted = buildOrderSourceIdentity({
    sourceProvider: provider,
    sourceAccountId: event.sourceAccountId,
    sourceOrderId,
  });
  const rows = await pg<{
    id: number;
    order_status: string;
    source_provider: string;
    source_account_id: string;
    source_order_id: string;
  }[]>`
    SELECT id, order_status, source_provider, source_account_id, source_order_id
    FROM orders
    WHERE source_provider = ${provider}
      AND source_order_id = ${sourceOrderId}
      AND source_account_id IS NOT NULL
      AND (${hinted?.sourceAccountId ?? null}::text IS NULL
        OR source_account_id = ${hinted?.sourceAccountId ?? null})
    ORDER BY id
    LIMIT 2
  `;

  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new UpstreamReconcileIdentityError(
      'Terminal webhook source identity matches more than one local provider account',
    );
  }
  const row = rows[0]!;
  const exact = buildOrderSourceIdentity({
    sourceProvider: row.source_provider,
    sourceAccountId: row.source_account_id,
    sourceOrderId: row.source_order_id,
  });
  if (!exact) {
    throw new UpstreamReconcileIdentityError(
      'Matched order does not carry a complete canonical source identity',
    );
  }
  return {
    id: row.id,
    orderStatus: row.order_status,
    ...exact,
  };
}

/**
 * Apply one durable terminal receipt to its exact local source order.
 *
 * The webhook route awaits this before acknowledging the provider. If the process dies after
 * the receipt insert, the provider's deduped retry supplies the same ledger id and runs this
 * idempotent owner again. No successful ACK can strand a `received` cancellation behind a
 * fire-and-forget promise.
 */
export async function reconcileOrderFromUpstreamEvent(
  event: NormalizedWebhookEvent,
  input: { webhookEventId: number },
): Promise<UpstreamReconcileResult> {
  if (event.canonicalStatus !== 'cancelled' && event.canonicalStatus !== 'shipped') {
    return { matchedOrderIds: [], action: 'none' };
  }
  if (!Number.isInteger(input.webhookEventId) || input.webhookEventId <= 0) {
    throw new UpstreamReconcileIdentityError('A durable webhook receipt id is required');
  }

  const candidate = await resolveExactOrderCandidate(event);
  // The order may legitimately arrive after its provider event. Preserve the `received`
  // receipt so a later exact lookup/create preflight can see it; there is nothing safe to
  // bind or mutate yet.
  if (!candidate) return { matchedOrderIds: [], action: 'none', replacementHoldsRaised: 0 };

  await bindWebhookEventToOrderIdentity({
    webhookEventId: input.webhookEventId,
    orderId: candidate.id,
    sourceProvider: candidate.sourceProvider,
    sourceAccountId: candidate.sourceAccountId,
    sourceOrderId: candidate.sourceOrderId,
  });
  const matchedOrderIds = [candidate.id];

  // ── PS-502 AC-16: the producer that actually fires ──────────────────────────────────
  //
  // The lifecycle branch below is awaiting-only: a shipped order must never be reopened or
  // hard-cancelled. But an upstream cancellation of an order we ALREADY SHIPPED
  // is precisely the case AC-16 exists for, and until now that signal was durably recorded
  // in the ledger and then dropped on the floor.
  //
  // So the shipped branch deliberately does not call applyOrderLifecycleCommand and does not
  // write canonical_status:
  //
  //   * the shipped -> cancelled invariant stays untouched — we DID ship, and the order row
  //     saying so remains true;
  //   * writing canonical_status = 'cancelled' would additionally zero the order's billing
  //     through the cancelled-no-charge predicate, turning a replacement question into
  //     silent revenue loss on the original.
  //
  // Only holds are raised. Every decision they imply belongs to a human.
  let replacementHoldsRaised = 0;
  // This reconciler runs for every inbound webhook whether or not the replacement feature
  // has been migrated, so the additive table read remains schema-gated.
  if (
    event.canonicalStatus === 'cancelled'
    && candidate.orderStatus === 'shipped'
    && await replacementSchemaPresent()
  ) {
    const reason = `original order cancelled upstream by ${candidate.sourceProvider}`;
    const actor = { type: 'system', email: null, permissions: [] };
    const swept = await db.transaction(async (tx) =>
      raiseReplacementOriginalOrderHoldsInTransaction(tx, {
        orderId: candidate.id,
        triggerKind: 'order_cancelled',
        evidence: { kind: 'webhook_event', webhookEventId: input.webhookEventId },
        reason,
        actor,
      }));
    replacementHoldsRaised += swept.outcomes.length;

    // AFTER the sweep has committed, never inside it. The reconciler takes the CLIENT
    // advisory lock and the sweep holds the ORDER one; nesting them in that order deadlocks
    // against the billing generator, which takes the client lock first.
    if (swept.finalizedCreditPending.length > 0) {
      await settleReplacementCancellationCredits(swept.finalizedCreditPending, {
        reason,
        actor,
        idempotencySeed: `webhook:${input.webhookEventId}`,
      });
    }
  }

  // Only an awaiting order may move. Exact terminal replays still reach this point so the
  // receipt can be rebound/marked processed, but they never reopen the local row.
  if (candidate.orderStatus !== 'awaiting_shipment') {
    await markWebhookEventStatus(input.webhookEventId, 'processed');
    return { matchedOrderIds, action: 'none', replacementHoldsRaised };
  }

  if (event.canonicalStatus === 'cancelled') {
    // PS-129: record a cancellation HOLD signal (forward-only). We set canonical_status —
    // NOT order_status — so we create a hold/review signal the guard blocks on, without
    // hard-cancelling the order row (avoids destructive cancelled-row side effects). Still
    // only awaiting rows.
    await applyOrderLifecycleCommand({
      orderId: candidate.id,
      commandKey: webhookCommandKey(event, candidate.id, 'cancelled'),
      transition: 'cancelled',
      source: `webhook:${candidate.sourceProvider}`,
      effectiveAt: event.occurredAt ?? new Date(),
      canonicalStatus: 'cancelled',
      requireAwaitingOrderStatus: true,
      fulfillmentFacts: { kind: 'none' },
      provenance: event.metadata,
    });
    await markWebhookEventStatus(input.webhookEventId, 'processed');
    return { matchedOrderIds, action: 'cancelled', replacementHoldsRaised };
  }

  // PS-128: flag external shipment (forward-only). externally_shipped is the existing
  // external-shipped signal; we surface it + its source so the order presents as "already
  // shipped in store" instead of allowing another label. Only awaiting rows.
  const provenanceSource = `webhook:${String(event.metadata.provider ?? 'unknown')}`;
  await applyOrderLifecycleCommand({
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
  });
  await markWebhookEventStatus(input.webhookEventId, 'processed');
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
