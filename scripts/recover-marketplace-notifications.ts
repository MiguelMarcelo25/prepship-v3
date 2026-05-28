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
 * USAGE (from Render Shell — env vars already configured)
 * ───────────────────────────────────────────────────────
 *   # By marketplace order numbers (Amazon-style):
 *   tsx scripts/recover-marketplace-notifications.ts \
 *     order:111-4349324-2899466 \
 *     order:112-6551875-5121844
 *
 *   # By ShipStation shipment IDs (the "Shipment #" column in SS UI):
 *   tsx scripts/recover-marketplace-notifications.ts \
 *     ssshipment:284049105 \
 *     ssshipment:284048333 \
 *     ssshipment:284045509
 *
 *   # Both can be mixed:
 *   tsx scripts/recover-marketplace-notifications.ts \
 *     order:111-4349324-2899466 \
 *     ssshipment:284049105
 *
 *   # Bare numbers (>= 100000000) → treated as ssShipmentIds
 *   # Bare strings with letters/dashes → treated as orderNumbers
 *   tsx scripts/recover-marketplace-notifications.ts \
 *     111-4349324-2899466 \
 *     284049105
 *
 * SAFETY
 * ──────
 * - Only acts on orders that already have a shipment row + tracking
 * - Never creates a new label / spends postage
 * - Never modifies the orders table (the orders are already 'shipped')
 * - Idempotent: ShipStation accepts re-acks (no double-charging)
 *
 * Per user override `unlock shipped data` on 2026-05-07.
 */

import { eq, desc, inArray, and } from 'drizzle-orm';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { ssMarkOrderShippedV1, asSSUpstreamOrderId } from '../src/lib/shipstation/labels';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';

type Result = { label: string; ok: boolean; reason?: string };

async function recoverByOrderNumber(orderNumber: string): Promise<Result> {
  const label = `orderNumber=${orderNumber}`;
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);

  if (!order) return { label, ok: false, reason: 'order not found in DB' };
  return ackOrder(label, order);
}

async function recoverBySsShipmentId(ssShipmentId: number): Promise<Result> {
  const label = `ssShipmentId=${ssShipmentId}`;
  const [row] = await db
    .select({ orderRow: orders })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.labelShipmentId, ssShipmentId))
    .limit(1);

  if (!row) return { label, ok: false, reason: 'no shipment row matched this SS shipmentId in PrepShip DB' };
  return ackOrder(label, row.orderRow);
}

async function ackOrder(label: string, order: typeof orders.$inferSelect): Promise<Result> {
  // asSSUpstreamOrderId is the only safe path to produce the branded
  // SSUpstreamOrderId type that ssMarkOrderShippedV1 requires. Any
  // attempt to pass order.id directly would fail to compile.
  const ssUpstreamOrderId = asSSUpstreamOrderId(order.externalOrderId);
  if (!ssUpstreamOrderId) {
    return {
      label,
      ok: false,
      reason: `externalOrderId="${order.externalOrderId ?? '(null)'}" is missing or not a valid positive integer`,
    };
  }

  const [shipment] = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), eq(shipments.voided, false)))
    .orderBy(desc(shipments.createdAt))
    .limit(1);

  if (!shipment) return { label, ok: false, reason: 'no non-voided shipment row for this order' };
  if (!shipment.trackingNumber) return { label, ok: false, reason: `shipment ${shipment.id} has no tracking number` };

  // Per-client creds are PREFERRED but not required. If a client has no
  // v1 keys of its own (common for sub-stores under a master ShipStation
  // account, e.g. Tran Agency at clientId=9), we pass undefined and let
  // the ShipStation v1 client fall back to env.SHIPSTATION_API_KEY/SECRET - the same
  // env-level master credentials the order sync uses successfully.
  // Per the loadClientCredentials docstring contract:
  //   "If nothing resolves, return all-null - callers fall through to
  //    env defaults via ShipStation request clients."
  const creds = order.clientId ? await loadClientCredentials(order.clientId) : null;
  const apiKey = creds?.apiKey ?? undefined;
  const apiSecret = creds?.apiSecret ?? undefined;

  const shipDate =
    shipment.shipDate?.toISOString().slice(0, 10) ??
    shipment.labelShipDate?.toISOString().slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  console.log(
    `▶ ${label} → orderNumber=${order.orderNumber} ssUpstreamOrderId=${ssUpstreamOrderId} tracking=${shipment.trackingNumber} carrier=${shipment.carrierCode} shipDate=${shipDate}`
  );

  try {
    await ssMarkOrderShippedV1(
      {
        orderId: ssUpstreamOrderId,
        carrierCode: shipment.carrierCode,
        trackingNumber: shipment.trackingNumber,
        shipDate,
      },
      { apiKey, apiSecret }
    );
    return { label: `${label} (orderNumber=${order.orderNumber})`, ok: true };
  } catch (err) {
    return {
      label: `${label} (orderNumber=${order.orderNumber})`,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

type Input =
  | { kind: 'orderNumber'; value: string }
  | { kind: 'ssShipmentId'; value: number };

function parseArg(raw: string): Input | null {
  if (!raw) return null;
  if (raw.startsWith('order:')) {
    const value = raw.slice('order:'.length).trim();
    return value ? { kind: 'orderNumber', value } : null;
  }
  if (raw.startsWith('ssshipment:')) {
    const value = Number(raw.slice('ssshipment:'.length).trim());
    return Number.isFinite(value) && value > 0 ? { kind: 'ssShipmentId', value } : null;
  }
  // Bare arg auto-detection: contains letters/dashes → orderNumber,
  // pure number ≥ 100000000 → ssShipmentId, otherwise reject.
  if (/[a-zA-Z\-]/.test(raw)) return { kind: 'orderNumber', value: raw };
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 100_000_000) return { kind: 'ssShipmentId', value: n };
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage:');
    console.error('  tsx scripts/recover-marketplace-notifications.ts \\');
    console.error('    order:111-4349324-2899466 \\');
    console.error('    ssshipment:284049105');
    console.error('');
    console.error('Or bare:');
    console.error('  tsx scripts/recover-marketplace-notifications.ts \\');
    console.error('    111-4349324-2899466 284049105');
    process.exit(1);
  }

  const inputs: Input[] = [];
  const invalid: string[] = [];
  for (const raw of args) {
    const parsed = parseArg(raw);
    if (parsed) inputs.push(parsed);
    else invalid.push(raw);
  }

  if (invalid.length > 0) {
    console.error(`Could not parse args: ${invalid.join(', ')}`);
    console.error('Use the order:<number> or ssshipment:<number> prefix to disambiguate.');
    process.exit(1);
  }

  console.log(`Recovering ${inputs.length} target(s)…\n`);
  const results: Result[] = [];

  for (const input of inputs) {
    const result =
      input.kind === 'orderNumber'
        ? await recoverByOrderNumber(input.value)
        : await recoverBySsShipmentId(input.value);
    if (result.ok) console.log(`  ✅ ${result.label} — marketplace will be notified by ShipStation`);
    else console.log(`  ❌ ${result.label} — ${result.reason}`);
    results.push(result);
    // Small spacing to play nice with v1 rate limit (40 req/min)
    await new Promise((r) => setTimeout(r, 200));
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'─'.repeat(60)}\nDone. OK: ${ok}  Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
