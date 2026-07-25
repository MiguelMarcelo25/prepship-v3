import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const client = new PGlite();
const declarationHash = `hz_${'a'.repeat(64)}`;
const snapshotHash = `hz_${'b'.repeat(64)}`;

try {
  await client.exec(`
    CREATE TABLE public.orders (id serial PRIMARY KEY);
    CREATE TABLE public.order_overrides (
      order_id integer PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
      best_rate_json jsonb
    );
    CREATE TABLE public.shipments (
      id serial PRIMARY KEY,
      order_id integer NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT
    );
    CREATE TABLE public.external_operations (id serial PRIMARY KEY);
  `);
  await client.exec(readFileSync('drizzle/0078_order_hazmat_declarations.sql', 'utf8'));

  const triggerRows = await client.query<{ tgname: string }>(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'public.shipment_hazmat_snapshots'::regclass
      AND NOT tgisinternal
    ORDER BY tgname
  `);
  assert.deepEqual(
    triggerRows.rows.map((row) => row.tgname),
    ['shipment_hazmat_snapshots_no_truncate', 'shipment_hazmat_snapshots_no_update_delete'],
  );

  await client.exec(`
    INSERT INTO public.orders (id) VALUES (465);
    INSERT INTO public.shipments (id, order_id) VALUES (465, 465);
    INSERT INTO public.external_operations (id) VALUES (465);
  `);
  await client.exec(`
    BEGIN;
    SELECT o.id, oo.best_rate_json
    FROM public.orders o
    LEFT JOIN public.order_overrides oo ON oo.order_id = o.id
    WHERE o.id = 465
    FOR UPDATE OF o;
    ROLLBACK;
  `);
  const before = await client.query<{ orders: number; shipments: number; snapshots: number }>(`
    SELECT
      (SELECT count(*)::integer FROM public.orders) AS orders,
      (SELECT count(*)::integer FROM public.shipments) AS shipments,
      (SELECT count(*)::integer FROM public.shipment_hazmat_snapshots) AS snapshots
  `);
  assert.deepEqual(before.rows[0], { orders: 1, shipments: 1, snapshots: 0 });

  await assert.rejects(
    client.exec(`
      INSERT INTO public.order_hazmat_declarations (
        order_id, revision, status, dry_ice, dry_ice_weight_value,
        dry_ice_weight_unit, semantic_hash
      ) VALUES (465, 1, 'active', true, NULL, NULL, '${declarationHash}')
    `),
    /order_hazmat_declarations_dry_ice_weight_chk/i,
  );

  await client.exec(`
    INSERT INTO public.order_hazmat_declarations (
      order_id, revision, status, limited_quantity, contains_battery,
      dry_ice, dry_ice_weight_value, dry_ice_weight_unit, semantic_hash
    ) VALUES (465, 1, 'active', false, false, true, 2.5, 'pound', '${declarationHash}');

    INSERT INTO public.order_hazmat_materials (
      order_id, sequence, un_na_number, proper_shipping_name, hazard_class,
      amount, amount_unit, quantity, transport_mean, regulation_level
    ) VALUES (465, 1, 'UN1845', 'Dry ice', '9', 2.5, 'kilogram', 1, 'ground', 'fully_regulated');

    INSERT INTO public.shipment_hazmat_snapshots (
      shipment_id, external_operation_id, snapshot_schema_version,
      order_declaration_revision, snapshot_hash, summary_is_hazmat,
      summary_profile, snapshot_json, capture_kind
    ) VALUES (
      465, 465, 1, 1, '${snapshotHash}', true, 'shipstation_usps',
      '{"profile":"shipstation_usps","revision":1}'::jsonb,
      'provider_purchase'
    );
  `);

  const decision = await client.query<{ decisionSource: string }>(`
    SELECT decision_source AS "decisionSource"
    FROM public.order_hazmat_declarations
    WHERE order_id = 465
  `);
  assert.equal(decision.rows[0]?.decisionSource, 'manual');
  await assert.rejects(
    client.exec(`UPDATE public.order_hazmat_declarations SET decision_source = 'provider' WHERE order_id = 465`),
    /order_hazmat_declarations_decision_source_chk/i,
  );

  await assert.rejects(
    client.exec(`UPDATE public.shipment_hazmat_snapshots SET summary_profile = 'walmart' WHERE shipment_id = 465`),
    /append-only/i,
  );
  await assert.rejects(
    client.exec(`DELETE FROM public.shipment_hazmat_snapshots WHERE shipment_id = 465`),
    /append-only/i,
  );
  await assert.rejects(
    client.exec(`TRUNCATE public.shipment_hazmat_snapshots`),
    /append-only/i,
  );
  await assert.rejects(
    client.exec(`DELETE FROM public.shipments WHERE id = 465`),
    /foreign key|violates/i,
  );

  const after = await client.query<{ orders: number; shipments: number; snapshots: number }>(`
    SELECT
      (SELECT count(*)::integer FROM public.orders) AS orders,
      (SELECT count(*)::integer FROM public.shipments) AS shipments,
      (SELECT count(*)::integer FROM public.shipment_hazmat_snapshots) AS snapshots
  `);
  assert.deepEqual(after.rows[0], { orders: 1, shipments: 1, snapshots: 1 });
  console.log('PS-465 isolated Postgres migration and immutable snapshot integration passed');
} finally {
  await client.close();
}
