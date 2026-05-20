import 'dotenv/config';
import postgres from 'postgres';

type Args = {
  clientId?: number;
  sku?: string;
  includeMatched: boolean;
  json: boolean;
  limit: number;
};

type DbRow = {
  inventory_id: number;
  client_id: number | null;
  sku: string;
  name: string | null;
  stock_qty: number;
  ledger_stock: number;
  total_received: number;
  total_sold: number;
  ledger_entries: number;
  last_ledger_at: string | null;
};

type ReconciliationRow = {
  inventoryId: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  currentStockQty: number;
  ledgerStock: number;
  effectiveStock: number;
  totalReceived: number;
  totalSold: number;
  ledgerEntries: number;
  lastLedgerAt: string | null;
  cacheVsLedgerDelta: number;
  cacheVsEffectiveDelta: number;
  ledgerVsEffectiveDelta: number;
  status: 'match' | 'cache_vs_ledger' | 'cache_vs_effective' | 'ledger_vs_effective';
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

Safety:
  This command is read-only and dry-run only.
  It compares inventory.stockQty, inventory_ledger balance, and effectiveStock.
  It does not modify inventory, orders, shipped/cancelled rows, or shipments.
  It intentionally has no apply mode; any future repair must be separate.
`);
}

function classify(row: Omit<ReconciliationRow, 'status'>): ReconciliationRow['status'] {
  if (row.cacheVsLedgerDelta === 0 && row.cacheVsEffectiveDelta === 0 && row.ledgerVsEffectiveDelta === 0) {
    return 'match';
  }
  if (row.ledgerVsEffectiveDelta !== 0) return 'ledger_vs_effective';
  if (row.cacheVsLedgerDelta !== 0) return 'cache_vs_ledger';
  return 'cache_vs_effective';
}

function toReportRow(row: DbRow): ReconciliationRow {
  const currentStockQty = Number(row.stock_qty) || 0;
  const ledgerStock = Number(row.ledger_stock) || 0;
  const totalReceived = Number(row.total_received) || 0;
  const totalSold = Number(row.total_sold) || 0;
  const effectiveStock = totalReceived - totalSold;
  const base = {
    inventoryId: row.inventory_id,
    clientId: row.client_id,
    sku: row.sku,
    name: row.name,
    currentStockQty,
    ledgerStock,
    effectiveStock,
    totalReceived,
    totalSold,
    ledgerEntries: Number(row.ledger_entries) || 0,
    lastLedgerAt: row.last_ledger_at,
    cacheVsLedgerDelta: ledgerStock - currentStockQty,
    cacheVsEffectiveDelta: effectiveStock - currentStockQty,
    ledgerVsEffectiveDelta: ledgerStock - effectiveStock,
  };

  return {
    ...base,
    status: classify(base),
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
        i.stock_qty
      from inventory i
      where i.active = true
        ${clientFilter}
        ${skuFilter}
    ),
    ledger as (
      select
        l.inventory_id,
        coalesce(sum(l.qty), 0)::int as ledger_stock,
        coalesce(sum(l.qty) filter (where l.type = 'receive'), 0)::int as total_received,
        count(*)::int as ledger_entries,
        max(l.created_at)::text as last_ledger_at
      from inventory_ledger l
      where l.inventory_id in (select id from scoped_inventory)
      group by l.inventory_id
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
    )
    select
      i.id as inventory_id,
      i.client_id,
      i.sku,
      i.name,
      i.stock_qty,
      coalesce(ledger.ledger_stock, 0)::int as ledger_stock,
      coalesce(ledger.total_received, 0)::int as total_received,
      coalesce(sold.total_sold, 0)::int as total_sold,
      coalesce(ledger.ledger_entries, 0)::int as ledger_entries,
      ledger.last_ledger_at
    from scoped_inventory i
    left join ledger on ledger.inventory_id = i.id
    left join sold on sold.inventory_id = i.id
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
      filters: {
        clientId: args.clientId ?? null,
        sku: args.sku ?? null,
      },
      limit: args.limit,
    };

    if (args.json) {
      console.log(JSON.stringify({ summary, rows: visibleRows }, null, 2));
      return;
    }

    console.log('\n[inventory-reconciliation] DRY RUN');
    console.log(
      `rowsScanned=${summary.rowsScanned} mismatchRows=${summary.mismatchRows} matchedRows=${summary.matchedRows}`,
    );
    console.log(
      `delta(cache-ledger)=${summary.totalCacheVsLedgerDelta} delta(cache-effective)=${summary.totalCacheVsEffectiveDelta} delta(ledger-effective)=${summary.totalLedgerVsEffectiveDelta}`,
    );
    console.log('No rows changed.');

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
