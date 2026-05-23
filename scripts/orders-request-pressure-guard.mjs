import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  ordersView.includes('function useDebouncedValue') &&
    ordersView.includes('const debouncedSearchQuery = useDebouncedValue(searchQuery, 350)') &&
    ordersView.includes('search: debouncedSearchQuery'),
  'Orders search must be debounced before it reaches the /orders query key/request',
);

assert(
  ordersView.includes('const lastHandledRefreshVersionRef = useRef(0)') &&
    ordersView.includes('lastHandledRefreshVersionRef.current === refreshVersion') &&
    ordersView.includes('lastHandledRefreshVersionRef.current = refreshVersion'),
  'Orders refreshVersion handling must consume each version only once',
);

assert(
  ordersView.includes('const scheduleOrdersRefetch = useCallback') &&
    ordersView.includes('transitionalRefetchTimerRef.current') &&
    ordersView.includes('scheduleOrdersRefetch(250)') &&
    !ordersView.includes('transitionalTimeoutsRef.current.delete(order.orderId)\n            void refetchOrders()'),
  'Delayed row transition refetches must be coalesced instead of one /orders refetch per row timer',
);

assert(
  ordersRoute.includes('.orderBy(desc(orders.orderDate), desc(orders.id))'),
  '/orders page query must use deterministic order_date/id ordering aligned to orders_status_date_id_idx',
);

assert(
  pkg.scripts?.['test:orders-request-pressure'] === 'node scripts/orders-request-pressure-guard.mjs',
  'package.json must expose test:orders-request-pressure',
);

console.log('PASS orders request pressure guard');
