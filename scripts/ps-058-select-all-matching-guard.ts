import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const ordersRoute = read('src/routes/orders.ts');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const packageJson = read('package.json');

assert(
  /idsOnly:\s*z\.coerce\.boolean\(\)\.optional\(\)/.test(ordersRoute),
  'GET /orders must expose an idsOnly query for selecting all matching rows without hydrating every page.',
);
assert(
  /selectionLimit:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.max\(5000\)\.optional\(\)/.test(ordersRoute),
  'GET /orders idsOnly must have a bounded selectionLimit so all-pages selection cannot request unbounded IDs.',
);
assert(
  /q\.idsOnly/.test(ordersRoute) && /select\(\{\s*id:\s*orders\.id\s*\}\)/s.test(ordersRoute),
  'GET /orders must return matching order IDs from the same filtered/orderBy scope when idsOnly=true.',
);
assert(
  /fetchMatchingOrderIds\(query:/.test(apiClient),
  'apiClient must expose fetchMatchingOrderIds for the Orders table all-matching selection action.',
);
assert(
  /fetchMatchingOrdersForSelection\(query:/.test(apiClient),
  'apiClient must expose fetchMatchingOrdersForSelection so off-page selected rows are hydrated before batch actions.',
);
assert(
  /selectionScopeKey/.test(ordersView) && /setAllMatchingSelection/.test(ordersView),
  'OrdersView must track the exact filter scope used for all-matching selection and reset it when filters change.',
);
assert(
  /selectAllMatchingOrders/.test(ordersView),
  'OrdersView must provide an explicit Select all matching orders action.',
);
assert(
  /Select page/.test(ordersView) && /Select all/.test(ordersView) && /matching/.test(ordersView),
  'OrdersView toolbar must label current-page selection separately from all matching orders across pages.',
);
assert(
  !/const batchOrders = orders\.filter\(\(order\) => selectedIdSet\.has\(order\.orderId\)\)/.test(ordersView),
  'Batch actions must not rebuild selection from the visible orders page only.',
);
assert(
  !/const nextSelected = selectedOrderIds\.filter\(\(id\) => visibleIds\.has\(id\)\)/.test(ordersView),
  'OrdersView must not prune selected IDs down to the current visible page.',
);
assert(
  /hydrateSelectedOrdersForActions/.test(ordersView),
  'OrdersView must hydrate off-page selected orders before print/queue/mark-shipped actions.',
);
assert(
  /current page/.test(ordersView) && /SKU group/.test(ordersView),
  'SKU group selection must be explicitly labeled as current-page/page-local.',
);
assert(
  /"test:ps-058-select-all-matching":\s*"tsx scripts\/ps-058-select-all-matching-guard\.ts"/.test(packageJson),
  'package.json must include test:ps-058-select-all-matching.',
);

console.log('[ps-058] select current page vs all matching guard passed');
