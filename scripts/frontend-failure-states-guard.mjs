import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');
const vercelFunctionSource = fs.readFileSync(path.join(root, 'web/src/lib/vercelFunction.ts'), 'utf8');
const ordersViewSource = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersView.tsx'), 'utf8');

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

assert(
  methodBlock('fetchBillingSummary').includes('throwOnError: true'),
  'fetchBillingSummary keeps stale cached data but rethrows first-load failures',
);

assert(
  /timeoutMs\?:\s*number/.test(vercelFunctionSource) &&
    /READ_TIMEOUT_MS\s*=\s*30_000/.test(vercelFunctionSource) &&
    /WRITE_TIMEOUT_MS\s*=\s*60_000/.test(vercelFunctionSource),
  'callVercelFunction exposes bounded timeout support with 30s read and 60s write defaults',
);

assert(
  /new\s+AbortController\(\)/.test(vercelFunctionSource) &&
    /window\.setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*timeoutMs\)/.test(vercelFunctionSource) &&
    /window\.clearTimeout\(timeoutId\)/.test(vercelFunctionSource),
  'callVercelFunction aborts timed-out direct Vercel fetches and clears the timer',
);

assert(
  vercelFunctionSource.includes('The carrier provider may still be processing') &&
    vercelFunctionSource.includes('retry from Orders in a moment') &&
    /Timed out after \$\{timeoutSeconds\}s calling \$\{method\} \$\{url\}/.test(vercelFunctionSource),
  'callVercelFunction throws safe timeout errors with method, API path, timeout seconds, and provider retry advice',
);

assert(
  /function getQueueableLabelUrl\(/.test(ordersViewSource) &&
    ordersViewSource.includes('[object Object]') &&
    ordersViewSource.includes('Label URL is not queueable'),
  'OrdersView has an explicit queueable label URL validator for empty, object, and [object Object] responses',
);

assert(
  /const labelUrl = getQueueableLabelUrl\(order\.label\?\.labelUrl\)/.test(ordersViewSource) &&
    /const queueableLabelUrl = getQueueableLabelUrl\(response\.labelUrl\)/.test(ordersViewSource) &&
    /await apiClient\.addToQueue\(buildQueueAddPayload\(order, queueableLabelUrl\)\)/.test(ordersViewSource),
  'OrdersView validates labelUrl before queueing existing labels and newly-created labels',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
