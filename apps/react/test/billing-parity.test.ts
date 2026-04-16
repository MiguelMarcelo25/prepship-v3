import assert from 'node:assert/strict'
import test from 'node:test'

import type { BillingConfigDto, BillingDetailDto, BillingSummaryDto, PackageDto } from '../src/types/api.ts'
import {
  buildBackfillRefRatesToast,
  buildBillingConfigInput,
  buildBillingPackagePriceRows,
  buildBillingSummaryTotals,
  buildFetchRefRatesDoneText,
  buildFetchRefRatesProgressText,
  buildFetchRefRatesStartText,
  buildGenerateBillingStatus,
  computeBillingDetailMetrics,
  createBillingConfigDraft,
  getBillingInitialRange,
  getBillingInvoiceUrl,
  getBillingPresetRange,
  readBillingDetailColumnIds,
  toggleBillingDetailColumnIds,
} from '../src/components/Views/billing-parity.ts'

function makeConfig(overrides: Partial<BillingConfigDto> = {}): BillingConfigDto {
  return {
    clientId: 1,
    clientName: 'Acme',
    pickPackFee: 4.25,
    additionalUnitFee: 1.1,
    packageCostMarkup: 0,
    shippingMarkupPct: 10,
    shippingMarkupFlat: 2.5,
    billing_mode: 'reference_rate',
    storageFeePerCuFt: 0.125,
    storageFeeMode: 'unit',
    palletPricingPerMonth: 0,
    palletCuFt: 0,
    ...overrides,
  }
}

function makePackage(overrides: Partial<PackageDto> = {}): PackageDto {
  return {
    packageId: 11,
    name: 'Mailer',
    type: 'box',
    length: 12,
    width: 10,
    height: 4,
    tareWeightOz: 1,
    source: 'custom',
    carrierCode: null,
    stockQty: 0,
    reorderLevel: 0,
    unitCost: 0.75,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<BillingSummaryDto> = {}): BillingSummaryDto {
  return {
    clientId: 1,
    clientName: 'Acme',
    pickPackTotal: 4.25,
    additionalTotal: 2.2,
    packageTotal: 0.75,
    shippingTotal: 12.5,
    storageTotal: 5,
    orderCount: 1,
    grandTotal: 24.7,
    ...overrides,
  }
}

function makeDetail(overrides: Partial<BillingDetailDto> = {}): BillingDetailDto {
  return {
    orderId: 1001,
    orderNumber: 'A-1001',
    shipDate: '2026-03-02T12:30:00.000Z',
    totalQty: 3,
    pickpackTotal: 4.25,
    additionalTotal: 2.2,
    packageTotal: 0.75,
    shippingTotal: 13.75,
    actualLabelCost: 11.75,
    label_weight_oz: 16,
    label_dims_l: 12,
    label_dims_w: 10,
    label_dims_h: 4,
    ref_usps_rate: 12.5,
    ref_ups_rate: 13.75,
    packageName: 'Mailer',
    itemNames: 'Widget | Gadget',
    itemSkus: 'SKU-1 | SKU-2',
    ...overrides,
  }
}

test('billing date presets preserve the web month and rolling-range behavior', () => {
  const now = new Date('2026-03-22T12:00:00.000Z')

  assert.deepEqual(getBillingInitialRange(now), {
    from: '2025-12-22',
    to: '2026-03-22',
  })

  assert.deepEqual(getBillingPresetRange('this_month', now), {
    from: '2026-03-01',
    to: '2026-03-31',
  })

  assert.deepEqual(getBillingPresetRange('last_month', now), {
    from: '2026-02-01',
    to: '2026-02-28',
  })

  assert.deepEqual(getBillingPresetRange('last_30', now), {
    from: '2026-02-20',
    to: '2026-03-22',
  })
})

test('billing config draft and payload builders mirror the editable web row fields', () => {
  const draft = createBillingConfigDraft(makeConfig())

  assert.deepEqual(draft, {
    pickPackFee: '4.25',
    additionalUnitFee: '1.10',
    shippingMarkupPct: '10.0',
    shippingMarkupFlat: '2.50',
    storageFeePerCuFt: '0.125',
    billing_mode: 'reference_rate',
  })

  assert.deepEqual(buildBillingConfigInput({
    ...draft,
    pickPackFee: ' 5.5 ',
    additionalUnitFee: '',
    shippingMarkupPct: '7.5',
    shippingMarkupFlat: '1.25',
    storageFeePerCuFt: '0.333',
    billing_mode: 'label_cost',
  }), {
    pickPackFee: 5.5,
    additionalUnitFee: 0,
    shippingMarkupPct: 7.5,
    shippingMarkupFlat: 1.25,
    billing_mode: 'label_cost',
    storageFeePerCuFt: 0.333,
  })
})

test('billing summary totals aggregate the same categories shown in the footer row', () => {
  assert.deepEqual(buildBillingSummaryTotals([
    makeSummary(),
    makeSummary({
      clientId: 2,
      clientName: 'Beta',
      pickPackTotal: 8.5,
      additionalTotal: 0,
      packageTotal: 0,
      shippingTotal: 7,
      storageTotal: 0,
      orderCount: 2,
      grandTotal: 15.5,
    }),
  ]), {
    orders: 3,
    pickPack: 12.75,
    additional: 2.2,
    package: 0.75,
    storage: 5,
    shipping: 19.5,
    grand: 40.2,
  })
})

test('billing package price rows keep custom-package filtering, overrides, and margin colors', () => {
  const rows = buildBillingPackagePriceRows([
    makePackage(),
    makePackage({ packageId: 12, name: 'Carrier Box', source: 'ss_carrier' }),
    makePackage({ packageId: 13, name: 'Flat', unitCost: null }),
  ], [
    { packageId: 11, price: 1.5, is_custom: 1, name: 'Mailer', length: 12, width: 10, height: 4 },
  ], {
    11: '2.00',
  })

  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    packageId: 11,
    name: 'Mailer',
    dimsText: '12×10×4"',
    ourCost: 0.75,
    charge: 2,
    isCustom: true,
    marginPct: 63,
    marginColor: 'var(--green)',
  })
  assert.equal(rows[1].marginPct, null)
})

