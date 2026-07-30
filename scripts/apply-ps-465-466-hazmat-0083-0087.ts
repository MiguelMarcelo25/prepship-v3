#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// Operator for the five PS-465/PS-466 follow-up migrations that shipped without
// one. 0078-0081 have apply-ps-465-466-migrations.ts and 0082 has
// apply-test-data-purge-guards.ts; 0083-0087 had no script, no workflow and no
// drizzle journal entry (the journal stops at 0015, so `db:migrate` skips every
// hand-written migration in this range). They were applied to production by
// hand, which left no repeatable path for any other environment.
//
// All five are additive and individually idempotent: constraint swaps are
// DROP IF EXISTS + ADD, tables and indexes are IF NOT EXISTS, functions are
// CREATE OR REPLACE, and the one new column is ADD COLUMN IF NOT EXISTS. Running
// this against a database that already has them is a no-op that still verifies.
//
// Two operational notes:
//   - 0085 builds a GIN index on automation_runs, the highest-volume table in
//     this schema. It runs inside the migration transaction, so it takes a write
//     lock on that table for the duration. CONCURRENTLY is not available inside
//     a transaction, and splitting it out would give up all-or-nothing.
//   - 0087 must land BEFORE the code that reads products.hazmat deploys. Drizzle
//     emits every mapped column on a bare select(), so a build ahead of this
//     migration 500s on every product read.
//
// Orders and shipments are read here for a before/after identity snapshot only.
// The migrations themselves are refused if they contain any order/shipment DML.

const CONFIRMATION = 'apply-ps-465-466-hazmat-automations-0083-0087';
const MIGRATION_PATHS = [
  'drizzle/0083_hazmat_test_profile_constraint.sql',
  'drizzle/0084_automation_publish_gate.sql',
  'drizzle/0085_automation_delete_unexecuted_published.sql',
  'drizzle/0086_hazmat_contacts.sql',
  'drizzle/0087_products_hazmat_flag.sql',
] as const;

const PREREQUISITE_RELATIONS = [
  'shipment_hazmat_snapshots',
  'automation_rule_versions',
  'automation_runs',
  'automation_action_results',
  'automation_reprocess_jobs',
  'clients',
  'products',
] as const;

type SchemaState = {
  profile_constraint_widened: boolean;
  profile_constraint_intact: boolean;
  publish_gate_column: boolean;
  publish_gate_constraint: boolean;
  publish_evidence_constraint: boolean;
  matched_versions_index: boolean;
  version_immutable_delete_guard: boolean;
  version_child_delete_guard: boolean;
  hazmat_contacts_table: boolean;
  hazmat_contacts_scope_index: boolean;
  hazmat_contacts_unique_index: boolean;
  hazmat_contacts_checks: boolean;
  products_hazmat_column: boolean;
  products_hazmat_default: boolean;
  products_hazmat_index: boolean;
};

type ProtectedSnapshot = {
  order_count: string;
  order_id_sum: string;
  shipment_count: string;
  shipment_id_sum: string;
  hazmat_snapshot_count: string;
  product_count: string;
  rule_version_count: string;
  published_version_count: string;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}

