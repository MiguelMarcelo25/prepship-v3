import { performance } from 'node:perf_hooks';
import { sql } from '../src/db/client';

const LIVE_LABEL_APPROVAL_REQUIRED = true;
const TOKEN_ENV = 'PREPSHIP_LIVE_LABEL_BEARER_TOKEN';

type Row = Record<string, unknown>;

function usage() {
  console.log(`Real-label shipping certification smoke.

Usage:
  npm run smoke:shipping:real-label -- --order-id <approved-test-order> --live-approved --api-base <url>

Required live gates:
  --order-id <id>       Explicit approved test order id.
  --live-approved      Human approval for this exact live label attempt.
  --api-base <url>     PrepShip API base URL, or PREPSHIP_API_BASE_URL.
  ${TOKEN_ENV}         Optional bearer token if the API requires auth.

Safety:
  LIVE_LABEL_APPROVAL_REQUIRED=${LIVE_LABEL_APPROVAL_REQUIRED}
  No secrets, PII, raw labels, or provider payloads are printed.
  Refuses shipped/cancelled orders.
  Refuses orders with an active non-void label.
  Refuses to run without explicit DJ/live approval for the exact order.`);
}

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function mask(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length <= 6) return '***';
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function providerFromExternalId(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^([a-z_]+)-/.exec(text);
  return match?.[1] ?? 'shipstation';
}

