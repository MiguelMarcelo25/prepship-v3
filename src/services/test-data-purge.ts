import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

type PurgeDatabase = typeof db;

export type TestDataPurgeResult = {
  clients: Array<{ id: number; name: string }>;
  deleted: {
    orders: number;
    shipments: number;
    ledger: number;
    billing: number;
    inventory: number;
    ledgerByInventory: number;
    orderOverrides: number;
    printQueue: number;
    pkgLedger: number;
    pkgStockRestored: number;
    pkgsAffected: number;
    relatedRecords: number;
  };
  message: string;
};

type PurgeCounts = Record<string, number>;

const CHILD_FIRST_TABLES = [
  'return_activity_events',
  'return_inspections',
  'return_label_purchase_intents',
  'return_labels',
  'return_items',
  'fulfillment_line_claims',
  'shipment_bundle_members',
  'shipment_group_packages',
  'shipment_hazmat_snapshots',
  'billing_credit_notes',
  'billing_line_items',
  'billing_box_resolutions',
  'billing_storage_proof',
  'billing_finalizations',
  'order_competitive_rate',
  'package_consumption_reviews',
  'shipment_tracking_status',
  'order_rate_jobs',
  'order_hazmat_declarations',
  'order_items',
  'order_overrides',
  'fulfillment_outbox',
  'order_lifecycle_events',
  'inventory_ledger',
  'returns',
  'shipment_bundles',
  'shipment_groups',
] as const;

function safeIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe purge identifier: ${value}`);
  }
  return `"${value}"`;
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null
    && typeof result === 'object'
    && 'rows' in result
    && Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Canonical owner for the Sandbox "Purge Test Orders" command.
 *
 * The roots are clients.is_test=true. Reusable client configuration remains,
 * while every order/inventory-owned operational row is removed transactionally.
 * No caller supplies IDs, so the UI cannot widen the destructive scope.
 */
export async function purgeAllTestClientData(
  database: PurgeDatabase = db,
): Promise<TestDataPurgeResult> {
  // Per user override unlock shipped data on 2026-07-25: this transaction may
  // remove shipped history only when every populated ownership link is test-owned.
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('prepship-test-data-purge'))`);
    await tx.execute(sql`select set_config('app.test_data_purge', 'on', true)`);

    const relationResult = await tx.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    const relationRows = resultRows<{ table_name: string }>(relationResult);
    const tables = new Set(relationRows.map((row) => row.table_name));

    const columnResult = await tx.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
    `);
    const columnRows = resultRows<{ table_name: string; column_name: string }>(columnResult);
    const columns = new Map<string, Set<string>>();
    for (const row of columnRows) {
      const set = columns.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      columns.set(row.table_name, set);
    }

    await tx.execute(sql.raw(`
      create temporary table purge_test_clients on commit drop as
      select id, name from public.clients where is_test = true
    `));
    const testClientResult = await tx.execute<{ id: number; name: string }>(sql`
      select id, name from purge_test_clients order by id
    `);
    const testClients = resultRows<{ id: number; name: string }>(testClientResult);

    const emptyDeleted = {
      orders: 0,
      shipments: 0,
      ledger: 0,
      billing: 0,
      inventory: 0,
      ledgerByInventory: 0,
      orderOverrides: 0,
      printQueue: 0,
      pkgLedger: 0,
      pkgStockRestored: 0,
      pkgsAffected: 0,
      relatedRecords: 0,
    };
    if (testClients.length === 0) {
      return {
        clients: [],
        deleted: emptyDeleted,
        message: 'No clients flagged is_test=true - nothing to purge.',
      };
    }

    await tx.execute(sql.raw(`
      create temporary table purge_test_orders on commit drop as
      select id, order_number
      from public.orders
      where client_id in (select id from purge_test_clients)
    `));
    await tx.execute(sql.raw(`
      create temporary table purge_test_shipments on commit drop as
      select id, label_shipment_id::text as label_shipment_id
      from public.shipments
      where (client_id in (select id from purge_test_clients)
          or order_id in (select id from purge_test_orders))
        and (client_id is null or client_id in (select id from purge_test_clients))
        and (order_id is null or order_id in (select id from purge_test_orders))
    `));
    await tx.execute(sql.raw(`
      create temporary table purge_test_inventory on commit drop as
      select id from public.inventory
      where client_id in (select id from purge_test_clients)
    `));

    const counts: PurgeCounts = {};
    const remember = (table: string, count: number): number => {
      counts[table] = (counts[table] ?? 0) + count;
      return count;
    };
    const tableColumns = (table: string) => columns.get(table) ?? new Set<string>();
    const ownershipPredicates = (table: string, alias: string) => {
      const available = tableColumns(table);
      const prefix = `${alias}.`;
      const matches: string[] = [];
      const ownershipChecks: string[] = [];
      if (available.has('client_id')) {
        matches.push(`${prefix}"client_id"::text in (select id::text from purge_test_clients)`);
        ownershipChecks.push(`(${prefix}"client_id" is null or ${prefix}"client_id"::text in (select id::text from purge_test_clients))`);
      }
      for (const column of ['order_id', 'source_order_id', 'primary_order_id']) {
        if (available.has(column)) {
          matches.push(`${prefix}${safeIdentifier(column)}::text in (select id::text from purge_test_orders)`);
          ownershipChecks.push(`(${prefix}${safeIdentifier(column)} is null or ${prefix}${safeIdentifier(column)}::text in (select id::text from purge_test_orders))`);
        }
      }
      for (const column of ['shipment_id', 'primary_shipment_id', 'return_shipment_id']) {
        if (available.has(column)) {
          matches.push(`${prefix}${safeIdentifier(column)}::text in (select id::text from purge_test_shipments)`);
          ownershipChecks.push(`(${prefix}${safeIdentifier(column)} is null or ${prefix}${safeIdentifier(column)}::text in (select id::text from purge_test_shipments))`);
        }
      }
      if (available.has('inventory_id')) {
        matches.push(`${prefix}"inventory_id"::text in (select id::text from purge_test_inventory)`);
        ownershipChecks.push(`(${prefix}"inventory_id" is null or ${prefix}"inventory_id"::text in (select id::text from purge_test_inventory))`);
      }
      if (available.has('return_id') && tables.has('purge_test_returns')) {
        matches.push(`${prefix}"return_id"::text in (select id::text from purge_test_returns)`);
        ownershipChecks.push(`(${prefix}"return_id" is null or ${prefix}"return_id"::text in (select id::text from purge_test_returns))`);
      }
      return { matches, ownershipChecks };
    };
    const rootPredicate = (table: string, alias = 'target'): string | null => {
      const { matches, ownershipChecks } = ownershipPredicates(table, alias);
      return matches.length > 0
        ? `((${matches.join(' or ')}) and ${ownershipChecks.join(' and ')})`
        : null;
    };
    const ownershipConflictPredicate = (table: string, alias: string): string | null => {
      const { ownershipChecks } = ownershipPredicates(table, alias);
      return ownershipChecks.length > 0 ? `not (${ownershipChecks.join(' and ')})` : null;
    };
    const assertNoRows = async (table: string, predicate: string, code: string): Promise<void> => {
      if (!tables.has(table)) return;
      const [row] = resultRows<{ count: number }>(await tx.execute<{ count: number }>(sql.raw(`
        select count(*)::int as count
        from public.${safeIdentifier(table)} as target
        where ${predicate}
      `)));
      if (countValue(row?.count) > 0) throw new Error(`${code}:${table}`);
    };
    const assertNoMixedOwnership = async (table: string, alias = 'target'): Promise<void> => {
      const { matches, ownershipChecks } = ownershipPredicates(table, alias);
      if (matches.length === 0 || ownershipChecks.length === 0) return;
      await assertNoRows(
        table,
        `((${matches.join(' or ')}) and not (${ownershipChecks.join(' and ')}))`,
        'TEST_DATA_PURGE_MIXED_OWNERSHIP',
      );
    };
    const deleteWhere = async (table: string, predicate: string): Promise<number> => {
      if (!tables.has(table)) return 0;
      const identifier = safeIdentifier(table);
      const result = await tx.execute<{ count: number }>(sql.raw(`
        with deleted as (
          delete from public.${identifier} as target
          where ${predicate}
          returning 1
        )
        select count(*)::int as count from deleted
      `));
      const [row] = resultRows<{ count: number }>(result);
      return remember(table, countValue(row?.count));
    };
    const deleteRoots = async (table: string): Promise<number> => {
      await assertNoMixedOwnership(table);
      const predicate = rootPredicate(table);
      return predicate ? deleteWhere(table, predicate) : 0;
    };

    if (tables.has('automation_runs')) {
      await tx.execute(sql.raw(`
        create temporary table purge_test_automation_runs on commit drop as
        select id from public.automation_runs
        where order_id in (select id from purge_test_orders)
      `));
      await deleteWhere(
        'automation_action_results',
        'target."run_id" in (select id from purge_test_automation_runs)',
      );
      await deleteWhere(
        'automation_reprocess_jobs',
        'target."preview_run_id" in (select id from purge_test_automation_runs)',
      );
      await deleteRoots('order_automation_state');
      await deleteRoots('automation_runs');
    }

    if (tables.has('print_queue_send_jobs')) {
      await assertNoMixedOwnership('print_queue_batch_job_items', 'target');
      const itemPredicate = tables.has('print_queue_batch_job_items')
        ? rootPredicate('print_queue_batch_job_items', 'item')
        : null;
      const itemConflict = tables.has('print_queue_batch_job_items')
        ? ownershipConflictPredicate('print_queue_batch_job_items', 'mixed_item')
        : null;
      await assertNoRows('print_queue_send_jobs', `
        (
          target.client_id in (select id from purge_test_clients)
          or exists (
            select 1 from jsonb_array_elements_text(coalesce(target.client_ids, '[]'::jsonb)) value
            where value::text in (select id::text from purge_test_clients)
          )
          ${itemPredicate ? `or exists (select 1 from public.print_queue_batch_job_items item where item.job_id = target.job_id and ${itemPredicate})` : ''}
        )
        and (
          (target.client_id is not null and target.client_id not in (select id from purge_test_clients))
          or exists (
            select 1 from jsonb_array_elements_text(coalesce(target.client_ids, '[]'::jsonb)) value
            where value::text not in (select id::text from purge_test_clients)
          )
          ${itemConflict ? `or exists (select 1 from public.print_queue_batch_job_items mixed_item where mixed_item.job_id = target.job_id and ${itemConflict})` : ''}
        )
      `, 'TEST_DATA_PURGE_MIXED_OWNERSHIP');
      await tx.execute(sql.raw(`
        create temporary table purge_test_send_jobs on commit drop as
        select distinct job.job_id
        from public.print_queue_send_jobs as job
        where (
            job.client_id in (select id from purge_test_clients)
            or exists (
             select 1 from jsonb_array_elements_text(coalesce(job.client_ids, '[]'::jsonb)) value
             where value::text in (select id::text from purge_test_clients)
            )
            ${itemPredicate ? `or exists (select 1 from public.print_queue_batch_job_items item where item.job_id = job.job_id and ${itemPredicate})` : ''}
          )
          and (job.client_id is null or job.client_id in (select id from purge_test_clients))
          and not exists (
            select 1 from jsonb_array_elements_text(coalesce(job.client_ids, '[]'::jsonb)) value
            where value::text not in (select id::text from purge_test_clients)
          )
          ${itemConflict ? `and not exists (select 1 from public.print_queue_batch_job_items mixed_item where mixed_item.job_id = job.job_id and ${itemConflict})` : ''}
      `));
      await deleteWhere(
        'print_queue_batch_job_items',
        'target."job_id" in (select job_id from purge_test_send_jobs)',
      );
      await deleteWhere(
        'print_queue_pdf_chunks',
        'target."job_id" in (select job_id from purge_test_send_jobs)',
      );
      await deleteWhere(
        'print_queue_merged_pdfs',
        'target."job_id" in (select job_id from purge_test_send_jobs)',
      );
      await deleteWhere(
        'print_queue_send_jobs',
        'target."job_id" in (select job_id from purge_test_send_jobs)',
      );
    }

    if (tables.has('print_queue_merge_jobs')) {
      await assertNoRows('print_queue_merge_jobs', `
        exists (
          select 1 from jsonb_array_elements_text(coalesce(target.client_ids, '[]'::jsonb)) value
          where value::text in (select id::text from purge_test_clients)
        )
        and exists (
          select 1 from jsonb_array_elements_text(coalesce(target.client_ids, '[]'::jsonb)) value
          where value::text not in (select id::text from purge_test_clients)
        )
      `, 'TEST_DATA_PURGE_MIXED_OWNERSHIP');
      await tx.execute(sql.raw(`
        create temporary table purge_test_merge_jobs on commit drop as
        select job_id
        from public.print_queue_merge_jobs as job
        where exists (
          select 1 from jsonb_array_elements_text(coalesce(job.client_ids, '[]'::jsonb)) value
          where value::text in (select id::text from purge_test_clients)
        )
          and not exists (
            select 1 from jsonb_array_elements_text(coalesce(job.client_ids, '[]'::jsonb)) value
            where value::text not in (select id::text from purge_test_clients)
          )
      `));
      await deleteWhere(
        'print_queue_pdf_chunks',
        'target."job_id" in (select job_id from purge_test_merge_jobs)',
      );
      await deleteWhere(
        'print_queue_merged_pdfs',
        'target."job_id" in (select job_id from purge_test_merge_jobs)',
      );
      await deleteWhere(
        'print_queue_merge_jobs',
        'target."job_id" in (select job_id from purge_test_merge_jobs)',
      );
    }

    if (tables.has('rate_browse_jobs')) {
      await tx.execute(sql.raw(`
        create temporary table purge_test_rate_jobs on commit drop as
        select job_id from public.rate_browse_jobs
        where order_id in (select id from purge_test_orders)
      `));
      await deleteWhere(
        'rate_browse_job_provider_statuses',
        'target."job_id" in (select job_id from purge_test_rate_jobs)',
      );
      await deleteWhere(
        'rate_browse_jobs',
        'target."job_id" in (select job_id from purge_test_rate_jobs)',
      );
    }

    if (tables.has('returns')) {
      const predicate = rootPredicate('returns');
      await tx.execute(sql.raw(`
        create temporary table purge_test_returns on commit drop as
        select id from public.returns as target
        where ${predicate ?? 'false'}
      `));
      tables.add('purge_test_returns');
    }

    if (tables.has('fulfillment_outbox')) {
      const predicate = rootPredicate('fulfillment_outbox');
      await tx.execute(sql.raw(`
        create temporary table purge_test_fulfillment_outbox on commit drop as
        select id from public.fulfillment_outbox as target
        where ${predicate ?? 'false'}
      `));
    }

    if (tables.has('external_operations')) {
      await tx.execute(sql.raw(`
        create temporary table purge_test_external_operations (id integer primary key) on commit drop
      `));
      await tx.execute(sql.raw(`
        insert into purge_test_external_operations (id)
        select id from public.external_operations
        where (subject_type = 'order' and subject_id in (select id::text from purge_test_orders))
           or (subject_type = 'shipment' and subject_id in (select id::text from purge_test_shipments))
        on conflict do nothing
      `));
      if (tables.has('fulfillment_outbox')) {
        await tx.execute(sql.raw(`
          insert into purge_test_external_operations (id)
          select id from public.external_operations
          where subject_type = 'fulfillment_outbox'
            and subject_id in (select id::text from purge_test_fulfillment_outbox)
          on conflict do nothing
        `));
      }
      if (tables.has('shipment_hazmat_snapshots') && tableColumns('shipment_hazmat_snapshots').has('external_operation_id')) {
        await tx.execute(sql.raw(`
          insert into purge_test_external_operations (id)
          select external_operation_id
          from public.shipment_hazmat_snapshots
          where shipment_id in (select id from purge_test_shipments)
            and external_operation_id is not null
          on conflict do nothing
        `));
      }
    }

    for (const table of CHILD_FIRST_TABLES) {
      await deleteRoots(table);
    }

    if (tables.has('mock_labels')) {
      await deleteWhere('mock_labels', `
        target."shipment_id"::text in (
          select label_shipment_id from purge_test_shipments where label_shipment_id is not null
        )
        or target."order_number" in (
          select order_number from purge_test_orders where order_number is not null
        )
      `);
    }

    await deleteRoots('billing_manual_overrides');
    await deleteRoots('label_purchase_intents');
    await deleteRoots('label_purchase_locks');
    await deleteRoots('print_queue_orders');

    if (tables.has('package_ledger')) {
      const packageColumns = tableColumns('package_ledger');
      const structuredPredicates: string[] = [];
      const ownershipChecks: string[] = [];
      if (packageColumns.has('order_id')) {
        structuredPredicates.push('ledger.order_id in (select id from purge_test_orders)');
        ownershipChecks.push('(ledger.order_id is null or ledger.order_id in (select id from purge_test_orders))');
      }
      if (packageColumns.has('shipment_id')) {
        structuredPredicates.push('ledger.shipment_id in (select id from purge_test_shipments)');
        ownershipChecks.push('(ledger.shipment_id is null or ledger.shipment_id in (select id from purge_test_shipments))');
      }
      if (packageColumns.has('note')) {
        structuredPredicates.push(`exists (
          select 1 from purge_test_orders test_order
          where test_order.order_number is not null
            and position(
              lower('for order ' || test_order.order_number)
              in lower(coalesce(ledger.note, ''))
            ) > 0
        )`);
      }
      if (structuredPredicates.length > 0 && ownershipChecks.length > 0) {
        const conflictMatches = structuredPredicates.map((predicate) => predicate.replaceAll('ledger.', 'target.'));
        const conflictChecks = ownershipChecks.map((predicate) => predicate.replaceAll('ledger.', 'target.'));
        await assertNoRows(
          'package_ledger',
          `((${conflictMatches.join(' or ')}) and not (${conflictChecks.join(' and ')}))`,
          'TEST_DATA_PURGE_MIXED_OWNERSHIP',
        );
      }
      await tx.execute(sql.raw(`
        create temporary table purge_test_package_ledger on commit drop as
        select ledger.id, ledger.package_id, ledger.qty_delta
        from public.package_ledger as ledger
        where (${structuredPredicates.length ? structuredPredicates.join(' or ') : 'false'})
          and ${ownershipChecks.length ? ownershipChecks.join(' and ') : 'true'}
      `));
      const packageResult = await tx.execute<{
        rows: number;
        restored: number;
        packages: number;
      }>(sql.raw(`
        select
          count(*)::int as rows,
          coalesce(sum(abs(net_delta)), 0)::int as restored,
          count(*)::int as packages
        from (
          select package_id, sum(qty_delta)::int as net_delta
          from purge_test_package_ledger
          group by package_id
        ) totals
      `));
      const [packageSummary] = resultRows<{
        rows: number;
        restored: number;
        packages: number;
      }>(packageResult);
      if (tables.has('packages')) {
        await tx.execute(sql.raw(`
          update public.packages as package
          set stock_qty = package.stock_qty - totals.net_delta,
              updated_at = now()
          from (
            select package_id, sum(qty_delta)::int as net_delta
            from purge_test_package_ledger
            group by package_id
          ) totals
          where package.id = totals.package_id
        `));
      }
      await deleteWhere(
        'package_ledger',
        'target."id" in (select id from purge_test_package_ledger)',
      );
      counts.pkgStockRestored = countValue(packageSummary?.restored);
      counts.pkgsAffected = countValue(packageSummary?.packages);
    }

    if (tables.has('external_operations')) {
      await deleteWhere(
        'external_operations',
        'target."id" in (select id from purge_test_external_operations)',
      );
    }

    await deleteRoots('shipments');
    await deleteRoots('orders');
    await deleteRoots('inventory');

    if (tables.has('automation_outbox')) {
      await deleteWhere('automation_outbox', `
        (target."aggregate_type" = 'order'
          and target."aggregate_id" in (select id::text from purge_test_orders))
        or target."payload" ->> 'orderId' in (select id::text from purge_test_orders)
      `);
    }

    const remainingResult = await tx.execute<{
      orders: number;
      shipments: number;
      inventory: number;
    }>(sql.raw(`
      select
        (select count(*)::int from public.orders where client_id in (select id from purge_test_clients)) as orders,
        (select count(*)::int from public.shipments where client_id in (select id from purge_test_clients)) as shipments,
        (select count(*)::int from public.inventory where client_id in (select id from purge_test_clients)) as inventory
    `));
    const [remaining] = resultRows<{
      orders: number;
      shipments: number;
      inventory: number;
    }>(remainingResult);
    if (countValue(remaining?.orders) + countValue(remaining?.shipments) + countValue(remaining?.inventory) > 0) {
      throw new Error('TEST_DATA_PURGE_INCOMPLETE: test-owned root rows remain');
    }

    const rootTables = new Set(['orders', 'shipments', 'inventory']);
    const relatedRecords = Object.entries(counts)
      .filter(([table]) => !rootTables.has(table) && table !== 'pkgStockRestored' && table !== 'pkgsAffected')
      .reduce((sum, [, count]) => sum + count, 0);
    const deleted = {
      orders: counts.orders ?? 0,
      shipments: counts.shipments ?? 0,
      ledger: counts.inventory_ledger ?? 0,
      billing: counts.billing_line_items ?? 0,
      inventory: counts.inventory ?? 0,
      ledgerByInventory: counts.inventory_ledger ?? 0,
      orderOverrides: counts.order_overrides ?? 0,
      printQueue: counts.print_queue_orders ?? 0,
      pkgLedger: counts.package_ledger ?? 0,
      pkgStockRestored: counts.pkgStockRestored ?? 0,
      pkgsAffected: counts.pkgsAffected ?? 0,
      relatedRecords,
    };

    return {
      clients: testClients.map((client) => ({ id: client.id, name: client.name })),
      deleted,
      message: `Deleted ${deleted.orders} test order(s) and ${deleted.relatedRecords} related test record(s).`,
    };
  });
}
