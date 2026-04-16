import assert from 'node:assert/strict'
import test from 'node:test'

import { groupOrdersBySku } from '../src/components/Views/orders-grouping.ts'

test('groupOrdersBySku groups same-SKU orders across clients and reports counts', () => {
  const grouped = groupOrdersBySku([
    { orderId: 1, clientName: 'Alpha', sku: 'SKU-1' },
    { orderId: 2, clientName: 'Beta', sku: 'SKU-1' },
    { orderId: 3, clientName: 'Gamma', sku: 'SKU-2' },
  ], (order) => order.sku)

  assert.deepEqual(
    grouped.map((group) => ({
      sku: group.sku,
      count: group.count,
      orderIds: group.orders.map((order) => order.orderId),
    })),
    [
      { sku: 'SKU-1', count: 2, orderIds: [1, 2] },
      { sku: 'SKU-2', count: 1, orderIds: [3] },
    ],
  )
})

test('groupOrdersBySku merges sku labels case-insensitively and falls back for blanks', () => {
  const grouped = groupOrdersBySku([
    { orderId: 1, sku: 'sku-1' },
    { orderId: 2, sku: 'SKU-1' },
    { orderId: 3, sku: '' },
  ], (order) => order.sku)

  assert.equal(grouped.length, 2)
  assert.equal(grouped[0]?.sku, 'sku-1')
  assert.equal(grouped[0]?.count, 2)
  assert.equal(grouped[1]?.sku, 'Unknown SKU')
  assert.equal(grouped[1]?.count, 1)
})
