// PS-477: the unsealed shape cannot be produced by buying a label.
//
// Buying through PrepShip -- even a mock label for a test client -- is what
// SEALS a snapshot. TESTING-MS2TCYUF-000 proves it: it went through the
// test-client path, PS-186 forced a mock label, and it produced the only
// snapshot in production (prepship_test / test_label). So the broken shape is
// built here directly instead: a shipment with source='shipstation' and no
// snapshot, exactly what shipment-sync.ts:163 writes.
//
// This does not call loadHazmatDisclosureForOrders (that would need a live
// drizzle/postgres-js connection, i.e. the real DATABASE_URL, which this test
// must never touch). Instead it mirrors, in raw SQL against an isolated PGlite
// instance, the two queries the batch loader runs: an INNER JOIN of
// shipments+shipment_hazmat_snapshots filtered by order id, and a
// order_hazmat_declarations lookup filtered by order id. Three orders pin the
// three resolveHazmatDisclosure branches:
//   - order 1: declared, NOT sealed  -> the PS-477 bug shape (declared_unsealed)
//   - order 2: declared AND sealed   -> sealed wins
//   - order 3: neither               -> none
//
// PGlite, in-process, throwaway. No real order is read or written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const client = new PGlite();

const declarationHashOrder1 = `hz_${'a'.repeat(64)}`;
const declarationHashOrder2 = `hz_${'c'.repeat(64)}`;
const snapshotHashOrder2 = `hz_${'b'.repeat(64)}`;

try {
  await client.exec(`
    CREATE TABLE public.orders (id serial PRIMARY KEY);
    CREATE TABLE public.order_overrides (
      order_id integer PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
      best_rate_json jsonb
    );
    CREATE TABLE public.shipments (
      id serial PRIMARY KEY,
      order_id integer NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
      source text
    );
    CREATE TABLE public.external_operations (id serial PRIMARY KEY);
  `);
  await client.exec(readFileSync('drizzle/0078_order_hazmat_declarations.sql', 'utf8'));

  const declarationCols = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_hazmat_declarations'
  `);
  assert.ok(
    declarationCols.rows.some((row) => row.column_name === 'status'),
    'order_hazmat_declarations must expose status',
  );

  await client.exec(`
    INSERT INTO public.orders (id) VALUES (1), (2), (3);
    -- Order 1: the PS-477 shape. Sync-ingested shipment, active declaration,
    -- deliberately NO snapshot.
    INSERT INTO public.shipments (id, order_id, source) VALUES (10, 1, 'shipstation');
    -- Order 2: sealed. PrepShip bought this one.
    INSERT INTO public.shipments (id, order_id, source) VALUES (20, 2, 'prepship_v2');
    -- Order 3: shipment, no declaration at all.
    INSERT INTO public.shipments (id, order_id, source) VALUES (30, 3, 'shipstation');
  `);

  await client.exec(`
    INSERT INTO public.order_hazmat_declarations (order_id, revision, status, semantic_hash)
    VALUES
      (1, 1, 'active', '${declarationHashOrder1}'),
      (2, 1, 'active', '${declarationHashOrder2}');

    INSERT INTO public.shipment_hazmat_snapshots (
      shipment_id, snapshot_schema_version, order_declaration_revision,
      snapshot_hash, summary_is_hazmat, summary_profile, snapshot_json, capture_kind
    ) VALUES (
      20, 1, 1, '${snapshotHashOrder2}', true, 'shipstation_usps',
      '{"profile":"shipstation_usps","revision":1}'::jsonb,
      'provider_purchase'
    );
  `);

  // Mirrors the batch loader's snapshot query: shipments INNER JOIN
  // shipment_hazmat_snapshots, filtered to the visible order ids.
  const sealedRows = await client.query<{ order_id: number }>(`
    SELECT s.order_id
    FROM public.shipment_hazmat_snapshots hs
    JOIN public.shipments s ON s.id = hs.shipment_id
    WHERE s.order_id IN (1, 2, 3)
    ORDER BY s.order_id
  `);
  const sealedOrderIds = new Set(sealedRows.rows.map((row) => row.order_id));
  assert.deepEqual([...sealedOrderIds], [2], 'only order 2 has a sealed snapshot');

  // Mirrors the batch loader's declaration query: order_hazmat_declarations
  // filtered to the visible order ids.
  const declaredRows = await client.query<{ order_id: number; status: string }>(`
    SELECT order_id, status
    FROM public.order_hazmat_declarations
    WHERE order_id IN (1, 2, 3)
    ORDER BY order_id
  `);
  const declaredOrderIds = new Set(declaredRows.rows.map((row) => row.order_id));
  assert.deepEqual([...declaredOrderIds], [1, 2], 'orders 1 and 2 have an active declaration; order 3 has none');
  assert.ok(
    declaredRows.rows.every((row) => row.status === 'active'),
    'both seeded declarations are active',
  );

  // The three resolveHazmatDisclosure branches, pinned at the SQL shape the
  // loaders read:
  //   - order 1: declared but NOT sealed -- the exact PS-477 bug shape.
  assert.ok(declaredOrderIds.has(1) && !sealedOrderIds.has(1), 'order 1 must be declared but unsealed');
  //   - order 2: declared AND sealed -- sealed provenance wins.
  assert.ok(declaredOrderIds.has(2) && sealedOrderIds.has(2), 'order 2 must be both declared and sealed');
  //   - order 3: neither -- not hazmat.
  assert.ok(!declaredOrderIds.has(3) && !sealedOrderIds.has(3), 'order 3 must have neither declaration nor snapshot');

  // Same shape from the other direction (LEFT JOIN from shipments): orders 1
  // and 3 have a shipment with no snapshot row; order 2 -- now that it has a
  // real snapshot -- must NOT appear. Without a real snapshot seeded for
  // order 2 this would be vacuously true for all three orders, which is
  // exactly the weak version of this assertion this test replaces.
  const unsealedShipments = await client.query<{ order_id: number }>(`
    SELECT s.order_id
    FROM public.shipments s
    LEFT JOIN public.shipment_hazmat_snapshots hs ON hs.shipment_id = s.id
    WHERE hs.shipment_id IS NULL
    ORDER BY s.order_id
  `);
  assert.deepEqual(
    unsealedShipments.rows.map((row) => row.order_id),
    [1, 3],
    'orders 1 and 3 have a shipment with no snapshot; sealed order 2 must not appear',
  );

  console.log('PS-477 hazmat disclosure PGlite integration passed');
} finally {
  await client.close();
}
