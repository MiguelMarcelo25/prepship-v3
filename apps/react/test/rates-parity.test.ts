import assert from 'node:assert/strict'
import test from 'node:test'

import type { RateDto } from '@prepshipv2/contracts/rates/contracts'
import {
  buildLiveRatesPayload,
  buildRateRows,
  buildRateSelectionToast,
  buildRatesMetaLabel,
  getAvailableRates,
  getRatesValidationState,
  type RatesFormState,
} from '../src/components/Views/rates-parity.ts'

function makeForm(overrides: Partial<RatesFormState> = {}): RatesFormState {
  return {
    weightOz: '16',
    lengthIn: '12',
    widthIn: '9',
    heightIn: '4',
    fromZip: '90248',
    toZip: '10001',
    markup: '1.00',
    ...overrides,
  }
}

function makeRate(overrides: Partial<RateDto> = {}): RateDto {
  return {
    serviceCode: 'ups_ground',
    serviceName: 'UPS Ground',
    packageType: null,
    shipmentCost: 8.25,
    otherCost: 0.5,
    rateDetails: [],
    carrierCode: 'ups',
    shippingProviderId: 111,
    carrierNickname: null,
    guaranteed: false,
    zone: null,
    sourceClientId: null,
    deliveryDays: 3,
    estimatedDelivery: null,
    ...overrides,
  }
}

test('getRatesValidationState matches web empty-state rules', () => {
  assert.deepEqual(getRatesValidationState(makeForm({ weightOz: '0' })), {
    icon: '⚖️',
    message: 'Enter weight to get rates',
  })

  assert.deepEqual(getRatesValidationState(makeForm({ toZip: '   ' })), {
    icon: '📍',
    message: 'Enter a destination ZIP',
  })

  assert.equal(getRatesValidationState(makeForm()), null)
})

test('buildLiveRatesPayload preserves the web defaults and units', () => {
  assert.deepEqual(buildLiveRatesPayload(makeForm({ fromZip: '   ' })), {
    fromPostalCode: '90248',
    toPostalCode: '10001',
    toCountry: 'US',
    weight: {
      value: 16,
      units: 'ounces',
    },
    dimensions: {
      units: 'inches',
      length: 12,
      width: 9,
      height: 4,
    },
  })
})

test('getAvailableRates filters blocked service rows before rendering', () => {
  const visible = getAvailableRates([
    makeRate({ serviceCode: 'ups_ground', serviceName: 'UPS Ground' }),
    makeRate({ serviceCode: 'usps_media_mail', serviceName: 'Media Mail', carrierCode: 'stamps_com', shippingProviderId: 222 }),
  ])

  assert.equal(visible.length, 1)
  assert.equal(visible[0]?.serviceCode, 'ups_ground')
})

test('buildRateRows mirrors the table math and keeps the first row flagged cheapest', () => {
  const rows = buildRateRows([
    makeRate({ serviceCode: 'ups_ground', serviceName: 'UPS Ground', shipmentCost: 7, otherCost: 0.25 }),
    makeRate({ serviceCode: 'fedex_2day', serviceName: 'FedEx 2Day', carrierCode: 'fedex', shipmentCost: 12.5, otherCost: 1 }),
  ], 1.5)

  assert.equal(rows[0]?.carrierLabel, 'UPS')
  assert.equal(rows[0]?.serviceLabel, 'UPS Ground')
  assert.equal(rows[0]?.baseCost, 7.25)
  assert.equal(rows[0]?.yourPrice, 8.75)
  assert.equal(rows[0]?.profit, 1.5)
  assert.equal(rows[0]?.isBest, true)
  assert.equal(rows[1]?.isBest, false)
})

test('buildRatesMetaLabel and selection toast match the web copy', () => {
  const row = buildRateRows([
    makeRate({ serviceCode: 'ups_ground', serviceName: "UPS Ground's Fast" }),
  ], 1)[0]

  assert.equal(buildRatesMetaLabel(makeForm()), '16oz · 12×9×4" · 90248→10001')
  assert.equal(buildRateSelectionToast(row), 'UPS UPS Grounds Fast @ $9.75 — Phase 3')
})
