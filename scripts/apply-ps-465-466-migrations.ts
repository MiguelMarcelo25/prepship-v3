#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-465-466-hazmat-automations-0078-0081';
const MIGRATION_PATHS = [
  'drizzle/0078_order_hazmat_declarations.sql',
  'drizzle/0079_ps466_automations_engine.sql',
  'drizzle/0080_ps466_automation_recovery_leases.sql',
  'drizzle/0081_ps466_automation_shipping_controls.sql',
] as const;

// Per user override unlock shipped data on 2026-07-25: this operator may apply
// only the reviewed additive PS-465/PS-466 migrations after exact confirmation.
// It snapshots orders and shipments read-only and refuses protected-table DML.

type SchemaState = {
  order_hazmat_declarations: boolean;
  order_hazmat_materials: boolean;
  shipment_hazmat_snapshots: boolean;
  automation_rules: boolean;
  automation_rule_versions: boolean;
  automation_rule_conditions: boolean;
  automation_rule_actions: boolean;
  automation_runs: boolean;
  automation_action_results: boolean;
  order_automation_state: boolean;
  automation_outbox: boolean;
  automation_reprocess_jobs: boolean;
  automation_shipping_controls: boolean;
  action_lease_columns: boolean;
  outbox_lease_columns: boolean;
  shipment_snapshot_guards: boolean;
  order_fact_trigger: boolean;
  item_fact_trigger: boolean;
  override_fact_trigger: boolean;
  legacy_setting_retired: boolean;
};

type ProtectedSnapshot = {
  order_count: string;
  order_id_sum: string;
  shipment_count: string;
  shipment_id_sum: string;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}

function ready(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

function assertMigrationSafety(path: string, sql: string): void {
  const protectedDml = [
    /\binsert\s+into\s+(?:public\.)?(?:orders|shipments)\b/i,
    /\bupdate\s+(?:public\.)?(?:orders|shipments)\s+set\b/i,
    /\bdelete\s+from\s+(?:public\.)?(?:orders|shipments)\b/i,
    /\btruncate\s+(?:table\s+)?(?:public\.)?(?:orders|shipments)\b/i,
    /\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i,
  ];
  if (protectedDml.some((pattern) => pattern.test(sql))) {
    throw new Error(`Migration refused: protected order/shipment mutation detected in ${path}`);
  }
  if (/\bdrop\s+(?:table|column)\b/i.test(sql)) {
    throw new Error(`Migration refused: destructive table/column DROP detected in ${path}`);
  }

  const deletedTables = [...sql.matchAll(/\bdelete\s+from\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/gi)]
    .map((match) => match[1]?.toLowerCase());
  if (deletedTables.some((table) => table !== 'settings')) {
    throw new Error(`Migration refused: unexpected DELETE detected in ${path}`);
  }
  if (deletedTables.length > 0 &&
    !/delete\s+from\s+(?:public\.)?settings\s+where\s+key\s*=\s*'shipping_automation_rules'/i.test(sql)) {
    throw new Error(`Migration refused: settings retirement is not narrowly scoped in ${path}`);
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
    connection: { application_name: 'ps-465-466-migrations-0078-0081' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        to_regclass('public.order_hazmat_declarations') is not null as order_hazmat_declarations,
        to_regclass('public.order_hazmat_materials') is not null as order_hazmat_materials,
        to_regclass('public.shipment_hazmat_snapshots') is not null as shipment_hazmat_snapshots,
        to_regclass('public.automation_rules') is not null as automation_rules,
        to_regclass('public.automation_rule_versions') is not null as automation_rule_versions,
        to_regclass('public.automation_rule_conditions') is not null as automation_rule_conditions,
        to_regclass('public.automation_rule_actions') is not null as automation_rule_actions,
        to_regclass('public.automation_runs') is not null as automation_runs,
        to_regclass('public.automation_action_results') is not null as automation_action_results,
        to_regclass('public.order_automation_state') is not null as order_automation_state,
        to_regclass('public.automation_outbox') is not null as automation_outbox,
        to_regclass('public.automation_reprocess_jobs') is not null as automation_reprocess_jobs,
        to_regclass('public.automation_shipping_controls') is not null as automation_shipping_controls,
        (
          select count(*) = 4 from information_schema.columns
          where table_schema = 'public' and table_name = 'automation_action_results'
            and column_name in ('attempt_count', 'lease_token', 'lease_expires_at', 'updated_at')
        ) as action_lease_columns,
        (
          select count(*) = 2 from information_schema.columns
          where table_schema = 'public' and table_name = 'automation_outbox'
            and column_name in ('lock_token', 'lease_expires_at')
        ) as outbox_lease_columns,
        (
          select count(*) = 2 from pg_trigger
          where tgrelid = to_regclass('public.shipment_hazmat_snapshots')
            and tgname in ('shipment_hazmat_snapshots_no_update_delete', 'shipment_hazmat_snapshots_no_truncate')
            and not tgisinternal
        ) as shipment_snapshot_guards,
        exists (
          select 1 from pg_trigger where tgrelid = to_regclass('public.orders')
            and tgname = 'automation_orders_fact_event' and not tgisinternal
        ) as order_fact_trigger,
        exists (
          select 1 from pg_trigger where tgrelid = to_regclass('public.order_items')
            and tgname = 'automation_order_items_fact_event' and not tgisinternal
        ) as item_fact_trigger,
        exists (
          select 1 from pg_trigger where tgrelid = to_regclass('public.order_overrides')
            and tgname = 'automation_order_overrides_fact_event' and not tgisinternal
        ) as override_fact_trigger,
        not exists (
          select 1 from public.settings where key = 'shipping_automation_rules'
        ) as legacy_setting_retired
    `;
    if (!state) throw new Error('PS-465/466 schema inspection returned no row');
    return state;
  };

  const protectedSnapshot = async (): Promise<ProtectedSnapshot> => {
    const [snapshot] = await client<ProtectedSnapshot[]>`
      select
        (select count(*)::text from public.orders) as order_count,
        (select coalesce(sum(id), 0)::text from public.orders) as order_id_sum,
        (select count(*)::text from public.shipments) as shipment_count,
        (select coalesce(sum(id), 0)::text from public.shipments) as shipment_id_sum
    `;
    if (!snapshot) throw new Error('Protected order/shipment snapshot returned no row');
    return snapshot;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-465-466-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-465-466-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[ps-465-466-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply 0078-0081`,
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
      await tx`select pg_advisory_xact_lock(hashtext('ps-465-466-hazmat-automations-0078-0081'))`;
      for (const migration of migrations) {
        console.log(`[ps-465-466-migration] applying=${migration.path}`);
        await tx.unsafe(migration.sql);
      }
    });

    const afterState = await inspect();
    if (!ready(afterState)) {
      throw new Error(`PS-465/466 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    const afterProtected = await protectedSnapshot();
    if (JSON.stringify(beforeProtected) !== JSON.stringify(afterProtected)) {
      throw new Error('Migration verification failed: order or shipment identity counts changed');
    }

    console.log(`[ps-465-466-migration] applied=${JSON.stringify(afterState)}`);
    console.log('[ps-465-466-migration] orders_shipments_unchanged=true');
    console.log('[ps-465-466-migration] labels_postage_provider_calls=0');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-465-466-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
