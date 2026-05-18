// Readiness check for the marketplace store_orders read/write model.
//
// The schema is owned by Drizzle migrations. Serverless compatibility
// handlers should not create tables or indexes during a marketplace pull.
const REQUIRED_STORE_ORDER_RELATIONS = [
  'store_orders',
  'store_orders_provider_external_idx',
  'store_orders_carrier_account_idx',
  'store_orders_last_fetched_at_idx',
  'store_orders_shipment_status_idx',
];

type SqlLike = {
  unsafe: (query: string) => Promise<Array<Record<string, unknown>>>;
};

export async function assertStoreOrdersSchemaReady(
  sql: SqlLike,
  logPrefix = 'store_orders',
): Promise<void> {
  const missing = await sql.unsafe(`
    SELECT relation_name
    FROM (
      VALUES
        ('store_orders'),
        ('store_orders_provider_external_idx'),
        ('store_orders_carrier_account_idx'),
        ('store_orders_last_fetched_at_idx'),
        ('store_orders_shipment_status_idx')
    ) AS expected(relation_name)
    WHERE to_regclass('public.' || relation_name) IS NULL
    ORDER BY relation_name
  `);

  if (missing.length > 0) {
    const names = missing.map((row) => String(row.relation_name)).join(', ');
    throw new Error(
      `${logPrefix}: store_orders migration is missing relations: ${names}. ` +
        'Run drizzle/0030_store_orders.sql before marketplace order imports.',
    );
  }

  const rls = await sql.unsafe(`
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'public.store_orders'::regclass
    LIMIT 1
  `);

  if (rls[0]?.relrowsecurity !== true) {
    throw new Error(
      `${logPrefix}: store_orders row-level security is not enabled. ` +
        'Run drizzle/0030_store_orders.sql before marketplace order imports.',
    );
  }
}

export function getRequiredStoreOrderRelations(): string[] {
  return [...REQUIRED_STORE_ORDER_RELATIONS];
}
