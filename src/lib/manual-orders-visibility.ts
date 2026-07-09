export const MANUAL_ORDERS_CLIENT_NAME = 'Manual Orders';

export function isManualOrdersClientName(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === MANUAL_ORDERS_CLIENT_NAME.toLowerCase();
}

export function manualOrdersOrderPredicateSql(
  orderAlias = 'o',
  clientAlias = 'manual_orders_client',
): string {
  return `exists (
    select 1 from clients ${clientAlias}
    where ${clientAlias}.id = ${orderAlias}.client_id
      and lower(${clientAlias}.name) = 'manual orders'
      and coalesce(${clientAlias}.active, true) = true
  )`;
}
