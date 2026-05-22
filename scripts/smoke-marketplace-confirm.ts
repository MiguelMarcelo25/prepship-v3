import { sql } from '../src/db/client';

const READ_ONLY_BY_DEFAULT = true;

function usage() {
  console.log(`Marketplace confirmation smoke inspector.

Usage:
  npm run smoke:marketplace-confirm -- --order-id <id>
  npm run smoke:marketplace-confirm -- --mock-process-once

Safety:
  READ_ONLY_BY_DEFAULT=${READ_ONLY_BY_DEFAULT}
  By default this only reads fulfillment_outbox/shipments state.
  --mock-process-once runs an in-memory fixture only; it never calls live marketplaces.`);
}

function support(provider: string): 'supported' | 'unsupported' | 'unknown' {
  if (provider === 'shipstation' || provider === 'walmart' || provider === 'ebay') return 'supported';
  if (provider === 'amazon' || provider === 'shopify') return 'unsupported';
  return 'unknown';
}

async function mockProcessOnce() {
  const row = {
    id: 1,
    provider: 'ebay',
    status: 'pending',
    attempts: 0,
    retrySafe: true,
  };
  console.log(JSON.stringify({
    ok: true,
    mockOnly: true,
    processed: 1,
    before: row,
    after: { ...row, status: 'succeeded', attempts: 1 },
    liveMarketplaceCalled: false,
  }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  if (argv.includes('--process-once')) {
    console.error('Refusing live processing. Use --mock-process-once for the fixture-only path, or coordinate exact live-order testing with DJ manually.');
    process.exitCode = 2;
    return;
  }
  if (argv.includes('--mock-process-once')) {
    await mockProcessOnce();
    return;
  }

  const orderIdArg = argv[argv.indexOf('--order-id') + 1];
  const shipmentIdArg = argv[argv.indexOf('--shipment-id') + 1];
  const orderId = Number(orderIdArg);
  const shipmentId = Number(shipmentIdArg);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const outbox = await sql`
    SELECT id, order_id, shipment_id, provider, status, attempts, last_error, next_run_at, updated_at
    FROM fulfillment_outbox
    WHERE order_id = ${Math.trunc(orderId)}
      ${Number.isFinite(shipmentId) && shipmentId > 0 ? sql`AND shipment_id = ${Math.trunc(shipmentId)}` : sql``}
    ORDER BY id DESC
    LIMIT 20
  `.catch(() => []) as Array<Record<string, unknown>>;

  const shipments = await sql`
    SELECT id, confirmation_provider, confirmation_status, confirmation_attempts,
           confirmation_last_error, marketplace_confirmed_at
    FROM shipments
    WHERE order_id = ${Math.trunc(orderId)}
      ${Number.isFinite(shipmentId) && shipmentId > 0 ? sql`AND id = ${Math.trunc(shipmentId)}` : sql``}
    ORDER BY id DESC
    LIMIT 20
  ` as Array<Record<string, unknown>>;

  console.log(JSON.stringify({
    ok: true,
    readOnly: READ_ONLY_BY_DEFAULT,
    orderId,
    shipmentId: Number.isFinite(shipmentId) && shipmentId > 0 ? shipmentId : null,
    outbox: outbox.map((row) => ({
      id: row.id,
      shipmentId: row.shipment_id,
      provider: row.provider,
      providerSupport: support(String(row.provider ?? '')),
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRunAt: row.next_run_at,
      retrySafety: row.status === 'pending' || row.status === 'failed' ? 'inspect_before_manual_retry' : 'not_retryable_from_current_state',
    })),
    shipments: shipments.map((row) => ({
      id: row.id,
      confirmationProvider: row.confirmation_provider,
      providerSupport: support(String(row.confirmation_provider ?? '')),
      confirmationStatus: row.confirmation_status,
      attempts: row.confirmation_attempts,
      lastError: row.confirmation_last_error,
      marketplaceConfirmedAt: row.marketplace_confirmed_at,
    })),
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
