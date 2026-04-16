import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDailyStripProgress,
  buildPicklistPrintHtml,
  buildQueueAddPayload,
  formatSyncPill,
  groupPrintQueueEntries,
  resolveColumnPrefs,
} from '../src/components/Views/orders-parity.ts'
import type { OrderSummaryDto } from '../src/types/api.ts'

const baseColumns = [
  { key: 'select', label: '', width: 34 },
  { key: 'date', label: 'Order Date', width: 90 },
  { key: 'tracking', label: 'Tracking #', width: 160 },
  { key: 'age', label: 'Age', width: 50 },
] as const

function makeOrder(overrides: Partial<OrderSummaryDto> = {}): OrderSummaryDto {
  return {
    orderId: 42,
    clientId: 7,
    clientName: 'ACME',
    orderNumber: 'ORDER-42',
    orderStatus: 'awaiting_shipment',
    orderDate: '2026-03-22T10:00:00.000Z',
    storeId: 11,
    customerEmail: 'ship@example.com',
    shipTo: { name: 'Ada Lovelace', city: 'Los Angeles', state: 'CA', postalCode: '90001' },
    carrierCode: null,
    serviceCode: null,
    weight: { value: 24, units: 'ounces' },
    orderTotal: 99.5,
    shippingAmount: 0,
    residential: null,
    sourceResidential: false,
    externalShipped: false,
    bestRate: null,
    selectedRate: null,
    label: {
      shipmentId: null,
      trackingNumber: null,
      carrierCode: null,
      serviceCode: null,
      shippingProviderId: null,
      cost: null,
      rawCost: null,
      shipDate: null,
      createdAt: null,
      labelUrl: '/labels/mock.pdf',
    },
    items: [
      { sku: 'SKU-1', name: 'Widget', quantity: 2 },
    ],
    raw: null,
    rateDims: { length: 12, width: 9, height: 4 },
    ...overrides,
  }
}

test('resolveColumnPrefs preserves saved order and auto-hides tracking for awaiting shipment', () => {
  const resolved = resolveColumnPrefs(baseColumns, 'awaiting_shipment', {
    order: ['age', 'date'],
    hidden: ['date'],
    widths: { age: 77 },
  })

  assert.deepEqual(resolved.orderedColumns.map((column) => column.key), ['age', 'date', 'select', 'tracking'])
  assert.equal(resolved.hiddenColumns.has('date'), true)
  assert.equal(resolved.hiddenColumns.has('tracking'), true)
  assert.equal(resolved.widths.age, 77)
})

test('resolveColumnPrefs auto-hides age for shipped orders', () => {
  const resolved = resolveColumnPrefs(baseColumns, 'shipped', null)
  assert.equal(resolved.hiddenColumns.has('age'), true)
  assert.equal(resolved.hiddenColumns.has('tracking'), false)
})

test('buildDailyStripProgress matches shipped summary and colors from web parity', () => {
  const progress = buildDailyStripProgress({
    window: {
      from: '2026-03-20T12:00:00-07:00',
      to: '2026-03-23T12:00:00-07:00',
      fromLabel: 'Mar 20, 12pm PT',
      toLabel: 'Mar 23, 12pm PT',
    },
    totalOrders: 10,
    needToShip: 4,
    upcomingOrders: 2,
  })

  assert.equal(progress.shipped, 6)
  assert.equal(progress.pct, 60)
  assert.equal(progress.barFill, 60)
  assert.equal(progress.barColor, '#e07a00')
  assert.equal(progress.needToShipColor, '#e07a00')
  assert.equal(progress.upcomingColor, '#2a5bd7')
})

test('groupPrintQueueEntries groups queued orders by sku_group_id', () => {
  const groups = groupPrintQueueEntries([
    {
      queue_entry_id: 'a',
      order_id: '1',
      order_number: '1001',
      client_id: 7,
      label_url: '/a.pdf',
      sku_group_id: 'SKU:ABC',
      primary_sku: 'ABC',
      item_description: 'Widget',
      order_qty: 2,
      status: 'queued',
      print_count: 0,
      last_printed_at: null,
      queued_at: '2026-03-22T10:00:00.000Z',
    },
    {
      queue_entry_id: 'b',
      order_id: '2',
      order_number: '1002',
      client_id: 7,
      label_url: '/b.pdf',
      sku_group_id: 'SKU:ABC',
      primary_sku: 'ABC',
      item_description: 'Widget',
      order_qty: 1,
      status: 'queued',
      print_count: 0,
      last_printed_at: null,
      queued_at: '2026-03-22T10:05:00.000Z',
    },
    {
      queue_entry_id: 'c',
      order_id: '3',
      order_number: '1003',
      client_id: 7,
      label_url: '/c.pdf',
      sku_group_id: 'SKU:OLD',
      primary_sku: 'OLD',
      item_description: 'Printed',
      order_qty: 5,
      status: 'printed',
      print_count: 1,
      last_printed_at: '2026-03-22T09:00:00.000Z',
      queued_at: '2026-03-22T08:00:00.000Z',
    },
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.groupId, 'SKU:ABC')
  assert.equal(groups[0]?.orders.length, 2)
  assert.equal(groups[0]?.totalQty, 3)
})

test('buildQueueAddPayload preserves single-sku grouping fields', () => {
  const payload = buildQueueAddPayload(makeOrder(), '/labels/mock.pdf')

  assert.equal(payload.order_id, '42')
  assert.equal(payload.client_id, 7)
  assert.equal(payload.sku_group_id, 'SKU:SKU-1')
  assert.equal(payload.primary_sku, 'SKU-1')
  assert.equal(payload.order_qty, 2)
})

test('buildPicklistPrintHtml includes summary counts and escaped sku data', () => {
  const html = buildPicklistPrintHtml([
    {
      storeId: 11,
      clientName: 'ACME',
      sku: 'SKU<&>',
      name: 'Widget <Large>',
      imageUrl: null,
      totalQty: 4,
      orderCount: 2,
    },
  ], {
    generatedAt: '3/22/2026, 10:15:00 AM',
    dateLabel: 'last-30',
    statusLabel: 'awaiting shipment',
  })

  assert.match(html, /PrepShip Pick List/)
  assert.match(html, /Total Units/)
  assert.match(html, /SKU&lt;&amp;&gt;/)
  assert.match(html, /Widget &lt;Large&gt;/)
  assert.match(html, /4/)
})

test('formatSyncPill mirrors web sync pill text', () => {
  assert.deepEqual(
    formatSyncPill({ status: 'syncing', mode: 'full', page: 3, lastSync: null }),
    { className: 'sync-pill syncing', text: 'Full sync… (3)' },
  )

  const idle = formatSyncPill({ status: 'idle', mode: 'idle', page: 0, lastSync: null })
  assert.equal(idle.className, 'sync-pill')
  assert.equal(idle.text, 'Last sync —')
})
