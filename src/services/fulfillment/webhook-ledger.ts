// PS-128 + PS-129 — Durable, redacted inbound webhook/event ledger shared by both tickets.
//
// Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): this ledger records
// upstream shipped/cancelled SIGNALS so the canonical shipping-safety guard can block
// duplicate/cancelled shipments. It NEVER stores raw provider payloads, customer PII,
// tokens, or labels — only redacted metadata + a payload hash. It NEVER mutates orders/
// shipments; reconciliation that updates canonical status is forward-only and lives in the
// reconcile layer.
//
// Migration 0040 owns this table. Boot readiness blocks migration-lag purchase
// work. Reads remain best-effort and never weaken order-column safety checks.

import { sql as pg } from '../../db/client.js';
import { assertRuntimeSchemaReady } from '../runtime-schema-readiness.js';
import { createHash } from 'node:crypto';
import { buildOrderSourceIdentity } from '../order-source-identity.js';

export type CanonicalWebhookStatus = 'shipped' | 'cancelled' | 'other';

export type WebhookEventRecord = {
  provider: string;
  eventType: string;
  canonicalStatus: CanonicalWebhookStatus;
  externalEventId?: string | null;
  /** Hash of the raw body (for dedupe / audit) — never the raw body itself. */
  payloadHash: string;
  /** Stable dedupe key: external event id when present, else provider+hash+event window. */
  dedupeKey: string;
  sourceOrderNumber?: string | null;
  sourceOrderId?: string | null;
  relatedOrderId?: number | null;
  relatedShipmentId?: number | null;
  occurredAt?: Date | null;
  /** Redacted metadata only (no PII / no raw payload). */
  metadata?: Record<string, unknown>;
};

export async function ensureWebhookEventsSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

