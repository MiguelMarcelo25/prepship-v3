import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, pass: boolean) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  if (!pass) failures += 1;
}

const helperPath = 'src/lib/manual-orders-visibility.ts';
const helper = existsSync(helperPath) ? read(helperPath) : '';
const initRoute = read('src/routes/init.ts');
const ordersRoute = read('src/routes/orders.ts');
const clientsRoute = read('src/routes/clients.ts');

check(
  'manual order visibility helper exists',
  helper.includes('MANUAL_ORDERS_CLIENT_NAME') &&
    helper.includes('isManualOrdersClientName') &&
    helper.includes('manualOrdersOrderPredicateSql'),
);

check(
  '/init/stores emits Manual Orders as a synthetic client-scoped sidebar store',
  initRoute.includes('isManualOrdersClientName') &&
    /storeId:\s*-cli\.id/.test(initRoute) &&
    initRoute.includes('visibleManualOrdersSidebarStore') &&
    /visibleManualOrdersSidebarStore[\s\S]*visibleIds\.length === 0/.test(initRoute),
);

check(
  '/init/counts includes Manual Orders only in the awaiting work visibility branch',
  initRoute.includes('manualOrdersOrderPredicateSql') &&
    /manualOrdersAwaitingPredicate[\s\S]*awaiting_shipment/.test(initRoute) &&
    /manualOrdersAwaitingPredicate[\s\S]*manualOrdersOrderPredicateSql\('o'/.test(initRoute),
);

check(
  '/orders list allows Manual Orders only when the effective status is awaiting',
  ordersRoute.includes('manualOrdersOrderPredicateSql') &&
    /manualOrdersAwaitingVisibilityPredicate[\s\S]*listEffectiveStatusSql[\s\S]*awaiting_shipment/.test(ordersRoute) &&
    /listVisibilityPredicate[\s\S]*manualOrdersAwaitingVisibilityPredicate/.test(ordersRoute),
);

check(
  '/orders daily stats keeps the Awaiting strip aligned with Manual Orders sidebar visibility',
  /manualOrdersDailyStatsAwaitingPredicate[\s\S]*dailyStatsEffectiveStatusSql[\s\S]*awaiting_shipment/.test(ordersRoute) &&
    /dailyStatsVisibilityPredicate[\s\S]*manualOrdersDailyStatsAwaitingPredicate/.test(ordersRoute),
);

check(
  '/clients/order-stats counts Manual Orders awaiting rows despite the excluded store id',
  clientsRoute.includes('manualOrdersOrderPredicateSql') &&
    /manualOrdersAwaitingPredicate[\s\S]*effectiveStatusSql[\s\S]*awaiting_shipment/.test(clientsRoute),
);

if (failures > 0) {
  console.error(`FAIL manual orders awaiting sidebar guard: ${failures} failure(s)`);
  process.exit(1);
}

console.log('PASS manual orders awaiting sidebar guard');
