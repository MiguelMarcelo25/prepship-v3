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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rawOrderLines(rawOrder: unknown): string[] {
  const record = asRecord(rawOrder);
  const orderLines = asRecord(record?.orderLines)?.orderLine;
  return Array.isArray(orderLines)
    ? orderLines
        .map((line) => String(asRecord(line)?.lineNumber ?? '').trim())
        .filter(Boolean)
    : [];
}

function rawPurchaseOrderId(rawOrder: unknown): string | null {
  const text = String(asRecord(rawOrder)?.purchaseOrderId ?? '').trim();
  return text || null;
}

function rawCustomerOrderId(rawOrder: unknown): string | null {
  const text = String(asRecord(rawOrder)?.customerOrderId ?? '').trim();
  return text || null;
}

function rawMethodCode(rawOrder: unknown): string | null {
  const method = asRecord(asRecord(rawOrder)?.shippingInfo)?.methodCode;
  const text = typeof method === 'string' ? method.trim() : '';
  return text || null;
}

function outboxPayloadSummary(payload: unknown) {
  const record = asRecord(payload) ?? {};
  const rawOrder = record.rawOrder;
  return {
    keys: Object.keys(record).sort(),
    purchaseOrderId: typeof record.purchaseOrderId === 'string' ? record.purchaseOrderId : null,
    rawPurchaseOrderId: rawPurchaseOrderId(rawOrder),
    rawCustomerOrderId: rawCustomerOrderId(rawOrder),
    rawOrderLineCount: rawOrderLines(rawOrder).length,
    lineNumbers: rawOrderLines(rawOrder),
    carrierName: typeof record.carrierName === 'string' ? record.carrierName : null,
    serviceCode: typeof record.serviceCode === 'string' ? record.serviceCode : null,
    methodCode: rawMethodCode(rawOrder),
    trackingNumber: mask(record.trackingNumber),
    trackingUrlPresent: typeof record.trackingUrl === 'string' && record.trackingUrl.trim().length > 0,
  };
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

  const storeOrderRowsForLookup = async (lookup: string) => sql`
    SELECT provider, external_order_id, customer_order_id, carrier_account_id,
           source_status, shipment_status, tracking_number, raw, updated_at
    FROM store_orders
    WHERE provider = 'walmart'
      AND (
        external_order_id = ${lookup}
        OR customer_order_id = ${lookup}
        OR raw->>'purchaseOrderId' = ${lookup}
        OR raw->>'customerOrderId' = ${lookup}
      )
    ORDER BY updated_at DESC
    LIMIT 10
  `.catch(() => []) as Promise<Array<Record<string, unknown>>>;

  const summarizeStoreOrders = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
    provider: row.provider,
    externalOrderId: row.external_order_id,
    customerOrderId: row.customer_order_id,
    carrierAccountId: row.carrier_account_id,
    sourceStatus: row.source_status,
    shipmentStatus: row.shipment_status,
    trackingNumber: mask(row.tracking_number),
    hasRaw: Boolean(row.raw),
    rawPurchaseOrderId: rawPurchaseOrderId(row.raw),
    rawCustomerOrderId: rawCustomerOrderId(row.raw),
    rawOrderLineCount: rawOrderLines(row.raw).length,
    lineNumbers: rawOrderLines(row.raw),
    methodCode: rawMethodCode(row.raw),
    updatedAt: row.updated_at,
  }));

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
    const lookup = String(args.orderNumber ?? '').trim();
    const storeOrders = lookup ? await storeOrderRowsForLookup(lookup) : [];
    console.log(JSON.stringify({
      ok: false,
      error: 'order_not_found',
      readOnly: READ_ONLY_INSPECTOR,
      lookup,
      storeOrders: summarizeStoreOrders(storeOrders),
      note: storeOrders.length
        ? 'No PrepShip order matched this value directly, but Walmart store_orders rows did match.'
        : 'No PrepShip order or Walmart store_orders rows matched this value.',
    }, null, 2));
    return;
  }

  const orderId = Number(order.id);
  const orderRaw = order.raw;
  const lookupA = String(order.order_number ?? '').trim();
  const lookupB = String(order.external_order_id ?? '').trim().replace(/^walmart-/, '');
  const lookupC = String(order.source_order_id ?? '').trim().replace(/^walmart-/, '');
  const lookupD = rawPurchaseOrderId(orderRaw) ?? '';

  const storeOrders = await sql`
    SELECT provider, external_order_id, customer_order_id, carrier_account_id,
           source_status, shipment_status, tracking_number, raw, updated_at
    FROM store_orders
    WHERE provider = 'walmart'
      AND (
        external_order_id IN (${lookupA}, ${lookupB}, ${lookupC}, ${lookupD})
        OR customer_order_id IN (${lookupA}, ${lookupB}, ${lookupC}, ${lookupD})
        OR raw->>'purchaseOrderId' IN (${lookupA}, ${lookupB}, ${lookupC}, ${lookupD})
        OR raw->>'customerOrderId' IN (${lookupA}, ${lookupB}, ${lookupC}, ${lookupD})
      )
    ORDER BY updated_at DESC
    LIMIT 10
  `.catch(() => []) as Array<Record<string, unknown>>;

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
    SELECT id, shipment_id, provider, status, attempts, last_error, next_run_at, updated_at, payload
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
      rawSummary: {
        hasRaw: Boolean(orderRaw),
        purchaseOrderId: rawPurchaseOrderId(orderRaw),
        customerOrderId: rawCustomerOrderId(orderRaw),
        rawOrderLineCount: rawOrderLines(orderRaw).length,
        lineNumbers: rawOrderLines(orderRaw),
        methodCode: rawMethodCode(orderRaw),
      },
    },
    storeOrders: summarizeStoreOrders(storeOrders),
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
      payload: outboxPayloadSummary(row.payload),
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
