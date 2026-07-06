import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  resolveOrderLifecycleStatus,
  isBillingLifecycleSourceStatus,
  type OrderLifecycleStatusResult,
} from '../src/services/order-lifecycle-status';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

function lifecycle(input: Parameters<typeof resolveOrderLifecycleStatus>[0]): OrderLifecycleStatusResult {
  return resolveOrderLifecycleStatus(input);
}

assert.deepEqual(
  lifecycle({ orderStatus: 'awaiting_shipment', canonicalStatus: 'cancelled' }),
  {
    effectiveOrderStatus: 'cancelled',
    orderLifecycleStatus: 'upstream_cancelled',
    orderLifecycleLabel: 'Cancelled upstream',
    orderLifecycleReason: 'canonical_status=cancelled while local order_status is still awaiting_shipment',
    isTerminal: true,
    isShippingBlocked: true,
    billingStatus: 'cancelled',
  },
  'upstream-cancelled awaiting rows must classify as effective cancelled without mutating order_status',
);

assert.equal(
  lifecycle({ orderStatus: 'awaiting_shipment', externallyShipped: true }).orderLifecycleStatus,
  'externally_shipped',
  'externally shipped awaiting rows must classify as shipped lifecycle',
);
assert.equal(
  lifecycle({ orderStatus: 'shipped', canonicalStatus: 'shipped_pending_confirmation' }).orderLifecycleStatus,
  'shipped_pending_confirmation',
  'pending marketplace confirmation must stay visible as its own shipped lifecycle',
);
assert.equal(
  lifecycle({ orderStatus: 'shipped', canonicalStatus: 'confirmation_failed' }).orderLifecycleStatus,
  'confirmation_failed',
  'marketplace confirmation failures must stay visible as their own shipped lifecycle',
);
assert.equal(
  lifecycle({ orderStatus: 'shipped', shippedLabelDisplayState: 'voided_label' }).orderLifecycleStatus,
  'voided_label',
  'voided shipped labels must stay visible as their own lifecycle state',
);
assert.equal(
  lifecycle({ orderStatus: 'shipped', shippedLabelDisplayState: 'missing_shipment_sync' }).orderLifecycleStatus,
  'missing_shipment_sync',
  'missing shipment sync must stay visible as its own lifecycle state',
);
assert.equal(isBillingLifecycleSourceStatus(lifecycle({ orderStatus: 'awaiting_shipment', canonicalStatus: 'cancelled' })), true);
assert.equal(isBillingLifecycleSourceStatus(lifecycle({ orderStatus: 'awaiting_shipment' })), false);

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const lifecycleOwner = read('src/services/order-lifecycle-status.ts');
const ordersRoute = read('src/routes/orders.ts');
const initRoute = read('src/routes/init.ts');
const clientsRoute = read('src/routes/clients.ts');
const billingService = read('src/services/billing.ts');
const billingRowStatus = read('src/services/billing-row-status.ts');
const ordersRowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const apiTypes = read('web/src/types/api.ts');

assertIncludes(lifecycleOwner, 'export function resolveOrderLifecycleStatus', 'backend lifecycle owner must expose pure resolver');
assertIncludes(lifecycleOwner, 'export function orderLifecycleBillingSourcePredicate', 'backend lifecycle owner must expose Billing SQL predicate');
assertIncludes(lifecycleOwner, 'export function orderLifecycleStatusSql', 'backend lifecycle owner must expose SQL projection for row surfaces');
assertIncludes(lifecycleOwner, 'export function orderLifecycleEffectiveStatusAliasSql', 'backend lifecycle owner must expose alias SQL projection for raw SQL count surfaces');

assertIncludes(ordersRoute, "from '../services/order-lifecycle-status'", 'Orders route must import backend lifecycle owner');
assertIncludes(ordersRoute, 'resolveOrderLifecycleStatus({', 'Orders route must build row lifecycle DTO from backend owner');
assertIncludes(ordersRoute, 'orderLifecycleStatus:', 'Orders rows must emit orderLifecycleStatus');
assertIncludes(ordersRoute, 'effectiveOrderStatus:', 'Orders rows must emit effectiveOrderStatus');
assertIncludes(ordersRoute, 'orderLifecycleEffectiveStatusAliasSql', 'Orders raw SQL count/filter surfaces must use lifecycle alias helper');
assert(
  !/const effectiveOrderStatus = isShippedBucket \? 'shipped' : r\.order\.orderStatus/.test(ordersRoute),
  'Orders route must not own an inline effective status ternary',
);
assertIncludes(initRoute, 'orderLifecycleEffectiveStatusAliasSql', 'Init counts must use backend lifecycle status SOT');
assertIncludes(clientsRoute, 'orderLifecycleEffectiveStatusAliasSql', 'Client order stats must use backend lifecycle status SOT');

assertIncludes(billingService, 'orderLifecycleBillingSourcePredicate()', 'Billing source query must use lifecycle predicate');
assertIncludes(billingService, 'orderLifecycleBillingSourcePredicateAlias', 'Billing freshness raw SQL must use lifecycle alias predicate');
assertIncludes(billingService, 'resolveOrderLifecycleStatus({', 'Billing source rows must delegate lifecycle classification to backend owner');
assertIncludes(billingService, 'orderLifecycleStatus:', 'Billing detail rows must carry lifecycle status');
assertIncludes(billingRowStatus, 'orderLifecycleStatus', 'Billing row badge owner must accept backend lifecycle status');

assertIncludes(apiTypes, 'orderLifecycleStatus?:', 'API type must expose backend lifecycle status');
assertIncludes(apiTypes, 'effectiveOrderStatus?:', 'API type must expose backend effective status');
assert(
  !/order\.orderStatus === 'awaiting_shipment'/.test(ordersRowDisplay),
  'Orders row display helpers must not use raw orderStatus as the lifecycle source of truth',
);
assertIncludes(ordersRowDisplay, 'getOrderEffectiveStatus(order)', 'Orders row display helpers must read backend effective status helper');

assert.equal(
  packageJson.scripts?.['test:ps-387-effective-order-status-sot'],
  'tsx scripts/ps-387-effective-order-status-sot-guard.ts',
  'package.json must expose PS-387 guard',
);

console.log('PASS PS-387 effective order status SOT guard');
