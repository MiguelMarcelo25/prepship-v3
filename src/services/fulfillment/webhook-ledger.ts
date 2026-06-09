// PS-128 + PS-129 — Durable, redacted inbound webhook/event ledger shared by both tickets.
//
// Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): this ledger records
// upstream shipped/cancelled SIGNALS so the canonical shipping-safety guard can block
// duplicate/cancelled shipments. It NEVER stores raw provider payloads, customer PII,
// tokens, or labels — only redacted metadata + a payload hash. It NEVER mutates orders/
// shipments; reconciliation that updates canonical status is forward-only and lives in the
// reconcile layer.
//
// A migration (drizzle/0040_webhook_events.sql) owns this table, but we ALSO self-provision
// it idempotently at runtime so a not-yet-migrated environment can't throw "table does not
// exist" at the purchase boundary (the rate_cache.diagnostics failure class). All reads are
// best-effort: a missing/unavailable ledger degrades gracefully and never weakens the
// order-column safety checks.

import { sql as pg } from '../../db/client.js';
import { createHash } from 'node:crypto';

export type CanonicalWebhookStatus = 'shipped' | 'cancelled' | 'other';

export type WebhookEventRecord = {
  provider: string;
  eventType: string;
  canonicalStatus: CanonicalWebhookStatus;
  externalEventId?: string | null;
  /** Hash of the raw body (for dedupe / audit) — never the raw body itself. */
  payloadHash: string;
  /** Stable dedupe key: external event id when present, else provider+hash+window. */
  dedupeKey: string;
  sourceOrderNumber?: string | null;
  sourceOrderId?: string | null;
  relatedOrderId?: number | null;
  relatedShipmentId?: number | null;
  occurredAt?: Date | null;
  /** Redacted metadata only (no PII / no raw payload). */
  metadata?: Record<string, unknown>;
};

let schemaEnsured: Promise<void> | null = null;

export async function ensureWebhookEventsSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id serial PRIMARY KEY,
        provider text NOT NULL,
        event_type text NOT NULL,
        canonical_status text,
        external_event_id text,
        payload_hash text NOT NULL,
        dedupe_key text NOT NULL,
        source_order_number text,
        source_order_id text,
        related_order_id integer,
        related_shipment_id integer,
        status text NOT NULL DEFAULT 'received',
        error text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz,
        received_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      )
    `;
    await pg`CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_dedupe_idx ON webhook_events (dedupe_key)`;
    await pg`CREATE INDEX IF NOT EXISTS webhook_events_order_status_idx ON webhook_events (related_order_id, canonical_status)`;
    await pg`CREATE INDEX IF NOT EXISTS webhook_events_source_lookup_idx ON webhook_events (provider, source_order_number)`;
    await pg`CREATE INDEX IF NOT EXISTS webhook_events_source_id_idx ON webhook_events (source_order_id)`;
  })().catch((err) => {
    // Reset so a later call can retry; surface to caller best-effort.
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

/** SHA-256 of the raw body. Stored instead of the payload so we never persist PII. */
export function hashWebhookBody(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Stable dedupe key. Prefer the provider's own event id; otherwise fold the payload hash
 * into a coarse time window so identical re-deliveries collapse but distinct events don't.
 */
export function webhookDedupeKey(input: {
  provider: string;
  externalEventId?: string | null;
  payloadHash: string;
  receivedAtMs: number;
  windowMs?: number;
}): string {
  if (input.externalEventId && input.externalEventId.trim()) {
    return `${input.provider}:eid:${input.externalEventId.trim()}`;
  }
  const windowMs = input.windowMs ?? 5 * 60_000;
  const bucket = Math.floor(input.receivedAtMs / windowMs);
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
 * Does the ledger hold a trusted shipped/cancelled event for this order? Matched by local
 * order id, or by source order number / source order id (covers events that arrived before
 * the local order was linked). Ignored events don't count.
 */
export async function findUpstreamTerminalStatusForOrder(order: {
  id: number;
  orderNumber?: string | null;
  sourceOrderNumber?: string | null;
  sourceOrderId?: string | null;
  externalOrderId?: string | null;
}): Promise<UpstreamTerminalStatus> {
  await ensureWebhookEventsSchema();
  const orderNumbers = [order.orderNumber, order.sourceOrderNumber].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  const sourceIds = [order.sourceOrderId, order.externalOrderId].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  const rows = await pg<{ canonical_status: string }[]>`
    SELECT DISTINCT canonical_status
    FROM webhook_events
    WHERE status <> 'ignored'
      AND canonical_status IN ('shipped', 'cancelled')
      AND (
        related_order_id = ${order.id}
        OR (${orderNumbers.length > 0} AND source_order_number = ANY(${orderNumbers}))
        OR (${sourceIds.length > 0} AND source_order_id = ANY(${sourceIds}))
      )
  `;
  return {
    shipped: rows.some((r) => r.canonical_status === 'shipped'),
    cancelled: rows.some((r) => r.canonical_status === 'cancelled'),
  };
}
