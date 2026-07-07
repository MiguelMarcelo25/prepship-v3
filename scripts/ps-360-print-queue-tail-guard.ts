import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

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

const handleBatchAction = sliceBetween(
  ordersView,
  "async function handleBatchAction(mode: 'print' | 'queue')",
  '// Batch Mark-as-Shipped',
);

const queueEarlyReturnStart = handleBatchAction.indexOf("if (mode === 'queue')");
// 2026-07-07 cleanup slice: the legacy print-only label-create tail is DELETED — the print
// branch now chains the backend queue jobs (runCreatePrintChain) unconditionally. The guard's
// intent is unchanged (queue mode delegates + returns; no FE buying remnants), repointed to
// the chain-only structure.
const printBranchStart = handleBatchAction.indexOf("if (mode === 'print')");

check(
  'handleBatchAction has an explicit queue early-return block',
  queueEarlyReturnStart >= 0 && printBranchStart > queueEarlyReturnStart,
);

const queueEarlyReturnBlock = handleBatchAction.slice(queueEarlyReturnStart, printBranchStart);
check(
  'queue mode delegates to backend sendOrdersToQueueBackend before the print branch',
  /await sendOrdersToQueueBackend\(batchOrders,\s*\{[\s\S]*kind:\s*'batch-queue'/.test(queueEarlyReturnBlock),
);
check(
  'queue mode returns before the print branch',
  /\breturn\b/.test(queueEarlyReturnBlock),
);

const printBranch = handleBatchAction.slice(printBranchStart);

const forbiddenQueueTailPatterns: Array<[string, RegExp]> = [
  ['queue-mode casts after the queue early return', /\(mode as string\)\s*===\s*'queue'/],
  ['old batch addToQueue call after the queue early return', /apiClient\.addToQueue\(buildQueueAddPayload\(order,\s*queueableLabelUrl\)\)/],
  ['persistent queue job creation after the queue early return', /beginPersistentQueueJob\('batch-queue'/],
  ['persistent queue progress markers after the queue early return', /markPersistentQueueJobOrder\(/],
  ['queue action progress advances after the queue early return', /advanceQueueActionProgress\(/],
  ['queue-only hydrate after the queue early return', /hydrateQueue\(true\)/],
  ['queue completion progress after the queue early return', /finishQueueActionProgress\(/],
  ['queued-item toast assembly after the queue early return', /formatQueuedOrdersToast\(/],
  // Legacy FE buying remnants — deleted 2026-07-07; must never come back.
  ['legacy FE label buy (apiClient.createLabel) in the print branch', /apiClient\.createLabel\(/],
  ['legacy FE label PDF open (apiClient.openLabelPdf) in the print branch', /apiClient\.openLabelPdf\(/],
];

for (const [name, pattern] of forbiddenQueueTailPatterns) {
  check(`no ${name}`, !pattern.test(printBranch));
}

check(
  'print branch chains the backend queue jobs (runCreatePrintChain)',
  /runCreatePrintChain\(/.test(printBranch),
);
check(
  'single-order queue and existing-label queue helpers remain outside this dead-tail guard',
  /async function createOrQueueLabel\(/.test(ordersView) &&
    /async function queueExistingLabels\(/.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL PS-360 print queue tail guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-360 print queue tail guard');
