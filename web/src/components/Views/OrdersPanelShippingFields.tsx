// PS-166 (Wave 4, JSX-safe): leaf presentational rows extracted from the
// OrdersView side-panel SHIPPING section (id="sec-shipping"). These components
// own NO state — the dims→rate→label interactive core, every handler, and the
// dimsUserEditedRef all stay in the OrdersView shell and are passed down as
// props, so the React execution model is UNCHANGED and the offline cert fully
// verifies these slices (the same proven pattern already shipped in
// OrdersPanelSections.tsx for the Items/Recipient sections). Markup is moved
// BYTE-IDENTICAL. These leaves are STRICT on purpose: an
// explicit props interface makes the compiler refuse any closure dependency
// that is not declared as a prop — the structural antidote to the loose-typed
// silent-missing-dep crash class.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Inbox, Printer as PrinterIcon, Save as SaveIcon, XCircle } from 'lucide-react'
import type { LocationDto, OrderSummaryDto } from '../../types/api'
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

// W4d — the shipped-order label actions (Reprint Label + Send to Queue), shown
// ONLY for shipped orders. Per user override unlock shipped data on 2026-06-13:
// this shipped-data UI is moved VERBATIM from OrdersView for the PS-166
// decomposition. The handlers (reprintLabel, queueExistingLabels) stay in the
// OrdersView shell; the external-label-disabled gating (shippedHasPrepShipLabel
// / canQueueShippedLabel / shippedLabelUnavailableCopy) is preserved exactly;
// no shipped/cancelled protection is weakened. data-testid kept byte-identical
// (order-editable-lockdown + the e2e DOM contract pin it).
// PS-219 (per user override unlock shipped data on 2026-06-13): the
// BACKEND-OWNED voidability verdict the shipped-detail DTO carries
// (order.labelVoidability). The FE only RENDERS it — it never recomputes
// voidability and never constructs a shipment/provider id. shipmentId is the
// local shipments.id PK the void route addresses.
export type OrderLabelVoidability = {
  shipmentId: number | null
  voidable: boolean
  reasonCode: 'already_voided' | 'not_supported' | 'missing_provider_label_id' | 'no_active_shipment' | null
  providerLabel: { carrier: string | null; service: string | null; accountLabel: string | null; trackingNumber: string | null } | null
}

// Operator-facing copy for a DISABLED Void button — driven by the backend
// reasonCode, never by parsing a message string.
function voidReasonCopy(reasonCode: OrderLabelVoidability['reasonCode']): string {
  switch (reasonCode) {
    case 'already_voided':
      return 'This label is already voided.'
    case 'not_supported':
      return 'PrepShip can’t void this provider yet — void it at the carrier portal; the label stays active.'
    case 'missing_provider_label_id':
      return 'No provider label id on record — void it at the carrier portal; the label stays active.'
    default:
      return 'This label can’t be voided.'
  }
}

export function OrdersPanelShippedLabelActions({
  panelOrder,
  reprintLabel,
  queueExistingLabels,
  shippedHasPrepShipLabel,
  canQueueShippedLabel,
  shippedLabelUnavailableCopy,
  labelVoidability,
  onVoidLabel,
}: {
  panelOrder: OrderSummaryDto
  reprintLabel: () => void | Promise<void>
  queueExistingLabels: (orderIds: number[]) => void | Promise<void>
  shippedHasPrepShipLabel: boolean
  canQueueShippedLabel: boolean
  shippedLabelUnavailableCopy: string
  // PS-219: null / no shipmentId → the Void action is HIDDEN (no active
  // shipment). Enabled ONLY when voidable===true; else disabled + reason tooltip.
  labelVoidability?: OrderLabelVoidability | null
  onVoidLabel?: () => void
}) {
  const voidShipmentId = labelVoidability?.shipmentId ?? null
  return (
    <>
    <div
      data-testid="shipped-label-actions"
      className="flex items-stretch gap-1 p-1.5 bg-surface-2/40"
    >
      <button
        type="button"
        onClick={() => void reprintLabel()}
        disabled={!shippedHasPrepShipLabel}
        title={shippedHasPrepShipLabel ? 'Open the existing shipping label PDF' : shippedLabelUnavailableCopy}
        className={[
          'flex-[5] inline-flex items-center justify-center gap-2',
          'h-9 rounded-lg',
          'text-[12.5px] font-semibold tracking-tight',
          shippedHasPrepShipLabel
            ? 'text-white bg-brand hover:bg-brand-dark shadow-[0_1px_2px_rgba(42,91,215,0.20),inset_0_1px_0_rgba(255,255,255,0.12)]'
            : 'text-ink-4 bg-surface ring-1 ring-line cursor-not-allowed',
          'active:scale-[0.985]',
          'disabled:opacity-70 disabled:active:scale-100',
          'transition-all duration-150 ease-out',
        ].join(' ')}
      >
        <PrinterIcon size={13} strokeWidth={2.5} aria-hidden />
        <span>{shippedHasPrepShipLabel ? 'Reprint Label' : 'Reprint unavailable'}</span>
      </button>

      <button
        type="button"
        onClick={() => void queueExistingLabels([panelOrder.orderId])}
        disabled={!canQueueShippedLabel}
        title={canQueueShippedLabel ? 'Send the existing label back to the print queue (no new postage)' : shippedLabelUnavailableCopy}
        className={[
          'flex-[3] inline-flex items-center justify-center gap-1.5',
          'h-9 px-2 rounded-lg',
          'text-[12.5px] font-semibold',
          'bg-surface ring-1 ring-line',
          canQueueShippedLabel
            ? 'text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface'
            : 'text-ink-4 cursor-not-allowed',
          'active:scale-[0.98]',
          'disabled:opacity-70 disabled:active:scale-100',
          'transition-all duration-150 ease-out',
        ].join(' ')}
      >
        <Inbox size={12.5} strokeWidth={2.25} aria-hidden />
        {/* Shipped rows SEND the existing label back to the queue (no new
            postage) — distinct wording from awaiting rows' "Print to Queue",
            which buys postage first. */}
        <span>Send to Queue</span>
      </button>
    </div>
    {voidShipmentId != null ? (
      <div className="flex items-stretch px-1.5 pb-1.5">
        <button
          type="button"
          data-testid="shipped-void-action"
          disabled={!labelVoidability?.voidable}
          onClick={() => { if (labelVoidability?.voidable) onVoidLabel?.() }}
          title={labelVoidability?.voidable ? 'Void this label at its carrier/provider (requests a refund where supported)' : voidReasonCopy(labelVoidability?.reasonCode ?? null)}
          className={[
            'flex-1 inline-flex items-center justify-center gap-1.5',
            'h-8 rounded-lg',
            'text-[12px] font-semibold',
            labelVoidability?.voidable
              ? 'text-rose-700 bg-rose-50 ring-1 ring-rose-200 hover:bg-rose-100 hover:ring-rose-300'
              : 'text-ink-4 bg-surface ring-1 ring-line cursor-not-allowed',
            'active:scale-[0.98]',
            'disabled:opacity-70 disabled:active:scale-100',
            'transition-all duration-150 ease-out',
          ].join(' ')}
        >
          <XCircle size={12.5} strokeWidth={2.25} aria-hidden />
          <span>Void Label</span>
        </button>
      </div>
    ) : null}
    </>
  )
}
