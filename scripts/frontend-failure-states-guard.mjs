import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function methodBlock(methodName) {
  const marker = `  ${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const promiseMarker = source.indexOf('): Promise', start);
  const searchFrom = promiseMarker === -1 ? start : promiseMarker;
  const bodyStart = source.indexOf('{', searchFrom);
  if (bodyStart === -1) return '';

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

const criticalMethods = [
  'fetchCounts',
  'fetchInitData',
  'fetchOrders',
  'fetchOrderFull',
  'fetchInventoryPage',
  'fetchInventory',
  'fetchBillingSummary',
  'fetchRates',
  'browseRates',
];

for (const method of criticalMethods) {
  const block = methodBlock(method);
  assert(block.length > 0, `${method} exists in v2-apiClient`);
  assert(
    !/\breturn\s+safe\(/.test(block),
    `${method} does not hide request failures behind safe() empty fallbacks`,
  );
}

assert(
  methodBlock('fetchCounts').includes('throwOnError: true'),
  'fetchCounts keeps stale cached data but rethrows first-load failures',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
