import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

type Args = {
  clientId?: number;
  sku?: string;
  includeMatched: boolean;
  json: boolean;
  limit: number;
  outJson?: string;
  outCsv?: string;
};

type DbRow = {
  inventory_id: number;
  client_id: number | null;
  sku: string;
  name: string | null;
  active: boolean;
  stock_qty: number;
  ledger_stock: number;
  total_received: number;
  total_sold: number;
  ledger_entries: number;
  sku_client_count: number;
  last_ledger_at: string | null;
};

type MismatchClassification =
  | 'match'
  | 'missing_receive_ledger'
  | 'sold_exceeds_received'
  | 'cache_differs_from_ledger'
  | 'client_sku_collision_risk'
  | 'inactive_or_deactivated_sku'
  | 'reporting_effective_stock_review';

type ReconciliationRow = {
  inventoryId: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  active: boolean;
  currentStockQty: number;
  ledgerStock: number;
  effectiveStock: number;
  totalReceived: number;
  totalSold: number;
  ledgerEntries: number;
  skuClientCount: number;
  lastLedgerAt: string | null;
  cacheVsLedgerDelta: number;
  cacheVsEffectiveDelta: number;
  ledgerVsEffectiveDelta: number;
  status: 'match' | 'cache_vs_ledger' | 'cache_vs_effective' | 'ledger_vs_effective';
  classification: MismatchClassification;
  recommendedAction: string;
  safeToAutoRepair: false;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function parseArgs(): Args {
  const clientIdRaw = argValue('client-id') ?? argValue('clientId');
  const clientId = clientIdRaw === null ? undefined : Number(clientIdRaw);
  if (clientIdRaw !== null && (!Number.isInteger(clientId) || clientId <= 0)) {
    throw new Error('--client-id must be a positive integer');
  }

  return {
    clientId,
    sku: argValue('sku')?.trim() || undefined,
    includeMatched: hasFlag('include-matched'),
    json: hasFlag('json'),
    limit: parsePositiveInt('limit', 50),
    outJson: argValue('out-json')?.trim() || undefined,
    outCsv: argValue('out-csv')?.trim() || undefined,
  };
}

function printUsage(): void {
  console.log(`
Usage:
  npm run inventory:reconcile:dry-run
  npm run inventory:reconcile:dry-run -- --client-id 3
  npm run inventory:reconcile:dry-run -- --sku "ABC-123" --limit 100
  npm run inventory:reconcile:dry-run -- --json
  npm run inventory:reconcile:dry-run -- --include-matched --limit 100
  npm run inventory:reconcile:dry-run -- --out-json artifacts/inventory-reconcile.json
  npm run inventory:reconcile:dry-run -- --out-csv artifacts/inventory-reconcile.csv

Safety:
  This command is read-only and dry-run only.
  It compares inventory.stockQty, inventory_ledger balance, and effectiveStock.
  It does not modify inventory, orders, shipped/cancelled rows, or shipments.
  It intentionally has no apply mode; any future repair must be separate.
`);
}

async function writeTextArtifact(filePath: string, contents: string): Promise<string> {
  const resolved = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, contents, 'utf8');
  return resolved;
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: ReconciliationRow[]): string {
  const headers = [
    'inventoryId',
    'clientId',
    'sku',
    'name',
    'active',
    'currentStockQty',
    'ledgerStock',
    'effectiveStock',
    'totalReceived',
    'totalSold',
    'ledgerEntries',
    'skuClientCount',
    'lastLedgerAt',
    'cacheVsLedgerDelta',
    'cacheVsEffectiveDelta',
    'ledgerVsEffectiveDelta',
    'status',
    'classification',
    'safeToAutoRepair',
    'recommendedAction',
  ] as const;

  return [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((header) => csvCell(row[header]))
        .join(','),
    ),
  ].join('\n') + '\n';
}

