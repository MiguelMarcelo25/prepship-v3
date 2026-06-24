/**
 * PS-312/PS-317 (S2) — REAL integration test for the bundle create/preview/link service against an
 * in-memory Postgres (PGlite). Proves: a valid same-recipient awaiting pair previews + creates a
 * durable bundle (1 primary + 1 child); mixed-recipient / different-client / shipped / single-order
 * sets are REFUSED; an already-bundled order can't be re-bundled (idempotency); linkBundleShipment
 * stamps the shared facts + flips status. NO real postage — createBundle only writes the additive
 * bundle tables. Offline/deterministic.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { shipmentBundles, shipmentBundleMembers } from '../src/db/schema/shipment-bundles.js';
import { previewBundle, createBundle, linkBundleShipment } from '../src/services/shipment-bundles/create-bundle.js';

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

async function expectThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  // Minimal orders table (only the columns the service reads) + the additive bundle sidecars (no FKs).
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

  // 1778 + 1777: same client/store/recipient, awaiting → bundleable pair.
  // 1779: same client/store, DIFFERENT recipient. 1780: same recipient but SHIPPED. 1781: DIFFERENT client.
  await pg.execute(sql`INSERT INTO orders
    (id, order_number, client_id, store_id, ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code, order_status) VALUES
    (1778, 'A1778', 100, 1, 'Sze Ting Lee', 'San Gabriel', 'CA', '91776', 'awaiting_shipment'),
    (1777, 'A1777', 100, 1, 'Sze Ting Lee', 'San Gabriel', 'CA', '91776', 'awaiting_shipment'),
    (1779, 'A1779', 100, 1, 'Someone Else', 'Dallas', 'TX', '75001', 'awaiting_shipment'),
    (1780, 'A1780', 100, 1, 'Sze Ting Lee', 'San Gabriel', 'CA', '91776', 'shipped'),
    (1781, 'A1781', 200, 1, 'Sze Ting Lee', 'San Gabriel', 'CA', '91776', 'awaiting_shipment')`);

  // ── Preview ──
  const okPreview = await previewBundle([1778, 1777], null, conn);
  check('preview: same-recipient awaiting pair is VALID, primary = lowest id (1777), 2 members',
    okPreview.valid && okPreview.primaryOrderId === 1777 && JSON.stringify(okPreview.memberOrderIds) === JSON.stringify([1777, 1778]));
  check('preview: explicit primary is honored', (await previewBundle([1778, 1777], 1778, conn)).primaryOrderId === 1778);
  check('preview: a single order is INVALID (<2)', !(await previewBundle([1778], null, conn)).valid);
  check('preview: different recipient is INVALID', !(await previewBundle([1778, 1779], null, conn)).valid);
  check('preview: a SHIPPED order is INVALID (not eligible)', !(await previewBundle([1778, 1780], null, conn)).valid);
  check('preview: different client is INVALID', !(await previewBundle([1778, 1781], null, conn)).valid);
  check('preview: an explicit primary NOT in the set is INVALID', !(await previewBundle([1778, 1777], 9999, conn)).valid);

  // ── createBundle REFUSALS — every rejection reason proven at the WRITE boundary (not just
  // preview), BEFORE any successful create so no order is bundled yet. Each must throw + write nothing.
  await expectThrows('create REFUSES a single order (<2)', () => createBundle([1778], 'tester', null, conn));
  await expectThrows('create REFUSES a mixed-recipient set', () => createBundle([1778, 1779], 'tester', null, conn));
  await expectThrows('create REFUSES a shipped (ineligible) order', () => createBundle([1778, 1780], 'tester', null, conn));
  await expectThrows('create REFUSES a different-client set', () => createBundle([1778, 1781], 'tester', null, conn));
  await expectThrows('create REFUSES an explicit primary not in the set', () => createBundle([1778, 1777], 'tester', 9999, conn));
  check('all createBundle refusals wrote NOTHING (0 bundles, 0 members)',
    (await pg.select().from(shipmentBundles)).length === 0 && (await pg.select().from(shipmentBundleMembers)).length === 0);

  // ── createBundle SUCCESS ──
  const created = await createBundle([1778, 1777], 'tester', null, conn);
  check('create: returns a bundle with primary 1777 + members [1777,1778]',
    created.primaryOrderId === 1777 && JSON.stringify(created.memberOrderIds) === JSON.stringify([1777, 1778]));
  const bundleRows = await pg.select().from(shipmentBundles);
  check('create: exactly ONE bundle row written, status draft', bundleRows.length === 1 && bundleRows[0].status === 'draft');
  const memberRows = await pg.select().from(shipmentBundleMembers);
  const primaryMembers = memberRows.filter((m) => m.role === 'primary');
  check('create: exactly ONE primary member (1777) + one child (1778)',
    memberRows.length === 2 && primaryMembers.length === 1 && primaryMembers[0].orderId === 1777 &&
    memberRows.some((m) => m.role === 'child' && m.orderId === 1778));

  // ── Idempotency: an already-bundled order can't be re-bundled (UNIQUE order_id + existingBundleId) ──
  await expectThrows('create: re-bundling already-bundled orders is REFUSED', () => createBundle([1778, 1777], 'tester', null, conn));
  check('idempotency wrote nothing extra: still exactly 1 bundle + 2 members',
    (await pg.select().from(shipmentBundles)).length === 1 && (await pg.select().from(shipmentBundleMembers)).length === 2);

  // ── Link the bought label's shared facts ──
  await linkBundleShipment(created.bundleId, {
    primaryShipmentId: 555, trackingNumber: '1ZTEST', carrierCode: 'ups', labelUrl: 'https://x/label.pdf', packageId: 7,
  }, conn);
  const linked = (await pg.select().from(shipmentBundles)).find((b) => b.id === created.bundleId);
  check('link: shared tracking/label/package stamped + status → labeled',
    linked?.status === 'labeled' && linked?.trackingNumber === '1ZTEST' && linked?.labelUrl === 'https://x/label.pdf' &&
    linked?.primaryShipmentId === 555 && linked?.packageId === 7);
  await expectThrows('link REFUSES a non-existent bundle', () => linkBundleShipment(999999, { trackingNumber: 'x' }, conn));

  await client.close();
  if (failures > 0) {
    console.error(`\nPS-312 bundle-create integration test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-312 bundle-create integration test passed.');
}

void main().catch((err) => {
  console.error('PS-312 bundle-create integration test crashed:', err);
  process.exit(1);
});
