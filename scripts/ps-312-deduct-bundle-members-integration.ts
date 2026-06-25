/**
 * PS-312 (S6) — REAL integration test for the deduct-once fan-out against in-memory Postgres.
 * Proves: once a bundle is LABELED, deductBundleMembersOnce deducts every CHILD exactly once — never
 * the primary (its per-label trigger handled it), never a non-bundled order, never a child caller. A
 * still-'draft' bundle deducts NOTHING. The deductInventoryForOrder owner + the member-loader are
 * injected as recording fakes, so this proves the FAN-OUT logic deterministically without the
 * inventory/orders tables. Offline. No postage, no real inventory movement.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { createBundle, linkBundleShipment } from '../src/services/shipment-bundles/create-bundle.js';
import { deductBundleMembersOnce } from '../src/services/shipment-bundles/deduct-bundle-members.js';

type Conn = Parameters<typeof createBundle>[3];

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// A member-loader that returns minimal id-only stubs (the injected deductor only reads order.id), and
// a recording deductor that captures every (orderId, shipmentId, source) it was asked to deduct.
function makeFakes() {
  const calls: Array<{ orderId: number; shipmentId: number; source: string }> = [];
  const loadMemberOrders = async (ids: number[]) => ids.map((id) => ({ id }) as never);
  const deduct = async (order: { id: number }, input: { shipmentId: number; source: string }) => {
    calls.push({ orderId: order.id, shipmentId: input.shipmentId, source: input.source });
  };
  return { calls, loadMemberOrders, deduct };
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  await pg.execute(sql`CREATE TABLE orders (
    id serial PRIMARY KEY, order_number text, client_id integer, store_id integer,
    ship_to_name text, ship_to_city text, ship_to_state text, ship_to_postal_code text,
    order_status text NOT NULL DEFAULT 'awaiting_shipment'
  )`);
  await pg.execute(sql`CREATE TABLE shipment_bundles (
    id serial PRIMARY KEY, client_id integer, primary_order_id integer NOT NULL, primary_shipment_id integer,
    tracking_number text, carrier_code text, service_code text, selected_rate jsonb, label_url text,
    label_shipment_id text, package_id integer, status text NOT NULL DEFAULT 'draft', created_by text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pg.execute(sql`CREATE TABLE shipment_bundle_members (
    id serial PRIMARY KEY, bundle_id integer NOT NULL, order_id integer NOT NULL UNIQUE, role text NOT NULL,
    status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  // 100 (→primary, lowest id) + 101 + 102: same recipient → a 3-order bundle. 200: not bundled.
  await pg.execute(sql`INSERT INTO orders
    (id, order_number, client_id, store_id, ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code, order_status) VALUES
    (100, 'B100', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (101, 'B101', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (102, 'B102', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (200, 'B200', 7, 1, 'Grace Hopper', 'Arlington', 'VA', '22204', 'awaiting_shipment')`);

  const created = await createBundle([100, 101, 102], 'tester', null, conn);

  // ── DRAFT: the bundle has no label yet → nothing deducts ──
  const draft = makeFakes();
  const draftResult = await deductBundleMembersOnce(100, 9001, draft.loadMemberOrders, draft.deduct, conn);
  check('draft bundle deducts NOTHING (returns [] + deductor never called)',
    draftResult.length === 0 && draft.calls.length === 0);

  // ── LABELED: the ONE label is linked → the two CHILDREN deduct exactly once, never the primary ──
  await linkBundleShipment(created.bundleId, {
    primaryShipmentId: 9001, trackingNumber: '1ZSHARED', carrierCode: 'ups', serviceCode: 'ground',
    labelUrl: 'https://x/bundle-label.pdf', packageId: 42,
  }, conn);
  const labeled = makeFakes();
  const result = await deductBundleMembersOnce(100, 9001, labeled.loadMemberOrders, labeled.deduct, conn);
  check('labeled bundle deducts exactly the two CHILDREN (101,102), never the primary (100)',
    JSON.stringify(sorted(result)) === JSON.stringify([101, 102]) &&
    JSON.stringify(sorted(labeled.calls.map((c) => c.orderId))) === JSON.stringify([101, 102]));
  check('each child deducts against the primary shipment id (9001) with source=bundle',
    labeled.calls.length === 2 && labeled.calls.every((c) => c.shipmentId === 9001 && c.source === 'bundle'));

  // ── Calling for a CHILD (non-primary) deducts nothing (the fan-out only fires for the primary) ──
  const childCaller = makeFakes();
  const childResult = await deductBundleMembersOnce(101, 9001, childCaller.loadMemberOrders, childCaller.deduct, conn);
  check('calling for a CHILD (non-primary) deducts NOTHING',
    childResult.length === 0 && childCaller.calls.length === 0);

  // ── A non-bundled order deducts nothing ──
  const nonBundled = makeFakes();
  const nbResult = await deductBundleMembersOnce(200, 9001, nonBundled.loadMemberOrders, nonBundled.deduct, conn);
  check('non-bundled order deducts NOTHING',
    nbResult.length === 0 && nonBundled.calls.length === 0);

  await client.close();
  if (failures > 0) {
    console.error(`\nPS-312 deduct-bundle-members integration test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-312 deduct-bundle-members integration test passed.');
}

void main().catch((err) => {
  console.error('PS-312 deduct-bundle-members integration test crashed:', err);
  process.exit(1);
});
