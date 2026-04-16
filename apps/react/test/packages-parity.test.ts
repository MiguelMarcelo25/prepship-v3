import assert from 'node:assert/strict'
import test from 'node:test'

import type { PackageDto } from '../src/types/api.ts'
import {
  buildLowStockBannerText,
  buildPackageAdjustInput,
  buildPackageReceiveInput,
  buildPackageSaveInput,
  buildSetDefaultPackagePriceToast,
  createPackageFormState,
  formatPackageDimensionsText,
  formatPackageUnitCost,
  getPackageStockColor,
  getPackagesContentState,
  splitPackagesBySource,
} from '../src/components/Views/packages-parity.ts'

function makePackage(overrides: Partial<PackageDto> = {}): PackageDto {
  return {
    packageId: 1,
    name: 'Small Poly Mailer',
    type: 'poly_mailer',
    length: 10,
    width: 7,
    height: 1,
    tareWeightOz: 0.5,
    source: 'custom',
    carrierCode: null,
    stockQty: 12,
    reorderLevel: 5,
    unitCost: 0.321,
    ...overrides,
  }
}

test('createPackageFormState hydrates edit values and defaults new forms to the web inputs', () => {
  assert.deepEqual(createPackageFormState(), {
    packageId: '',
    name: '',
    type: 'box',
    tareWeightOz: '0',
    length: '0',
    width: '0',
    height: '0',
    unitCost: '',
  })

  assert.deepEqual(createPackageFormState(makePackage({ packageId: 42 })), {
    packageId: '42',
    name: 'Small Poly Mailer',
    type: 'poly_mailer',
    tareWeightOz: '0.5',
    length: '10',
    width: '7',
    height: '1',
    unitCost: '0.321',
  })
})

test('buildPackageSaveInput trims the form and preserves nullable unit cost', () => {
  assert.deepEqual(buildPackageSaveInput({
    packageId: '',
    name: '  Large Box  ',
    type: 'box',
    tareWeightOz: '3',
    length: '18.5',
    width: '12',
    height: '4',
    unitCost: ' 0.875 ',
  }), {
    name: 'Large Box',
    type: 'box',
    tareWeightOz: 3,
    length: 18.5,
    width: 12,
    height: 4,
    unitCost: 0.875,
  })

  assert.equal(buildPackageSaveInput({
    packageId: '',
    name: 'Envelope',
    type: 'envelope',
    tareWeightOz: '0',
    length: '0',
    width: '0',
    height: '0',
    unitCost: '',
  }).unitCost, null)
})

test('packages content state follows the web loading, empty, and populated branches', () => {
  assert.equal(getPackagesContentState({ loading: true, error: null, packages: [] }), 'loading')
  assert.equal(getPackagesContentState({ loading: false, error: 'boom', packages: [] }), 'error')
  assert.equal(getPackagesContentState({ loading: false, error: null, packages: [] }), 'empty')
  assert.equal(getPackagesContentState({ loading: false, error: null, packages: [makePackage()] }), 'list')
})

test('splitPackagesBySource keeps custom and ShipStation carrier packages separate', () => {
  const split = splitPackagesBySource([
    makePackage({ packageId: 1, source: 'custom' }),
    makePackage({ packageId: 2, source: 'ss_carrier', name: '[UPS] Tube' }),
    makePackage({ packageId: 3, source: null }),
  ])

  assert.deepEqual(split.custom.map((pkg) => pkg.packageId), [1, 3])
  assert.deepEqual(split.carrier.map((pkg) => pkg.packageId), [2])
})

test('receive and adjust payload builders mirror the web modal behavior', () => {
  assert.deepEqual(buildPackageReceiveInput({
    qty: '4',
    note: ' PO-77 ',
    costPerUnit: ' 1.125 ',
  }), {
    qty: 4,
    note: 'PO-77',
    costPerUnit: 1.125,
  })

  assert.deepEqual(buildPackageAdjustInput({
    qty: '3',
    note: '',
    costPerUnit: '',
  }, -1), {
    qty: -3,
    note: 'Manual remove',
  })

  assert.deepEqual(buildPackageAdjustInput({
    qty: '2',
    note: 'Cycle count',
    costPerUnit: '',
  }, 1), {
    qty: 2,
    note: 'Cycle count',
  })
})

test('package formatting helpers preserve the web dims, cost, banner, and stock colors', () => {
  assert.equal(formatPackageDimensionsText(makePackage()), '10×7×1" · 0.5 oz')
  assert.equal(formatPackageDimensionsText(makePackage({ length: 0, width: 0, height: 0, tareWeightOz: 0 })), '—')
  assert.equal(formatPackageUnitCost(0.321), '$0.321')
  assert.equal(formatPackageUnitCost(null), '—')
  assert.equal(buildLowStockBannerText([
    makePackage({ name: 'Box A', stockQty: 2 }),
    makePackage({ packageId: 2, name: 'Box B', stockQty: 0 }),
  ]), 'Low stock: Box A (2 left), Box B (0 left)')
  assert.equal(getPackageStockColor(makePackage({ stockQty: 0 })), 'var(--red)')
  assert.equal(getPackageStockColor(makePackage({ stockQty: 3, reorderLevel: 5 })), 'var(--yellow,#f59e0b)')
  assert.equal(getPackageStockColor(makePackage({ stockQty: 8, reorderLevel: 5 })), 'var(--green)')
})

test('buildSetDefaultPackagePriceToast matches the web success wording', () => {
  assert.equal(
    buildSetDefaultPackagePriceToast({ ok: true, updated: 3, skipped: 2 }),
    '✅ Default set for 3 clients · 2 skipped (custom override)',
  )

  assert.equal(
    buildSetDefaultPackagePriceToast({ ok: true, updated: 1, skipped: 0 }),
    '✅ Default set for 1 client',
  )
})
