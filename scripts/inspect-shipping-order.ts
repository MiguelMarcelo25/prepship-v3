import { sql } from '../src/db/client';

const READ_ONLY_INSPECTOR = true;

type Args = {
  orderId?: number;
  orderNumber?: string;
  help?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    if (arg === '--order-id') args.orderId = Number(argv[++i]);
    if (arg === '--order-number') args.orderNumber = argv[++i];
  }
  return args;
}

function usage() {
  console.log(`Read-only PrepShip shipping inspector.

Usage:
  npm run inspect:shipping-order -- --order-id <id>
  npm run inspect:shipping-order -- --order-number <orderNumber>

Safety:
  READ_ONLY_INSPECTOR=${READ_ONLY_INSPECTOR}
  Performs SELECT statements only. It never creates labels, buys postage, sends marketplace notifications, or mutates live orders.`);
}

function mask(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}

function providerFromOrder(row: Record<string, unknown>): string {
  const explicit = String(row.source_provider ?? '').trim();
  if (explicit) return explicit;
  const external = String(row.external_order_id ?? '').trim().toLowerCase();
  const match = /^([a-z_]+)-/.exec(external);
  return match?.[1] ?? 'shipstation';
}

function confirmationSupport(provider: string): 'supported' | 'unsupported' | 'unknown' {
  if (provider === 'shipstation' || provider === 'walmart' || provider === 'ebay') return 'supported';
  if (['amazon', 'shopify'].includes(provider)) return 'unsupported';
  return 'unknown';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.orderId && !args.orderNumber) {
    usage();
    process.exitCode = 1;
    return;
  }

  const orderRows = args.orderId
    ? await sql`
        SELECT id, external_order_id, source_provider, source_order_id, client_id, store_id,
               order_number, order_status, canonical_status, ship_to_name, ship_to_city,
               ship_to_state, ship_to_postal_code, weight_oz, carrier_code, service_code,
               raw
        FROM orders
        WHERE id = ${args.orderId}
        LIMIT 1
      ` as Array<Record<string, unknown>>
    : await sql`
        SELECT id, external_order_id, source_provider, source_order_id, client_id, store_id,
               order_number, order_status, canonical_status, ship_to_name, ship_to_city,
               ship_to_state, ship_to_postal_code, weight_oz, carrier_code, service_code,
               raw
        FROM orders
        WHERE order_number = ${args.orderNumber}
        ORDER BY id DESC
        LIMIT 1
      ` as Array<Record<string, unknown>>;

  const order = orderRows[0];
  if (!order) {
    console.log(JSON.stringify({ ok: false, error: 'order_not_found' }, null, 2));
    return;
  }

  const orderId = Number(order.id);
  const shipments = await sql`
    SELECT id, carrier_code, service_code, tracking_number, label_url,
           confirmation_provider, confirmation_status, confirmation_attempts,
           confirmation_last_error, marketplace_confirmed_at, voided, is_return,
           created_at
    FROM shipments
    WHERE order_id = ${orderId}
    ORDER BY id DESC
    LIMIT 10
  ` as Array<Record<string, unknown>>;

  const outbox = await sql`
    SELECT id, shipment_id, provider, status, attempts, last_error, next_run_at, updated_at
    FROM fulfillment_outbox
    WHERE order_id = ${orderId}
    ORDER BY id DESC
    LIMIT 10
  `.catch(() => []) as Array<Record<string, unknown>>;

  const activeShipment = shipments.find((row) => row.voided !== true && row.is_return !== true);
  const provider = providerFromOrder(order);
  const hasShipTo = Boolean(order.ship_to_name && order.ship_to_city && order.ship_to_state && order.ship_to_postal_code);
  const weightOz = Number(order.weight_oz ?? 0);
  const retrySafe = order.order_status === 'awaiting_shipment' && !activeShipment;

  console.log(JSON.stringify({
    ok: true,
    readOnly: READ_ONLY_INSPECTOR,
    order: {
      orderId,
      orderNumber: order.order_number,
      orderStatus: order.order_status,
      canonicalStatus: order.canonical_status ?? null,
      provider,
      confirmationSupport: confirmationSupport(provider),
      externalOrderId: order.external_order_id ?? null,
      sourceOrderId: order.source_order_id ?? null,
      clientId: order.client_id ?? null,
      storeId: order.store_id ?? null,
      shipToComplete: hasShipTo,
      weight: { present: weightOz > 0, weightOz: weightOz || null },
      selectedCarrier: {
        carrierCode: order.carrier_code ?? null,
        serviceCode: order.service_code ?? null,
      },
    },
    duplicateActiveLabelRisk: Boolean(activeShipment),
    retryingLabelCreationAppearsSafe: retrySafe,
    shipments: shipments.map((row) => ({
      id: row.id,
      carrierCode: row.carrier_code,
      serviceCode: row.service_code,
      trackingNumber: mask(row.tracking_number),
      hasLabelUrl: Boolean(row.label_url),
      confirmationProvider: row.confirmation_provider,
      confirmationStatus: row.confirmation_status,
      confirmationAttempts: row.confirmation_attempts,
      confirmationLastError: row.confirmation_last_error,
      marketplaceConfirmedAt: row.marketplace_confirmed_at,
      voided: row.voided,
      isReturn: row.is_return,
      createdAt: row.created_at,
    })),
    fulfillmentOutbox: outbox.map((row) => ({
      id: row.id,
      shipmentId: row.shipment_id,
      provider: row.provider,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRunAt: row.next_run_at,
      updatedAt: row.updated_at,
    })),
    warnings: [
      activeShipment ? 'duplicate active label risk: do not create another label until reviewed' : null,
      !hasShipTo ? 'ship-to fields are incomplete' : null,
      weightOz <= 0 ? 'weight is missing or zero' : null,
      confirmationSupport(provider) !== 'supported' ? `marketplace confirmation support is ${confirmationSupport(provider)}` : null,
    ].filter(Boolean),
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
