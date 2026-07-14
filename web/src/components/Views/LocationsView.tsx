import { useContext, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  MapPin,
  Plus,
  Star,
  Pencil,
  Trash2,
  Save,
  Loader2,
  AlertTriangle,
  X as XIcon,
} from 'lucide-react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type { LocationDto } from '../../types/api'
import {
  buildLocationSaveInput,
  buildLocationSummary,
  createLocationFormState,
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
  /** 2026-05-13: when true, suppress the page-level title block and
   *  outer padding/scroll wrapper so this content can be embedded
   *  inside another shell (e.g. the Settings page's tab panel). The
   *  parent page is responsible for rendering its own section header
   *  in that case. Defaults to false for back-compat with the
   *  standalone /locations route fallback. */
  embedded?: boolean
  /** 2026-05-13: DOM element to portal the "+ Add Location" CTA
   *  button into. When provided AND embedded is true, the button
   *  renders next to the parent page's section title instead of
   *  inside this view's content area — same UX pattern used by
   *  the shared <Table>'s columnsAnchorEl. Falsy values fall back
   *  to in-content rendering, so the embedded prop alone still
   *  produces a usable view if no anchor is wired up. */
  headerActionAnchor?: HTMLElement | null
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
  embedded = false,
  headerActionAnchor = null,
}: LocationsViewContentProps) {
  const contentState = getLocationsContentState({ loading, error, locations })

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-line bg-surface text-[13px] text-ink placeholder:text-ink-3 ' +
    'focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none'
  const labelCls = 'block text-tiny font-bold uppercase tracking-[0.06em] text-ink-3 mb-1.5'

  // 2026-05-13: when embedded inside Settings, drop the page-level
  // padding + scroll wrapper (the Settings shell provides its own)
  // and skip the page header (Settings renders its own section
  // header). The "+ Add Location" button is now portal'd into the
  // Settings section header (via headerActionAnchor) when one is
  // provided, so it sits next to "Ship-From Locations" instead of
  // floating alone above the cards. Falls back to inline rendering
  // when no anchor is wired up.
  const containerClass = embedded ? '' : 'view-content !p-5 !overflow-y-auto'

  // The Add button itself — extracted so we can either inline it
  // (standalone /locations view) or portal it into the Settings
  // header (embedded view with anchor). Identical visual treatment
  // either way; only the mount point differs.
  const addButton = (
    <motion.button
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.96 }}
      type="button"
      onClick={onShowAdd}
      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-md hover:shadow-lg transition-all duration-150 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 outline-none"
    >
      <Plus size={14} strokeWidth={2.5} />
      Add Location
    </motion.button>
  )

  return (
    <div id="view-locations" className={containerClass}>
      {/* Portal: when embedded AND we have a header anchor, render
          the Add button there. The portal'd node remains owned by
          this component's React tree — props/state/onClick all
          continue to flow as if it were a normal child. */}
      {embedded && headerActionAnchor ? createPortal(addButton, headerActionAnchor) : null}

      {embedded ? (
        // Embedded WITHOUT an anchor: in-content fallback so the
        // button is still reachable. Keeps the view self-contained
        // for any future caller that forgets to wire the anchor.
        !headerActionAnchor ? (
          <div className="flex items-center justify-end mb-5">
            {addButton}
          </div>
        ) : null
      ) : (
        <div className="flex items-start justify-between gap-3 mb-5 flex-wrap max-w-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-rose-500 to-rose-600 flex items-center justify-center shadow-md ring-1 ring-rose-400/20">
              <MapPin size={20} strokeWidth={2.25} className="text-white" />
            </div>
            <div>
              <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Ship-From Locations</h2>
              <p className="text-tiny text-ink-3 mt-0.5">Warehouses, 3PL centers, or drop-ship addresses. The ★ default is used for new labels.</p>
            </div>
          </div>
          {addButton}
        </div>
      )}

      <AnimatePresence>
        {formOpen ? (
          <motion.form
            key="loc-form"
            id="locFormCard"
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="bg-surface rounded-2xl border border-line shadow-sm overflow-hidden mb-5 max-w-3xl"
            onSubmit={onSubmit}
          >
            <div className="px-5 py-4 border-b border-line bg-gradient-to-b from-page to-surface-2/30 flex items-center justify-between">
              <div className="text-[14px] font-bold text-ink font-display tracking-tight">{getLocationFormTitle(form)}</div>
              <motion.button
                type="button"
                whileTap={{ scale: 0.85 }}
                whileHover={{ rotate: 90 }}
                onClick={onCancelForm}
                aria-label="Close form"
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 transition-colors"
              >
                <XIcon size={14} strokeWidth={2.5} />
              </motion.button>
            </div>
            <input id="locFormId" type="hidden" value={form.locationId} readOnly />
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="locFormName" className={labelCls}>Location Name</label>
                <input id="locFormName" type="text" className={inputCls} placeholder="e.g. GWH Fulfillment Center" value={form.name} onChange={(event) => onFieldChange('name', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="locFormCompany" className={labelCls}>Company</label>
                <input id="locFormCompany" type="text" className={inputCls} placeholder="e.g. DR PREPPER USA" value={form.company} onChange={(event) => onFieldChange('company', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="locFormStreet1" className={labelCls}>Street Address</label>
                <input id="locFormStreet1" type="text" className={inputCls} placeholder="123 Main St" value={form.street1} onChange={(event) => onFieldChange('street1', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="locFormStreet2" className={labelCls}>Suite / Unit <span className="text-ink-4 normal-case font-normal tracking-normal">(optional)</span></label>
                <input id="locFormStreet2" type="text" className={inputCls} placeholder="Suite 100" value={form.street2} onChange={(event) => onFieldChange('street2', event.target.value)} />
              </div>
              <div>
                <label htmlFor="locFormCity" className={labelCls}>City</label>
                <input id="locFormCity" type="text" className={inputCls} placeholder="Gardena" value={form.city} onChange={(event) => onFieldChange('city', event.target.value)} />
              </div>
              <div>
                <label htmlFor="locFormState" className={labelCls}>State</label>
                <input id="locFormState" type="text" className={inputCls} placeholder="CA" maxLength={2} value={form.state} onChange={(event) => onFieldChange('state', event.target.value)} />
              </div>
              <div>
                <label htmlFor="locFormZip" className={labelCls}>ZIP Code</label>
                <input id="locFormZip" type="text" className={`${inputCls} font-mono tabular-nums`} placeholder="ZIP" maxLength={10} value={form.postalCode} onChange={(event) => onFieldChange('postalCode', event.target.value)} />
              </div>
              <div>
                <label htmlFor="locFormPhone" className={labelCls}>Phone <span className="text-ink-4 normal-case font-normal tracking-normal">(optional)</span></label>
                <input id="locFormPhone" type="text" className={`${inputCls} font-mono tabular-nums`} placeholder="(310) 555-0000" value={form.phone} onChange={(event) => onFieldChange('phone', event.target.value)} />
              </div>
            </div>
            <div className="px-5 py-4 border-t border-line bg-page/30 flex items-center gap-2">
              <label className="inline-flex items-center gap-2 text-tiny text-ink-2 font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(event) => onFieldChange('isDefault', event.target.checked)}
                  className="w-4 h-4 rounded border-line text-brand focus:ring-2 focus:ring-brand/30 cursor-pointer"
                />
                Set as default ship-from
              </label>
              <div className="flex-1" />
              <motion.button
                type="button"
                whileTap={{ scale: 0.96 }}
                onClick={onCancelForm}
                className="px-3 py-1.5 rounded-md text-[12.5px] font-semibold text-ink-2 hover:text-ink hover:bg-line/40 transition-colors"
              >
                Cancel
              </motion.button>
              <motion.button
                type="submit"
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.96 }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-sm hover:shadow-md transition-all duration-150"
              >
                <Save size={13} strokeWidth={2.5} />
                Save Location
              </motion.button>
            </div>
          </motion.form>
        ) : null}
      </AnimatePresence>

      <div id="locationsContent" className="max-w-3xl">
        <AnimatePresence mode="wait">
          {contentState === 'loading' ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-12 bg-surface rounded-2xl border border-line"
            >
              <Loader2 size={22} strokeWidth={2.25} className="text-brand animate-spinSlow" />
              <div className="text-tiny text-ink-3 uppercase tracking-wider font-semibold">Loading locations…</div>
            </motion.div>
          ) : contentState === 'error' ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-14 bg-surface rounded-2xl border border-danger/20"
            >
              <div className="w-14 h-14 rounded-full bg-danger-bg ring-2 ring-danger/15 flex items-center justify-center">
                <AlertTriangle size={26} strokeWidth={2.25} className="text-danger" />
              </div>
              <div className="text-sm font-semibold text-danger">Failed to load locations</div>
              <div className="text-xs2 text-ink-3 max-w-md text-center leading-relaxed">{error}</div>
            </motion.div>
          ) : contentState === 'empty' ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-14 bg-surface rounded-2xl border border-line"
            >
              <motion.div
                initial={{ scale: 0.6, rotate: -10 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 280, damping: 14 }}
                className="w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-50 to-rose-100 ring-1 ring-rose-200 flex items-center justify-center"
              >
                <MapPin size={28} strokeWidth={2} className="text-rose-500" />
              </motion.div>
              <div className="text-sm font-semibold text-ink font-display tracking-tight">No locations yet</div>
              <div className="text-xs2 text-ink-3 leading-relaxed">Click <strong className="text-ink">Add Location</strong> above to get started.</div>
            </motion.div>
          ) : (
            <motion.div
              key="list"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
              initial="hidden"
              animate="show"
              className="space-y-2.5"
            >
              {locations.map((location) => (
                <motion.div
                  key={location.locationId}
                  variants={{
                    hidden: { opacity: 0, y: 8 },
                    show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 24 } },
                  }}
                  whileHover={{ y: -1 }}
                  className="bg-surface rounded-xl border border-line shadow-sm hover:shadow-md transition-shadow p-4 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-[13.5px] text-ink font-display tracking-tight truncate">{location.name}</span>
                      {location.isDefault ? (
                        <span className="inline-flex items-center gap-1 bg-brand text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wider shadow-sm">
                          <Star size={9} strokeWidth={2.75} fill="currentColor" />
                          Default
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[12px] text-ink-2 leading-relaxed">{buildLocationSummary(location as Parameters<typeof buildLocationSummary>[0])}</div>
                    {location.phone ? (
                      <div className="text-tiny text-ink-3 mt-1 font-mono tabular-nums">{location.phone}</div>
                    ) : null}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {!location.isDefault ? (
                      <motion.button
                        whileTap={{ scale: 0.92 }}
                        type="button"
                        title="Set as default"
                        aria-label="Set as default"
                        onClick={() => onSetDefault(location.locationId)}
                        className="w-8 h-8 rounded-md flex items-center justify-center text-amber-500 hover:bg-amber-50 hover:text-amber-600 transition-colors"
                      >
                        <Star size={14} strokeWidth={2.25} />
                      </motion.button>
                    ) : null}
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="button"
                      title="Edit"
                      aria-label="Edit location"
                      onClick={() => onEdit(location.locationId)}
                      className="w-8 h-8 rounded-md flex items-center justify-center text-ink-2 hover:bg-brand-bg hover:text-brand transition-colors"
                    >
                      <Pencil size={13} strokeWidth={2.25} />
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="button"
                      title="Delete"
                      aria-label="Delete location"
                      onClick={() => onDelete(location.locationId)}
                      className="w-8 h-8 rounded-md flex items-center justify-center text-ink-3 hover:bg-danger-bg hover:text-danger transition-colors"
                    >
                      <Trash2 size={13} strokeWidth={2.25} />
                    </motion.button>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

interface LocationsViewProps {
  /** 2026-05-13: forwarded to LocationsViewContent. Settings tab
   *  sets this to true so the duplicate "Ship-From Locations" title
   *  doesn't render on top of the Settings page header. */
  embedded?: boolean
  /** 2026-05-13: forwarded to LocationsViewContent. When provided
   *  AND embedded, the "+ Add Location" button portals into this
   *  DOM node (typically a slot in the parent's section header). */
  headerActionAnchor?: HTMLElement | null
  /** Audit 2.2: Settings delays non-critical section GETs until idle. */
  queriesEnabled?: boolean
}

export default function LocationsView({
  embedded = false,
  headerActionAnchor = null,
  queriesEnabled = true,
}: LocationsViewProps = {}) {
  const toastContext = useContext(ToastContext)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<LocationFormState>(() => createLocationFormState())
  const [saving, setSaving] = useState(false)

  const locationsQuery = useQuery<LocationDto[]>({
    queryKey: ['settings', 'locations'],
    enabled: queriesEnabled,
    queryFn: () => apiClient.fetchLocations(),
  })
  const locations = locationsQuery.data ?? []
  const loading = locationsQuery.data == null && (!queriesEnabled || locationsQuery.isPending)
  const error = locationsQuery.isError
    ? (locationsQuery.error instanceof Error ? locationsQuery.error.message : 'Failed to load locations')
    : null

  const refreshLocations = async () => {
    const result = await locationsQuery.refetch()
    if (result.isError) throw result.error
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
      embedded={embedded}
      headerActionAnchor={headerActionAnchor}
    />
  )
}
