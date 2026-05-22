import { sql } from '../src/db/client';

const READ_ONLY_PREFLIGHT = true;

function usage() {
  console.log(`Read-only shipping preflight.

Usage:
  npm run smoke:shipping:preflight -- --order-id <id>

Safety:
  READ_ONLY_PREFLIGHT=${READ_ONLY_PREFLIGHT}
  SELECT-only. Does not create labels, buy postage, send marketplace notifications, or mutate live orders.`);
}

function providerFromExternalId(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^([a-z_]+)-/.exec(text);
  return match?.[1] ?? 'shipstation';
}

function confirmationSupport(provider: string): 'supported' | 'unsupported' | 'unknown' {
  if (provider === 'shipstation' || provider === 'walmart' || provider === 'ebay') return 'supported';
  if (['amazon', 'shopify'].includes(provider)) return 'unsupported';
  return 'unknown';
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  const orderIdArg = argv[argv.indexOf('--order-id') + 1];
  const orderId = Number(orderIdArg);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const rows = await sql`
    SELECT id, external_order_id, source_provider, client_id, store_id, order_number,
           order_status, ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code,
           weight_oz, carrier_code, service_code
    FROM orders
    WHERE id = ${Math.trunc(orderId)}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const order = rows[0];
  if (!order) {
    console.log(JSON.stringify({ ok: false, readOnly: READ_ONLY_PREFLIGHT, error: 'order_not_found' }, null, 2));
    return;
  }

  const activeShipments = await sql`
    SELECT id FROM shipments
    WHERE order_id = ${Math.trunc(orderId)}
      AND COALESCE(voided, false) = false
      AND COALESCE(is_return, false) = false
    LIMIT 1
  ` as Array<{ id: number }>;

  const provider = String(order.source_provider ?? '').trim() || providerFromExternalId(order.external_order_id);
  const status = String(order.order_status ?? '');
  const terminal = status === 'shipped' || status === 'cancelled';
  const hasShipTo = Boolean(order.ship_to_name && order.ship_to_city && order.ship_to_state && order.ship_to_postal_code);
  const hasWeight = Number(order.weight_oz ?? 0) > 0;
  const hasClientStore = order.client_id != null && order.store_id != null;
  const hasCarrierHint = Boolean(order.carrier_code || order.service_code);

  const failures = [
    status !== 'awaiting_shipment' ? `order_status is ${status}, expected awaiting_shipment` : null,
    terminal ? 'order is shipped/cancelled and protected from automated tests' : null,
    activeShipments.length ? 'active non-void shipment already exists' : null,
    !hasShipTo ? 'ship-to fields are incomplete' : null,
    !hasWeight ? 'weight is missing or zero' : null,
    !hasClientStore ? 'client/store mapping is incomplete' : null,
  ].filter(Boolean);

  console.log(JSON.stringify({
    ok: failures.length === 0,
    readOnly: READ_ONLY_PREFLIGHT,
    orderId: order.id,
    orderNumber: order.order_number,
    provider,
    status,
    checks: {
      awaitingShipment: status === 'awaiting_shipment',
      notShippedOrCancelled: !terminal,
      noActiveShipment: activeShipments.length === 0,
      shipToComplete: hasShipTo,
      weightPresent: hasWeight,
      clientStorePresent: hasClientStore,
      carrierAccountOrServiceKnown: hasCarrierHint ? 'known_from_order' : 'requires_rate_or_account_lookup',
      marketplaceConfirmSupported: confirmationSupport(provider),
    },
    failures,
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
