// @ts-nocheck — the recipient section reads loose DTO fields
// (panelOrder.residential / sourceResidential, panelDetail.raw), following the
// documented sibling precedent (orders-display-state.ts, OrdersTableCells.tsx).
//
// PS-166 (Wave 3b, JSX-safe): the side-panel Items + Recipient display
// sections, extracted from OrdersView's renderSinglePanel with BYTE-IDENTICAL
// markup. PRESENTATIONAL only — these components own NO state. Section
// collapse, the residential toggle, copy, and toasts are all passed as
// callbacks that STILL LIVE in OrdersView (the dims→rate→label interactive
// core and all handlers stay in the shell, so the React execution model is
// unchanged and the offline cert fully verifies this slice). PS-182's real
// residential 'change' control is preserved verbatim; no stub revert/tax rows
// were reintroduced.
import { AlertTriangle, BadgeCheck, Box, ChevronDown, Copy as CopyIcon, Edit3, Loader2, MapPin, Package, User as UserIcon } from 'lucide-react'
import HoverImage from '../HoverImage'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
// PS-276 (slice 4-UI): the resi/comm tag reads the backend verdict off the DTO (display-only).
import { ResidentialTag, residentialTagFacts } from '../ui/ResidentialTag'
import { copyText } from './orders-display-state'
import { formatMoney, toRecord, toStringValue } from './orders-row-display'
import type { OrderLineItem } from './orders-items'

type PanelSectionKey = 'shipping' | 'items' | 'recipient'

type ShipToDisplay = {
  name: string | null
  phone: string | null
  addressVerified: string | null
}

