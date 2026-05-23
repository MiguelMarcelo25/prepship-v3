#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const service = read('src/services/print-queue.ts');
const route = read('src/routes/print-queue.ts');
const labels = read('src/services/labels.ts');
const orderSync = read('src/services/order-sync.ts');
const cleanup = fs.existsSync(path.join(root, 'scripts/cleanup-stale-queue-entries.ts'))
  ? read('scripts/cleanup-stale-queue-entries.ts')
  : '';
const apiClient = read('web/src/lib/v2-apiClient.ts');

const failures = [];
const pass = (condition, message) => {
  if (!condition) failures.push(message);
};

pass(
  service.includes('confirmPrintedQueueEntries'),
  'print queue service must expose explicit operator confirm-printed behavior'
);
pass(
  route.includes('/confirm-printed') && route.includes('confirmPrintedQueueEntries'),
  'print queue routes must expose a scoped /confirm-printed endpoint'
);
pass(
  apiClient.includes('confirmPrintedQueueEntries'),
  'frontend API client must expose confirmPrintedQueueEntries'
);
pass(
  !/runMergeJob[\s\S]*\.set\(\{\s*status:\s*['"]printed['"]/m.test(service),
  'PDF merge must not mark queue entries printed'
);
pass(
  !labels.includes('scheduleQueueCleanupAfterLabel(order.id, timer)'),
  'label creation must not schedule queue cleanup after marking an order shipped'
);
pass(
  !/markOrderShipped[\s\S]*removeQueueEntriesForOrder/m.test(labels),
  'markOrderShipped must not remove active print queue entries'
);
pass(
  !/delete\(printQueue\)[\s\S]*orderIdsForCleanup/m.test(orderSync),
  'order sync must not delete queue entries only because an order became shipped/cancelled'
);
pass(
  /print queue persists until explicit[\s\S]*operator action/.test(service),
  'print queue service must document the persistence rule near legacy cleanup behavior'
);
pass(
  !/where o\.order_status in \('shipped', 'cancelled'\)[\s\S]*delete\(printQueue\)/m.test(cleanup),
  'cleanup-stale-queue-entries must not delete active entries solely because orders are shipped/cancelled'
);
pass(
  route.includes('REMOVE_UNPRINTED_LABELS') && apiClient.includes('REMOVE_UNPRINTED_LABELS'),
  'clear queue must require a strong explicit confirmation token'
);

if (failures.length) {
  console.error('print queue persistence guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('print queue persistence guard passed');
