import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');
// PS-200 S2 re-anchor: vercelFunction.ts (the second FE transport) is DELETED —
// every FE request now flows through web/src/lib/api.ts, so the bounded-timeout
// and abort pins below retarget there. Same protections, one transport.
const apiSource = fs.readFileSync(path.join(root, 'web/src/lib/api.ts'), 'utf8');
const ordersViewSource = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersView.tsx'), 'utf8');
// PS-258 re-anchor: the queueable-label-URL validator (getQueueableLabelUrl) moved out of OrdersView
// into the strict module orders-queue-parsers.ts; OrdersView imports + still uses it. Same protection.
const queueParsersSource = fs.readFileSync(path.join(root, 'web/src/components/Views/orders-queue-parsers.ts'), 'utf8');
// PS-166/PS-306/PS-258 (Wave 3) re-anchor: the loading/error/Retry framing around the orders
// table moved VERBATIM out of OrdersView into the strict presentational <OrdersResultsShell>.
// The "Failed to load orders" + Retry markup now lives in OrdersResultsShell (delegating to
// onRetry), and OrdersView passes onRetry={refetchOrders}. Same recovery protection, one move.
const ordersResultsShellSource = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersResultsShell.tsx'), 'utf8');

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
  /function getQueueableLabelUrl\(/.test(queueParsersSource) &&
    queueParsersSource.includes('[object Object]') &&
    /import \{[^}]*getQueueableLabelUrl[^}]*\} from '\.\/orders-queue-parsers'/.test(ordersViewSource) &&
    ordersViewSource.includes('Label URL is not queueable'),
  'queueable label URL validator (getQueueableLabelUrl, rejects [object Object]) lives in orders-queue-parsers; OrdersView imports it and still surfaces "Label URL is not queueable"',
);

assert(
  /const labelUrl = getQueueableLabelUrl\(order\.label\?\.labelUrl\)/.test(ordersViewSource) &&
    /const queueableLabelUrl = getQueueableLabelUrl\(response\.labelUrl\)/.test(ordersViewSource) &&
    /await apiClient\.addToQueue\(buildQueueAddPayload\(order, queueableLabelUrl\)\)/.test(ordersViewSource) &&
    // 2026-07-07 cleanup re-anchor: the legacy batch loop's per-label apiClient.openLabelPdf is
    // deleted (batch print opens ONE merged PDF via the backend signed URL). The created-label
    // validated open survives on the single-order path via openLabelPdfUrl(queueableLabelUrl, ...).
    /openLabelPdfUrl\(queueableLabelUrl/.test(ordersViewSource),
  'OrdersView validates existing-label queue URLs before addToQueue and created-label URLs before opening PDFs',
);

assert(
  /Failed to load orders/.test(ordersResultsShellSource) &&
    /onClick=\{\(\)\s*=>\s*void onRetry\(\)\}/.test(ordersResultsShellSource) &&
    />\s*Retry\s*</.test(ordersResultsShellSource) &&
    /onRetry=\{refetchOrders\}/.test(ordersViewSource),
  'OrdersResultsShell shows a recoverable Retry action when the Orders API fails; OrdersView delegates via onRetry={refetchOrders}',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