export function OrdersPanelItemsSection({
  collapsedSections,
  toggleSection,
  items,
  mergedItems,
}: {
  collapsedSections: Record<PanelSectionKey, boolean>
  toggleSection: (key: PanelSectionKey) => void
  items: OrderLineItem[]
  mergedItems: OrderLineItem[]
}) {
  return (
    <div className={`panel-section${collapsedSections.items ? ' collapsed' : ''}`} id="sec-items">
      <button
        type="button"
        onClick={() => toggleSection('items')}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
      >
        <Package size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
        <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase">Items</span>
        <span className="text-[10px] font-medium text-ink-4 tabular-nums">
          {mergedItems.length === 0 ? '0' : mergedItems.length}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={2.5}
          className={`text-ink-3 transition-transform ${collapsedSections.items ? '-rotate-90' : ''}`}
        />
      </button>
      <div className="px-3 pb-3">
        {items.length === 0 ? (
          <div className="pt-3 text-[11.5px] text-ink-3">No items found for this order.</div>
        ) : null}
        <div className="divide-y divide-line">
          {mergedItems.map((item) => (
            <div
              key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`}
              className="flex items-start gap-2.5 py-2.5"
            >
              <div className="w-[42px] h-[42px] rounded-md bg-surface-2 ring-1 ring-line flex items-center justify-center overflow-hidden shrink-0">
                <HoverImage
                  src={item.imageUrl}
                  alt={item.name ?? ''}
                  size={42}
                  radius={5}
                  title={item.name ?? ''}
                  fallback={<Package size={18} strokeWidth={1.75} className="text-ink-4" />}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold text-ink leading-snug truncate" title={item.name ?? ''}>
                  {item.name ?? 'Unknown Item'}
                </div>
                <div className="text-[10.5px] text-ink-3 font-mono tabular-nums truncate">
                  SKU: {item.sku ?? '—'}
                </div>
                <div className="text-[10.5px] text-ink-2 mt-0.5 tabular-nums">
                  {formatMoney(item.unitPrice)} × {item.quantity} = <strong className="text-ink">{formatMoney((item.unitPrice ?? 0) * item.quantity)}</strong>
                </div>
              </div>
              <div className="w-[26px] h-[26px] rounded-full bg-brand text-white flex items-center justify-center text-[12.5px] font-bold tabular-nums shrink-0 shadow-sm">
                {item.quantity}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function OrdersPanelRecipientSection({
  collapsedSections,
  toggleSection,
  shipTo,
  addressBlock,
  panelOrder,
  panelDetail,
  toggleResidential,
  showToast,
  activeOrderLoading,
  activeOrderError,
}: {
  collapsedSections: Record<PanelSectionKey, boolean>
  toggleSection: (key: PanelSectionKey) => void
  shipTo: ShipToDisplay
  addressBlock: string
  panelOrder: OrderSummaryDto
  panelDetail: OrderFullDto | null
  toggleResidential: () => void | Promise<void>
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void
  activeOrderLoading: boolean
  activeOrderError: unknown
}) {
  return (
    <div className={`panel-section${collapsedSections.recipient ? ' collapsed' : ''}`} id="sec-recipient">
      <button
        type="button"
        onClick={() => toggleSection('recipient')}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
      >
        <MapPin size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
        <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase">Recipient</span>
        <ChevronDown
          size={13}
          strokeWidth={2.5}
          className={`text-ink-3 transition-transform ${collapsedSections.recipient ? '-rotate-90' : ''}`}
        />
      </button>
      <div className="px-3 pb-3">
        {/* Ship To header row */}
        <div className="flex items-center gap-2 mt-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-4">Ship To</span>
          <div className="flex-1 h-px bg-line" />
          <button
            type="button"
            onClick={() => copyText(addressBlock)}
            title="Copy address"
            className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 transition"
          >
            <CopyIcon size={11} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            onClick={() => showToast('Edit recipient — Phase 3')}
            title="Edit recipient"
            className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-[10.5px] font-semibold text-brand hover:bg-brand/5 transition"
          >
            <Edit3 size={10} strokeWidth={2.5} />
            Edit
          </button>
        </div>

        {/* Address card */}
        <div className="text-[13px] font-semibold text-ink leading-snug">{shipTo.name ?? '—'}</div>
        <div className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-line">
          {addressBlock || '—'}
        </div>
        {shipTo.phone ? (
          <div className="text-[12px] text-ink-2 mt-1 font-mono tabular-nums">{shipTo.phone}</div>
        ) : null}

        {/* Address type pill — PS-276 (slice 4-UI): the backend resi/comm verdict + source/confidence
            (green trusted-commercial, amber low-confidence-commercial, neutral residential). Display
            of the SOT classification, never a second classifier. */}
        <div className="flex items-center gap-1.5 mt-2 text-[10.5px]">
          <ResidentialTag facts={residentialTagFacts(panelOrder)} />
          <button
            type="button"
            onClick={(event) => { event.preventDefault(); void toggleResidential() }}
            className="ml-1 text-brand font-medium hover:underline"
          >
            change
          </button>
        </div>

        {/* Validation status row */}
        <div className="flex items-center gap-1.5 mt-2 text-[10.5px]">
          {shipTo.addressVerified && shipTo.addressVerified !== 'Not Validated' ? (
            <>
              <BadgeCheck size={11} strokeWidth={2.5} className="text-ok" />
              <span className="text-ok-dark font-semibold">Address Validated</span>
            </>
          ) : (
            <>
              <AlertTriangle size={11} strokeWidth={2.5} className="text-warn" />
              <span className="text-warn font-semibold">Address Not Validated</span>
            </>
          )}
          {/* PS-182: the 'Revert' button was a no-op stub (its toast claimed a
              revert without reverting anything — there is no address-edit
              feature to undo) and the Tax Information row hardcoded a zero
              count over a backend concept that doesn't exist. Both v2-parity
              stubs removed; reintroduce only WITH a real backend feature. */}
        </div>

        {/* Sold To section */}
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex items-center gap-1.5 mb-1.5">
            <UserIcon size={10} strokeWidth={2.5} className="text-ink-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-4">Sold To</span>
          </div>
          <div className="text-[12.5px] font-semibold text-ink">
            {toStringValue(toRecord(panelDetail?.raw)?.customerUsername) ?? shipTo.name ?? '—'}
          </div>
          {panelOrder.customerEmail ? (
            <div className="text-[11.5px] text-ink-2 truncate">{panelOrder.customerEmail}</div>
          ) : null}
        </div>

        {activeOrderLoading ? (
          <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
            <Loader2 size={10} strokeWidth={2.25} className="animate-spin" />
            Loading full order detail…
          </div>
        ) : null}
        {activeOrderError ? (
          <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-danger">
            <AlertTriangle size={10} strokeWidth={2.5} />
            Failed to load full order detail.
          </div>
        ) : null}
      </div>
    </div>
  )
}
