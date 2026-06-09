// PS-128 + PS-129 — provider payload translation + signature verification for inbound
// store/marketplace webhooks. Connectors own payload shape; the route owns transport; the
// shipping-safety service owns policy. These helpers are PURE (no DB/network) so HMAC and
// normalization are unit-testable.
//
// Security: we NEVER trust an unsigned webhook. If no secret is configured for a provider
// the route rejects the event. We store only redacted metadata + a payload hash, never the
// raw body / PII / tokens.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../lib/env.js';
import type { CanonicalWebhookStatus } from './webhook-ledger.js';

export type NormalizedWebhookEvent = {
  eventType: string;
  canonicalStatus: CanonicalWebhookStatus;
  externalEventId: string | null;
  sourceOrderNumber: string | null;
  sourceOrderId: string | null;
  occurredAt: Date | null;
  /** Redacted, non-PII metadata for diagnostics. */
  metadata: Record<string, unknown>;
};

/** Resolve the signing secret for a provider: provider-specific env, else the shared one. */
export function webhookSecretForProvider(provider: string): string | null {
  const p = provider.toLowerCase();
  const map: Record<string, string | undefined> = {
    shopify: env.SHOPIFY_WEBHOOK_SECRET,
    shipstation: env.SHIPSTATION_WEBHOOK_SECRET,
    walmart: env.WALMART_WEBHOOK_SECRET,
    ebay: env.EBAY_WEBHOOK_SECRET,
  };
  return (map[p] || env.WEBHOOK_SIGNING_SECRET) ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the provider signature over the EXACT raw body. Shopify uses base64 HMAC-SHA256 in
 * X-Shopify-Hmac-Sha256; everyone else uses a generic hex HMAC-SHA256 in X-Webhook-Signature
 * (our convention — adjust per provider as their schemes are wired). Returns false on any
 * missing secret/signature so unsigned events are rejected.
 */
export function verifyWebhookSignature(input: {
  provider: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string | null;
}): boolean {
  const { provider, rawBody, headers, secret } = input;
  if (!secret) return false;
  const p = provider.toLowerCase();
  const h = (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? '';

  if (p === 'shopify') {
    const provided = h('x-shopify-hmac-sha256');
    if (!provided) return false;
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    return safeEqual(provided, expected);
  }

  // Per-provider HMAC-SHA256 over the raw body (the ticket's requirement: "verify HMAC /
  // per-provider secret before processing"). We accept the common signature header names
  // providers use (Walmart/eBay configurable webhook, GitHub/Meta-style x-hub-signature-256)
  // so onboarding a provider is a secret + header config, not a code change. NOTE: confirm
  // the exact header/scheme with each provider at onboarding; if a provider later requires a
  // non-HMAC scheme (e.g. RSA), add a provider branch above like Shopify's.
  const provided =
    h('x-webhook-signature') || h('x-signature') || h('x-hub-signature-256') || h('x-wm-signature');
  if (!provided) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Allow an optional "sha256=" prefix some providers use.
  const normalized = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  return safeEqual(normalized, expected);
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Translate a parsed provider payload + headers into a normalized event. Unknown shapes map
 * to canonicalStatus 'other' (recorded but not treated as a terminal block signal).
 */
export function normalizeWebhookEvent(input: {
  provider: string;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown> | null;
}): NormalizedWebhookEvent {
  const { provider, headers, body } = input;
  const p = provider.toLowerCase();
  const b = body ?? {};
  const h = (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined;

  let eventType = '';
  let canonicalStatus: CanonicalWebhookStatus = 'other';
  let externalEventId: string | null = null;
  let sourceOrderNumber: string | null = null;
  let sourceOrderId: string | null = null;
  let occurredAt: Date | null = null;

  if (p === 'shopify') {
    eventType = String(h('x-shopify-topic') ?? 'shopify.unknown');
    externalEventId = firstString(h('x-shopify-webhook-id'));
    sourceOrderNumber = firstString((b as any).order_number, (b as any).name, (b as any).order_id);
    sourceOrderId = firstString((b as any).id, (b as any).order_id, (b as any).admin_graphql_api_id);
    occurredAt = toDate((b as any).cancelled_at) ?? toDate((b as any).updated_at) ?? toDate((b as any).created_at);
    if (eventType.includes('cancel') || (b as any).cancelled_at) canonicalStatus = 'cancelled';
    else if (eventType.includes('fulfillment')) canonicalStatus = 'shipped';
  } else {
    // Generic shape (shipstation/walmart/ebay/custom). Pull common identifiers + status.
    eventType = firstString(
      (b as any).eventType, (b as any).event_type, (b as any).topic, h('x-event-type'),
    ) ?? `${p}.event`;
    externalEventId = firstString(
      (b as any).eventId, (b as any).event_id, (b as any).id, h('x-event-id'),
    );
    sourceOrderNumber = firstString(
      (b as any).orderNumber, (b as any).order_number, (b as any).purchaseOrderId,
      (b as any).customerOrderId, (b as any).poNumber,
    );
    sourceOrderId = firstString(
      (b as any).orderId, (b as any).order_id, (b as any).sourceOrderId, (b as any).externalOrderId,
    );
    occurredAt = toDate((b as any).occurredAt) ?? toDate((b as any).timestamp) ?? toDate((b as any).eventTime);
    const status = String(
      firstString((b as any).status, (b as any).orderStatus, (b as any).order_status, eventType) ?? '',
    ).toLowerCase();
    if (/cancel/.test(status)) canonicalStatus = 'cancelled';
    else if (/ship|fulfill|complete|delivered/.test(status)) canonicalStatus = 'shipped';
  }

  return {
    eventType: eventType || `${p}.event`,
    canonicalStatus,
    externalEventId,
    sourceOrderNumber,
    sourceOrderId,
    occurredAt,
    // Redacted: identifiers + status only. NEVER addresses/contact/raw payload.
    metadata: {
      provider: p,
      eventType: eventType || `${p}.event`,
      canonicalStatus,
      hasOrderNumber: Boolean(sourceOrderNumber),
      hasOrderId: Boolean(sourceOrderId),
    },
  };
}
