import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  ordersView.includes('const weightOz = getOrderWeightOz(order, orderDetail)') &&
    ordersView.includes('const effectiveWeightOz = weightOz > 0 ? weightOz : orderIsTest ? 1 : 0') &&
    ordersView.includes('weightOz: effectiveWeightOz > 0 ? effectiveWeightOz : undefined'),
  'Batch Send to Queue must use the same test-order weight fallback as the single-label path',
);

const testWeightFallbackCount = (ordersView.match(/const effectiveWeightOz = weightOz > 0 \? weightOz : orderIsTest \? 1 : 0/g) ?? []).length;
assert(
  testWeightFallbackCount >= 3,
  'Batch queue, batch print, and resumed batch queue paths must all apply the test-order weight fallback',
);

assert(
  !ordersView.includes('const weightOz = order.weight?.value ?? 0\n      const dims = getDimensions(order, null)'),
  'Batch label paths must not use the stale summary-only weight/dims lookup',
);

assert(
  ordersView.includes('weightOz: effectiveWeightOz,'),
  'Batch Create + Print Label must send the effective test-order weight fallback',
);

assert(
  labelsService.includes('body.testLabel ? 1 : 0') &&
    labelsService.includes('if (body.testLabel === true)'),
  'Backend test labels must have a safe fallback weight before mock label creation',
);

assert(
  pkg.scripts?.['test:test-order-queue-label'] === 'node scripts/test-order-queue-label-guard.mjs',
  'package.json must expose test:test-order-queue-label',
);

console.log('PASS test order queue label guard');
