// PS-166 (Wave 4, JSX-safe): leaf presentational rows extracted from the
// OrdersView side-panel SHIPPING section (id="sec-shipping"). These components
// own NO state — the dims→rate→label interactive core, every handler, and the
// dimsUserEditedRef all stay in the OrdersView shell and are passed down as
// props, so the React execution model is UNCHANGED and the offline cert fully
// verifies these slices (the same proven pattern already shipped in
// OrdersPanelSections.tsx for the Items/Recipient sections). Markup is moved
// BYTE-IDENTICAL. These leaves are STRICT (no @ts-nocheck) on purpose: an
// explicit props interface makes the compiler refuse any closure dependency
// that is not declared as a prop — the structural antidote to the @ts-nocheck
// silent-missing-dep crash class.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Save as SaveIcon } from 'lucide-react'
import type { LocationDto } from '../../types/api'
import type { PanelFormState } from './orders-panel-state'

// W4a — the "Save weights & dims as SKU defaults" quiet text-link. The
// saveSkuDefaults HANDLER stays in OrdersView (it owns the recalcGroup logic
// pinned by ps-121); only the link markup moves here.
export function OrdersPanelSaveSkuDefaultsLink({
  shipped,
  saveSkuDefaults,
}: {
  shipped: boolean
  saveSkuDefaults: () => void | Promise<void>
}) {
  return shipped ? null : (
    <button
      type="button"
      onClick={() => void saveSkuDefaults()}
      className="mt-1 inline-flex items-center gap-1.5 text-[10.5px] font-medium text-ink-3 hover:text-brand transition group"
      title="Apply current weights and dims as defaults for this SKU"
    >
      <SaveIcon size={10} strokeWidth={2.25} className="text-ink-4 group-hover:text-brand transition" />
      Save weights & dims as SKU defaults
    </button>
  )
}

type ShipmentDims = { length: number; width: number; height: number }

// W4b — the green "L × W × H in" package-dims line under the Package
// selector. Pure display; the `dims` value is derived in the OrdersView shell
// and passed in. The display:none toggle (dims ? 'block' : 'none') is kept
// byte-identical so the inline style object is unchanged.
export function OrdersPanelPackageDimsLine({ dims }: { dims: ShipmentDims | null }) {
  return (
    <div id="p-package-dims" style={{ padding: '0 0 6px 98px', fontSize: 10, fontWeight: 600, color: 'var(--green,#16a34a)', borderBottom: '1px solid var(--border)', display: dims ? 'block' : 'none' }}>
      {dims ? `${dims.length} × ${dims.width} × ${dims.height} in` : ''}
    </div>
  )
}

// W4c — the "Ship From" location row (first row of the panel body). The
// setPanelForm setter and locations list stay owned by the OrdersView shell;
// the trivial location onChange and the 📍 manage-locations button (with its
// optional onNavigateView?. guard) move verbatim.
export function OrdersPanelShipFromRow({
  panelForm,
  setPanelForm,
  shipped,
  locations,
  onNavigateView,
}: {
  panelForm: PanelFormState
  setPanelForm: Dispatch<SetStateAction<PanelFormState>>
  shipped: boolean
  locations: LocationDto[]
  onNavigateView?: (view: 'locations' | 'packages') => void
}) {
  return (
    <div className="ship-field-row">
      <span className="ship-field-label">Ship From</span>
      <div className="ship-field-value">
        <select className="ship-select" style={{ flex: 1 }} value={panelForm.locationId} onChange={(event) => setPanelForm((current) => ({ ...current, locationId: event.target.value }))} disabled={shipped}>
          {locations.length === 0 ? <option value="">Loading…</option> : null}
          {locations.map((location: LocationDto, i: number) => {
            const id = location.locationId ?? (location as any).id ?? i
            return (
              <option key={id} value={id}>
                {location.name}
              </option>
            )
          })}
        </select>
        <button className="ship-icon-btn" type="button" title="Manage locations" onClick={() => onNavigateView?.('locations')}>📍</button>
      </div>
    </div>
  )
}

// W4e — the Weight (lb / oz) row. First slice to thread the MUTABLE
// dimsUserEditedRef: the child receives the SAME ref object and sets
// .current = true on edit, exactly as inline, so the shell's auto-rate-refresh
// decision is preserved. setPanelForm stays the shell setter.
export function OrdersPanelWeightRow({
  panelForm,
  setPanelForm,
  shipped,
  dimsUserEditedRef,
}: {
  panelForm: PanelFormState
  setPanelForm: Dispatch<SetStateAction<PanelFormState>>
  shipped: boolean
  dimsUserEditedRef: MutableRefObject<boolean>
}) {
  return (
    <div className="ship-field-row">
      <span className="ship-field-label">Weight</span>
      <div className="ship-field-value">
        <input type="number" className="ship-input ship-input-sm" value={panelForm.weightLb} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, weightLb: event.target.value })) }} />
        <span className="ship-input-unit">lb</span>
        <input type="number" className="ship-input ship-input-sm" value={panelForm.weightOz} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, weightOz: event.target.value })) }} />
        <span className="ship-input-unit">oz</span>
      </div>
    </div>
  )
}

// W4f — the Size (L / W / H) row. Threads the mutable dimsUserEditedRef AND
// lockstepPanelDims (the shell closure that auto-matches a known package when
// the entered dims line up). Both stay owned by the shell; the child calls
// them through props exactly as the inline handlers did.
export function OrdersPanelSizeRow({
  panelForm,
  setPanelForm,
  shipped,
  dimsUserEditedRef,
  lockstepPanelDims,
}: {
  panelForm: PanelFormState
  setPanelForm: Dispatch<SetStateAction<PanelFormState>>
  shipped: boolean
  dimsUserEditedRef: MutableRefObject<boolean>
  lockstepPanelDims: (next: PanelFormState) => PanelFormState
}) {
  return (
    <div className="ship-field-row">
      <span className="ship-field-label">Size</span>
      <div className="ship-field-value" style={{ gap: 3, flexWrap: 'wrap' }}>
        <input type="number" className="ship-input ship-input-sm" value={panelForm.length} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => lockstepPanelDims({ ...current, length: event.target.value })) }} />
        <span className="ship-input-unit">L</span>
        <input type="number" className="ship-input ship-input-sm" value={panelForm.width} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => lockstepPanelDims({ ...current, width: event.target.value })) }} />
        <span className="ship-input-unit">W</span>
        <input type="number" className="ship-input ship-input-sm" value={panelForm.height} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => lockstepPanelDims({ ...current, height: event.target.value })) }} />
        <span className="ship-input-unit">H (in)</span>
      </div>
    </div>
  )
}
