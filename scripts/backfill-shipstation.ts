#!/usr/bin/env tsx
/**
 * Full ShipStation backfill — fetches EVERY shipped/cancelled/awaiting order
 * and EVERY shipment from epoch, upserting into the local Postgres DB.
 *
 * Run: npx tsx scripts/backfill-shipstation.ts
 *
 * Safe to re-run: both upserts are idempotent.
 *   - orders: ON CONFLICT (external_order_id)
 *   - shipments: ON CONFLICT (label_shipment_id)
 *
 * Uses the same env as `npm run dev` — reads DATABASE_URL + SHIPSTATION_* creds
 * from .env at the repo root.
 */
import 'dotenv/config';
import { sql as rawSql } from '../src/db/client';
import { db, sql } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { syncOrders } from '../src/services/order-sync';
import { syncShipments } from '../src/services/shipment-sync';

void rawSql; // keep the import — ensures the client is initialized

function hh(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

async function main() {
  const t0 = Date.now();
  console.log('┌─────────────────────────────────────────────────────────────');
  console.log('│ ShipStation backfill — fetching ALL history from epoch');
  console.log('└─────────────────────────────────────────────────────────────');

  // Baseline counts
  const [{ c: ordersBefore }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(orders);
  const [{ c: shipmentsBefore }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(shipments);
  console.log(`Before  →  orders=${ordersBefore}  shipments=${shipmentsBefore}`);

  // ─── Pass 1 — orders ────────────────────────────────────────────────
  // fullResync: sinceMs=0 for both shipped/cancelled passes AND the
  // awaiting pass. Iterates every ShipStation account (env main + every
  // active client with ss_api_key set) so multi-tenant is covered.
  console.log('\n[1/2] Fetching orders (shipped + cancelled + awaiting_shipment)…');
  const ordersT0 = Date.now();
  const orderRes = await syncOrders({
    sinceMs: 0,
    awaitingSinceMs: 0,
  });
  console.log(
    `      done in ${hh(Date.now() - ordersT0)} — synced=${orderRes.synced} pages=${orderRes.pages}`,
  );

  // ─── Pass 2 — shipments ─────────────────────────────────────────────
  // sinceMs=0 so the per-account watermark is ignored and we fetch every
  // historical shipment. Marks the matching order rows as shipped.
  console.log('\n[2/2] Fetching shipments (all labels, all accounts)…');
  const shipT0 = Date.now();
  const shipRes = await syncShipments({ sinceMs: 0 });
  console.log(
    `      done in ${hh(Date.now() - shipT0)} — fetched=${shipRes.fetched} inserted=${shipRes.inserted} updated=${shipRes.updated} matched=${shipRes.matchedOrders} orphaned=${shipRes.orphaned} ordersMarkedShipped=${shipRes.ordersMarkedShipped}`,
  );

  // After counts
  const [{ c: ordersAfter }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(orders);
  const [{ c: shipmentsAfter }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(shipments);

  const [{ c: shippedCount }] = await db.execute<{ c: number }>(
    sql`select count(*)::int as c from orders where order_status = 'shipped'`,
  );
  const [{ c: awaitingCount }] = await db.execute<{ c: number }>(
    sql`select count(*)::int as c from orders where order_status = 'awaiting_shipment'`,
  );

  console.log('\n┌─────────────────────────────────────────────────────────────');
  console.log('│ Summary');
  console.log('├─────────────────────────────────────────────────────────────');
  console.log(`│ Orders:     ${ordersBefore} → ${ordersAfter}  (+${ordersAfter - ordersBefore})`);
  console.log(`│ Shipments:  ${shipmentsBefore} → ${shipmentsAfter}  (+${shipmentsAfter - shipmentsBefore})`);
  console.log(`│ Status:     shipped=${shippedCount}  awaiting=${awaitingCount}`);
  console.log(`│ Elapsed:    ${hh(Date.now() - t0)}`);
  console.log('└─────────────────────────────────────────────────────────────');
}

main()
  .then(async () => {
    await rawSql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nBackfill FAILED:', err instanceof Error ? err.stack : err);
    await rawSql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
