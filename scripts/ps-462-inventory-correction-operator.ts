#!/usr/bin/env tsx
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../src/db/client.js';
import {
  assertInventoryCorrectionApproval,
  buildInventoryCorrectionPlan,
} from '../src/services/inventory-correction-plan.js';
import { applyInventoryMovementInTransaction } from '../src/services/inventory-movement.js';
import {
  buildInventoryReconciliationPlan,
  buildInventoryReconciliationPlanInTransaction,
} from '../src/services/inventory-reconciliation.js';

const APPLY_CONFIRMATION = 'apply-ps-462-inventory-correction';
const MAINTENANCE_CONFIRMATION = 'api-workers-stopped-inventory-auto-deduct-disabled';

type SchemaState = {
  identity_columns: boolean;
  nonzero_constraint: boolean;
  insert_guard: boolean;
  update_delete_guard: boolean;
  truncate_guard: boolean;
  idempotency_index: boolean;
  source_identity_index: boolean;
  legacy_stock_column: boolean;
};

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function schemaReady(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

async function inspectSchema(databaseUrl: string): Promise<SchemaState> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe('set transaction read only');
      const [state] = await tx<SchemaState[]>`
        select
          (select count(*) = 4 from information_schema.columns
            where table_schema = 'public' and table_name = 'inventory_ledger'
              and column_name in ('client_id', 'sku', 'source_entity', 'source_id')) as identity_columns,
          exists (select 1 from pg_constraint where conrelid = to_regclass('public.inventory_ledger')
            and conname = 'inventory_ledger_nonzero_qty_chk') as nonzero_constraint,
          exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
            and tgname = 'inventory_ledger_prepare_insert_guard' and not tgisinternal and tgenabled <> 'D') as insert_guard,
          exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
            and tgname = 'inventory_ledger_no_update_delete' and not tgisinternal and tgenabled <> 'D') as update_delete_guard,
          exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
            and tgname = 'inventory_ledger_no_truncate' and not tgisinternal and tgenabled <> 'D') as truncate_guard,
          to_regclass('public.inventory_ledger_idempotency_key_unq') is not null as idempotency_index,
          to_regclass('public.inventory_ledger_source_identity_unq') is not null as source_identity_index,
          exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = 'inventory' and column_name = 'stock_qty') as legacy_stock_column
      `;
      if (!state) throw new Error('PS462_CORRECTION_SCHEMA_INSPECTION_EMPTY');
      return state;
    });
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const apply = process.argv.includes('--apply');
  const schema = await inspectSchema(databaseUrl);
  const sourcePlan = await buildInventoryReconciliationPlan({});
  const correctionPlan = buildInventoryCorrectionPlan(sourcePlan);

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'READ_ONLY_PREFLIGHT',
      productionMutation: false,
      schemaReady: schemaReady(schema),
      schema,
      planHash: correctionPlan.sourcePlanHash,
      movementsSha256: correctionPlan.movementsSha256,
      rows: correctionPlan.rows.length,
      correctionQuantity: correctionPlan.correctionQuantity,
      blocked: !schemaReady(schema) || correctionPlan.rows.length === 0,
    }, null, 2));
    return;
  }

  if (!process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`)) {
    throw new Error('PS462_CORRECTION_EXACT_CONFIRMATION_REQUIRED');
  }
  if (!process.argv.includes(`--maintenance-confirm=${MAINTENANCE_CONFIRMATION}`)) {
    throw new Error('PS462_CORRECTION_MAINTENANCE_CONFIRMATION_REQUIRED');
  }
  if (!schemaReady(schema)) throw new Error('PS462_CORRECTION_SCHEMA_NOT_READY');
  if (correctionPlan.rows.length === 0) throw new Error('PS462_CORRECTION_HAS_NO_MOVEMENTS');
  assertInventoryCorrectionApproval(
    correctionPlan,
    argument('plan-hash'),
    argument('movements-sha'),
  );
  const createdBy = argument('created-by')?.trim();
  if (!createdBy) throw new Error('PS462_CORRECTION_CREATED_BY_REQUIRED');

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local lock_timeout = '5s'"));
    await tx.execute(sql.raw("set local statement_timeout = '60s'"));
    await tx.execute(sql.raw('lock table public.inventory in share row exclusive mode'));
    await tx.execute(sql.raw('lock table public.inventory_ledger in share row exclusive mode'));

    const inventoryIds = correctionPlan.rows.map((row) => row.inventoryId);
    const idList = sql.join(inventoryIds.map((id) => sql`${id}`), sql`, `);
    await tx.execute(sql`select id from public.inventory where id in (${idList}) order by id for update`);

    const lockedSourcePlan = await buildInventoryReconciliationPlanInTransaction(tx, {});
    const lockedCorrectionPlan = buildInventoryCorrectionPlan(lockedSourcePlan);
    assertInventoryCorrectionApproval(
      lockedCorrectionPlan,
      argument('plan-hash'),
      argument('movements-sha'),
    );

    const [before] = await tx.execute<{ ledger_rows: number; ledger_quantity: number }>(sql`
      select count(*)::int as ledger_rows, coalesce(sum(qty), 0)::int as ledger_quantity
      from public.inventory_ledger
    `);
    if (!before) throw new Error('PS462_CORRECTION_PRE_SNAPSHOT_EMPTY');

    const effectiveAt = new Date();
    let applied = 0;
    for (const row of lockedCorrectionPlan.rows) {
      const movement = await applyInventoryMovementInTransaction(tx, {
        inventoryId: row.inventoryId,
        qty: row.correctionQuantity,
        type: row.type,
        orderId: row.orderId,
        note: row.note,
        createdBy,
        effectiveAt,
        idempotencyKey: row.idempotencyKey,
        sourceEntity: row.sourceEntity,
        sourceId: row.sourceId,
      });
      if (movement.status !== 'applied') {
        throw new Error(`PS462_CORRECTION_UNEXPECTED_REPLAY: inventory ${row.inventoryId}`);
      }
      if (movement.inventory.inventoryQuantity !== row.expectedPostQuantity) {
        throw new Error(`PS462_CORRECTION_ROW_PARITY_FAILED: inventory ${row.inventoryId}`);
      }
      applied += 1;
    }

    const verifiedPlan = await buildInventoryReconciliationPlanInTransaction(tx, {});
    if (verifiedPlan.rowsToAdjust !== 0) {
      throw new Error(`PS462_CORRECTION_GLOBAL_PARITY_FAILED: ${verifiedPlan.rowsToAdjust} rows`);
    }
    const [after] = await tx.execute<{ ledger_rows: number; ledger_quantity: number }>(sql`
      select count(*)::int as ledger_rows, coalesce(sum(qty), 0)::int as ledger_quantity
      from public.inventory_ledger
    `);
    if (!after) throw new Error('PS462_CORRECTION_POST_SNAPSHOT_EMPTY');
    if (Number(after.ledger_rows) - Number(before.ledger_rows) !== applied) {
      throw new Error('PS462_CORRECTION_LEDGER_ROW_COUNT_FAILED');
    }
    if (Number(after.ledger_quantity) - Number(before.ledger_quantity)
      !== lockedCorrectionPlan.correctionQuantity) {
      throw new Error('PS462_CORRECTION_LEDGER_QUANTITY_FAILED');
    }
    return {
      applied,
      correctionQuantity: lockedCorrectionPlan.correctionQuantity,
      effectiveAt: effectiveAt.toISOString(),
      globalMismatches: verifiedPlan.rowsToAdjust,
    };
  });

  console.log(JSON.stringify({ mode: 'APPLIED', productionMutation: true, ...result }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
