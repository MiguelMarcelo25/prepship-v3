// PS-155: the three Package modals extracted verbatim from PackagesView.tsx (behavior-preserving).
// They are pure, prop-driven presentational components — no PackagesView-local state/closures — so
// relocating them here thins the view without changing any behavior.
import { type FormEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { type PackageFormState, type PackageQuantityFormState } from './packages-parity'

export function PackageAdjustModal({
  title,
  packageName,
  children,
  onClose,
  narrow = false,
}: {
  title: string
  packageName: string
  children: ReactNode
  onClose: () => void
  narrow?: boolean
}) {
  return (
    <div className="packages-overlay" onClick={onClose}>
      <div className={`packages-modal${narrow ? ' packages-modal-narrow' : ''}`} onClick={(event) => event.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>{packageName}</div>
        {children}
      </div>
    </div>
  )
}

export function PackageBillingDefaultModal({
  packageName,
  price,
  onPriceChange,
  onClose,
  onConfirm,
  saving,
}: {
  packageName: string
  price: string
  onPriceChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
  saving: boolean
}) {
  return (
    <div className="packages-overlay" onClick={onClose}>
      <div className="packages-modal packages-modal-default" onClick={(event) => event.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>📋 Set Billing Default</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>{packageName}</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, lineHeight: 1.5 }}>
          This will set the billing charge for <strong>all clients</strong> that haven&apos;t manually overridden their price.
          Clients with custom prices will <strong>not</strong> be changed.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Billing charge $</span>
          <input
            id="pkgDefaultPrice"
            type="number"
            min="0"
            step="0.01"
            value={price}
            placeholder="0.00"
            autoFocus
            onChange={(event) => onPriceChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onConfirm()
              }
            }}
            style={{
              flex: 1,
              padding: '7px 10px',
              border: '1px solid var(--border2)',
              borderRadius: 6,
              background: 'var(--surface2)',
              color: 'var(--text)',
              fontSize: 14,
              fontWeight: 700,
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>per box</span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid var(--border2)',
              background: 'var(--surface2)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--ss-blue)',
              color: '#fff',
              cursor: saving ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Set Default'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PackageFormModal({
  form,
  saving,
  onChange,
  onSubmit,
  onClose,
}: {
  form: PackageFormState
  saving: boolean
  onChange: <K extends keyof PackageFormState>(field: K, value: PackageFormState[K]) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClose: () => void
}) {
  const isEditing = Boolean(form.packageId)

  return (
    <div className="packages-overlay" onClick={saving ? undefined : onClose}>
      <form
        className="packages-modal packages-modal-package-form"
        id="pkgFormCard"
        onSubmit={onSubmit}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="packages-form-modal-header">
          <div>
            <div className="packages-form-modal-kicker">Package Library</div>
            <h3 id="pkgFormTitle">{isEditing ? 'Edit Custom Package' : 'Add Custom Package'}</h3>
            <p>{isEditing ? 'Update this reusable package size and cost.' : 'Create a reusable package size for future shipments.'}</p>
          </div>
          <button
            type="button"
            className="packages-modal-close"
            aria-label="Close package form"
            title="Close"
            onClick={onClose}
            disabled={saving}
          >
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <input id="pkgFormId" type="hidden" value={form.packageId} readOnly />

        <div className="packages-form-modal-grid">
          <div className="pkg-form-field packages-form-field-wide">
            <label htmlFor="pkgFormName">
              Name <span className="packages-required-mark" aria-hidden="true">*</span>
            </label>
            <input
              id="pkgFormName"
              type="text"
              required
              placeholder="e.g. Small Poly Mailer"
              value={form.name}
              autoFocus
              onChange={(event) => onChange('name', event.target.value)}
            />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormType">Type</label>
            <select id="pkgFormType" value={form.type} onChange={(event) => onChange('type', event.target.value)}>
              <option value="box">Box</option>
              <option value="poly_mailer">Poly Mailer</option>
              <option value="envelope">Envelope</option>
              <option value="flat_rate_box_sm">Flat Rate Box SM</option>
              <option value="flat_rate_box_md">Flat Rate Box MD</option>
              <option value="flat_rate_box_lg">Flat Rate Box LG</option>
              <option value="flat_rate_env">Flat Rate Envelope</option>
            </select>
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormTare">Tare Weight (oz)</label>
            <input id="pkgFormTare" type="number" min="0" step="0.5" value={form.tareWeightOz} onChange={(event) => onChange('tareWeightOz', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormL">Length (in)</label>
            <input id="pkgFormL" type="number" min="0" step="0.25" value={form.length} onChange={(event) => onChange('length', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormW">Width (in)</label>
            <input id="pkgFormW" type="number" min="0" step="0.25" value={form.width} onChange={(event) => onChange('width', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormH">Height (in)</label>
            <input id="pkgFormH" type="number" min="0" step="0.25" value={form.height} onChange={(event) => onChange('height', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormCost">Unit Cost ($)</label>
            <input id="pkgFormCost" type="number" min="0" step="0.001" placeholder="0.000" value={form.unitCost} onChange={(event) => onChange('unitCost', event.target.value)} />
          </div>
        </div>

        <div className="packages-form-modal-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save Package'}
          </button>
        </div>
      </form>
    </div>
  )
}

// PS-155: Receive-stock modal body extracted verbatim from PackagesView.tsx (behavior-preserving).
// State (the receiveModal object) + the submit handler (handleReceiveSubmit → buildPackageReceiveInput
// → apiClient.receivePackage) stay OWNED by PackagesView. This component only renders the inputs and
// forwards field edits via onFormChange and the submit via onSubmit (Enter-to-submit wiring is verbatim).
export function ReceiveStockModal({
  packageName,
  form,
  modalSaving,
  onFormChange,
  onClose,
  onSubmit,
}: {
  packageName: string
  form: PackageQuantityFormState
  modalSaving: boolean
  onFormChange: (field: keyof PackageQuantityFormState, value: string) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <PackageAdjustModal title="📥 Receive Stock" packageName={packageName} onClose={onClose}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <input
          id="pkgAdjQty"
          type="number"
          min="1"
          step="1"
          value={form.qty}
          placeholder="Qty"
          autoFocus
          onChange={(event) => onFormChange('qty', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void onSubmit()
            }
          }}
          style={{
            flex: 1,
            padding: '7px 10px',
            border: '1px solid var(--border2)',
            borderRadius: 6,
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 14,
            fontWeight: 700,
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>units</span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>Cost/unit $</span>
        <input
          id="pkgAdjCost"
          type="number"
          min="0"
          step="0.001"
          value={form.costPerUnit}
          placeholder="0.000 (optional)"
          onChange={(event) => onFormChange('costPerUnit', event.target.value)}
          style={{
            flex: 1,
            padding: '7px 10px',
            border: '1px solid var(--border2)',
            borderRadius: 6,
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 13,
          }}
        />
        <span style={{ fontSize: 10.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>updates unit cost</span>
      </div>
      <input
        id="pkgAdjNote"
        type="text"
        maxLength={120}
        value={form.note}
        placeholder="Note (optional)"
        onChange={(event) => onFormChange('note', event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void onSubmit()
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          border: '1px solid var(--border2)',
          borderRadius: 6,
          background: 'var(--surface2)',
          color: 'var(--text)',
          fontSize: 12,
          marginBottom: 14,
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button type="button" onClick={() => void onSubmit()} disabled={modalSaving} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--green)', color: '#fff', cursor: modalSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: modalSaving ? 0.7 : 1 }}>{modalSaving ? 'Receiving…' : 'Receive'}</button>
      </div>
    </PackageAdjustModal>
  )
}

// PS-155: Adjust-stock modal body extracted verbatim from PackagesView.tsx (behavior-preserving).
// State (the adjustModal object incl. the +/- sign) + the submit handler (handleAdjustSubmit →
// buildPackageAdjustInput → apiClient.adjustPackage) stay OWNED by PackagesView. This component only
// renders the inputs and forwards the sign toggle (onSignChange), field edits (onFormChange) and the
// submit (onSubmit). Enter-to-submit wiring is verbatim.
export function AdjustStockModal({
  packageName,
  form,
  sign,
  modalSaving,
  onSignChange,
  onFormChange,
  onClose,
  onSubmit,
}: {
  packageName: string
  form: PackageQuantityFormState
  sign: 1 | -1
  modalSaving: boolean
  onSignChange: (sign: 1 | -1) => void
  onFormChange: (field: keyof PackageQuantityFormState, value: string) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <PackageAdjustModal title="± Adjust Stock" packageName={packageName} onClose={onClose} narrow>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          id="pkgAdjBtn-add"
          type="button"
          onClick={() => onSignChange(1)}
          style={{
            flex: 1,
            padding: 7,
            borderRadius: 6,
            border: sign > 0 ? '2px solid var(--ss-blue)' : '2px solid var(--border2)',
            background: sign > 0 ? 'var(--ss-blue)' : 'var(--surface2)',
            color: sign > 0 ? '#fff' : 'var(--text)',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          + Add
        </button>
        <button
          id="pkgAdjBtn-rem"
          type="button"
          onClick={() => onSignChange(-1)}
          style={{
            flex: 1,
            padding: 7,
            borderRadius: 6,
            border: sign < 0 ? '2px solid var(--red)' : '2px solid var(--border2)',
            background: sign < 0 ? 'var(--red)' : 'var(--surface2)',
            color: sign < 0 ? '#fff' : 'var(--text)',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          − Remove
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <span id="pkgAdjSignLabel" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', width: 16, textAlign: 'center' }}>{sign > 0 ? '+' : '−'}</span>
        <input
          type="number"
          min="1"
          step="1"
          value={form.qty}
          placeholder="Qty"
          autoFocus
          onChange={(event) => onFormChange('qty', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void onSubmit()
            }
          }}
          style={{
            flex: 1,
            padding: '7px 10px',
            border: '1px solid var(--border2)',
            borderRadius: 6,
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 14,
            fontWeight: 700,
          }}
        />
      </div>
      <input
        type="text"
        maxLength={120}
        value={form.note}
        placeholder="Note (optional)"
        onChange={(event) => onFormChange('note', event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void onSubmit()
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          border: '1px solid var(--border2)',
          borderRadius: 6,
          background: 'var(--surface2)',
          color: 'var(--text)',
          fontSize: 12,
          marginBottom: 14,
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button type="button" onClick={() => void onSubmit()} disabled={modalSaving} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--ss-blue)', color: '#fff', cursor: modalSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: modalSaving ? 0.7 : 1 }}>{modalSaving ? 'Saving…' : 'Save'}</button>
      </div>
    </PackageAdjustModal>
  )
}
