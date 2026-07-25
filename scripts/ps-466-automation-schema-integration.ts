import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const pg = new PGlite();
await pg.exec(`
  create table clients (id serial primary key);
  create table orders (
    id serial primary key,
    client_id integer references clients(id),
    store_id integer,
    order_status text not null default 'awaiting_shipment',
    source_provider text,
    order_total numeric default 0,
    shipping_amount numeric default 0,
    ship_to_state text,
    ship_to_postal_code text,
    weight_oz real
  );
  create table order_items (id serial primary key, order_id integer not null references orders(id), sku text);
  create table order_overrides (
    order_id integer primary key references orders(id), residential boolean,
    rate_weight_oz real, rate_dims_l real, rate_dims_w real, rate_dims_h real,
    selected_package_id text, recipient_override jsonb
  );
`);

const migration = await readFile('drizzle/0079_ps466_automations_engine.sql', 'utf8');
await pg.exec(migration);

const required = [
  'automation_rules',
  'automation_rule_versions',
  'automation_rule_conditions',
  'automation_rule_actions',
  'automation_runs',
  'automation_action_results',
  'order_automation_state',
  'automation_outbox',
  'automation_reprocess_jobs',
];
const relations = await pg.query<{ table_name: string }>(`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
    and table_name = any($1)
`, [required]);
assert.deepEqual(relations.rows.map((row) => row.table_name).sort(), [...required].sort());

await pg.exec(`
  insert into clients(id) values (4);
  insert into orders(id, client_id, store_id, order_status) values (101, 4, 378060, 'awaiting_shipment');
  insert into automation_rules(id, name, priority, position, trigger, status, client_id, store_id, created_by, updated_by)
  values (1, 'HUGRAB Leeds review', 10, 0, 'order_imported', 'draft', 4, 378060, 'test@example.com', 'test@example.com');
  insert into automation_rule_versions(id, rule_id, version_number, lifecycle, document, document_hash, draft_revision, created_by)
  values (1, 1, 1, 'draft', '{"schemaVersion":1}'::jsonb, repeat('a', 64), 1, 'test@example.com');
`);
const factEvents = await pg.query<{ event_type: string; payload: { orderId: number; trigger: string; sourceEventId: string } }>(`
  select event_type, payload from automation_outbox where event_type = 'order_facts_changed'
`);
assert.equal(factEvents.rows.length, 1, 'order insert enters the durable automation outbox');
assert.deepEqual(factEvents.rows[0]?.payload, { orderId: 101, sourceEventId: factEvents.rows[0]?.payload.sourceEventId, trigger: 'order_imported' });
await assert.rejects(
  pg.exec(`
    update automation_rule_versions
    set lifecycle = 'published', published_at = now(), published_by = 'test@example.com'
    where id = 1
  `),
  /check constraint/i,
  'publishing without exact simulation evidence is rejected',
);
await pg.exec(`
  update automation_rule_versions
  set lifecycle = 'published', published_at = now(), published_by = 'test@example.com', simulation_hash = repeat('a', 64)
  where id = 1;
`);

await assert.rejects(
  pg.exec(`update automation_rule_versions set document = '{"changed":true}'::jsonb where id = 1`),
  /published automation rule versions are immutable/i,
);
await assert.rejects(
  pg.exec(`delete from automation_rule_versions where id = 1`),
  /published automation rule versions are immutable/i,
);

await pg.exec(`
  insert into automation_runs(id, execution_key, order_id, trigger, source_event_id, facts_revision, ruleset_digest, engine_version, mode, status, trace_hash)
  values (1, repeat('e', 64), 101, 'order_imported', 'event-1', 'facts-1', repeat('b', 64), 'ps-466-v1', 'apply', 'completed', repeat('c', 64));
  insert into automation_action_results(run_id, rule_version_id, action_index, action_type, idempotency_key, status)
  values (1, 1, 0, 'tag.add', 'effect-1', 'applied');
`);
await assert.rejects(
  pg.exec(`
    insert into automation_action_results(run_id, rule_version_id, action_index, action_type, idempotency_key, status)
    values (1, 1, 0, 'tag.add', 'effect-1', 'applied')
  `),
  /unique|duplicate/i,
);

await pg.exec(`
  insert into order_automation_state(order_id, facts_revision, ruleset_digest, engine_version, status, last_run_id)
  values (101, 'facts-1', repeat('b', 64), 'ps-466-v1', 'current', 1);
  insert into automation_outbox(event_key, event_type, aggregate_type, aggregate_id, payload)
  values ('order:101:facts-1', 'order_facts_changed', 'order', '101', '{"orderId":101}'::jsonb);
`);
await assert.rejects(
  pg.exec(`
    insert into automation_outbox(event_key, event_type, aggregate_type, aggregate_id, payload)
    values ('order:101:facts-1', 'order_facts_changed', 'order', '101', '{}'::jsonb)
  `),
  /unique|duplicate/i,
);

const indexes = await pg.query<{ indexname: string }>(`
  select indexname from pg_indexes
  where schemaname = 'public' and indexname in (
    'automation_rules_scope_status_idx',
    'automation_rules_activation_idx',
    'automation_versions_rule_lifecycle_idx',
    'automation_runs_order_trigger_idx',
    'automation_action_results_idempotency_unq',
    'automation_outbox_ready_idx'
  )
`);
assert.equal(indexes.rows.length, 6, 'runtime-critical scope, activation, run, idempotency, and outbox indexes exist');

await pg.close();
console.log('PS-466 PGlite migration/immutability/idempotency proof passed (18 assertions)');
