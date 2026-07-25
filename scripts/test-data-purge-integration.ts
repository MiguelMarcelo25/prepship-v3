import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret';

const { purgeAllTestClientData } = await import('../src/services/test-data-purge.js');
const client = new PGlite();
const testDb = drizzle(client, { casing: 'snake_case' });

try {
  await client.exec(`
    create table clients (
      id integer primary key,
      name text not null,
      is_test boolean not null default false
    );
    create table orders (
      id integer primary key,
      client_id integer references clients(id),
      order_number text
    );
    create table shipments (
      id integer primary key,
      order_id integer references orders(id),
      client_id integer references clients(id),
      label_shipment_id integer
    );
    create table inventory (
      id integer primary key,
      client_id integer references clients(id)
    );
    create table inventory_ledger (
      id integer primary key,
      inventory_id integer references inventory(id),
      order_id integer references orders(id),
      client_id integer references clients(id)
    );
    create table packages (
      id integer primary key,
      stock_qty integer not null,
      updated_at timestamptz not null default now()
    );
    create table package_ledger (
      id integer primary key,
      package_id integer references packages(id),
      qty_delta integer not null,
      order_id integer,
      shipment_id integer,
      note text
    );
    create table order_overrides (order_id integer primary key references orders(id));
    create table mock_labels (
      shipment_id integer primary key,
      order_number text
    );
    create table print_queue_orders (
      id text primary key,
      client_id integer not null,
      order_id text not null
    );

    create table order_lifecycle_events (
      id integer primary key,
      order_id integer not null references orders(id),
      shipment_id integer references shipments(id)
    );
    create table fulfillment_line_claims (
      id integer primary key,
      lifecycle_event_id integer not null references order_lifecycle_events(id),
      order_id integer not null references orders(id),
      shipment_id integer references shipments(id),
      inventory_id integer references inventory(id),
      original_claim_id integer references fulfillment_line_claims(id)
    );
    create table fulfillment_outbox (
      id integer primary key,
      order_id integer not null references orders(id),
      shipment_id integer references shipments(id)
    );
    create table external_operations (
      id integer primary key,
      subject_type text not null,
      subject_id text not null
    );
    create table shipment_hazmat_snapshots (
      shipment_id integer primary key references shipments(id) on delete restrict,
      external_operation_id integer references external_operations(id) on delete restrict,
      capture_kind text not null
    );

    create table automation_runs (
      id bigint primary key,
      order_id integer references orders(id) on delete restrict
    );
    create table automation_action_results (
      id bigint primary key,
      run_id bigint references automation_runs(id) on delete restrict
    );
    create table automation_reprocess_jobs (
      id bigint primary key,
      preview_run_id bigint references automation_runs(id) on delete restrict
    );
    create table order_automation_state (
      order_id integer primary key references orders(id) on delete cascade,
      last_run_id bigint references automation_runs(id) on delete set null
    );
    create table automation_outbox (
      id bigint generated always as identity primary key,
      aggregate_type text not null,
      aggregate_id text not null,
      payload jsonb not null default '{}'::jsonb
    );

    create table billing_finalizations (
      id text primary key,
      client_id integer not null references clients(id),
      period_start timestamptz not null,
      period_end timestamptz not null
    );
    create table billing_credit_notes (
      id text primary key,
      client_id integer not null references clients(id),
      source_order_id integer references orders(id)
    );
    create table billing_line_items (
      id integer primary key,
      client_id integer not null references clients(id),
      order_id integer references orders(id),
      shipment_id integer references shipments(id),
      billing_effective_date timestamptz,
      ship_date timestamptz,
      billing_adjustment_id text,
      invoiced boolean not null default false
    );

    create table label_purchase_locks (order_id integer primary key);
    create table label_purchase_intents (
      id integer primary key,
      order_id integer not null,
      shipment_id integer
    );
    create table billing_manual_overrides (
      id integer primary key,
      client_id integer not null,
      order_id integer not null
    );
    create table print_queue_send_jobs (
      job_id text primary key,
      client_id integer,
      client_ids jsonb not null default '[]'::jsonb
    );
    create table print_queue_batch_job_items (
      id integer primary key,
      job_id text not null,
      order_id integer not null,
      client_id integer
    );
    create table print_queue_merged_pdfs (job_id text primary key);
    create table print_queue_pdf_chunks (
      job_id text not null,
      chunk_number integer not null,
      primary key (job_id, chunk_number)
    );
    create table print_queue_merge_jobs (
      job_id text primary key,
      client_ids jsonb not null default '[]'::jsonb
    );
    create table rate_browse_jobs (job_id text primary key, order_id integer);
    create table rate_browse_job_provider_statuses (
      job_id text not null,
      provider_key text not null,
      primary key (job_id, provider_key)
    );
  `);

  await client.exec(readFileSync('drizzle/0082_test_data_purge_guards.sql', 'utf8'));
  await client.exec(`
    create trigger inventory_ledger_no_update_delete
      before update or delete on inventory_ledger
      for each row execute function inventory_ledger_block_mutations();
    create trigger order_lifecycle_events_no_update_delete
      before update or delete on order_lifecycle_events
      for each row execute function order_lifecycle_events_block_mutations();
    create trigger shipment_hazmat_snapshots_no_update_delete
      before update or delete on shipment_hazmat_snapshots
      for each row execute function shipment_hazmat_snapshots_block_mutations();
    create trigger billing_line_items_adjustment_immutable_guard
      before update or delete on billing_line_items
      for each row execute function billing_line_items_block_adjustment_mutation();
    create trigger billing_line_items_closed_period_guard
      before insert or update or delete on billing_line_items
      for each row execute function billing_line_items_block_closed_period_mutation();
    create trigger billing_finalizations_no_update_delete
      before update or delete on billing_finalizations
      for each row execute function billing_close_records_block_mutations();
    create trigger billing_credit_notes_no_update_delete
      before update or delete on billing_credit_notes
      for each row execute function billing_close_records_block_mutations();

    create function emit_automation_delete_event()
    returns trigger language plpgsql as $$
    begin
      insert into automation_outbox (aggregate_type, aggregate_id, payload)
      values ('order', old.id::text, jsonb_build_object('orderId', old.id));
      return old;
    end $$;
    create trigger orders_emit_automation_delete
      after delete on orders
      for each row execute function emit_automation_delete_event();
  `);

  await client.exec(`
    insert into clients (id, name, is_test) values
      (1, 'Test Orders', true),
      (2, 'Real Client', false);
    insert into orders (id, client_id, order_number) values
      (100, 1, 'TESTING-HU10-001'),
      (101, 1, 'TESTING-AWAITING-001'),
      (200, 2, 'REAL-ORDER-001');
    insert into shipments (id, order_id, client_id, label_shipment_id) values
      (100, 100, 1, -100),
      (200, 200, 2, 200);
    insert into inventory (id, client_id) values (100, 1), (200, 2);
    insert into inventory_ledger (id, inventory_id, order_id, client_id) values
      (100, 100, 100, 1),
      (200, 200, 200, 2);
    insert into packages (id, stock_qty) values (1, 9);
    insert into package_ledger (id, package_id, qty_delta, order_id, shipment_id, note)
      values (100, 1, -1, 100, 100, 'Shipment 100 for order TESTING-HU10-001');
    insert into order_overrides (order_id) values (100);
    insert into mock_labels (shipment_id, order_number) values (-100, 'TESTING-HU10-001');
    insert into print_queue_orders (id, client_id, order_id) values
      ('test-queue', 1, '100'),
      ('real-queue', 2, '200');

    insert into order_lifecycle_events (id, order_id, shipment_id) values
      (100, 100, 100),
      (200, 200, 200);
    insert into fulfillment_line_claims (
      id, lifecycle_event_id, order_id, shipment_id, inventory_id
    ) values (100, 100, 100, 100, 100);
    insert into fulfillment_outbox (id, order_id, shipment_id) values (100, 100, 100);
    insert into external_operations (id, subject_type, subject_id) values
      (100, 'order', '100'),
      (101, 'fulfillment_outbox', '100'),
      (200, 'order', '200');
    insert into shipment_hazmat_snapshots (shipment_id, external_operation_id, capture_kind) values
      (100, 100, 'test_label'),
      (200, 200, 'provider_purchase');

    insert into automation_runs (id, order_id) values (100, 100), (200, 200);
    insert into automation_action_results (id, run_id) values (100, 100), (200, 200);
    insert into automation_reprocess_jobs (id, preview_run_id) values (100, 100);
    insert into order_automation_state (order_id, last_run_id) values (100, 100), (200, 200);
    insert into automation_outbox (aggregate_type, aggregate_id, payload) values
      ('order', '100', '{"orderId":100}'),
      ('order', '200', '{"orderId":200}');

    insert into billing_line_items (
      id, client_id, order_id, shipment_id, ship_date, billing_adjustment_id
    ) values
      (100, 1, 100, 100, '2026-07-25', 'test-adjustment'),
      (200, 2, 200, 200, '2026-07-25', 'real-adjustment');
    insert into billing_finalizations (id, client_id, period_start, period_end) values
      ('test-final', 1, '2026-07-01', '2026-08-01'),
      ('real-final', 2, '2026-07-01', '2026-08-01');
    insert into billing_credit_notes (id, client_id, source_order_id) values
      ('test-credit', 1, 100),
      ('real-credit', 2, 200);

    insert into label_purchase_locks (order_id) values (100);
    insert into label_purchase_intents (id, order_id, shipment_id) values (100, 100, 100);
    insert into billing_manual_overrides (id, client_id, order_id) values (100, 1, 100);
    insert into print_queue_send_jobs (job_id, client_id, client_ids)
      values ('test-send', 1, '[1]');
    insert into print_queue_batch_job_items (id, job_id, order_id, client_id)
      values (100, 'test-send', 100, 1);
    insert into print_queue_merged_pdfs (job_id) values ('test-send'), ('test-merge');
    insert into print_queue_pdf_chunks (job_id, chunk_number) values
      ('test-send', 1), ('test-merge', 1);
    insert into print_queue_merge_jobs (job_id, client_ids) values ('test-merge', '[1]');
    insert into rate_browse_jobs (job_id, order_id) values ('test-rate', 100);
    insert into rate_browse_job_provider_statuses (job_id, provider_key)
      values ('test-rate', 'stamps');
  `);

  await assert.rejects(
    client.exec('delete from order_lifecycle_events where id = 100'),
    /append-only/i,
    'normal code must not delete immutable test history outside the purge transaction',
  );

  const result = await purgeAllTestClientData(
    testDb as unknown as NonNullable<Parameters<typeof purgeAllTestClientData>[0]>,
  );
  assert.equal(result.deleted.orders, 2);
  assert.equal(result.deleted.shipments, 1);
  assert.equal(result.deleted.inventory, 1);
  assert.ok(result.deleted.relatedRecords >= 20);

  const testRoots = await client.query<{ orders: number; shipments: number; inventory: number }>(`
    select
      (select count(*)::int from orders where client_id = 1) as orders,
      (select count(*)::int from shipments where client_id = 1) as shipments,
      (select count(*)::int from inventory where client_id = 1) as inventory
  `);
  assert.deepEqual(testRoots.rows[0], { orders: 0, shipments: 0, inventory: 0 });

  const testResidue = await client.query<{ residue: number }>(`
    select (
      (select count(*) from inventory_ledger where client_id = 1) +
      (select count(*) from package_ledger where order_id in (100, 101)) +
      (select count(*) from order_overrides where order_id in (100, 101)) +
      (select count(*) from automation_runs where order_id in (100, 101)) +
      (select count(*) from automation_action_results where run_id = 100) +
      (select count(*) from automation_reprocess_jobs where preview_run_id = 100) +
      (select count(*) from order_automation_state where order_id in (100, 101)) +
      (select count(*) from automation_outbox where aggregate_id in ('100', '101')) +
      (select count(*) from fulfillment_line_claims where order_id in (100, 101)) +
      (select count(*) from fulfillment_outbox where order_id in (100, 101)) +
      (select count(*) from order_lifecycle_events where order_id in (100, 101)) +
      (select count(*) from shipment_hazmat_snapshots where shipment_id = 100) +
      (select count(*) from billing_line_items where client_id = 1) +
      (select count(*) from billing_finalizations where client_id = 1) +
      (select count(*) from billing_credit_notes where client_id = 1) +
      (select count(*) from label_purchase_locks where order_id in (100, 101)) +
      (select count(*) from label_purchase_intents where order_id in (100, 101)) +
      (select count(*) from billing_manual_overrides where client_id = 1) +
      (select count(*) from mock_labels where order_number like 'TESTING-%') +
      (select count(*) from print_queue_orders where client_id = 1) +
      (select count(*) from print_queue_send_jobs where client_id = 1) +
      (select count(*) from print_queue_batch_job_items where client_id = 1) +
      (select count(*) from print_queue_merge_jobs where client_ids @> '[1]'::jsonb) +
      (select count(*) from print_queue_merged_pdfs where job_id in ('test-send', 'test-merge')) +
      (select count(*) from print_queue_pdf_chunks where job_id in ('test-send', 'test-merge')) +
      (select count(*) from rate_browse_jobs where order_id in (100, 101)) +
      (select count(*) from rate_browse_job_provider_statuses where job_id = 'test-rate') +
      (select count(*) from external_operations where subject_id in ('100', '101'))
    )::int as residue
  `);
  assert.equal(testResidue.rows[0]?.residue, 0);

  const controls = await client.query<{
    clients: number;
    realOrders: number;
    realShipments: number;
    realLedger: number;
    realLifecycle: number;
    realHazmat: number;
    realBilling: number;
    realQueue: number;
    packageStock: number;
  }>(`
    select
      (select count(*)::int from clients) as clients,
      (select count(*)::int from orders where client_id = 2) as "realOrders",
      (select count(*)::int from shipments where client_id = 2) as "realShipments",
      (select count(*)::int from inventory_ledger where client_id = 2) as "realLedger",
      (select count(*)::int from order_lifecycle_events where order_id = 200) as "realLifecycle",
      (select count(*)::int from shipment_hazmat_snapshots where shipment_id = 200) as "realHazmat",
      (select count(*)::int from billing_line_items where client_id = 2) as "realBilling",
      (select count(*)::int from print_queue_orders where client_id = 2) as "realQueue",
      (select stock_qty from packages where id = 1) as "packageStock"
  `);
  assert.deepEqual(controls.rows[0], {
    clients: 2,
    realOrders: 1,
    realShipments: 1,
    realLedger: 1,
    realLifecycle: 1,
    realHazmat: 1,
    realBilling: 1,
    realQueue: 1,
    packageStock: 10,
  });

  await assert.rejects(
    client.exec(`
      begin;
      select set_config('app.test_data_purge', 'on', true);
      delete from order_lifecycle_events where id = 200;
      commit;
    `),
    /append-only/i,
    'even the purge GUC must not authorize real-client history deletion',
  );
  await client.exec('rollback');

  await assert.rejects(
    client.exec(`
      begin;
      select set_config('app.test_data_purge', 'on', true);
      delete from inventory_ledger where id = 200;
      commit;
    `),
    /PS462_INVENTORY_LEDGER_IMMUTABLE/i,
    'the purge GUC must not authorize real-client inventory history deletion',
  );
  await client.exec('rollback');

  console.log('Test-data purge integration passed.');
} finally {
  await client.close();
}
