import assert from 'node:assert/strict'
import test from 'node:test'

import { formatQueuedItemsSummary, formatQueuedOrderToast, formatQueuedOrdersToast } from '../src/components/Views/orders-queue.ts'

test('formatQueuedItemsSummary merges repeated items and prefers sku labels', () => {
  const summary = formatQueuedItemsSummary([
    { sku: 'SKU-1', name: 'Widget', quantity: 2 },
    { sku: 'SKU-1', name: 'Widget', quantity: 1 },
    { sku: 'SKU-2', name: 'Other', quantity: 4 },
  ])

  assert.equal(summary, 'SKU-1 x3, SKU-2 x4')
})

test('formatQueuedItemsSummary truncates long item lists with overflow text', () => {
  const summary = formatQueuedItemsSummary([
    { sku: 'A', quantity: 1 },
    { sku: 'B', quantity: 1 },
    { sku: 'C', quantity: 1 },
    { sku: 'D', quantity: 1 },
  ])

  assert.equal(summary, 'A x1, B x1, C x1 +1 more')
})

test('formatQueuedOrderToast includes the order number and queued item summary', () => {
  const message = formatQueuedOrderToast('ORDER-42', [
    { sku: 'SKU-1', quantity: 2 },
    { name: 'Widget', quantity: 1 },
  ])

  assert.equal(message, '✅ ORDER-42 sent to queue: SKU-1 x2, Widget x1')
})

test('formatQueuedOrdersToast includes aggregate item summary and skipped count', () => {
  const message = formatQueuedOrdersToast(2, [
    { sku: 'SKU-1', quantity: 2 },
    { sku: 'SKU-1', quantity: 1 },
    { sku: 'SKU-2', quantity: 4 },
  ], 1)

  assert.equal(message, '✅ 2 orders sent to queue: SKU-1 x3, SKU-2 x4 (1 skipped)')
})
