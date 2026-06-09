import { sql, type SQL } from 'drizzle-orm';

export const WALMART_SHIPSTATION_STORE_ID = 376661;
export const WALMART_DIRECT_STORE_ID = 9_000_001;
export const WALMART_DIRECT_STORE_ACCOUNT_ID = 1;

// PS-139: removed dead export normalizeWalmartOrderIdentity (0 callers).
function aliasColumn(alias: 'orders' | 'o', column: string): SQL {
  return sql.raw(`${alias}.${column}`);
}

export function walmartDirectDuplicateSuppressionPredicate(alias: 'orders' | 'o' = 'orders'): SQL {
  const id = aliasColumn(alias, 'id');
  const storeId = aliasColumn(alias, 'store_id');
  const orderNumber = aliasColumn(alias, 'order_number');
  return sql`not (
    ${storeId} = ${WALMART_DIRECT_STORE_ID}
    and nullif(${orderNumber}, '') is not null
    and exists (
      select 1
      from orders walmart_shipstation_order
      where walmart_shipstation_order.store_id = ${WALMART_SHIPSTATION_STORE_ID}
        and walmart_shipstation_order.order_number = ${orderNumber}
        and walmart_shipstation_order.id <> ${id}
    )
  )`;
}

export function walmartDirectStoreDebugInfo() {
  return {
    shipstationStoreId: WALMART_SHIPSTATION_STORE_ID,
    directStoreId: WALMART_DIRECT_STORE_ID,
    directStoreAccountId: WALMART_DIRECT_STORE_ACCOUNT_ID,
  };
}
