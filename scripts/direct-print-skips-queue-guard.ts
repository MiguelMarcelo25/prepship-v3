import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');

let failures = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function sliceAfter(source: string, startMarker: string, afterMarker: string): string {
  const startSearch = source.indexOf(afterMarker);
  if (startSearch < 0) throw new Error(`Missing search marker: ${afterMarker}`);
  const start = source.indexOf(startMarker, startSearch);
  if (start < 0) throw new Error(`Missing start marker after ${afterMarker}: ${startMarker}`);
  return source.slice(start);
}

const createOrQueueLabel = sliceBetween(
  ordersView,
  "async function createOrQueueLabel(mode: 'print' | 'queue' | 'test'",
  'async function reprintLabel()',
);

const singleQueueAndPrint = sliceAfter(createOrQueueLabel, "if (mode === 'queue')", 'singleActionBusyRef.current = true');
const singleQueueBlock = sliceBetween(
  singleQueueAndPrint,
  "if (mode === 'queue')",
  'const labelRequestStarted = performance.now()',
);
const singleDirectPrintBlock = sliceBetween(
  singleQueueAndPrint,
  'const labelRequestStarted = performance.now()',
  '} catch (error) {',
);
const singleCatchBlock = sliceBetween(
  singleQueueAndPrint,
  '} catch (error) {',
  '} finally {',
);

check(
  'single-order Print to Queue delegates to backend queue send',
  /await sendOrdersToQueueBackend\(\[order\],\s*\{[\s\S]*kind:\s*'existing-labels'/.test(singleQueueBlock),
);
check(
  'single-order Create + Print buys through labels API',
  /await apiClient\.createLabel\(payload\)/.test(singleDirectPrintBlock),
);
check(
  'single-order Create + Print opens the returned label PDF',
  /openLabelPdfUrl\(queueableLabelUrl,\s*labelPopup\)/.test(singleDirectPrintBlock),
);
check(
  'single-order existing-label requeue is guarded to queue mode only',
  /if \(mode === 'queue'\)\s*\{[\s\S]*queueExistingLabelAfterCreateConflict\(order,\s*error\)/.test(singleCatchBlock),
);

const handleBatchAction = sliceBetween(
  ordersView,
  "async function handleBatchAction(mode: 'print' | 'queue')",
  '// Batch Mark-as-Shipped',
);
const batchQueueAndPrint = sliceAfter(handleBatchAction, "if (mode === 'queue')", 'if (batchOrders.length === 0)');
const batchQueueBlock = sliceBetween(
  batchQueueAndPrint,
  "if (mode === 'queue')",
  "if (mode === 'print')",
);
// SUPERSEDED 2026-07-07 (58cb23ec "Delete legacy Create+Print loop; retire
// BATCH_PRINT_VIA_QUEUE flag"; wired at 03e22584): the legacy per-order batch
// Create+Print loop (`let created = 0`) is GONE. Batch Create+Print now chains
// the backend queue jobs — runCreatePrintChain -> sendOrdersToQueueBackend
// (kind:'create-print') -> /print-queue/print merge — and the FE buys nothing.
const batchPrintStart = batchQueueAndPrint.indexOf("if (mode === 'print')");
if (batchPrintStart < 0) throw new Error("Missing batch print-branch marker: if (mode === 'print')");
const batchPrintBlock = batchQueueAndPrint.slice(batchPrintStart);

check(
  'batch Send to Queue delegates to backend queue send',
  /await sendOrdersToQueueBackend\(batchOrders,\s*\{[\s\S]*kind:\s*'batch-queue'/.test(batchQueueBlock),
);
check(
  'batch Send to Queue returns before direct-print tail',
  /\breturn\b/.test(batchQueueBlock),
);
check(
  'batch Create + Print routes the buy through the backend create/print chain (FE buys nothing)',
  /await runCreatePrintChain\(batchOrders,/.test(batchPrintBlock) &&
    /sendOrdersToQueueBackend\(sendableOrders,\s*\{[\s\S]*?kind:\s*'create-print'/.test(batchPrintBlock) &&
    !/apiClient\.createLabel\(/.test(batchPrintBlock),
);
check(
  'batch Create + Print prints via the backend print-queue merge, not a FE label open',
  /printQueueEntries\(entryIds,/.test(batchPrintBlock) &&
    !/apiClient\.openLabelPdf\(/.test(batchPrintBlock),
);

const forbiddenDirectQueuePatterns: Array<[string, RegExp]> = [
  ['backend queue send from direct-print block', /sendOrdersToQueueBackend/],
  ['frontend addToQueue from direct-print block', /apiClient\.addToQueue/],
  ['queue job start from direct-print block', /startQueueSendJob/],
  ['queue drawer hydration from direct-print block', /hydrateQueue\(true\)/],
  ['queue drawer open from direct-print block', /setQueueOpen\(true\)/],
  ['print-queue route string from direct-print block', /['"]\/print-queue/],
  ['existing-label queue recovery from direct-print block', /queueExistingLabelAfterCreateConflict/],
];

for (const [name, pattern] of forbiddenDirectQueuePatterns) {
  // single-order Create+Print is still a TRUE direct print that SKIPS the queue.
  check(`single-order Create + Print has no ${name}`, !pattern.test(singleDirectPrintBlock));
  // SUPERSEDED 2026-07-07 (58cb23ec): batch Create+Print now DELIBERATELY calls
  // sendOrdersToQueueBackend (kind:'create-print'); every OTHER FE queue-helper is
  // still forbidden in the batch branch.
  if (!/sendOrdersToQueueBackend/.test(pattern.source)) {
    check(`batch Create + Print has no ${name}`, !pattern.test(batchPrintBlock));
  }
}

const createLabelApiClientBlock = sliceBetween(apiClient, 'createLabel(payload: unknown)', 'retrieveLabel(orderLookup');
check(
  'apiClient.createLabel posts only to /labels',
  /api\.post<any>\('\/labels',\s*payload\)/.test(createLabelApiClientBlock),
);
check(
  'apiClient.createLabel does not call print-queue APIs',
  !/\/print-queue|addToQueue|startQueueSendJob/.test(createLabelApiClientBlock),
);

const labelsCreateRouteBlock = sliceBetween(labelsRoute, "app.post('/',", "// POST /labels/create");
// fe730dda ("Add label and print queue operation logs") extracted the handler body into
// createLabelRouteResponse; the route delegates to it and IT owns the createLabelV2 call.
check(
  'POST /labels route delegates to createLabelV2',
  /return createLabelRouteResponse\(c,\s*c\.req\.valid\('json'\)\)/.test(labelsCreateRouteBlock) &&
    /async function createLabelRouteResponse\(c: Context, body: CreateLabelRouteBody\): Promise<Response> \{[\s\S]{0,200}?await createLabelV2\(body,\s*labelsScopeFromContext\(c\)\)/.test(labelsRoute),
);
check(
  'POST /labels route does not call print-queue persistence',
  !/\/print-queue|addToQueue|startQueueSendJob|sendOrdersToQueueBackend/.test(labelsCreateRouteBlock),
);

const labelServiceImports = labelsService.slice(0, 5000);
check(
  'label service does not import print-queue persistence',
  !/from ['"].*(print-queue|schema\/print-queue)/.test(labelServiceImports) && !/addToQueue/.test(labelServiceImports),
);

if (failures > 0) {
  console.error(`\nFAIL direct-print skips queue guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS direct-print skips queue guard');
