import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const ordersRoute = read('src/routes/orders.ts');

const bulkStart = ordersRoute.indexOf("'/bulk-assign'");
assert(bulkStart >= 0, 'orders route must define POST /bulk-assign');
const bulkEnd = ordersRoute.indexOf('// PS-312/PS-317', bulkStart);
assert(bulkEnd > bulkStart, 'bulk-assign block boundary must be findable');
const bulkBlock = ordersRoute.slice(bulkStart, bulkEnd);

assertIncludes(
  bulkBlock,
  'resolveOrderLifecycleStatus({',
  'bulk assignment must delegate terminal-row policy to order-lifecycle-status',
);
assertIncludes(
  bulkBlock,
  'terminalRows',
  'bulk assignment must compute terminal rows before writing',
);
assertIncludes(
  bulkBlock,
  'terminalRows.length',
  'bulk assignment must reject terminal lifecycle rows before the UPDATE',
);
assertIncludes(
  bulkBlock,
  'order lifecycle is terminal',
  'bulk assignment rejection must document the terminal lifecycle policy',
);
assert(
  bulkBlock.indexOf('terminalRows.length') < bulkBlock.indexOf('.update(orders)'),
  'bulk assignment terminal check must run before the UPDATE',
);
assert(
  /where\(and\(orderScopePredicate\(bulkAssignScope\),\s*inArray\(orders\.id,\s*orderIds\)\)\)/.test(bulkBlock),
  'bulk assignment UPDATE must remain caller-scope-predicated',
);

assert.equal(
  packageJson.scripts?.['test:ps-411-bulk-assign-terminal-lock'],
  'tsx scripts/ps-411-bulk-assign-terminal-lock-guard.ts',
  'package.json must expose PS-411 bulk assignment terminal lock guard',
);

console.log('PASS PS-411 bulk assignment terminal lock guard');
