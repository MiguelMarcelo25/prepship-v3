import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getInitialPanelServiceCode,
  getInitialPanelShipAccountId,
  getMatchedPackageIdByDimensions,
  getPanelConfirmation,
  getPanelPackageId,
  getPanelRequestedService,
  getPanelWarehouseId,
  getProductDefaultPackageId,
} from '../src/components/Views/orders-panel-state.ts'
import type { OrderFullDto, OrderSummaryDto, PackageDto, ProductDefaultsDto } from '../src/types/api.ts'

function makeOrder(overrides: Partial<OrderSummaryDto> = {}): OrderSummaryDto {
  return {
    orderId: 101,
    clientId: 7,
    clientName: 'ACME',
    orderNumber: 'ORDER-101',
    orderStatus: 'awaiting_shipment',
    orderDate: '2026-03-22T10:00:00.000Z',
    storeId: 11,
    customerEmail: 'ship@example.com',
    shipTo: { name: 'Ada Lovelace', city: 'Los Angeles', state: 'CA', postalCode: '90001' },
    carrierCode: null,
    serviceCode: 'ups_surepost_1_lb_or_greater',
    weight: { value: 72, units: 'ounces' },
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
    items: [{ sku: 'SKU-1', name: 'Widget', quantity: 1 }],
    raw: {
      requestedShippingService: 'Standard Std US D2D Dom',
      serviceCode: 'ups_ground_saver',
      packageCode: 'package',
      advancedOptions: {
        warehouseId: 226617,
        billToMyOtherAccount: 555001,
        deliveryConfirmation: 'delivery',
      },
    },
    rateDims: { length: 11, width: 8, height: 6 },
    ...overrides,
  }
}

function makeDetail(overrides: Partial<OrderFullDto> = {}): OrderFullDto {
  return {
    raw: {},
    shipments: [],
    local: null,
    ...overrides,
  }
}

function makePackage(overrides: Partial<PackageDto> = {}): PackageDto {
  return {
    packageId: 123,
    name: '11x8x6',
    type: 'box',
    length: 11,
    width: 8,
    height: 6,
    tareWeightOz: 0,
    source: 'custom',
    carrierCode: null,
    ...overrides,
  }
}

test('getInitialPanelShipAccountId prefers best rate provider for awaiting orders', () => {
  const order = makeOrder({
    bestRate: {
      serviceCode: 'ups_ground_saver',
      serviceName: 'UPS Ground Saver',
      carrierCode: 'ups',
      shippingProviderId: 596001,
    },
  })

  assert.equal(getInitialPanelShipAccountId(order, null), 596001)
})

test('getInitialPanelShipAccountId falls back to raw billToMyOtherAccount when no best rate exists', () => {
  assert.equal(getInitialPanelShipAccountId(makeOrder(), null), 555001)
})

test('getInitialPanelServiceCode follows the web panel precedence for awaiting orders', () => {
  const order = makeOrder({
    bestRate: {
      serviceCode: 'ups_ground_saver',
      serviceName: 'UPS Ground Saver',
      carrierCode: 'ups',
    },
  })

  assert.equal(getInitialPanelServiceCode(order, null), 'ups_ground_saver')
})

test('panel metadata helpers fall back to list-order raw data when full detail is absent', () => {
  const order = makeOrder()

  assert.equal(getPanelRequestedService(order, null), 'Standard Std US D2D Dom')
  assert.equal(getPanelWarehouseId(order, null), 226617)
  assert.equal(getPanelConfirmation(order, null), 'delivery')
})

test('getPanelPackageId uses saved package ids and ignores unresolved raw package codes', () => {
  const packages = [makePackage(), makePackage({ packageId: 999, name: '12x9x4', length: 12, width: 9, height: 4 })]
  const order = makeOrder()

  assert.equal(getPanelPackageId(order, makeDetail({ local: { selected_pid: 123 } }), packages), '123')
  assert.equal(getPanelPackageId(order, null, packages), '')
})

test('package helpers resolve saved defaults and dimension matches to actual package ids', () => {
  const packages = [makePackage(), makePackage({ packageId: 777, name: 'Mailer', length: 12, width: 9, height: 4 })]
  const product: ProductDefaultsDto = {
    sku: 'SKU-1',
    weightOz: 72,
    length: 11,
    width: 8,
    height: 6,
    defaultPackageCode: '123',
  }

  assert.equal(getProductDefaultPackageId(product, packages), '123')
  assert.equal(getMatchedPackageIdByDimensions({ length: 11, width: 8, height: 6 }, packages), '123')
  assert.equal(getMatchedPackageIdByDimensions({ length: 10, width: 8, height: 6 }, packages), '')
})
