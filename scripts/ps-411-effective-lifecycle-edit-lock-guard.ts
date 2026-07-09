import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolveOrderLifecycleStatus } from '../src/services/order-lifecycle-status';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment', canonicalStatus: 'cancelled' }).isTerminal,
  true,
  'upstream-cancelled awaiting rows must be terminal at the lifecycle owner',
);
assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment', externallyShipped: true }).isTerminal,
  true,
  'externally-shipped awaiting rows must be terminal at the lifecycle owner',
);
assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment' }).isTerminal,
  false,
  'normal awaiting rows must remain editable lifecycle rows',
);

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const ordersRoute = read('src/routes/orders.ts');
const comboDefaults = read('src/services/combo-package-defaults.ts');

assertIncludes(
  ordersRoute,
  'Per user override unlock shipped data on 2026-07-09',
  'orders route locked edit path must carry the explicit override note',
);
assertIncludes(
  ordersRoute,
  'canonicalStatus: orders.canonicalStatus',
  'assertOrderEditable must select canonicalStatus for effective lifecycle locking',
);
assertIncludes(
  ordersRoute,
  'externallyShipped: orders.externallyShipped',
  'assertOrderEditable must select externallyShipped for effective lifecycle locking',
);
assertIncludes(
  ordersRoute,
  'resolveOrderLifecycleStatus({',
  'assertOrderEditable must delegate terminal policy to order-lifecycle-status',
);
assertIncludes(
  ordersRoute,
  'if (!lifecycle.isTerminal)',
  'assertOrderEditable must allow only non-terminal effective lifecycle rows',
);
assert(
  !/const status = String\(row\.status \?\? ''\)\.toLowerCase\(\);\s*if \(!LOCKED_STATUSES\.has\(status\)\) \{\s*return \{ ok: true \};\s*\}/.test(ordersRoute),
  'assertOrderEditable must not use raw-status-only LOCKED_STATUSES as the allow decision',
);

assertIncludes(
  comboDefaults,
  'orderLifecycleEffectiveStatusSql',
  'combo package default writers must use lifecycle effective status SQL',
);
assertIncludes(
  comboDefaults,
  'mutableAwaitingOrderLifecyclePredicate()',
  'combo package default writers must share the lifecycle mutable-awaiting predicate',
);
assert(
  !/eq\(orders\.orderStatus,\s*'awaiting_shipment'\),\s*\)/.test(comboDefaults),
  'combo package default writes must not rely on raw awaiting status as their only mutation gate',
);

assert.equal(
  packageJson.scripts?.['test:ps-411-effective-lifecycle-edit-lock'],
  'tsx scripts/ps-411-effective-lifecycle-edit-lock-guard.ts',
  'package.json must expose PS-411 effective lifecycle edit-lock guard',
);

console.log('PASS PS-411 effective lifecycle edit-lock guard');
