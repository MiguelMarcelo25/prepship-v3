// PS-166/PS-306/PS-258 (Wave 1): the recipient-editor modal, extracted VERBATIM from
// OrdersView's inline JSX (was ~L9561-9618). PRESENTATIONAL — owns NO state: the parent
// keeps recipientDraft / recipientEditorSaving / saveRecipientOverride and passes the same
// values down, and the per-field input render closure (recipientInput) is passed as the
// renderRecipientInput render-prop so the markup is byte-identical and the draft state stays
// in OrdersView. No backend-critical truth lives here (PS-306).
import type { ReactNode } from 'react'
import { Check as CheckIcon, Loader2, MapPin, X as XIcon } from 'lucide-react'
import type { OrderSummaryDto } from '../../types/api'

// The recipient draft field keys (mirror OrdersView's local RecipientDraft keys). Kept local
// so this leaf does not import from its parent; keyof RecipientDraft is identical to this union,
// so the parent's recipientInput closure is assignable to renderRecipientInput.
type RecipientFieldKey =
  | 'name'
  | 'company'
  | 'street1'
  | 'street2'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'phone'

export type OrdersRecipientEditorModalProps = {
  isOpen: boolean
  panelOrder: OrderSummaryDto | null | undefined
  isSaving: boolean
  onClose: () => void
  onSave: () => void
  renderRecipientInput: (key: RecipientFieldKey, label: string, autoComplete?: string) => ReactNode
}

export function OrdersRecipientEditorModal({
  isOpen,
  panelOrder,
  isSaving,
  onClose,
  onSave,
  renderRecipientInput,
}: OrdersRecipientEditorModalProps): ReactNode {
  if (!isOpen || !panelOrder) return null
  return (
    <div
      data-recipient-editor-backdrop
      className="fixed inset-0 z-[80] isolate flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
    >
      <div
        data-recipient-editor-modal
        className="relative z-[81] w-full max-w-[560px] rounded-lg bg-surface shadow-xl ring-1 ring-line"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <MapPin size={15} strokeWidth={2.25} className="text-brand" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-ink truncate">Edit recipient</div>
            <div className="text-[11px] text-ink-3 font-mono truncate">{panelOrder.orderNumber ?? panelOrder.orderId}</div>
          </div>
          <button
            type="button"
            title="Close"
            disabled={isSaving}
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
          >
            <XIcon size={15} strokeWidth={2.25} />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          {renderRecipientInput('name', 'Name', 'shipping name')}
          {renderRecipientInput('company', 'Company', 'shipping organization')}
          <div className="sm:col-span-2">{renderRecipientInput('street1', 'Address 1', 'shipping address-line1')}</div>
          <div className="sm:col-span-2">{renderRecipientInput('street2', 'Address 2', 'shipping address-line2')}</div>
          {renderRecipientInput('city', 'City', 'shipping address-level2')}
          {renderRecipientInput('state', 'State', 'shipping address-level1')}
          {renderRecipientInput('postalCode', 'Postal code', 'shipping postal-code')}
          {renderRecipientInput('country', 'Country', 'shipping country')}
          <div className="sm:col-span-2">{renderRecipientInput('phone', 'Phone', 'shipping tel')}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="inline-flex h-8 items-center justify-center rounded-md border border-line px-3 text-[12px] font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-brand px-3 text-[12px] font-bold text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {isSaving ? <Loader2 size={13} className="animate-spin" /> : <CheckIcon size={13} />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
