// @ts-nocheck
import { useContext, useEffect, useState, type FormEvent } from 'react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type { LocationDto } from '../../types/api'
import {
  buildLocationSaveInput,
  buildLocationSummary,
  createLocationFormState,
  getLocationActionLabels,
  getLocationFormTitle,
  getLocationsContentState,
  type LocationFormState,
} from './locations-parity'

interface LocationsViewContentProps {
  locations: LocationDto[]
  loading: boolean
  error: string | null
  formOpen: boolean
  form: LocationFormState
  onShowAdd: () => void
  onCancelForm: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onFieldChange: <K extends keyof LocationFormState>(field: K, value: LocationFormState[K]) => void
  onEdit: (locationId: number) => void
  onDelete: (locationId: number) => void
  onSetDefault: (locationId: number) => void
}

export function LocationsViewContent({
  locations,
  loading,
  error,
  formOpen,
  form,
  onShowAdd,
  onCancelForm,
  onSubmit,
  onFieldChange,
  onEdit,
  onDelete,
  onSetDefault,
}: LocationsViewContentProps) {
  const contentState = getLocationsContentState({ loading, error, locations })

  return (
    <div id="view-locations" className="view-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 2 }}>📍 Ship-From Locations</h2>
          <p style={{ color: 'var(--text3)', fontSize: 12 }}>Add warehouses, 3PL centers, or drop-ship addresses. The ★ default is used for all new labels.</p>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={onShowAdd}>＋ Add Location</button>
      </div>

      {formOpen ? (
        <form id="locFormCard" className="loc-form-card" onSubmit={onSubmit}>
          <div id="locFormTitle" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            {getLocationFormTitle(form)}
          </div>
          <input id="locFormId" type="hidden" value={form.locationId} readOnly />
          <div className="loc-form-grid">
            <div className="loc-form-field full">
              <label htmlFor="locFormName">Location Name</label>
              <input id="locFormName" type="text" placeholder="e.g. GWH Fulfillment Center" value={form.name} onChange={(event) => onFieldChange('name', event.target.value)} />
            </div>
            <div className="loc-form-field full">
              <label htmlFor="locFormCompany">Company</label>
              <input id="locFormCompany" type="text" placeholder="e.g. DR PREPPER USA" value={form.company} onChange={(event) => onFieldChange('company', event.target.value)} />
            </div>
            <div className="loc-form-field full">
              <label htmlFor="locFormStreet1">Street Address</label>
              <input id="locFormStreet1" type="text" placeholder="123 Main St" value={form.street1} onChange={(event) => onFieldChange('street1', event.target.value)} />
            </div>
            <div className="loc-form-field full">
              <label htmlFor="locFormStreet2">Suite / Unit (optional)</label>
              <input id="locFormStreet2" type="text" placeholder="Suite 100" value={form.street2} onChange={(event) => onFieldChange('street2', event.target.value)} />
            </div>
            <div className="loc-form-field">
              <label htmlFor="locFormCity">City</label>
              <input id="locFormCity" type="text" placeholder="Gardena" value={form.city} onChange={(event) => onFieldChange('city', event.target.value)} />
            </div>
            <div className="loc-form-field">
              <label htmlFor="locFormState">State</label>
              <input id="locFormState" type="text" placeholder="CA" maxLength={2} value={form.state} onChange={(event) => onFieldChange('state', event.target.value)} />
            </div>
            <div className="loc-form-field">
              <label htmlFor="locFormZip">ZIP Code</label>
              <input id="locFormZip" type="text" placeholder="90248" maxLength={10} value={form.postalCode} onChange={(event) => onFieldChange('postalCode', event.target.value)} />
            </div>
            <div className="loc-form-field">
              <label htmlFor="locFormPhone">Phone (optional)</label>
              <input id="locFormPhone" type="text" placeholder="(310) 555-0000" value={form.phone} onChange={(event) => onFieldChange('phone', event.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text2)' }}>
              <input type="checkbox" checked={form.isDefault} onChange={(event) => onFieldChange('isDefault', event.target.checked)} />
              {' '}
              Set as default ship-from
            </label>
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-sm" type="button" onClick={onCancelForm}>Cancel</button>
            <button className="btn btn-primary btn-sm" type="submit">💾 Save Location</button>
          </div>
        </form>
      ) : null}

      <div id="locationsContent">
        {contentState === 'loading' ? (
          <div className="loading"><div className="spinner" /><div style={{ fontSize: 12, marginTop: 4 }}>Loading locations…</div></div>
        ) : contentState === 'error' ? (
          <div className="empty-state"><div className="empty-icon">⚠️</div><div>{error}</div></div>
        ) : contentState === 'empty' ? (
          <div className="empty-state"><div className="empty-icon">📍</div><div>No locations yet. Add one above.</div></div>
        ) : (
          locations.map((location) => (
            <div
              key={location.locationId}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '14px 16px',
                marginBottom: 10,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{location.name}</span>
                  {location.isDefault ? (
                    <span style={{ background: 'var(--ss-blue)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10 }}>DEFAULT</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)' }}>{buildLocationSummary(location)}</div>
                {location.phone ? <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{location.phone}</div> : null}
              </div>
              <div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'flex-start' }}>
                {getLocationActionLabels(location).map((label) => (
                  <button
                    key={`${location.locationId}-${label}`}
                    className="btn btn-ghost btn-xs"
                    type="button"
                    style={label === '🗑' ? { color: 'var(--red)' } : undefined}
                    onClick={() => {
                      if (label === '★ Default') onSetDefault(location.locationId)
                      else if (label === '✏️ Edit') onEdit(location.locationId)
                      else onDelete(location.locationId)
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function LocationsView() {
  const toastContext = useContext(ToastContext)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<LocationFormState>(() => createLocationFormState())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadLocations = async () => {
      setLoading(true)
      setError(null)

      try {
        const payload = await apiClient.fetchLocations()
        if (cancelled) return
        setLocations(payload)
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load locations')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadLocations()

    return () => {
      cancelled = true
    }
  }, [])

  const refreshLocations = async () => {
    const payload = await apiClient.fetchLocations()
    setLocations(payload)
    setError(null)
  }

  const handleFieldChange = <K extends keyof LocationFormState>(field: K, value: LocationFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const handleEdit = (locationId: number) => {
    const location = locations.find((candidate) => candidate.locationId === locationId)
    if (!location) return
    setForm(createLocationFormState(location))
    setFormOpen(true)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return

    const payload = buildLocationSaveInput(form)
    if (!payload.name) {
      toastContext?.addToast('⚠ Name is required')
      return
    }

    setSaving(true)

    try {
      if (form.locationId) {
        await apiClient.updateLocationMutation(Number(form.locationId), payload)
      } else {
        await apiClient.createLocationMutation(payload)
      }
      toastContext?.addToast('✅ Location saved')
      setFormOpen(false)
      setForm(createLocationFormState())
      await refreshLocations()
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save location'
      toastContext?.addToast(`❌ ${message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (locationId: number) => {
    if (!window.confirm('Delete this location?')) return

    try {
      await apiClient.deleteLocationMutation(locationId)
      await refreshLocations()
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Failed to delete location'
      toastContext?.addToast(`❌ ${message}`, 'error')
    }
  }

  const handleSetDefault = async (locationId: number) => {
    try {
      await apiClient.setDefaultLocation(locationId)
      await refreshLocations()
    } catch (defaultError) {
      const message = defaultError instanceof Error ? defaultError.message : 'Failed to set default location'
      toastContext?.addToast(`❌ ${message}`, 'error')
    }
  }

  return (
    <LocationsViewContent
      locations={locations}
      loading={loading}
      error={error}
      formOpen={formOpen}
      form={form}
      onShowAdd={() => {
        setForm(createLocationFormState())
        setFormOpen(true)
      }}
      onCancelForm={() => setFormOpen(false)}
      onSubmit={handleSubmit}
      onFieldChange={handleFieldChange}
      onEdit={handleEdit}
      onDelete={handleDelete}
      onSetDefault={handleSetDefault}
    />
  )
}
