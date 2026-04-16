import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyReceiveSkuInput,
  buildBulkDimensionUpdates,
  buildInventoryLedgerQuery,
  buildReceiveItems,
  createReceiveDraftRow,
  filterInventoryRows,
  getInventoryCuFt,
  getInventoryDateRangePreset,
  getReceiveRowHints,
  groupInventoryRowsByClient,
} from '../src/components/Views/inventory-parity.ts'
import type { InventoryItemDto } from '../src/types/api.ts'

function makeItem(overrides: Partial<InventoryItemDto> = {}): InventoryItemDto {
  return {
    id: 1,
    clientId: 7,
    sku: 'SKU-1',
    name: 'Widget',
    minStock: 3,
    active: true,
    weightOz: 12,
    parentSkuId: null,
    baseUnitQty: 1,
    packageLength: 0,
    packageWidth: 0,
    packageHeight: 0,
    productLength: 12,
    productWidth: 6,
    productHeight: 3,
    packageId: null,
    units_per_pack: 1,
    cuFtOverride: null,
    clientName: 'ACME',
    packageName: null,
    packageDimLength: null,
    packageDimWidth: null,
    packageDimHeight: null,
    parentName: null,
    currentStock: 10,
    lastMovement: null,
    imageUrl: null,
    baseUnits: 10,
    status: 'ok',
    ...overrides,
  }
}

test('filterInventoryRows matches search, client, and alert-only parity rules', () => {
  const rows = [
    makeItem(),
    makeItem({ id: 2, clientId: 8, clientName: 'Beta', sku: 'LOW-2', name: 'Low Widget', status: 'low' }),
    makeItem({ id: 3, sku: 'OUT-3', name: 'Out Widget', status: 'out' }),
  ]

  assert.deepEqual(
    filterInventoryRows(rows, { search: 'widget', clientId: '', alertOnly: true }).map((row) => row.id),
    [2, 3],
  )

  assert.deepEqual(
    filterInventoryRows(rows, { search: 'low', clientId: '8', alertOnly: false }).map((row) => row.id),
    [2],
  )
})

test('groupInventoryRowsByClient preserves client buckets in encounter order', () => {
  const groups = groupInventoryRowsByClient([
    makeItem({ id: 1, clientId: 7, clientName: 'ACME' }),
    makeItem({ id: 2, clientId: 8, clientName: 'Beta' }),
    makeItem({ id: 3, clientId: 7, clientName: 'ACME 2' }),
  ])

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.clientName, 'ACME')
  assert.deepEqual(groups[0]?.rows.map((row) => row.id), [1, 3])
  assert.deepEqual(groups[1]?.rows.map((row) => row.id), [2])
})

test('getInventoryCuFt prefers overrides before computed product dimensions', () => {
  const computed = getInventoryCuFt(makeItem({ cuFtOverride: null, productLength: 12, productWidth: 12, productHeight: 12 }))
  const overridden = getInventoryCuFt(makeItem({ cuFtOverride: 1.75, productLength: 12, productWidth: 12, productHeight: 12 }))

  assert.equal(computed, 1)
  assert.equal(overridden, 1.75)
})

test('receive-row helpers mirror web auto-fill and hint behavior', () => {
  const baseRow = createReceiveDraftRow()
  const hydrated = applyReceiveSkuInput({ ...baseRow, sku: 'CASE-6' }, { name: 'Case Pack', unitsPerPack: 6 })
  const hints = getReceiveRowHints({ ...hydrated, qty: '3' }, { name: 'Case Pack', unitsPerPack: 6 })

  assert.equal(hydrated.name, 'Case Pack')
  assert.equal(hydrated.autofilledName, true)
  assert.equal(hints.packHint, '×6 units/pack')
  assert.equal(hints.totalHint, '= 18 total units')

  const manualName = applyReceiveSkuInput({ ...hydrated, name: 'Manual Name', autofilledName: false }, null)
  assert.equal(manualName.name, 'Manual Name')
})

test('buildReceiveItems excludes incomplete rows and preserves optional names', () => {
  const rows = [
    { ...createReceiveDraftRow(), sku: 'SKU-1', name: 'Widget', qty: '4' },
    { ...createReceiveDraftRow(), sku: 'SKU-2', name: '', qty: '2' },
    { ...createReceiveDraftRow(), sku: '', name: 'Ignored', qty: '5' },
  ]

  assert.deepEqual(buildReceiveItems(rows), [
    { sku: 'SKU-1', name: 'Widget', qty: 4 },
    { sku: 'SKU-2', name: undefined, qty: 2 },
  ])
})

test('buildInventoryLedgerQuery converts history filters into API timestamps', () => {
  const query = buildInventoryLedgerQuery({
    clientId: '9',
    type: 'receive',
    from: '2026-03-01',
    to: '2026-03-22',
  })

  assert.equal(query.clientId, 9)
  assert.equal(query.type, 'receive')
  assert.equal(query.limit, 500)
  assert.equal(query.dateStart, new Date('2026-03-01T00:00:00').getTime())
  assert.equal(query.dateEnd, new Date('2026-03-22T23:59:59').getTime())
})

test('buildBulkDimensionUpdates maps visible stock rows into the inventory bulk-update payload', () => {
  const payload = buildBulkDimensionUpdates(
    [makeItem({ id: 11 }), makeItem({ id: 12 })],
    {
      11: { weightOz: '14', productLength: '6', productWidth: '5', productHeight: '4' },
      12: { weightOz: '8.5', productLength: '', productWidth: '3', productHeight: '' },
    },
  )

  assert.deepEqual(payload, {
    updates: [
      { invSkuId: 11, weightOz: 14, productLength: 6, productWidth: 5, productHeight: 4 },
      { invSkuId: 12, weightOz: 8.5, productLength: undefined, productWidth: 3, productHeight: undefined },
    ],
  })
})

test('getInventoryDateRangePreset defaults history to the last 30 days', () => {
  const range = getInventoryDateRangePreset(new Date('2026-03-22T10:00:00.000Z'))
  assert.deepEqual(range, {
    from: '2026-02-20',
    to: '2026-03-22',
  })
})
