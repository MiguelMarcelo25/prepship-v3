/**
 * PS-312/PS-317 (S4 slice 1) — REAL integration test for resolveScopedBundles against in-memory
 * Postgres. The security-critical property: an order OUTSIDE the caller's client/store scope is
 * dropped BEFORE the read-model sees it, so the bundle endpoint can never leak another client's
 * combined-shipment data. Also proves admin (unrestricted) sees all, store-scope works, and a
 * non-bundled in-scope order resolves to nothing. Offline/deterministic.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { createBundle } from '../src/services/shipment-bundles/create-bundle.js';
import { resolveScopedBundles } from '../src/services/shipment-bundles/resolve-scoped-bundles.js';
import type { ClientStoreScope } from '../src/lib/client-store-scope.js';

type Conn = Parameters<typeof resolveScopedBundles>[2];

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const restricted = (clientIds: number[], storeIds: number[] = []): ClientStoreScope => ({
  clientIds,
  storeIds,
  isGlobal: false,
  isRestricted: true,
});
const ADMIN: ClientStoreScope = { clientIds: [], storeIds: [], isGlobal: true, isRestricted: false };

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

  // client 7 / store 1: orders 100+101 (bundled) + 300 (not bundled). client 9 / store 2: 200+201 (bundled).
  await pg.execute(sql`INSERT INTO orders
    (id, order_number, client_id, store_id, ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code, order_status) VALUES
    (100, 'C100', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (101, 'C101', 7, 1, 'Ada Lovelace', 'Austin', 'TX', '78701', 'awaiting_shipment'),
    (300, 'C300', 7, 1, 'Solo Shipper', 'Dallas', 'TX', '75001', 'awaiting_shipment'),
    (200, 'C200', 9, 2, 'Bob Other', 'Reno', 'NV', '89501', 'awaiting_shipment'),
    (201, 'C201', 9, 2, 'Bob Other', 'Reno', 'NV', '89501', 'awaiting_shipment')`);

  await createBundle([100, 101], 'tester', null, conn); // client 7 bundle
  await createBundle([200, 201], 'tester', null, conn); // client 9 bundle

  // ── Restricted to client 7: only client 7's orders resolve; client 9's order 200 is DROPPED ──
  const scoped7 = await resolveScopedBundles([100, 101, 200], restricted([7]), conn);
  check('client-7 caller sees its own bundled orders (100,101)', scoped7.has(100) && scoped7.has(101));
  check('client-7 caller does NOT see client-9 order 200 (no cross-client leak)', !scoped7.has(200));

  // ── Cross-client leak attempt: client 9 caller asks about client 7's order 100 → nothing ──
  const leak = await resolveScopedBundles([100], restricted([9]), conn);
  check('client-9 caller asking for a client-7 order gets NOTHING (leak prevented)', leak.size === 0);

  // ── Admin (unrestricted) sees every requested bundle ──
  const adminView = await resolveScopedBundles([100, 200], ADMIN, conn);
  check('admin/unrestricted resolves both clients (100 + 200)', adminView.has(100) && adminView.has(200));

  // ── Store scope: scoped to store 1 → client-7 orders only (store 1), not store-2 order 200 ──
  const storeScoped = await resolveScopedBundles([100, 200], restricted([], [1]), conn);
  check('store-1 scope resolves store-1 order 100, not store-2 order 200',
    storeScoped.has(100) && !storeScoped.has(200));

  // ── In-scope but not bundled, + empty input ──
  check('an in-scope non-bundled order resolves to nothing',
    (await resolveScopedBundles([300], restricted([7]), conn)).size === 0);
  check('empty input returns an empty map', (await resolveScopedBundles([], ADMIN, conn)).size === 0);

  // ── The resolved DTO is the real read-model shape (members + role), not a stub ──
  const dto = scoped7.get(100);
  check('resolved DTO carries the bundle members + a role',
    !!dto && Array.isArray(dto.memberOrderIds) && dto.memberOrderIds.includes(101) &&
    (dto.role === 'primary' || dto.role === 'child'));

  await client.close();
  if (failures > 0) {
    console.error(`\nPS-312 resolve-scoped-bundles integration test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-312 resolve-scoped-bundles integration test passed.');
}

void main().catch((err) => {
  console.error('PS-312 resolve-scoped-bundles integration test crashed:', err);
  process.exit(1);
});
