/**
 * PS-312/PS-317 (S3) — REAL integration test for the bundle READ-MODEL against in-memory Postgres.
 * Proves: after a bundle is created (S2) and its primary's label is linked, BOTH the primary AND
 * every CHILD resolve to the SAME shared tracking/label/status + the full member list — i.e. a child
 * shows the bundle's shipment, not "Shipment sync error". A non-bundled order resolves to null.
 * Status flows draft → labeled. Offline/deterministic. No postage.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { createBundle, linkBundleShipment } from '../src/services/shipment-bundles/create-bundle.js';
import { getBundlesForOrders, getBundleForOrder } from '../src/services/shipment-bundles/bundle-read-model.js';

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

  // 100 (→primary, lowest id) + 101 + 102: same recipient, awaiting → a 3-order bundle. 200: not bundled.
  await pg.execute(sql`INSERT INTO orders
    (id, order_number, client_id, store_id, ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code, order_status) VALUES
    (100, 'B100', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (101, 'B101', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (102, 'B102', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (200, 'B200', 7, 1, 'Grace Hopper', 'Arlington', 'VA', '22204', 'awaiting_shipment')`);

  const created = await createBundle([100, 101, 102], 'tester', null, conn);

  // ── Before the label is linked: every member resolves to the bundle, status 'draft', no tracking ──
  const draftMap = await getBundlesForOrders([100, 101, 102, 200], conn);
  check('read: all 3 members resolve to a bundle; the non-bundled order does NOT',
    draftMap.has(100) && draftMap.has(101) && draftMap.has(102) && !draftMap.has(200));
  check('read: a child (101) carries the SAME bundle + member list + primary as the primary (100)',
    draftMap.get(101)?.bundleId === created.bundleId &&
    draftMap.get(101)?.role === 'child' &&
    draftMap.get(101)?.primaryOrderId === 100 &&
    JSON.stringify(draftMap.get(101)?.memberOrderIds) === JSON.stringify([100, 101, 102]) &&
    draftMap.get(100)?.role === 'primary');
  check('read: status is draft + no shared tracking before the label is linked',
    draftMap.get(101)?.status === 'draft' && draftMap.get(101)?.trackingNumber === null);

  // ── Link the ONE bought label → every member now resolves to the SAME shared shipment ──
  await linkBundleShipment(created.bundleId, {
    primaryShipmentId: 9001, trackingNumber: '1ZSHARED', carrierCode: 'ups', serviceCode: 'ground',
    labelUrl: 'https://x/bundle-label.pdf', packageId: 42,
  }, conn);
  const map = await getBundlesForOrders([100, 101, 102], conn);
  const primary = map.get(100);
  const childA = map.get(101);
  const childB = map.get(102);
  check('read: status advanced to labeled for the whole bundle',
    primary?.status === 'labeled' && childA?.status === 'labeled' && childB?.status === 'labeled');
  check('read: BOTH children resolve to the SAME shared tracking/label as the primary (not a sync error)',
    childA?.trackingNumber === '1ZSHARED' && childB?.trackingNumber === '1ZSHARED' &&
    primary?.trackingNumber === '1ZSHARED' &&
    childA?.labelUrl === 'https://x/bundle-label.pdf' && childA?.primaryShipmentId === 9001 &&
    childA?.packageId === 42 && childA?.carrierCode === 'ups');
  check('read: roles are exactly one primary (100) + two children (101,102)',
    primary?.role === 'primary' && childA?.role === 'child' && childB?.role === 'child' &&
    primary?.primaryOrderId === 100 && childB?.primaryOrderId === 100);

  // ── Single-order convenience + the non-bundled null path ──
  check('read: getBundleForOrder returns the DTO for a child', (await getBundleForOrder(102, conn))?.bundleId === created.bundleId);
  check('read: getBundleForOrder returns null for a non-bundled order', (await getBundleForOrder(200, conn)) === null);

  await client.close();
  if (failures > 0) {
    console.error(`\nPS-312 bundle read-model integration test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-312 bundle read-model integration test passed.');
}

void main().catch((err) => {
  console.error('PS-312 bundle read-model integration test crashed:', err);
  process.exit(1);
});
