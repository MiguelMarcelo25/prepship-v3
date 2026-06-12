import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');
// PS-200 S2 re-anchor: vercelFunction.ts (the second FE transport) is DELETED —
// every FE request now flows through web/src/lib/api.ts, so the bounded-timeout
// and abort pins below retarget there. Same protections, one transport.
const apiSource = fs.readFileSync(path.join(root, 'web/src/lib/api.ts'), 'utf8');
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
  // PS-159 removed the dead `fetchInitData` object method (0 callers; trivial passthrough,
  // no safe() fallback). Dropped from the critical-method anchor — no protection lost.
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
  /timeoutMs\?:\s*number/.test(apiSource) &&
    /READ_TIMEOUT_MS\s*=\s*30_000/.test(apiSource) &&
    /WRITE_TIMEOUT_MS\s*=\s*60_000/.test(apiSource),
  'api client exposes bounded timeout support with 30s read and 60s write defaults',
);

assert(
  /new\s+AbortController\(\)/.test(apiSource) &&
    /controller\.abort\(\)/.test(apiSource) &&
    /clearTimeout\(timer\)/.test(apiSource),
  'api client aborts timed-out fetches and clears the timer',
);

assert(
  /timed out after \$\{seconds\(timeoutMs\)\}s/.test(apiSource) &&
    apiSource.includes('Please retry; if it repeats, Render or Supabase is not responding.'),
  'api client throws safe timeout errors with the timeout seconds and retry advice',
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

assert(
  /Failed to load orders/.test(ordersViewSource) &&
    /onClick=\{\(\)\s*=>\s*void refetchOrders\(\)\}/.test(ordersViewSource) &&
    />\s*Retry\s*</.test(ordersViewSource),
  'OrdersView shows a recoverable Retry action when the Orders API fails',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
