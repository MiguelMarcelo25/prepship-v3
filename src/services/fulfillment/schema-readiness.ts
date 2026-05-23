type SqlExecutor = any;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orders: [
    'source_provider',
    'source_account_id',
    'source_order_id',
    'source_order_number',
    'source_status',
    'canonical_status',
  ],
  shipments: [
    'carrier_provider',
    'carrier_account_id',
    'label_provider_key',
    'confirmation_status',
    'confirmation_provider',
    'confirmation_attempts',
    'confirmation_last_error',
    'marketplace_confirmed_at',
  ],
  fulfillment_outbox: [
    'id',
    'order_id',
    'shipment_id',
    'event_type',
    'provider',
    'dedupe_key',
    'payload',
    'status',
    'attempts',
    'last_error',
    'next_run_at',
    'created_at',
    'updated_at',
  ],
};

const REQUIRED_INDEXES = [
  'orders_source_provider_idx',
  'orders_canonical_status_idx',
  'shipments_confirmation_status_idx',
  'fulfillment_outbox_dedupe_idx',
  'fulfillment_outbox_due_idx',
];

let readinessCheck: Promise<void> | null = null;

export function resetFulfillmentSchemaReadinessForTests(): void {
  readinessCheck = null;
}

export async function assertFulfillmentSchemaReady(sql: SqlExecutor): Promise<void> {
  readinessCheck ??= verifyFulfillmentSchema(sql);
  return readinessCheck;
}

async function verifyFulfillmentSchema(sql: SqlExecutor): Promise<void> {
  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const columnRows = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any(${tableNames})
  `;

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    const columns = columnsByTable.get(table) ?? new Set<string>();
    columns.add(column);
    columnsByTable.set(table, columns);
  }

  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = columnsByTable.get(table) ?? new Set<string>();
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }

  const indexRows = await sql<{ indexname: string }>`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname = any(${REQUIRED_INDEXES})
  `;
  const presentIndexes = new Set(indexRows.map((row: { indexname: unknown }) => String(row.indexname)));
  for (const index of REQUIRED_INDEXES) {
    if (!presentIndexes.has(index)) missing.push(`index:${index}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Fulfillment schema is not migration-ready. Missing: ${missing.slice(0, 12).join(', ')}`,
    );
  }
}