/** SHA-256 of the raw body. Stored instead of the payload so we never persist PII. */
export function hashWebhookBody(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Stable dedupe key. Prefer the provider's own event id; otherwise fold the payload hash
 * into the event occurrence window so delayed retries collapse but distinct events don't.
 */
export function webhookDedupeKey(input: {
  provider: string;
  externalEventId?: string | null;
  payloadHash: string;
  occurredAt?: Date | null;
  receivedAtMs: number;
  windowMs?: number;
}): string {
  if (input.externalEventId && input.externalEventId.trim()) {
    return `${input.provider}:eid:${input.externalEventId.trim()}`;
  }
  const windowMs = input.windowMs ?? 5 * 60_000;
  // Per user override unlock shipped data on 2026-07-14: dedupe only webhook
  // ledger ingestion metadata; shipped/cancelled mutation guards are unchanged.
  const occurredAtMs = input.occurredAt?.getTime();
  const bucketSourceMs = Number.isFinite(occurredAtMs) ? occurredAtMs! : input.receivedAtMs;
  const bucket = Math.floor(bucketSourceMs / windowMs);
  return `${input.provider}:hash:${input.payloadHash}:${bucket}`;
}

/**
 * Insert a redacted ledger row. Idempotent: a duplicate dedupe_key is a no-op
 * (deduped=true). Returns the row id when newly recorded.
 */
export async function recordWebhookEvent(
  event: WebhookEventRecord,
): Promise<{ recorded: boolean; deduped: boolean; id: number | null }> {
  await ensureWebhookEventsSchema();
  const rows = await pg<{ id: number }[]>`
    INSERT INTO webhook_events (
      provider, event_type, canonical_status, external_event_id, payload_hash, dedupe_key,
      source_order_number, source_order_id, related_order_id, related_shipment_id,
      status, metadata, occurred_at
    ) VALUES (
      ${event.provider}, ${event.eventType}, ${event.canonicalStatus},
      ${event.externalEventId ?? null}, ${event.payloadHash}, ${event.dedupeKey},
      ${event.sourceOrderNumber ?? null}, ${event.sourceOrderId ?? null},
      ${event.relatedOrderId ?? null}, ${event.relatedShipmentId ?? null},
      'received', ${pg.json((event.metadata ?? {}) as Record<string, never>)}, ${event.occurredAt ?? null}
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  const inserted = rows[0];
  if (inserted) return { recorded: true, deduped: false, id: inserted.id };
  return { recorded: false, deduped: true, id: null };
}

/**
 * Recover the durable row behind a deduped delivery.
 *
 * A duplicate insert intentionally returns no id, but the duplicate is exactly the delivery
 * that must retry unfinished reconciliation after a process death. The route therefore reads
 * the existing receipt by the same unique key rather than treating `deduped` as `processed`.
 */
export async function findWebhookEventIdByDedupeKey(dedupeKey: string): Promise<number | null> {
  await ensureWebhookEventsSchema();
  const [row] = await pg<{ id: number }[]>`
    SELECT id
    FROM webhook_events
    WHERE dedupe_key = ${dedupeKey}
    LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * Bind a receipt to the exact local source identity that reconciliation resolved.
 *
 * `source_account_id` predates the webhook ledger and is not a ledger column, so the
 * redacted metadata stores the canonical account component. The update refuses to move an
 * already-bound receipt to another order. This is a local evidence link only; it performs no
 * provider call and changes no order/shipments row.
 */
export async function bindWebhookEventToOrderIdentity(input: {
  webhookEventId: number;
  orderId: number;
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: string;
}): Promise<void> {
  await ensureWebhookEventsSchema();
  const rows = await pg<{ id: number }[]>`
    UPDATE webhook_events
    SET related_order_id = ${input.orderId},
        metadata = metadata || jsonb_build_object(
          'sourceAccountId', ${input.sourceAccountId},
          'sourceIdentityBound', true
        )
    WHERE id = ${input.webhookEventId}
      AND provider = ${input.sourceProvider}
      AND source_order_id = ${input.sourceOrderId}
      AND (
        nullif(metadata ->> 'sourceAccountId', '') IS NULL
        OR metadata ->> 'sourceAccountId' = ${input.sourceAccountId}
      )
      AND (related_order_id IS NULL OR related_order_id = ${input.orderId})
    RETURNING id
  `;
  if (!rows[0]) {
    throw new Error('Webhook receipt does not match the resolved order source identity');
  }
}

export async function markWebhookEventStatus(
  id: number,
  status: 'ignored' | 'processed' | 'failed',
  error?: string | null,
): Promise<void> {
  await ensureWebhookEventsSchema();
  await pg`
    UPDATE webhook_events
    SET status = ${status},
        error = ${error ?? null},
        processed_at = CASE WHEN ${status} = 'received' THEN processed_at ELSE now() END
    WHERE id = ${id}
  `;
}

export type UpstreamTerminalStatus = { shipped: boolean; cancelled: boolean };

/**
 * Does the ledger hold a trusted shipped/cancelled event for this exact source order?
 *
 * Provider ids are account-scoped, so an order number, external-id fallback, or bare source
 * id is never enough. A receipt with no account hint is accepted only while the local
 * provider/source-id candidate is unique; as soon as a second account shares that id the
 * lookup fails closed instead of holding the wrong tenant's order.
 */
export async function findUpstreamTerminalStatusForOrder(order: {
  id: number;
  sourceProvider?: string | null;
  sourceAccountId?: string | null;
  sourceOrderId?: string | null;
}): Promise<UpstreamTerminalStatus> {
  await ensureWebhookEventsSchema();
  const identity = buildOrderSourceIdentity(order);
  if (!identity) return { shipped: false, cancelled: false };

  const rows = await pg<{ canonical_status: string }[]>`
    SELECT DISTINCT canonical_status
    FROM webhook_events event
    WHERE event.status <> 'ignored'
      AND event.canonical_status IN ('shipped', 'cancelled')
      AND event.provider = ${identity.sourceProvider}
      AND event.source_order_id = ${identity.sourceOrderId}
      AND (
        event.metadata ->> 'sourceAccountId' = ${identity.sourceAccountId}
        OR (
          nullif(event.metadata ->> 'sourceAccountId', '') IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM orders competing
            WHERE competing.source_provider = ${identity.sourceProvider}
              AND competing.source_order_id = ${identity.sourceOrderId}
              AND competing.source_account_id IS DISTINCT FROM ${identity.sourceAccountId}
          )
        )
      )
  `;
  return {
    shipped: rows.some((r) => r.canonical_status === 'shipped'),
    cancelled: rows.some((r) => r.canonical_status === 'cancelled'),
  };
}
