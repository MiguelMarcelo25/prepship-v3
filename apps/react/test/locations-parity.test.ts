import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLocationSaveInput,
  buildLocationSummary,
  createLocationFormState,
  getLocationActionLabels,
  getLocationFormTitle,
  getLocationsContentState,
} from '../src/components/Views/locations-parity.ts'
import type { LocationDto } from '../src/types/api.ts'

function makeLocation(overrides: Partial<LocationDto> = {}): LocationDto {
  return {
    locationId: 1,
    name: 'Gardena Warehouse',
    company: 'DR PREPPER USA',
    street1: '123 Main St',
    street2: 'Suite 100',
    city: 'Gardena',
    state: 'CA',
    postalCode: '90248',
    country: 'US',
    phone: '(310) 555-0000',
    isDefault: false,
    active: true,
    ...overrides,
  }
}

test('createLocationFormState hydrates existing location data for editing', () => {
  const form = createLocationFormState(makeLocation({ locationId: 42, isDefault: true }))

  assert.deepEqual(form, {
    locationId: '42',
    name: 'Gardena Warehouse',
    company: 'DR PREPPER USA',
    street1: '123 Main St',
    street2: 'Suite 100',
    city: 'Gardena',
    state: 'CA',
    postalCode: '90248',
    phone: '(310) 555-0000',
    isDefault: true,
  })
})

test('buildLocationSaveInput trims values and uppercases the state code', () => {
  const payload = buildLocationSaveInput({
    locationId: '',
    name: '  Torrance  ',
    company: ' PrepShip ',
    street1: ' 456 Harbor ',
    street2: ' Suite B ',
    city: ' torrance ',
    state: ' ca ',
    postalCode: ' 90501 ',
    phone: ' 555-2222 ',
    isDefault: true,
  })

  assert.deepEqual(payload, {
    name: 'Torrance',
    company: 'PrepShip',
    street1: '456 Harbor',
    street2: 'Suite B',
    city: 'torrance',
    state: 'CA',
    postalCode: '90501',
    phone: '555-2222',
    isDefault: true,
  })
})

test('buildLocationSummary mirrors the web location detail line and omits blanks', () => {
  assert.equal(
    buildLocationSummary(makeLocation()),
    'DR PREPPER USA · 123 Main St · Suite 100 · Gardena, CA 90248',
  )

  assert.equal(
    buildLocationSummary(makeLocation({ company: '', street2: '', postalCode: '', city: '', state: '' })),
    '123 Main St',
  )
})

test('locations content state matches the web loading, empty, error, and list branches', () => {
  assert.equal(getLocationsContentState({ loading: true, error: null, locations: [] }), 'loading')
  assert.equal(getLocationsContentState({ loading: false, error: 'boom', locations: [] }), 'error')
  assert.equal(getLocationsContentState({ loading: false, error: null, locations: [] }), 'empty')
  assert.equal(getLocationsContentState({ loading: false, error: null, locations: [makeLocation()] }), 'list')
})

test('location card actions and form title preserve the web workflow labels', () => {
  assert.deepEqual(getLocationActionLabels(makeLocation({ isDefault: true })), ['✏️ Edit', '🗑'])
  assert.deepEqual(getLocationActionLabels(makeLocation({ isDefault: false })), ['★ Default', '✏️ Edit', '🗑'])

  assert.equal(getLocationFormTitle(createLocationFormState()), 'Add Location')
  assert.equal(getLocationFormTitle(createLocationFormState(makeLocation({ locationId: 2 }))), 'Edit Location')
})