function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = String(process.env[TOKEN_ENV] ?? '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function safeUrl(base: string, path: string): string {
  return new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`).toString();
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; data: Row }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: Row = {};
  try {
    data = text ? JSON.parse(text) as Row : {};
  } catch {
    data = { error: `non_json_response_status_${res.status}` };
  }
  if (!res.ok) {
    const message = String(data.error ?? data.message ?? `HTTP ${res.status}`);
    throw new Error(message);
  }
  return { status: res.status, data };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const orderId = Number(argValue(argv, '--order-id'));
  const liveApproved = argv.includes('--live-approved');
  const apiBase = String(argValue(argv, '--api-base') ?? process.env.PREPSHIP_API_BASE_URL ?? '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!liveApproved) {
    console.error('LIVE_LABEL_APPROVAL_REQUIRED: refusing real-label smoke without --live-approved for this exact approved test order.');
    process.exitCode = 2;
    return;
  }
  if (!apiBase) {
    console.error('LIVE_LABEL_APPROVAL_REQUIRED: refusing real-label smoke without --api-base or PREPSHIP_API_BASE_URL.');
    process.exitCode = 2;
    return;
  }

  const timings: Record<string, number> = {};
  const totalStart = performance.now();
  const loadStart = performance.now();
  const rows = await sql`
    SELECT id, order_number, order_status, canonical_status, external_order_id,
           source_provider, client_id, store_id, weight_oz, carrier_code,
           service_code, package_code
    FROM orders
    WHERE id = ${Math.trunc(orderId)}
    LIMIT 1
  ` as Row[];
  const order = rows[0];
  timings.orderLoadMs = elapsed(loadStart);
  if (!order) {
    console.log(JSON.stringify({ ok: false, error: 'order_not_found', orderId }, null, 2));
    return;
  }

  const status = String(order.order_status ?? '');
  if (status === 'shipped' || status === 'cancelled') {
    throw new Error('Cannot create label for shipped/cancelled order');
  }
  if (status !== 'awaiting_shipment') {
    throw new Error(`Cannot create label for order_status ${status}; expected awaiting_shipment`);
  }

  // Per user override unlock shipped data on 2026-05-23: PS-016 reads shipments only to block duplicate live postage.
  const existingStart = performance.now();
  const activeShipments = await sql`
    SELECT id, tracking_number, label_url
    FROM shipments
    WHERE order_id = ${Math.trunc(orderId)}
      AND COALESCE(voided, false) = false
      AND COALESCE(is_return, false) = false
    LIMIT 1
  ` as Row[];
  timings.duplicateCheckMs = elapsed(existingStart);
  if (activeShipments.length) {
    throw new Error('Label already exists for this order');
  }

  const serviceCode = String(argValue(argv, '--service-code') ?? order.service_code ?? '').trim();
  if (!serviceCode) {
    throw new Error('serviceCode is required; pass --service-code or select a service on the order first');
  }
  const shippingProviderIdText = argValue(argv, '--shipping-provider-id');
  const shippingProviderId = shippingProviderIdText ? Number(shippingProviderIdText) : null;

  const payload: Row = {
    orderId: Math.trunc(orderId),
    orderNumber: order.order_number,
    carrierCode: String(argValue(argv, '--carrier-code') ?? order.carrier_code ?? '').trim() || undefined,
    serviceCode,
    packageCode: String(argValue(argv, '--package-code') ?? order.package_code ?? '').trim() || undefined,
    weightOz: Number(argValue(argv, '--weight-oz') ?? order.weight_oz ?? 0) || undefined,
  };
  if (Number.isFinite(shippingProviderId) && Number(shippingProviderId) > 0) {
    payload.shippingProviderId = Math.trunc(Number(shippingProviderId));
  }

  const createStart = performance.now();
  const create = await fetchJson(safeUrl(apiBase, '/labels'), {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  timings.labelCreateMs = elapsed(createStart);

  const shipmentId = Number(create.data.shipmentId ?? create.data.id);
  const trackingNumber = String(create.data.trackingNumber ?? '').trim();
  const labelUrl = String(create.data.labelUrl ?? '').trim();
  if (!Number.isFinite(shipmentId) || shipmentId <= 0 || !trackingNumber || !labelUrl) {
    throw new Error('label endpoint returned success but missing shipmentId/trackingNumber/labelUrl');
  }

  const persistenceStart = performance.now();
  const shipmentRows = await sql`
    SELECT id, order_id, tracking_number, label_url, confirmation_provider,
           confirmation_status, marketplace_confirmed_at
    FROM shipments
    WHERE id = ${Math.trunc(shipmentId)}
    LIMIT 1
  ` as Row[];
  const orderRows = await sql`
    SELECT id, order_status, canonical_status
    FROM orders
    WHERE id = ${Math.trunc(orderId)}
    LIMIT 1
  ` as Row[];
  timings.persistenceCheckMs = elapsed(persistenceStart);
  const persisted = shipmentRows[0];
  if (!persisted) throw new Error('label created but shipment row was not found');

  const retrieveStart = performance.now();
  const retrieve = await fetchJson(safeUrl(apiBase, `/labels/${encodeURIComponent(String(shipmentId))}/retrieve`), {
    method: 'GET',
    headers: jsonHeaders(),
  });
  timings.labelRetrieveMs = elapsed(retrieveStart);

  const outboxStart = performance.now();
  const outboxRows = await sql`
    SELECT id, provider, status, attempts, last_error, next_run_at
    FROM fulfillment_outbox
    WHERE order_id = ${Math.trunc(orderId)}
      AND shipment_id = ${Math.trunc(shipmentId)}
    ORDER BY id DESC
    LIMIT 10
  ` as Row[];
  timings.outboxCheckMs = elapsed(outboxStart);
  timings.totalMs = elapsed(totalStart);

  console.log(JSON.stringify({
    ok: true,
    liveApproved,
    apiStatus: create.status,
    orderId,
    orderNumber: order.order_number,
    provider: String(order.source_provider ?? '').trim() || providerFromExternalId(order.external_order_id),
    shipmentId,
    trackingNumber: mask(trackingNumber),
    hasLabelUrl: Boolean(labelUrl),
    retrieveHasLabelUrl: Boolean(retrieve.data.labelUrl ?? retrieve.data.url ?? retrieve.data.href),
    orderStatusAfter: orderRows[0]?.order_status ?? null,
    canonicalStatusAfter: orderRows[0]?.canonical_status ?? null,
    shipment: {
      id: persisted.id,
      trackingNumber: mask(persisted.tracking_number),
      hasLabelUrl: Boolean(persisted.label_url),
      confirmationProvider: persisted.confirmation_provider,
      confirmationStatus: persisted.confirmation_status,
      marketplaceConfirmedAt: persisted.marketplace_confirmed_at,
    },
    fulfillmentOutbox: outboxRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      attempts: row.attempts,
      hasLastError: Boolean(row.last_error),
      nextRunAt: row.next_run_at,
    })),
    timings,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });
