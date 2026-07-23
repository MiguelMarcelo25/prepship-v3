/**
 * PS-455 migration-owned runtime schema proof.
 *
 * Offline only: PGlite applies the real additive migration to an empty
 * database, then reapplies it after representative durable rows exist. No
 * configured database, provider, label/postage, or production data is used.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync('drizzle/0062_runtime_schema_ownership.sql', 'utf8');
const requiredRelations = [
  'billing_fee_waivers',
  'billing_manual_overrides',
  'direct_carrier_rate_cache',
  'label_purchase_intents',
  'label_purchase_locks',
  'print_queue_batch_job_items',
  'print_queue_merged_pdfs',
  'print_queue_pdf_chunks',
  'print_queue_send_jobs',
  'rate_browse_job_provider_statuses',
  'rate_browse_jobs',
  'rate_limiter_state',
  'worker_status_events',
] as const;

assert.doesNotMatch(
  migration,
  /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i,
  '0062 contains no data mutation or backfill',
);
assert.doesNotMatch(
  migration,
  /\b(?:DROP\s+(?:TABLE|COLUMN)|ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments))\b/i,
  '0062 never destructively alters protected orders or shipments schema',
);

const pg = new PGlite();

try {
  await pg.exec(migration);

  const relations = await pg.query<{ relation_name: string; rls_enabled: boolean }>(`
    select c.relname as relation_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = any($1::text[])
    order by c.relname
  `, [[...requiredRelations]]);
  assert.deepEqual(
    relations.rows.map((row) => row.relation_name),
    [...requiredRelations].sort(),
    'fresh database receives every migration-owned runtime relation',
  );
  assert.ok(
    relations.rows.every((row) => row.rls_enabled),
    'every migration-owned runtime relation has RLS enabled',
  );

  await pg.exec(`
    insert into label_purchase_locks
      (order_id, token, owner, expires_at)
    values
      (45501, 'offline-token', 'ps-455-fixture', now() + interval '5 minutes');

    insert into print_queue_send_jobs
      (job_id, status, snapshot)
    values
      ('ps-455-queue', 'pending', '{"source":"offline-fixture"}'::jsonb);

    insert into rate_browse_jobs
      (job_id, status, snapshot)
    values
      ('ps-455-rate', 'pending', '{"source":"offline-fixture"}'::jsonb);

    insert into worker_status_events
      (event_type, details)
    values
      ('ps-455-fixture', '{"offline":true}'::jsonb);
  `);

  const beforeReplay = await pg.query<{
    label_locks: number;
    queue_jobs: number;
    rate_jobs: number;
    worker_events: number;
  }>(`
    select
      (select count(*)::int from label_purchase_locks) as label_locks,
      (select count(*)::int from print_queue_send_jobs) as queue_jobs,
      (select count(*)::int from rate_browse_jobs) as rate_jobs,
      (select count(*)::int from worker_status_events) as worker_events
  `);
  const catalogBeforeReplay = await pg.query<{
    relation_name: string;
    relation_kind: string;
    rls_enabled: boolean;
  }>(`
    select
      c.relname as relation_name,
      c.relkind::text as relation_kind,
      c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    order by c.relkind, c.relname
  `);

  await pg.exec(migration);

  const afterReplay = await pg.query<{
    label_locks: number;
    queue_jobs: number;
    rate_jobs: number;
    worker_events: number;
  }>(`
    select
      (select count(*)::int from label_purchase_locks) as label_locks,
      (select count(*)::int from print_queue_send_jobs) as queue_jobs,
      (select count(*)::int from rate_browse_jobs) as rate_jobs,
      (select count(*)::int from worker_status_events) as worker_events
  `);
  const catalogAfterReplay = await pg.query<{
    relation_name: string;
    relation_kind: string;
    rls_enabled: boolean;
  }>(`
    select
      c.relname as relation_name,
      c.relkind::text as relation_kind,
      c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    order by c.relkind, c.relname
  `);

  assert.deepEqual(
    afterReplay.rows,
    beforeReplay.rows,
    'existing durable rows survive an idempotent migration replay',
  );
  assert.deepEqual(
    catalogAfterReplay.rows,
    catalogBeforeReplay.rows,
    'existing database receives no schema drift on migration replay',
  );
} finally {
  await pg.close();
}

console.log('PASS PS-455 runtime schema migration fresh/existing database integration');