test('billing detail helpers preserve charged-rate detection, SS upcharge highlighting, and column toggles', () => {
  assert.deepEqual(computeBillingDetailMetrics(makeDetail()), {
    pickPack: 4.25,
    additional: 2.2,
    packageCost: 0.75,
    shipping: 13.75,
    total: 20.95,
    ourCost: 11.75,
    margin: 2,
    ssCharged: true,
    chargedRate: 'upsss',
  })

  assert.deepEqual(readBillingDetailColumnIds({
    getItem: () => '["orderNumber","margin","bogus"]',
  }), ['orderNumber', 'margin'])

  assert.deepEqual(toggleBillingDetailColumnIds(['orderNumber', 'shipping'], 'shipping'), ['orderNumber'])
  assert.deepEqual(toggleBillingDetailColumnIds(['orderNumber'], 'margin'), ['orderNumber', 'margin'])
})

test('billing status and invoice helpers keep the web copy for generate/ref-rate/backfill flows', () => {
  assert.equal(buildGenerateBillingStatus(4, 24.7), 'Generated 4 line items · $24.70 total')
  assert.equal(buildFetchRefRatesStartText({ ok: true, message: 'queued', orders: 12, queued: 4, total: 4 }), 'Fetching rates for 12 orders (4 unique combos)…')
  assert.equal(buildFetchRefRatesStartText({ ok: false, message: 'Already running' }), 'Already running — checking status…')
  assert.equal(buildFetchRefRatesDoneText({ running: false, total: 4, done: 4, errors: 1, startedAt: 1 }), '✓ Done — 4 combos fetched, 1 errors')
  assert.equal(buildFetchRefRatesProgressText({ running: true, total: 4, done: 2, errors: 0, startedAt: 1 }), 'Progress: 2/4')
  assert.equal(buildBackfillRefRatesToast({ ok: true, filled: 3, missing: 1 }), 'Backfill done — 3 orders filled, 1 missing from cache')
  assert.equal(getBillingInvoiceUrl(7, '2026-03-01', '2026-03-31'), '/api/billing/invoice?clientId=7&from=2026-03-01&to=2026-03-31')
})