function classify(row: Omit<ReconciliationRow, 'status'>): ReconciliationRow['status'] {
  if (row.cacheVsLedgerDelta === 0 && row.cacheVsEffectiveDelta === 0 && row.ledgerVsEffectiveDelta === 0) {
    return 'match';
  }
  if (row.ledgerVsEffectiveDelta !== 0) return 'ledger_vs_effective';
  if (row.cacheVsLedgerDelta !== 0) return 'cache_vs_ledger';
  return 'cache_vs_effective';
}

function classifyMismatch(row: {
  active: boolean;
  currentStockQty: number;
  ledgerStock: number;
  totalReceived: number;
  totalSold: number;
  ledgerEntries: number;
  skuClientCount: number;
  cacheVsLedgerDelta: number;
  cacheVsEffectiveDelta: number;
  ledgerVsEffectiveDelta: number;
}): MismatchClassification {
  if (!row.active) return 'inactive_or_deactivated_sku';
  if (row.cacheVsLedgerDelta === 0 && row.cacheVsEffectiveDelta === 0 && row.ledgerVsEffectiveDelta === 0) {
    return 'match';
  }
  if (row.skuClientCount > 1 && row.ledgerVsEffectiveDelta !== 0) {
    return 'client_sku_collision_risk';
  }
  if (row.ledgerEntries === 0 && row.totalSold > 0) {
    return 'missing_receive_ledger';
  }
  if (row.totalSold > row.totalReceived) {
    return 'sold_exceeds_received';
  }
  if (row.cacheVsLedgerDelta !== 0) {
    return 'cache_differs_from_ledger';
  }
  return 'reporting_effective_stock_review';
}

function recommendedActionFor(classification: MismatchClassification): string {
  switch (classification) {
    case 'match':
      return 'No action needed.';
    case 'missing_receive_ledger':
      return 'Review receive/import history before any repair; shipped sales exist without receive ledger coverage.';
    case 'sold_exceeds_received':
      return 'Review shipped order history versus receive ledger; do not auto-repair stock from effectiveStock.';
    case 'cache_differs_from_ledger':
      return 'Possible cache repair candidate after owner approval and saved dry-run evidence.';
    case 'client_sku_collision_risk':
      return 'Confirm client/SKU mapping before repair; same SKU appears across multiple client scopes.';
    case 'inactive_or_deactivated_sku':
      return 'Confirm active/deactivated SKU handling before including this row in any repair.';
    case 'reporting_effective_stock_review':
      return 'Review effectiveStock formula/source data before changing stock cache.';
  }
}

function countByClassification(rows: ReconciliationRow[]): Record<MismatchClassification, number> {
  const classificationCounts: Record<MismatchClassification, number> = {
    match: 0,
    missing_receive_ledger: 0,
    sold_exceeds_received: 0,
    cache_differs_from_ledger: 0,
    client_sku_collision_risk: 0,
    inactive_or_deactivated_sku: 0,
    reporting_effective_stock_review: 0,
  };

  for (const row of rows) {
    classificationCounts[row.classification] += 1;
  }

  return classificationCounts;
}

function toReportRow(row: DbRow): ReconciliationRow {
  const currentStockQty = Number(row.stock_qty) || 0;
  const ledgerStock = Number(row.ledger_stock) || 0;
  const totalReceived = Number(row.total_received) || 0;
  const totalSold = Number(row.total_sold) || 0;
  const effectiveStock = ledgerStock;
  const base = {
    inventoryId: row.inventory_id,
    clientId: row.client_id,
    sku: row.sku,
    name: row.name,
    active: row.active,
    currentStockQty,
    ledgerStock,
    effectiveStock,
    totalReceived,
    totalSold,
    ledgerEntries: Number(row.ledger_entries) || 0,
    skuClientCount: Number(row.sku_client_count) || 0,
    lastLedgerAt: row.last_ledger_at,
    cacheVsLedgerDelta: ledgerStock - currentStockQty,
    cacheVsEffectiveDelta: effectiveStock - currentStockQty,
    ledgerVsEffectiveDelta: ledgerStock - effectiveStock,
  };
  const classification = classifyMismatch(base);

  return {
    ...base,
    status: classify(base),
    classification,
    recommendedAction: recommendedActionFor(classification),
    safeToAutoRepair: false,
  };
}

