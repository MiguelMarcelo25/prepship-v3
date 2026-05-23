import { sql } from '../src/db/client';
import { processFulfillmentOutboxById } from '../src/services/fulfillment/outbox';

type OutboxAuditRow = {
  outbox_id: number;
  outbox_order_id: number;
  outbox_shipment_id: number | null;
  provider: string;
  status: string;
  attempts: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  order_number: string | null;
  order_status: string | null;
  canonical_status: string | null;
  shipment_confirmation_status: string | null;
  marketplace_confirmed_at: string | null;
};

function usage() {
  console.log(`Gated marketplace confirmation retry.

Usage:
  npm run marketplace:confirm:retry -- --outbox-id <id> --dry-run
  npm run marketplace:confirm:retry -- --outbox-id <id> --order-number <orderNumber> --shipment-id <id> --provider walmart --live-approved

Safety:
  - dry-run is the default and performs read-only inspection only
  - live retry requires --live-approved and exact --outbox-id
  - this command is scoped to Walmart confirmations only
  - it does not create labels, buy postage, void labels, or mutate orders directly`);
}

function argValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
}

function maskTracking(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function rawOrderLines(rawOrder: unknown): string[] {
  const orderLines = Array.isArray((rawOrder as any)?.orderLines?.orderLine)
    ? (rawOrder as any).orderLines.orderLine
    : [];
  return orderLines
    .map((line: any) => String(line?.lineNumber ?? '').trim())
    .filter(Boolean);
}

function payloadSummary(payload: Record<string, unknown>) {
  const lines = rawOrderLines(payload.rawOrder);
  return {
    keys: Object.keys(payload).sort(),
    purchaseOrderId: typeof payload.purchaseOrderId === 'string' ? payload.purchaseOrderId : null,
    customerOrderId: typeof (payload.rawOrder as any)?.customerOrderId === 'string'
      ? (payload.rawOrder as any).customerOrderId
      : null,
    rawPurchaseOrderId: typeof (payload.rawOrder as any)?.purchaseOrderId === 'string'
      ? (payload.rawOrder as any).purchaseOrderId
      : null,
    rawOrderLineCount: lines.length,
    lineNumbers: lines,
    carrierName: typeof payload.carrierName === 'string' ? payload.carrierName : null,
    methodCode: typeof (payload.rawOrder as any)?.shippingInfo?.methodCode === 'string'
      ? (payload.rawOrder as any).shippingInfo.methodCode
      : null,
    trackingNumber: maskTracking(payload.trackingNumber),
    trackingUrlPresent: typeof payload.trackingUrl === 'string' && payload.trackingUrl.trim().length > 0,
  };
}

function assertRetrySafe(row: OutboxAuditRow, expected: {
  orderNumber?: string;
  shipmentId?: number;
  provider: string;
}) {
  if (row.provider !== expected.provider) {
    throw new Error(`Refusing retry: provider ${row.provider} does not match ${expected.provider}`);
  }
  const provider = row.provider;
  if (provider !== 'walmart') {
    throw new Error('Refusing retry: only Walmart marketplace confirmations are supported by this live command');
  }
  if (row.status === 'succeeded') {
    throw new Error('Refusing retry: outbox row already succeeded');
  }
  if (expected.orderNumber && row.order_number !== expected.orderNumber) {
    throw new Error(`Refusing retry: order number mismatch (${row.order_number ?? 'missing'})`);
  }
  if (expected.shipmentId && row.outbox_shipment_id !== expected.shipmentId) {
    throw new Error(`Refusing retry: shipment id mismatch (${row.outbox_shipment_id ?? 'missing'})`);
  }
  const purchaseOrderId = String(row.payload?.purchaseOrderId ?? '').trim();
  if (!purchaseOrderId) {
    throw new Error('Refusing retry: missing Walmart purchaseOrderId');
  }
  const lineNumbers = rawOrderLines(row.payload?.rawOrder);
  if (!lineNumbers.length) {
    throw new Error('Refusing retry: missing Walmart order line numbers');
  }
  const trackingNumber = String(row.payload?.trackingNumber ?? '').trim();
  if (!trackingNumber) {
    throw new Error('Refusing retry: missing tracking number');
  }
}

async function loadOutboxRow(outboxId: number): Promise<OutboxAuditRow | null> {
  const rows = await sql`
    SELECT
      fo.id AS outbox_id,
      fo.order_id AS outbox_order_id,
      fo.shipment_id AS outbox_shipment_id,
      fo.provider,
      fo.status,
      fo.attempts,
      fo.last_error,
      fo.payload,
      o.order_number,
      o.order_status,
      o.canonical_status,
      s.confirmation_status AS shipment_confirmation_status,
      s.marketplace_confirmed_at
    FROM fulfillment_outbox fo
    LEFT JOIN orders o ON o.id = fo.order_id
    LEFT JOIN shipments s ON s.id = fo.shipment_id
    WHERE fo.id = ${outboxId}
    LIMIT 1
  ` as OutboxAuditRow[];
  return rows[0] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const outboxId = Number(argValue(argv, '--outbox-id'));
  const shipmentIdArg = Number(argValue(argv, '--shipment-id'));
  const expectedShipmentId = Number.isFinite(shipmentIdArg) && shipmentIdArg > 0 ? Math.trunc(shipmentIdArg) : undefined;
  const orderNumber = argValue(argv, '--order-number') || undefined;
  const provider = argValue(argv, '--provider') || 'walmart';
  const liveApproved = argv.includes('--live-approved');
  const dryRun = argv.includes('--dry-run') || !liveApproved;

  if (!Number.isFinite(outboxId) || outboxId <= 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const before = await loadOutboxRow(Math.trunc(outboxId));
  if (!before) {
    throw new Error(`No fulfillment_outbox row found for id ${outboxId}`);
  }

  assertRetrySafe(before, {
    orderNumber,
    shipmentId: expectedShipmentId,
    provider,
  });

  const audit = {
    outboxId: before.outbox_id,
    orderId: before.outbox_order_id,
    orderNumber: before.order_number,
    orderStatus: before.order_status,
    canonicalStatus: before.canonical_status,
    shipmentId: before.outbox_shipment_id,
    provider: before.provider,
    status: before.status,
    attempts: before.attempts,
    lastError: before.last_error,
    shipmentConfirmationStatus: before.shipment_confirmation_status,
    marketplaceConfirmedAt: before.marketplace_confirmed_at,
    payload: payloadSummary(before.payload ?? {}),
  };

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      liveMarketplaceCalled: false,
      readyForLiveRetry: true,
      audit,
      nextCommand: `npm run marketplace:confirm:retry -- --outbox-id ${before.outbox_id} --order-number ${before.order_number ?? '<orderNumber>'} --shipment-id ${before.outbox_shipment_id ?? '<shipmentId>'} --provider walmart --live-approved`,
    }, null, 2));
    return;
  }

  const result = await processFulfillmentOutboxById({
    outboxId: before.outbox_id,
    orderId: before.outbox_order_id,
    shipmentId: before.outbox_shipment_id ?? undefined,
    provider: 'walmart',
  });
  const after = await loadOutboxRow(before.outbox_id);

  console.log(JSON.stringify({
    ok: result.succeeded === 1,
    dryRun: false,
    liveMarketplaceCalled: true,
    before: audit,
    result,
    after: after ? {
      outboxId: after.outbox_id,
      orderId: after.outbox_order_id,
      orderNumber: after.order_number,
      shipmentId: after.outbox_shipment_id,
      provider: after.provider,
      status: after.status,
      attempts: after.attempts,
      lastError: after.last_error,
      shipmentConfirmationStatus: after.shipment_confirmation_status,
      marketplaceConfirmedAt: after.marketplace_confirmed_at,
      payload: payloadSummary(after.payload ?? {}),
    } : null,
  }, null, 2));

  if (result.succeeded !== 1) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });
