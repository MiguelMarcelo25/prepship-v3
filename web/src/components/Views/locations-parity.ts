import type { LocationDto } from '../../types/api'

// TODO PS-257: restore real SaveLocationInput type (not exported by ../../types/api)
type SaveLocationInput = any

export interface LocationFormState {
  locationId: string
  name: string
  company: string
  street1: string
  street2: string
  city: string
  state: string
  postalCode: string
  phone: string
  isDefault: boolean
}

export function createLocationFormState(location?: LocationDto | null): LocationFormState {
  return {
    locationId: location ? String(location.locationId) : '',
    name: location?.name ?? '',
    company: location?.company ?? '',
    street1: location?.street1 ?? '',
    street2: location?.street2 ?? '',
    city: location?.city ?? '',
    state: location?.state ?? '',
    postalCode: location?.postalCode ?? '',
    phone: location?.phone ?? '',
    isDefault: Boolean(location?.isDefault),
  }
}

export function buildLocationSaveInput(form: LocationFormState): SaveLocationInput {
  return {
    name: form.name.trim(),
    company: form.company.trim(),
    street1: form.street1.trim(),
    street2: form.street2.trim(),
    city: form.city.trim(),
    state: form.state.trim().toUpperCase(),
    postalCode: form.postalCode.trim(),
    phone: form.phone.trim(),
    isDefault: form.isDefault,
  }
}

export function getLocationFormTitle(form: Pick<LocationFormState, 'locationId'>): string {
  return form.locationId ? 'Edit Location' : 'Add Location'
}

export function buildLocationSummary(location: Pick<LocationDto, 'company' | 'street1' | 'street2' | 'city' | 'state' | 'postalCode'>): string {
  return [
    location.company,
    location.street1,
    location.street2,
    location.city && location.state ? `${location.city}, ${location.state} ${location.postalCode}`.trim() : '',
  ].filter(Boolean).join(' · ')
}

export function getLocationActionLabels(location: Pick<LocationDto, 'isDefault'>): string[] {
  return [
    ...(location.isDefault ? [] : ['★ Default']),
    '✏️ Edit',
    '🗑',
  ]
}

export function getLocationsContentState(input: {
  loading: boolean
  error: string | null
  locations: LocationDto[]
}): 'loading' | 'error' | 'empty' | 'list' {
  if (input.loading) return 'loading'
  if (input.error) return 'error'
  if (input.locations.length === 0) return 'empty'
  return 'list'
}
