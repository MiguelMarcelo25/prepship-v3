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
