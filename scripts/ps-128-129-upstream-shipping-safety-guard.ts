/**
 * PS-128 + PS-129 guard — backend-owned upstream shipping safety.
 *   PS-128: block duplicate shipments when the marketplace/source already shipped.
 *   PS-129: hold/block shipping when the order was cancelled upstream.
 * Plus webhook HMAC verification + dedupe + redacted ledger + forward-only reconcile.
 *
 * Pure logic + static source assertions. No DB, no network, no postage, no labels.
 *   npx tsx scripts/ps-128-129-upstream-shipping-safety-guard.ts
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

// Dummy env so the env-bound modules import cleanly; the guard only calls PURE functions,
// so no DB connection is ever opened. VERCEL=1 makes the Render-only secrets optional.
process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SHIPPING_SAFETY_UNVERIFIED_POLICY ??= 'audit_only';
process.env.WEBHOOK_SIGNING_SECRET ??= 'shared-secret';

const { decideShippingSafety } = await import('../src/services/fulfillment/shipping-safety');
const { verifyWebhookSignature, normalizeWebhookEvent } = await import(
  '../src/services/fulfillment/webhook-providers'
);
const { webhookDedupeKey } = await import('../src/services/fulfillment/webhook-ledger');

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── PS-129: upstream cancellation hold ───────────────────────────────────────
{
  const local = decideShippingSafety({ orderStatus: 'cancelled' });
  check('local cancelled -> block', [local.safe, local.code], [false, 'local_cancelled']);
  const reconciled = decideShippingSafety({ orderStatus: 'awaiting_shipment', canonicalStatus: 'cancelled' });
  check('reconciled upstream cancel -> block', [reconciled.safe, reconciled.code], [false, 'upstream_cancelled_reconciled']);
  const evt = decideShippingSafety({ orderStatus: 'awaiting_shipment', upstreamCancelledEvent: true });
  check('upstream cancel event -> block', [evt.safe, evt.code], [false, 'upstream_cancelled_event']);
}

// ── PS-128: duplicate / external shipment block ──────────────────────────────
{
  const localShipped = decideShippingSafety({ orderStatus: 'shipped' });
  check('local shipped -> block', [localShipped.safe, localShipped.code], [false, 'local_shipped']);
  const ext = decideShippingSafety({ orderStatus: 'awaiting_shipment', externallyShipped: true });
  check('externally shipped -> block', [ext.safe, ext.code], [false, 'externally_shipped']);
  const evt = decideShippingSafety({ orderStatus: 'awaiting_shipment', upstreamShippedEvent: true });
  check('upstream shipped event -> block', [evt.safe, evt.code], [false, 'upstream_shipped_event']);
}

// ── PS-128 fail-closed policy: audit-only default never false-blocks; enforce blocks ──
{
  const audit = decideShippingSafety({
    orderStatus: 'awaiting_shipment',
    highRiskUnverifiedSource: true,
    unverifiedPolicy: 'audit_only',
  });
  check('unverified high-risk + audit_only -> allowed (audit)', [audit.safe, audit.severity, audit.code], [true, 'audit', 'unverified_high_risk_source']);
  const enforce = decideShippingSafety({
    orderStatus: 'awaiting_shipment',
    highRiskUnverifiedSource: true,
    unverifiedPolicy: 'enforce',
  });
  check('unverified high-risk + enforce -> block', [enforce.safe, enforce.code], [false, 'unverified_high_risk_source']);
}

// ── normal awaiting order is allowed; terminal signals take priority ──────────
{
  const ok = decideShippingSafety({ orderStatus: 'awaiting_shipment' });
  check('normal awaiting -> allow', [ok.safe, ok.severity, ok.code], [true, 'allow', 'ok']);
  const priority = decideShippingSafety({ orderStatus: 'cancelled', externallyShipped: true, upstreamShippedEvent: true });
  check('cancelled takes priority over ship signals', priority.code, 'local_cancelled');
}

// ── PS-128 webhook HMAC verification ─────────────────────────────────────────
{
  const body = '{"order_number":"200014986465025","cancelled_at":null}';
  const secret = 'shopify-secret';
  const shopifySig = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  check('shopify valid HMAC accepted', verifyWebhookSignature({ provider: 'shopify', rawBody: body, secret, headers: { 'x-shopify-hmac-sha256': shopifySig } }), true);
  check('shopify wrong HMAC rejected', verifyWebhookSignature({ provider: 'shopify', rawBody: body, secret, headers: { 'x-shopify-hmac-sha256': 'deadbeef' } }), false);
  check('shopify missing HMAC rejected', verifyWebhookSignature({ provider: 'shopify', rawBody: body, secret, headers: {} }), false);
  check('any provider with no secret rejected', verifyWebhookSignature({ provider: 'shopify', rawBody: body, secret: null, headers: { 'x-shopify-hmac-sha256': shopifySig } }), false);

  const genHex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  check('generic hex HMAC accepted', verifyWebhookSignature({ provider: 'walmart', rawBody: body, secret, headers: { 'x-webhook-signature': genHex } }), true);
  check('generic sha256= prefixed HMAC accepted', verifyWebhookSignature({ provider: 'walmart', rawBody: body, secret, headers: { 'x-webhook-signature': `sha256=${genHex}` } }), true);
  check('generic x-hub-signature-256 header accepted', verifyWebhookSignature({ provider: 'walmart', rawBody: body, secret, headers: { 'x-hub-signature-256': `sha256=${genHex}` } }), true);
  check('generic tampered body rejected', verifyWebhookSignature({ provider: 'walmart', rawBody: body + 'x', secret, headers: { 'x-webhook-signature': genHex } }), false);
}

// ── PS-128 dedupe key ────────────────────────────────────────────────────────
{
  const a = webhookDedupeKey({ provider: 'shopify', externalEventId: 'evt_1', payloadHash: 'h', receivedAtMs: 1000 });
  const b = webhookDedupeKey({ provider: 'shopify', externalEventId: 'evt_1', payloadHash: 'h', receivedAtMs: 9_999_999 });
  check('same external event id -> same dedupe key (time-independent)', a === b, true);
  const c = webhookDedupeKey({ provider: 'shopify', externalEventId: 'evt_2', payloadHash: 'h', receivedAtMs: 1000 });
  check('different external event id -> different key', a === c, false);
  const noId1 = webhookDedupeKey({ provider: 'walmart', payloadHash: 'h', receivedAtMs: 1000 });
  const noId2 = webhookDedupeKey({ provider: 'walmart', payloadHash: 'h', receivedAtMs: 2000 });
  check('no event id, same hash+window -> same key', noId1 === noId2, true);
  const noId3 = webhookDedupeKey({ provider: 'walmart', payloadHash: 'different', receivedAtMs: 1000 });
  check('no event id, different hash -> different key', noId1 === noId3, false);
}

// ── PS-128/129 payload normalization ─────────────────────────────────────────
{
  const cancel = normalizeWebhookEvent({ provider: 'shopify', headers: { 'x-shopify-topic': 'orders/cancelled' }, body: { order_number: 'A1', id: 99 } });
  check('shopify orders/cancelled -> cancelled', [cancel.canonicalStatus, cancel.sourceOrderNumber], ['cancelled', 'A1']);
  const ship = normalizeWebhookEvent({ provider: 'shopify', headers: { 'x-shopify-topic': 'fulfillments/create' }, body: { order_number: 'A2' } });
  check('shopify fulfillments/create -> shipped', ship.canonicalStatus, 'shipped');
  const genCancel = normalizeWebhookEvent({ provider: 'walmart', headers: {}, body: { status: 'Cancelled', purchaseOrderId: 'PO1' } });
  check('generic cancelled status -> cancelled', [genCancel.canonicalStatus, genCancel.sourceOrderNumber], ['cancelled', 'PO1']);
  const genShip = normalizeWebhookEvent({ provider: 'ebay', headers: {}, body: { orderStatus: 'shipped', orderNumber: 'E1' } });
  check('generic shipped status -> shipped', genShip.canonicalStatus, 'shipped');
  // Redaction: metadata must carry only identifiers/flags, never PII.
  const meta = JSON.stringify(cancel.metadata);
  check('metadata redacted (no address/email/phone)', /address|email|phone|name|street|zip/i.test(meta), false);
}

// ── Static wiring: backend is the authoritative block point ───────────────────
{
  const main = readFileSync('src/main.ts', 'utf8');
  check('webhooks route mounted', /app\.route\('\/webhooks',\s*webhooksRoute\)/.test(main), true);
  check('webhooks NOT behind JWT (not in protectedPrefixes)', /'\/webhooks'/.test(main.split('protectedPrefixes')[1] ?? ''), false);

  const labels = readFileSync('src/services/labels.ts', 'utf8');
  check('createLabelV2 calls assertOrderSafeToShip', /assertOrderSafeToShip\(/.test(labels), true);

  // PS-209: api/carriers/labels.ts is a retired 410 stub. The direct-carrier purchase
  // path moved into createLabelV2 (src/services/labels.ts), which runs the SAME
  // assertOrderSafeToShip BEFORE the direct-carrier branch (createDirectCarrierLabelForOrder).
  // Assert the ORDERING so a future edit can't reach the direct branch without the safety gate —
  // stricter than the old "stub contains the call" string check (the live invariant, not a dead file).
  const safeIdx = labels.indexOf('assertOrderSafeToShip(');
  const directBranchIdx = labels.indexOf('createDirectCarrierLabelForOrder(');
  check('direct-carrier label path runs assertOrderSafeToShip before the direct-carrier branch',
    safeIdx !== -1 && directBranchIdx !== -1 && safeIdx < directBranchIdx, true);

  const route = readFileSync('src/routes/webhooks.ts', 'utf8');
  check('webhook route verifies signature', /verifyWebhookSignature\(/.test(route), true);
  check('webhook route records ledger', /recordWebhookEvent\(/.test(route), true);
  check('webhook route rejects invalid signature (401)', /Invalid signature.*401|401\)/.test(route) && /verifyWebhookSignature/.test(route), true);
  check('webhook route rejects unconfigured provider secret (503)', /503/.test(route), true);

  const reconcile = readFileSync('src/services/fulfillment/upstream-reconcile.ts', 'utf8');
  check('reconcile is forward-only (awaiting only)', /order_status = 'awaiting_shipment'/.test(reconcile), true);
  check('reconcile terminal facts delegate to the atomic lifecycle owner',
    /applyOrderLifecycleCommand\(\{/.test(reconcile) &&
      /transition: 'cancelled'/.test(reconcile) &&
      /canonicalStatus: 'cancelled'/.test(reconcile) &&
      !/SET order_status = 'cancelled'/.test(reconcile), true);

  const ledger = readFileSync('src/services/fulfillment/webhook-ledger.ts', 'utf8');
  const ledgerMigration = readFileSync('drizzle/0040_webhook_events.sql', 'utf8');
  check('ledger stores payload_hash (not raw payload)', /payload_hash/.test(ledger) && !/raw_body|raw_payload/.test(ledger), true);
  check('ledger schema is migration-owned and readiness-gated',
    /CREATE TABLE IF NOT EXISTS webhook_events/.test(ledgerMigration) &&
      /assertRuntimeSchemaReady/.test(ledger) &&
      !/CREATE TABLE IF NOT EXISTS/.test(ledger), true);

  const env = readFileSync('src/lib/env.ts', 'utf8');
  check('env exposes webhook signing secret', /WEBHOOK_SIGNING_SECRET/.test(env), true);
  check('env exposes unverified policy (default audit_only)', /SHIPPING_SAFETY_UNVERIFIED_POLICY/.test(env), true);
}

// ── UI follow-ups: DTO surfacing, OrdersView gating, print-queue merge exclusion ──
{
  const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
  const ordersReadModel = readFileSync('src/services/orders-read-model.ts', 'utf8');
  check('order DTO surfaces canonicalStatus (list select)', /canonicalStatus:\s*orders\.canonicalStatus/.test(ordersRoute), true);
  check('order DTO surfaces canonicalStatus (detail read-model)',
    /canonicalStatus:\s*stringOrNull\(order\.canonicalStatus\)/.test(ordersReadModel), true);

  const ordersSchema = readFileSync('src/db/schema/orders.ts', 'utf8');
  check('orders schema maps canonicalStatus (read mapping)', /canonicalStatus:\s*text\(\)/.test(ordersSchema), true);

  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  // PS-317: orderShippingHold moved to ./orders/best-rate/rate-request.ts (the DISPLAY mirror of
  // the backend shipping-safety guard, incl. the 'Already shipped in store' / 'Cancelled — label
  // blocked' hold status strings). The OrdersView panelHold call site below stayed.
  const rateRequest = readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');
  const rateHelpers = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
  check('orderShippingHold helper defined (rate-request.ts)', /function orderShippingHold\(/.test(rateRequest), true);
  check('orderShippingHold mirrors the backend hold statuses (already-shipped / cancelled)',
    /Already shipped in store/.test(rateRequest) && /Cancelled — label blocked/.test(rateRequest), true);
  // PS-166/PS-306/PS-258 (Wave 5): the order-detail side panel (which gates the
  // label-action buttons on the hold via `panelHold?.blocked`) was extracted
  // VERBATIM from OrdersView into OrdersDetailSidePanel.tsx. The OrdersView shell
  // still computes the verdict (orderShippingHold(...)) and threads it down as the
  // `panelHold` prop; the gating invariant holds — just at the new leaf owner.
  const detailSidePanel = readFileSync('web/src/components/Views/OrdersDetailSidePanel.tsx', 'utf8');
  check('OrdersView computes the panel shipping-hold verdict', /const panelHold = orderShippingHold\(/.test(ordersView), true);
  check('side panel gates label actions on the hold', /panelHold\?\.blocked/.test(detailSidePanel), true);
  // PS-317: the rate-flow gating (skip rating a held order) moved into buildStrictBestRateRequest
  // in ./orders/best-rate/rate-helpers.ts. The OrdersView shell still threads the verdict via the
  // factory; the gate itself now lives at the request-builder owner.
  check('rate builder skips rating a held order (rate-flow gating)', /orderShippingHold\(order\)\?\.blocked\)\s*return null/.test(rateHelpers), true);
  // PS-166/PS-306/PS-258 (Wave 2): the Best Rate leaf cell (which renders the
  // ⛔ list-row hold pill) was extracted VERBATIM from OrdersView into
  // ./orders/cells/order-cells. The hold-pill invariant still holds — at the new owner.
  const orderCells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
  check('OrdersView shows a list-row hold pill', /rowHold\?\.blocked/.test(orderCells), true);
  // PS-257: the Print Queue drawer (with the per-entry shipping-hold badge) was
  // extracted VERBATIM from OrdersView into OrdersPrintQueueDrawer.tsx. The badge
  // invariant still holds — just at the new owner.
  const printQueueDrawer = readFileSync('web/src/components/Views/OrdersPrintQueueDrawer.tsx', 'utf8');
  check('Print Queue drawer shows hold badge', /entry\.shipping_hold/.test(printQueueDrawer), true);

  const pq = readFileSync('src/services/print-queue.ts', 'utf8');
  check('print-queue merge excludes held orders', /loadShippingHoldsByOrderId/.test(pq), true);
  check('print-queue merge skips held entry (per-entry fail)', /excluded from print batch/.test(pq), true);
  check('print-queue list surfaces shipping_hold to the UI', /shipping_hold:/.test(pq), true);
  check('print-queue exposes shared hold loader', /loadShippingHoldsForOrderIds/.test(pq), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-128/PS-129 upstream shipping safety guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-128/PS-129 upstream shipping safety guard');
