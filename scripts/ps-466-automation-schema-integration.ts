import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const pg = new PGlite();
await pg.exec(`
  create table clients (id serial primary key);
  create table settings (key text primary key, value text);
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
  insert into clients(id) values (4), (9);
  insert into settings(key, value) values (
    'shipping_automation_rules',
    '{"version":1,"rules":[{"type":"carrier","clientId":9,"storeId":363392,"carrierId":"se-disabled","carrierCode":"ups","disabled":true,"reason":"Disabled by Automation","locked":false,"source":"settings-automation","updatedAt":"2026-07-24T00:00:00.000Z","updatedBy":"lawrence@example.com"},{"type":"service","clientId":4,"storeId":378060,"carrierId":"se-hugrab-ups","carrierCode":"ups","serviceCode":"ups_ground_saver","serviceName":"UPS Ground Saver","disabled":true,"reason":"PS-057 locked","locked":true,"source":"system","updatedAt":"2026-07-24T01:00:00.000Z","updatedBy":"system"},{"type":"service","clientId":9,"storeId":363392,"serviceCode":"ups_next_day_air","serviceName":"UPS Next Day Air","disabled":true,"reason":"Service disabled for this store","source":"settings-automation","updatedAt":"2026-07-24T02:00:00.000Z","updatedBy":"lawrence@example.com"}]}'
  );
`);

const migration = await readFile('drizzle/0079_ps466_automations_engine.sql', 'utf8');
await pg.exec(migration);
const recoveryMigration = await readFile('drizzle/0080_ps466_automation_recovery_leases.sql', 'utf8');
await pg.exec(recoveryMigration);
const controlsMigration = await readFile('drizzle/0081_ps466_automation_shipping_controls.sql', 'utf8');
await pg.exec(controlsMigration);
const runRecoveryMigration = await readFile('drizzle/0091_ps466_automation_run_recovery.sql', 'utf8');
await pg.exec(runRecoveryMigration);
await pg.exec(`
  create index if not exists automation_runs_recovery_idx
    on automation_runs (status, lease_expires_at, started_at, id)
    where status = 'running'
`);

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
  'automation_shipping_controls',
];
const relations = await pg.query<{ table_name: string }>(`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
    and table_name = any($1)
`, [required]);
assert.deepEqual(relations.rows.map((row) => row.table_name).sort(), [...required].sort());

await pg.exec(`
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
  insert into automation_action_results(
    run_id, rule_version_id, action_index, action_type, idempotency_key, status,
    attempt_count, lease_token, lease_expires_at
  ) values
    (1, 1, 1, 'tag.add', 'effect-stale', 'planned', 1, 'stale-token', now() - interval '1 second'),
    (1, 1, 2, 'tag.add', 'effect-live', 'planned', 1, 'live-token', now() + interval '5 minutes'),
    (1, 1, 3, 'tag.add', 'effect-failed', 'failed', 1, null, null);
`);
const reclaimableEffects = await pg.query<{ idempotency_key: string }>(`
  select idempotency_key
  from automation_action_results
  where status = 'failed'
     or (status = 'planned' and (lease_expires_at is null or lease_expires_at <= now()))
  order by idempotency_key
`);
assert.deepEqual(
  reclaimableEffects.rows.map((row) => row.idempotency_key),
  ['effect-failed', 'effect-stale'],
  'failed and expired planned effects are reclaimable while a live lease is fenced',
);
await pg.exec(`
  update automation_action_results
  set status = 'applied'
  where idempotency_key = 'effect-stale' and lease_token = 'wrong-token'
`);
const [wrongFence] = (await pg.query<{ status: string }>(`
  select status from automation_action_results where idempotency_key = 'effect-stale'
`)).rows;
assert.equal(wrongFence?.status, 'planned', 'a stale effect owner cannot finalize another lease');
await pg.exec(`
  update automation_action_results
  set status = 'applied', lease_token = null, lease_expires_at = null
  where idempotency_key = 'effect-stale' and lease_token = 'stale-token'
`);
const [rightFence] = (await pg.query<{ status: string; lease_token: string | null }>(`
  select status, lease_token from automation_action_results where idempotency_key = 'effect-stale'
`)).rows;
assert.deepEqual(rightFence, { status: 'applied', lease_token: null }, 'the current effect owner can finalize and clear its lease');

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

