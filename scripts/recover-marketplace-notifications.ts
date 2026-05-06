/**
 * One-shot recovery script for the marketplace-notification bug.
 *
 * BACKGROUND
 * ──────────
 * Until 2026-05-07, every label created via PrepShip v4 was hitting
 * ShipStation's `/orders/markasshipped` v1 endpoint with the WRONG
 * orderId (the local DB autoincrement PK instead of the upstream
 * ShipStation orderId stored in `orders.external_order_id`). The v1
 * endpoint returned 404 for every call, the inner client silently
 * swallowed the error, and the marketplace was never notified.
 *
 * The fix is in place for new labels, but historical orders that were
 * shipped through PrepShip during the bug window need a manual ack to
 * ShipStation so their marketplaces (Amazon, eBay, Walmart, etc.)
 * finally receive the tracking number.
 *
 * USAGE
 * ─────
 *   # Single order (by orderNumber, the marketplace-facing ID):
 *   tsx scripts/recover-marketplace-notifications.ts 111-4349324-2899466
 *
 *   # Multiple orders:
 *   tsx scripts/recover-marketplace-notifications.ts \
 *     111-4349324-2899466 \
 *     112-6551875-5121844 \
 *     OTHER-ORDER-ID
 *
 *   # Or pipe a list (one orderNumber per line):
 *   cat stuck-orders.txt | xargs tsx scripts/recover-marketplace-notifications.ts
 *
 * SAFETY
 * ──────
 * - Only acts on orders that already have a shipment row + tracking
 * - Never creates a new label / spends postage
 * - Never modifies the orders table (the orders are already 'shipped')
 * - Idempotent: ShipStation accepts re-acks (no double-charging)
 *
 * Requires DATABASE_URL, SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET
 * (or per-client credentials in the clients table).
 */

import { eq, desc } from 'drizzle-orm';
import { db } from '../src/db';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { ssMarkOrderShippedV1 } from '../src/lib/shipstation/labels';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';

async function recoverOne(orderNumber: string): Promise<{ ok: boolean; reason?: string }> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);

  if (!order) {
    return { ok: false, reason: `orderNumber=${orderNumber} not found in DB` };
  }
  if (!order.externalOrderId) {
    return {
      ok: false,
      reason: `orderNumber=${orderNumber} has no externalOrderId (manual order or sync gap)`,
    };
  }
  const ssOrderId = Number(order.externalOrderId);
  if (!Number.isFinite(ssOrderId)) {
    return {
      ok: false,
      reason: `orderNumber=${orderNumber} externalOrderId="${order.externalOrderId}" is not a valid number`,
    };
  }

  // Find the most recent non-voided shipment for this order
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, order.id))
    .orderBy(desc(shipments.createdAt))
    .limit(1);

  if (!shipment) {
    return { ok: false, reason: `no shipment row for orderNumber=${orderNumber}` };
  }
  if (shipment.voided) {
    return { ok: false, reason: `shipment ${shipment.id} is voided — skipping` };
  }
  if (!shipment.trackingNumber) {
    return { ok: false, reason: `shipment ${shipment.id} has no tracking number` };
  }

  if (!order.clientId) {
    return { ok: false, reason: `order has no clientId — can't load ShipStation creds` };
  }
  const creds = await loadClientCredentials(order.clientId);
  if (!creds.apiKey || !creds.apiSecret) {
    return { ok: false, reason: `client ${order.clientId} has no v1 ShipStation API credentials` };
  }

  const shipDate =
    shipment.shipDate?.toISOString().slice(0, 10) ??
    shipment.labelShipDate?.toISOString().slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  console.log(
    `▶ Recovering ${orderNumber}: ssOrderId=${ssOrderId}, tracking=${shipment.trackingNumber}, carrier=${shipment.carrierCode}, shipDate=${shipDate}`
  );

  try {
    await ssMarkOrderShippedV1(
      {
        orderId: ssOrderId,
        carrierCode: shipment.carrierCode,
        trackingNumber: shipment.trackingNumber,
        shipDate,
      },
      { apiKey: creds.apiKey, apiSecret: creds.apiSecret }
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `ssMarkOrderShippedV1 threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function main() {
  const orderNumbers = process.argv.slice(2);
  if (orderNumbers.length === 0) {
    console.error('Usage: tsx scripts/recover-marketplace-notifications.ts <orderNumber1> [<orderNumber2> …]');
    process.exit(1);
  }

  console.log(`Recovering ${orderNumbers.length} order(s)…\n`);
  let okCount = 0;
  let failCount = 0;

  for (const orderNumber of orderNumbers) {
    const result = await recoverOne(orderNumber);
    if (result.ok) {
      console.log(`  ✅ ${orderNumber} — marketplace will be notified by ShipStation`);
      okCount += 1;
    } else {
      console.log(`  ❌ ${orderNumber} — ${result.reason}`);
      failCount += 1;
    }
    // Small spacing between calls to avoid hammering v1 (40 req/min limit
    // is shared across the whole API server; the v1 client also rate-limits).
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`\nDone. OK: ${okCount}  Failed: ${failCount}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
