import assert from 'node:assert/strict'
import test from 'node:test'

import type { AnalysisDailySalesResponse, AnalysisSkuDto } from '@prepshipv2/contracts/analysis/contracts'
import {
  buildAnalysisTotals,
  filterAnalysisRows,
  formatAnalysisMoney,
  getAnalysisEmptyMessage,
  getAnalysisPresetRange,
  getAnalysisSortDirection,
  getAnalysisSummaryText,
  getChartSelectionRange,
  getInitialAnalysisFilters,
  sortAnalysisRows,
} from '../src/components/Views/analysis-parity.ts'

function makeRow(overrides: Partial<AnalysisSkuDto> = {}): AnalysisSkuDto {
  return {
    sku: 'SKU-1',
    name: 'Alpha Widget',
    clientName: 'Acme',
    invSkuId: 1,
    orders: 5,
    qty: 11,
    pendingOrders: 1,
    externalOrders: 0,
    standardOrders: 4,
    standardShipCount: 3,
    standardAvgShipping: 5.25,
    standardTotalShipping: 15.75,
    expeditedOrders: 1,
    expeditedShipCount: 1,
    expeditedAvgShipping: 12.5,
    expeditedTotalShipping: 12.5,
    shipCountWithCost: 4,
    blendedAvgShipping: 7.06,
    totalShipping: 28.25,
    ...overrides,
  }
}

function makeStorage(values: Record<string, string | null>) {
  return {
    getItem(key: string) {
      return values[key] ?? null
    },
  }
}

test('getInitialAnalysisFilters restores saved preset before custom dates', () => {
  const now = new Date('2026-03-22T12:00:00.000Z')

  assert.deepEqual(
    getInitialAnalysisFilters(makeStorage({
      analysis_preset_days: '90',
      analysis_from: '2026-01-01',
      analysis_to: '2026-01-31',
    }), now),
    {
      from: '2025-12-22',
      to: '2026-03-22',
      presetDays: 90,
    },
  )
})

test('getInitialAnalysisFilters falls back to saved custom dates when no preset is stored', () => {
  assert.deepEqual(
    getInitialAnalysisFilters(makeStorage({
      analysis_from: '2026-02-01',
      analysis_to: '2026-02-29',
    }), new Date('2026-03-22T12:00:00.000Z')),
    {
      from: '2026-02-01',
      to: '2026-02-29',
      presetDays: null,
    },
  )
})

test('getAnalysisPresetRange mirrors the web date math for 30d and All presets', () => {
  const now = new Date('2026-03-22T12:00:00.000Z')

  assert.deepEqual(getAnalysisPresetRange(30, now), {
    from: '2026-02-20',
    to: '2026-03-22',
  })

  assert.deepEqual(getAnalysisPresetRange(0, now), {
    from: '',
    to: '2026-03-22',
  })
})

test('filterAnalysisRows and sortAnalysisRows match the web search and ordering rules', () => {
  const rows = [
    makeRow(),
    makeRow({ sku: 'BETA-2', name: 'Beta Widget', clientName: 'Beta', qty: 6, totalShipping: 8.5, standardShipCount: 2, expeditedShipCount: 0 }),
    makeRow({ sku: 'GAMMA-3', name: 'Gamma Thing', clientName: 'Gamma', qty: 18, totalShipping: 3.25, standardShipCount: 1, expeditedShipCount: 2 }),
  ]

  assert.deepEqual(filterAnalysisRows(rows, 'widget').map((row) => row.sku), ['SKU-1', 'BETA-2'])

  assert.deepEqual(
    sortAnalysisRows(rows, 'qty', 'desc').map((row) => row.sku),
    ['GAMMA-3', 'SKU-1', 'BETA-2'],
  )

  assert.deepEqual(
    sortAnalysisRows(rows, 'client', 'asc').map((row) => row.clientName),
    ['Acme', 'Beta', 'Gamma'],
  )
})

test('buildAnalysisTotals preserves the footer aggregate math', () => {
  const totals = buildAnalysisTotals([
    makeRow(),
    makeRow({
      sku: 'BETA-2',
      orders: 2,
      qty: 5,
      pendingOrders: 0,
      externalOrders: 1,
      standardShipCount: 1,
      expeditedShipCount: 0,
      totalShipping: 6.5,
    }),
  ])

  assert.deepEqual(totals, {
    skuCount: 2,
    totalOrders: 7,
    totalPending: 1,
    totalExternal: 1,
    totalQty: 16,
    totalStdCount: 4,
    totalExpCount: 1,
    totalShipping: 34.75,
  })
})

test('getAnalysisSortDirection follows the web toggle/default rules', () => {
  assert.equal(getAnalysisSortDirection('name', 'qty', 'desc'), 'asc')
  assert.equal(getAnalysisSortDirection('qty', 'qty', 'desc'), 'asc')
  assert.equal(getAnalysisSortDirection('qty', 'qty', 'asc'), 'desc')
})

test('getChartSelectionRange converts drag pixels into the inclusive date range', () => {
  const chartData: AnalysisDailySalesResponse = {
    topSkus: [{ sku: 'SKU-1', name: 'Alpha Widget', total: 12 }],
    dates: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
    series: {
      'SKU-1': [1, 2, 3, 4, 2],
    },
  }

  assert.deepEqual(getChartSelectionRange(chartData, 40, 110, 34, 120), {
    from: '2026-03-01',
    to: '2026-03-04',
  })

  assert.equal(getChartSelectionRange(chartData, 60, 64, 34, 120), null)
})

test('summary and empty-state helpers keep the web copy', () => {
  assert.equal(getAnalysisSummaryText(12, 3456), '12 SKUs · 3,456 orders')
  assert.equal(getAnalysisEmptyMessage('sku'), 'No results matching your search')
  assert.equal(getAnalysisEmptyMessage(''), 'No orders in this date range')
  assert.equal(formatAnalysisMoney(8.5), '$8.50')
  assert.equal(formatAnalysisMoney(0), '—')
})