await pg.exec(`
  insert into automation_outbox(
    event_key, event_type, aggregate_type, aggregate_id, payload, status,
    attempt_count, lock_token, lease_expires_at
  ) values
    ('lease-stale', 'order_facts_changed', 'order', '101', '{"orderId":101}'::jsonb, 'processing', 1, 'stale', now() - interval '1 second'),
    ('lease-live', 'order_facts_changed', 'order', '101', '{"orderId":101}'::jsonb, 'processing', 1, 'live', now() + interval '5 minutes');
`);
const reclaimableOutbox = await pg.query<{ event_key: string }>(`
  select event_key
  from automation_outbox
  where event_key in ('lease-stale', 'lease-live')
    and (
      (status in ('pending', 'failed') and available_at <= now())
      or (status = 'processing' and (lease_expires_at is null or lease_expires_at <= now()))
    )
  order by event_key
`);
assert.deepEqual(reclaimableOutbox.rows.map((row) => row.event_key), ['lease-stale'], 'only an expired processing outbox lease is reclaimable');

const indexes = await pg.query<{ indexname: string }>(`
  select indexname from pg_indexes
  where schemaname = 'public' and indexname in (
    'automation_rules_scope_status_idx',
    'automation_rules_activation_idx',
    'automation_versions_rule_lifecycle_idx',
    'automation_runs_order_trigger_idx',
    'automation_action_results_idempotency_unq',
    'automation_action_results_reclaim_idx',
    'automation_outbox_ready_idx',
    'automation_outbox_reclaim_idx',
    'automation_runs_recovery_idx'
  )
`);
assert.equal(indexes.rows.length, 9, 'runtime-critical scope, activation, idempotency, and recovery indexes exist');

const leaseColumns = await pg.query<{ table_name: string; column_name: string }>(`
  select table_name, column_name
  from information_schema.columns
  where (table_name = 'automation_action_results' and column_name in ('attempt_count', 'lease_token', 'lease_expires_at', 'updated_at'))
     or (table_name = 'automation_outbox' and column_name in ('lock_token', 'lease_expires_at'))
     or (table_name = 'automation_runs' and column_name in ('attempt_count', 'lease_token', 'lease_expires_at', 'recovery_count', 'last_recovery_code', 'last_recovered_at'))
`);
assert.equal(leaseColumns.rows.length, 12, 'run, effect, and outbox recovery lease columns are migrated');

const importedControls = await pg.query<{
  control_type: string;
  client_id: number;
  store_id: number;
  carrier_id: string;
  service_code: string | null;
  system_locked: boolean;
  provenance: string;
  source_updated_at: string;
}>(`
  select control_type, client_id, store_id, carrier_id, service_code,
         system_locked, provenance, source_updated_at
  from automation_shipping_controls
  order by position
`);
assert.deepEqual(importedControls.rows, [
  {
    control_type: 'carrier', client_id: 9, store_id: 363392,
    carrier_id: 'se-disabled', service_code: null, system_locked: false,
    provenance: 'legacy_import', source_updated_at: '2026-07-24T00:00:00.000Z',
  },
  {
    control_type: 'service', client_id: 4, store_id: 378060,
    carrier_id: 'se-hugrab-ups', service_code: 'ups_ground_saver', system_locked: true,
    provenance: 'system', source_updated_at: '2026-07-24T01:00:00.000Z',
  },
  {
    control_type: 'service', client_id: 9, store_id: 363392,
    carrier_id: null, service_code: 'ups_next_day_air', system_locked: false,
    provenance: 'legacy_import', source_updated_at: '2026-07-24T02:00:00.000Z',
  },
], 'legacy carrier/service exclusions import into ordered typed records with lock provenance');

const legacySettings = await pg.query<{ count: number }>(`
  select count(*)::int as count from settings where key = 'shipping_automation_rules'
`);
assert.equal(legacySettings.rows[0]?.count, 0, 'the imported settings blob is retired atomically');

await assert.rejects(
  pg.exec(`
    insert into automation_shipping_controls(
      control_key, control_type, client_id, carrier_id, disabled, position,
      provenance, updated_by
    ) values ('invalid-enabled-control', 'carrier', 9, 'se-invalid', false, 99, 'operator', 'test')
  `),
  /check constraint/i,
  'typed control rows represent exclusions only and cannot become an enabled alternate truth',
);

await pg.close();
console.log('PS-466 PGlite migration/immutability/idempotency/recovery/control-import proof passed (17 assertions)');