function severity(row: ReconciliationRow): number {
  return Math.max(
    Math.abs(row.cacheVsLedgerDelta),
    Math.abs(row.cacheVsEffectiveDelta),
    Math.abs(row.ledgerVsEffectiveDelta),
  );
}

async function loadRows(sql: postgres.Sql, args: Args): Promise<DbRow[]> {
  const clientFilter = args.clientId ? sql`and i.client_id = ${args.clientId}` : sql``;
  const skuFilter = args.sku ? sql`and lower(i.sku) = lower(${args.sku})` : sql``;

  return sql<DbRow[]>`
    with scoped_inventory as (
      select
        i.id,
        i.client_id,
        i.sku,
        i.name,
        i.active,
        i.stock_qty
      from inventory i
      where i.active = true
        ${clientFilter}
        ${skuFilter}
    ),
    -- PS-133: this ledger_rows/ledger_summary balance is the raw-postgres form of the
    -- canonical effective-stock owner in src/services/inventory-stock-math.ts
    -- (inventoryLedgerBalance). This script uses the raw `postgres` driver (not Drizzle),
    -- so it can't import the owner directly; the behavioral guard pins the shared formula.
    ledger_rows as (
      select l.inventory_id, l.qty
      from inventory_ledger l
      where l.inventory_id in (select id from scoped_inventory)
        and (l.type <> 'ship' or l.order_id is null)
      union all
      select l.inventory_id, min(l.qty)::int as qty
      from inventory_ledger l
      where l.inventory_id in (select id from scoped_inventory)
        and l.type = 'ship'
        and l.order_id is not null
      group by l.inventory_id, l.order_id
    ),
    ledger_summary as (
      select
        ledger_rows.inventory_id,
        coalesce(sum(ledger_rows.qty), 0)::int as ledger_stock,
        count(*)::int as deduped_ledger_entries
      from ledger_rows
      group by ledger_rows.inventory_id
    ),
    ledger as (
      select
        l.inventory_id,
        coalesce(ledger_summary.ledger_stock, 0)::int as ledger_stock,
        coalesce(sum(l.qty) filter (where l.type = 'receive'), 0)::int as total_received,
        count(*)::int as ledger_entries,
        max(l.created_at)::text as last_ledger_at
      from inventory_ledger l
      left join ledger_summary on ledger_summary.inventory_id = l.inventory_id
      where l.inventory_id in (select id from scoped_inventory)
      group by l.inventory_id, ledger_summary.ledger_stock
    ),
    ledger_sold as (
      select
        ship_rows.inventory_id,
        abs(coalesce(sum(ship_rows.qty), 0))::int as total_sold
      from (
        select l.inventory_id, l.order_id, min(l.qty)::int as qty
        from inventory_ledger l
        where l.inventory_id in (select id from scoped_inventory)
          and l.type = 'ship'
          and l.order_id is not null
        group by l.inventory_id, l.order_id
      ) ship_rows
      group by ship_rows.inventory_id
    ),
    sold as (
      select
        i.id as inventory_id,
        coalesce(sum(oi.quantity), 0)::int as total_sold
      from scoped_inventory i
      join order_items oi
        on lower(oi.sku) = lower(i.sku)
      join orders o
        on (
          o.id = oi.order_id
          and (
            (i.client_id is null and o.client_id is null)
            or i.client_id = o.client_id
          )
        )
      where oi.quantity > 0
        and o.order_status = 'shipped'
      group by i.id
    ),
    sku_scope as (
      select
        lower(sku) as normalized_sku,
        count(distinct coalesce(client_id, -1))::int as sku_client_count
      from scoped_inventory
      group by lower(sku)
    )
    select
      i.id as inventory_id,
      i.client_id,
      i.sku,
      i.name,
      i.active,
      i.stock_qty,
      coalesce(ledger.ledger_stock, 0)::int as ledger_stock,
      coalesce(ledger.total_received, 0)::int as total_received,
      coalesce(ledger_sold.total_sold, sold.total_sold, 0)::int as total_sold,
      coalesce(ledger.ledger_entries, 0)::int as ledger_entries,
      coalesce(sku_scope.sku_client_count, 0)::int as sku_client_count,
      ledger.last_ledger_at
    from scoped_inventory i
    left join ledger on ledger.inventory_id = i.id
    left join ledger_sold on ledger_sold.inventory_id = i.id
    left join sold on sold.inventory_id = i.id
    left join sku_scope on sku_scope.normalized_sku = lower(i.sku)
  `;
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const args = parseArgs();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    connection: { statement_timeout: 15000 },
  });

  try {
    const rows = (await loadRows(sql, args)).map(toReportRow);
    const mismatches = rows.filter((row) => row.status !== 'match');
    const visibleRows = (args.includeMatched ? rows : mismatches)
      .sort((a, b) => severity(b) - severity(a) || a.sku.localeCompare(b.sku))
      .slice(0, args.limit);

    const summary = {
      mode: 'dry-run',
      rowsScanned: rows.length,
      mismatchRows: mismatches.length,
      matchedRows: rows.length - mismatches.length,
      totalCacheVsLedgerDelta: mismatches.reduce((sum, row) => sum + row.cacheVsLedgerDelta, 0),
      totalCacheVsEffectiveDelta: mismatches.reduce((sum, row) => sum + row.cacheVsEffectiveDelta, 0),
      totalLedgerVsEffectiveDelta: mismatches.reduce((sum, row) => sum + row.ledgerVsEffectiveDelta, 0),
      classificationCounts: countByClassification(rows),
      filters: {
        clientId: args.clientId ?? null,
        sku: args.sku ?? null,
      },
      limit: args.limit,
    };

    const report = { summary, rows: visibleRows };
    const artifactPaths: string[] = [];
    if (args.outJson) {
      artifactPaths.push(await writeTextArtifact(args.outJson, JSON.stringify(report, null, 2) + '\n'));
    }
    if (args.outCsv) {
      artifactPaths.push(await writeTextArtifact(args.outCsv, rowsToCsv(visibleRows)));
    }

    if (args.json) {
      console.log(JSON.stringify({ ...report, artifactPaths }, null, 2));
      return;
    }

    console.log('\n[inventory-reconciliation] DRY RUN');
    console.log(
      `rowsScanned=${summary.rowsScanned} mismatchRows=${summary.mismatchRows} matchedRows=${summary.matchedRows}`,
    );
    console.log(
      `delta(cache-ledger)=${summary.totalCacheVsLedgerDelta} delta(cache-effective)=${summary.totalCacheVsEffectiveDelta} delta(ledger-effective)=${summary.totalLedgerVsEffectiveDelta}`,
    );
    console.log(`classificationCounts=${JSON.stringify(summary.classificationCounts)}`);
    console.log('No rows changed.');
    for (const artifactPath of artifactPaths) {
      console.log(`artifact=${artifactPath}`);
    }

    if (visibleRows.length) {
      console.table(
        visibleRows.map((row) => ({
          id: row.inventoryId,
          clientId: row.clientId ?? '-',
          sku: row.sku,
          stockQty: row.currentStockQty,
          ledgerStock: row.ledgerStock,
          effectiveStock: row.effectiveStock,
          cacheVsLedger: row.cacheVsLedgerDelta,
          cacheVsEffective: row.cacheVsEffectiveDelta,
          ledgerVsEffective: row.ledgerVsEffectiveDelta,
          status: row.status,
          classification: row.classification,
          safeToAutoRepair: row.safeToAutoRepair,
          recommendedAction: row.recommendedAction,
        })),
      );
    } else {
      console.log('No mismatches found.');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