function ready(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

function missingKeys(state: SchemaState): string[] {
  return Object.entries(state)
    .filter(([, present]) => !present)
    .map(([key]) => key);
}

// Comments in this range legitimately discuss TRUNCATE, DELETE and DROP in
// prose (0083 explains that the snapshot table's UPDATE/DELETE/TRUNCATE
// blocking triggers are unchanged). Scanning raw text for those words would
// refuse a safe migration, so the structural checks run against comment-stripped
// SQL. The order/shipment checks still run against the RAW text, so stripping
// can never be used to hide protected-table DML behind a `--`.
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function assertMigrationSafety(path: string, sql: string): void {
  const protectedDml: Array<[RegExp, string]> = [
    [/\binsert\s+into\s+(?:public\.)?(?:orders|shipments)\b/i, 'INSERT into orders/shipments'],
    [/\bupdate\s+(?:public\.)?(?:orders|shipments)\s+set\b/i, 'UPDATE of orders/shipments'],
    [/\bdelete\s+from\s+(?:public\.)?(?:orders|shipments)\b/i, 'DELETE from orders/shipments'],
    [/\btruncate\s+(?:table\s+)?(?:public\.)?(?:orders|shipments)\b/i, 'TRUNCATE of orders/shipments'],
    [/\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i, 'ALTER of orders/shipments'],
  ];
  for (const [pattern, label] of protectedDml) {
    if (pattern.test(sql)) {
      throw new Error(`Migration refused: ${label} detected in ${path}`);
    }
  }

  // 0083 drops and re-adds a CHECK on the append-only snapshot table; widening
  // that constraint is the entire point of the migration. Removing the triggers
  // that make the table append-only is a different thing and stays forbidden.
  const structural: Array<[RegExp, string]> = [
    [/\bdrop\s+(?:table|column)\b/i, 'destructive table/column DROP'],
    [/\bdrop\s+trigger\b/i, 'trigger DROP'],
    [/\balter\s+table\s+[a-z_."]+\s+disable\s+trigger\b/i, 'trigger DISABLE'],
    [/\btruncate\b/i, 'TRUNCATE'],
    [/\bdelete\s+from\b/i, 'row DELETE'],
  ];
  const statements = stripSqlComments(sql);
  for (const [pattern, label] of structural) {
    if (pattern.test(statements)) {
      throw new Error(`Migration refused: ${label} detected in ${path}`);
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-465-466-hazmat-0083-0087' },
  });

  // 0083 widens a constraint created by 0078; 0084 and 0085 alter tables and
  // functions created by 0079. Applying this range against a database that
  // never ran 0078-0081 fails partway through with a confusing error, so it is
  // refused up front with a message that names the missing owner.
  const assertPrerequisites = async (): Promise<void> => {
    const rows = await client<{ relation: string; present: boolean }[]>`
      select
        relation,
        to_regclass('public.' || relation) is not null as present
      from unnest(${client.array([...PREREQUISITE_RELATIONS])}::text[]) as relation
    `;
    const missing = rows.filter((row) => !row.present).map((row) => row.relation);
    if (missing.length > 0) {
      throw new Error(
        `Missing prerequisite relations (${missing.join(', ')}). ` +
          'Run migrate:ps-465-466-rollout (0078-0081) before this range.',
      );
    }
  };

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        coalesce((
          select pg_get_constraintdef(oid) like '%prepship_test%'
          from pg_constraint where conname = 'shipment_hazmat_snapshots_profile_chk'
        ), false) as profile_constraint_widened,
        -- Widening, not weakening: every profile 0078 allowed must still be allowed.
        coalesce((
          select pg_get_constraintdef(oid) like '%shipstation_usps%'
            and pg_get_constraintdef(oid) like '%shipstation_ups_dry_ice%'
            and pg_get_constraintdef(oid) like '%shipstation_ups_dangerous_goods%'
            and pg_get_constraintdef(oid) like '%ups_direct%'
            and pg_get_constraintdef(oid) like '%walmart%'
          from pg_constraint where conname = 'shipment_hazmat_snapshots_profile_chk'
        ), false) as profile_constraint_intact,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'automation_rule_versions'
            and column_name = 'publish_gate'
        ) as publish_gate_column,
        exists (
          select 1 from pg_constraint where conname = 'automation_versions_publish_gate_chk'
        ) as publish_gate_constraint,
        -- The rewritten evidence constraint is the one that knows about the
        -- exemption; the pre-0084 constraint has the same name and does not.
        coalesce((
          select pg_get_constraintdef(oid) like '%low_risk_exempt%'
          from pg_constraint where conname = 'automation_versions_publish_evidence_chk'
        ), false) as publish_evidence_constraint,
        to_regclass('public.automation_runs_matched_versions_gin') is not null
          as matched_versions_index,
        -- rule_id is written NULL by the engine, so a guard that checks only it
        -- is always false. matched_rule_version_ids is the real signal and its
        -- presence is what proves 0085's function bodies actually landed.
        coalesce(position('matched_rule_version_ids' in pg_get_functiondef(
          to_regprocedure('public.automation_rule_version_immutable()'))) > 0, false)
          as version_immutable_delete_guard,
        coalesce(position('matched_rule_version_ids' in pg_get_functiondef(
          to_regprocedure('public.automation_rule_version_child_immutable()'))) > 0, false)
          as version_child_delete_guard,
        to_regclass('public.hazmat_contacts') is not null as hazmat_contacts_table,
        to_regclass('public.hazmat_contacts_scope_idx') is not null as hazmat_contacts_scope_index,
        to_regclass('public.hazmat_contacts_unique_live') is not null
          as hazmat_contacts_unique_index,
        (
          select count(*) = 2 from pg_constraint
          where conname in ('hazmat_contacts_name_chk', 'hazmat_contacts_phone_chk')
        ) as hazmat_contacts_checks,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'products' and column_name = 'hazmat'
        ) as products_hazmat_column,
        -- NOT NULL DEFAULT false is the part that keeps existing rows readable.
        coalesce((
          select is_nullable = 'NO' and column_default like '%false%'
          from information_schema.columns
          where table_schema = 'public' and table_name = 'products' and column_name = 'hazmat'
        ), false) as products_hazmat_default,
        to_regclass('public.products_hazmat_idx') is not null as products_hazmat_index
    `;
    if (!state) throw new Error('PS-465/466 0083-0087 schema inspection returned no row');
    return state;
  };

  const protectedSnapshot = async (): Promise<ProtectedSnapshot> => {
    const [snapshot] = await client<ProtectedSnapshot[]>`
      select
        (select count(*)::text from public.orders) as order_count,
        (select coalesce(sum(id), 0)::text from public.orders) as order_id_sum,
        (select count(*)::text from public.shipments) as shipment_count,
        (select coalesce(sum(id), 0)::text from public.shipments) as shipment_id_sum,
        -- 0083 swaps a constraint on this append-only table; the row count
        -- proves the swap validated existing rows instead of discarding them.
        (select count(*)::text from public.shipment_hazmat_snapshots) as hazmat_snapshot_count,
        (select count(*)::text from public.products) as product_count,
        -- 0085 relaxes a DELETE guard. The audit trail it protects must be the
        -- same size afterwards.
        (select count(*)::text from public.automation_rule_versions) as rule_version_count,
        (select count(*)::text from public.automation_rule_versions
          where lifecycle = 'published') as published_version_count
    `;
    if (!snapshot) throw new Error('Protected snapshot returned no row');
    return snapshot;
  };

  try {
    await assertPrerequisites();

    const beforeState = await inspect();
    console.log(`[ps-465-466-hazmat-0083-0087] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-465-466-hazmat-0083-0087] already_applied=true');
      return;
    }
    console.log(`[ps-465-466-hazmat-0083-0087] missing=${missingKeys(beforeState).join(',')}`);
    if (!approved()) {
      console.log(
        `[ps-465-466-hazmat-0083-0087] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply 0083-0087`,
      );
      return;
    }

    const migrations = MIGRATION_PATHS.map((path) => {
      const sql = readFileSync(path, 'utf8');
      assertMigrationSafety(path, sql);
      return { path, sql };
    });
    const beforeProtected = await protectedSnapshot();

    await client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ps-465-466-hazmat-automations-0083-0087'))`;
      for (const migration of migrations) {
        console.log(`[ps-465-466-hazmat-0083-0087] applying=${migration.path}`);
        await tx.unsafe(migration.sql);
      }
    });

    const afterState = await inspect();
    if (!ready(afterState)) {
      throw new Error(
        `0083-0087 verification failed, missing: ${missingKeys(afterState).join(', ')}`,
      );
    }
    const afterProtected = await protectedSnapshot();
    if (JSON.stringify(beforeProtected) !== JSON.stringify(afterProtected)) {
      throw new Error(
        '0083-0087 verification failed: protected row counts changed ' +
          `(before=${JSON.stringify(beforeProtected)} after=${JSON.stringify(afterProtected)})`,
      );
    }

    console.log(`[ps-465-466-hazmat-0083-0087] applied=${JSON.stringify(afterState)}`);
    console.log('[ps-465-466-hazmat-0083-0087] orders_shipments_unchanged=true');
    console.log('[ps-465-466-hazmat-0083-0087] audit_trail_unchanged=true');
    console.log('[ps-465-466-hazmat-0083-0087] labels_postage_provider_calls=0');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(
    '[ps-465-466-hazmat-0083-0087] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
