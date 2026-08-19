// PS-128 + PS-129 — public inbound store/marketplace webhook route. Mounted BEFORE the JWT
// middleware (like /health and /cron) because providers can't present a Supabase JWT; trust
// is established by per-provider HMAC over the raw body instead.
//
// Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): this handler only
// VERIFIES + RECORDS a redacted event and completes a forward-only scoped reconcile before
// acknowledging it. A retry resumes the same durable receipt, including after a process loss. It
// never buys postage, creates labels, notifies marketplaces, or reopens terminal rows.

import { Hono } from 'hono';
import { env } from '../lib/env';
import {
  hashWebhookBody,
  webhookDedupeKey,
  recordWebhookEvent,
  findWebhookEventIdByDedupeKey,
  markWebhookEventStatus,
} from '../services/fulfillment/webhook-ledger';
import {
  verifyWebhookSignature,
  normalizeWebhookEvent,
  webhookSecretForProvider,
} from '../services/fulfillment/webhook-providers';
import { reconcileOrderFromUpstreamEvent } from '../services/fulfillment/upstream-reconcile';

const app = new Hono();

const ALLOWED_PROVIDERS = new Set(['shopify', 'shipstation', 'walmart', 'ebay']);

app.post('/:provider', async (c) => {
  const provider = c.req.param('provider').toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return c.json({ error: 'Unknown webhook provider' }, 404);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Raw body is required for HMAC; read it once.
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > env.WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413);
  }

  const secret = webhookSecretForProvider(provider);
  if (!secret) {
    // Fail-safe: never trust an unsigned/unconfigured webhook.
    return c.json({ error: 'Webhook not configured for provider' }, 503);
  }

  if (!verifyWebhookSignature({ provider, rawBody, headers, secret })) {
    // Invalid signature — reject and mutate nothing.
    return c.json({ error: 'Invalid signature' }, 401);
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
  } catch {
    body = null; // recorded as 'other'; still durable for audit
  }

  const normalized = normalizeWebhookEvent({ provider, headers, body });
  const payloadHash = hashWebhookBody(rawBody);
  const dedupeKey = webhookDedupeKey({
    provider,
    externalEventId: normalized.externalEventId,
    payloadHash,
    // Per user override unlock shipped data on 2026-07-14: pass normalized
    // event time to the ledger owner; this route still performs no order mutation.
    occurredAt: normalized.occurredAt,
    receivedAtMs: Date.now(),
  });

  let result: { recorded: boolean; deduped: boolean; id: number | null };
  try {
    result = await recordWebhookEvent({
      provider,
      eventType: normalized.eventType,
      canonicalStatus: normalized.canonicalStatus,
      externalEventId: normalized.externalEventId,
      payloadHash,
      dedupeKey,
      sourceOrderNumber: normalized.sourceOrderNumber,
      sourceOrderId: normalized.sourceOrderId,
      occurredAt: normalized.occurredAt,
      metadata: normalized.metadata,
    });
  } catch (err) {
    // PS-440: the durable ledger is the webhook acceptance boundary. Returning
    // success here discarded the provider's only retry signal while recording
    // nothing, so fail closed and let the provider retry its signed event.
    console.error('[webhooks] ledger record failed:', err instanceof Error ? err.message : err);
    return c.json({ ok: false, recorded: false, retryable: true }, 503);
  }

  // The durable ledger is the acceptance boundary, but recording is not processing. Await
  // terminal reconciliation before ACK so a process death cannot strand an AC-16 hold behind
  // a fire-and-forget promise. If the insert deduped, recover the SAME receipt and retry it:
  // duplicate means "already recorded", never "already reconciled".
  if (normalized.canonicalStatus === 'cancelled' || normalized.canonicalStatus === 'shipped') {
    const webhookEventId = result.id ?? await findWebhookEventIdByDedupeKey(dedupeKey);
    if (webhookEventId == null) {
      return c.json({ ok: false, recorded: result.recorded, retryable: true }, 503);
    }
    try {
      await reconcileOrderFromUpstreamEvent(normalized, { webhookEventId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'terminal webhook reconcile failed';
      try {
        await markWebhookEventStatus(webhookEventId, 'failed', message.slice(0, 1000));
      } catch {
        // The original error remains the retry reason. A failed status is diagnostic only;
        // the receipt itself already exists and the deduped retry will run it again.
      }
      console.warn('[webhooks] scoped reconcile failed:', message);
      return c.json({ ok: false, recorded: result.recorded, retryable: true }, 503);
    }
  }

  return c.json({ ok: true, recorded: result.recorded, deduped: result.deduped }, 200);
});

export default app;
