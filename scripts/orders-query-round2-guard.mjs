import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const ordersSchema = readFileSync('src/db/schema/orders.ts', 'utf8');
const clientsSchema = readFileSync('src/db/schema/clients.ts', 'utf8');
const migration = readFileSync('drizzle/0034_orders_query_round2_indexes.sql', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  ordersRoute.includes('function visiblePredicateForOrdersList') &&
    ordersRoute.includes('!isExcludedStoreId(q.storeId)') &&
    ordersRoute.includes('return q.includeInactiveClients === true ? undefined : activeOrderClientPredicate'),
  '/orders must avoid the broad visible-store OR predicate for explicit non-excluded store filters',
);

assert(
  ordersRoute.includes('select test_client.id') &&
    ordersRoute.includes('select owner_client.id') &&
    ordersRoute.includes('where test_client.is_test = true') &&
    ordersRoute.includes('where coalesce(owner_client.active, true) = true'),
  '/orders hot visibility predicates should use uncorrelated client-id subqueries instead of per-row correlated EXISTS checks',
);

assert(
  ordersSchema.includes("index('orders_store_status_date_id_idx')") &&
    ordersSchema.includes("index('orders_client_status_date_id_idx')") &&
    migration.includes('"orders_store_status_date_id_idx"') &&
    migration.includes('"orders_client_status_date_id_idx"'),
  'orders schema and migration must include store/client status+date+id indexes aligned to /orders ORDER BY',
);

assert(
  clientsSchema.includes("index('clients_test_client_id_idx')") &&
    clientsSchema.includes("index('clients_active_client_id_idx')") &&
    migration.includes('"clients_test_client_id_idx"') &&
    migration.includes('"clients_active_client_id_idx"'),
  'clients schema and migration must include visibility helper partial indexes',
);

assert(
  migration.includes('ANALYZE "orders"') && migration.includes('ANALYZE "clients"'),
  'round-2 performance migration must refresh planner statistics after new indexes',
);

assert(
  pkg.scripts?.['test:orders-query-round2'] === 'node scripts/orders-query-round2-guard.mjs',
  'package.json must expose test:orders-query-round2',
);

console.log('PASS orders query round-2 guard');
