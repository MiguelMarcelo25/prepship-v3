import { useState, type FormEvent } from 'react'
import { CreditCard, LockKeyhole, LockOpen, ReceiptText } from 'lucide-react'
import { formatBillingMoney } from './billing-parity'

export type BillingFinalizationDto = {
  id: string
  clientId: number
  periodStart: string
  periodEnd: string
  lineCount: number
  orderCount: number
  subtotal: string
  creditedAmount: string
  debitedAmount: string
  signedAdjustmentAmount: string
  balance: string
  finalizedBy: string
  finalizedByEmail: string | null
  finalizedAt: string
}

export type BillingCreditNoteDto = {
  id: string
  finalizationId: string
  clientId: number
  amount: string
  signedAmount: string
  adjustmentKind: 'credit' | 'debit'
  adjustmentSource: 'manual' | 'regeneration'
  sourceOrderId: number | null
  postingVersion: 'legacy_credit_v1' | 'current_period_v2'
  effectiveDate: string | null
  billingPolicyVersion: string | null
  billingLineItemId: number | null
  sourceFinalizationId: string
  reason: string
  idempotencyKey: string
  createdBy: string
  createdByEmail: string | null
  createdAt: string
}

export type BillingCreditDraft = {
  finalizationId: string
  adjustmentKind: 'credit' | 'debit'
  amount: string
  reason: string
  idempotencyKey: string
}

function requestKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `billing-credit:${crypto.randomUUID()}`
  }
  return `billing-credit:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
}

function displayMoney(value: string): string {
  return formatBillingMoney(Number(value))
}

function displayDateTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function displayPeriodBoundary(value: string): string {
  return value.slice(0, 10)
}

export function BillingCloseWorkflowPanel({
  clientName,
  dateFrom,
  dateTo,
  finalizations,
  selectedFinalizationId,
  creditNotes,
  statusLoading,
  statusError,
  creditNotesLoading,
  creditNotesError,
  creditSubmitting,
  onSelectFinalization,
  onRequestFinalize,
  onCreateCredit,
}: {
  clientName: string
  dateFrom: string
  dateTo: string
  finalizations: BillingFinalizationDto[]
  selectedFinalizationId: string | null
  creditNotes: BillingCreditNoteDto[]
  statusLoading: boolean
  statusError: string | null
  creditNotesLoading: boolean
  creditNotesError: string | null
  creditSubmitting: boolean
  onSelectFinalization: (finalizationId: string) => void
  onRequestFinalize: () => void
  onCreateCredit: (draft: BillingCreditDraft) => Promise<boolean>
}) {
  const [creditFormOpen, setCreditFormOpen] = useState(false)
  const [adjustmentKind, setAdjustmentKind] = useState<'credit' | 'debit'>('credit')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(requestKey)
  const selectedFinalization = finalizations.find((row) => row.id === selectedFinalizationId)
    ?? finalizations[0]
    ?? null
  const locked = finalizations.length > 0
  const adjustmentAvailable = selectedFinalization != null

  function resetCreditDraft() {
    setCreditFormOpen(false)
    setAdjustmentKind('credit')
    setAmount('')
    setReason('')
    setIdempotencyKey(requestKey())
  }

  function changeAmount(value: string) {
    setAmount(value)
    setIdempotencyKey(requestKey())
  }

  function changeReason(value: string) {
    setReason(value)
    setIdempotencyKey(requestKey())
  }

  async function submitCredit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedFinalization) return
    const created = await onCreateCredit({
      finalizationId: selectedFinalization.id,
      adjustmentKind,
      amount,
      reason,
      idempotencyKey,
    })
    if (created) resetCreditDraft()
  }

  return (
    <section
      className="mb-3 rounded-xl bg-surface-2 p-3 ring-1 ring-line"
      data-billing-close-workflow
      data-billing-period-locked={locked ? 'true' : 'false'}
      aria-label={`Billing close workflow for ${clientName}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg ${locked ? 'bg-amber-100 text-amber-700' : 'bg-brand/10 text-brand'}`}>
            {locked ? <LockKeyhole size={16} aria-hidden="true" /> : <LockOpen size={16} aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold text-ink">
              {statusLoading ? 'Checking period lock…' : statusError ? 'Period lock unavailable' : locked ? 'Finalized period · edits locked' : 'Open billing period'}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              {dateFrom} → {dateTo} · {clientName}
            </div>
            {statusError ? (
              <div role="alert" className="mt-1 text-[11px] font-semibold text-rose-700">
                {statusError}. Billing edits stay disabled until lock status can be verified.
              </div>
            ) : locked ? (
              <div className="mt-1 text-[11px] text-ink-2">
                Invoice lines are immutable. Corrections post as append-only current-period credit or debit adjustments.
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-ink-2">
                Review line items before closing. Finalization cannot be undone.
              </div>
            )}
          </div>
        </div>

        {!locked && !statusLoading && !statusError ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onRequestFinalize}
            data-billing-finalize-trigger
          >
            <LockKeyhole size={14} aria-hidden="true" />
            Finalize period
          </button>
        ) : null}
      </div>

      {locked && selectedFinalization ? (
        <div className="mt-3 border-t border-line pt-3">
          {finalizations.length > 1 ? (
            <label className="mb-3 block text-[11px] font-bold text-ink-2">
              Overlapping finalized period
              <select
                className="filter-sel mt-1 block w-full max-w-[420px] bg-surface text-ink"
                value={selectedFinalization.id}
                onChange={(event) => {
                  resetCreditDraft()
                  onSelectFinalization(event.target.value)
                }}
              >
                {finalizations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {displayPeriodBoundary(row.periodStart)} → before {displayPeriodBoundary(row.periodEnd)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-ink-3">Frozen subtotal</div>
              <div className="mt-0.5 text-[14px] font-extrabold tabular-nums text-ink">{displayMoney(selectedFinalization.subtotal)}</div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-ink-3">Credits</div>
              <div className="mt-0.5 text-[14px] font-extrabold tabular-nums text-ink">{displayMoney(selectedFinalization.creditedAmount)}</div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-ink-3">Debits</div>
              <div className="mt-0.5 text-[14px] font-extrabold tabular-nums text-ink">{displayMoney(selectedFinalization.debitedAmount)}</div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-ink-3">Balance</div>
              <div className="mt-0.5 text-[14px] font-extrabold tabular-nums text-brand">{displayMoney(selectedFinalization.balance)}</div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-ink-3">Frozen rows</div>
              <div className="mt-0.5 text-[12px] font-bold text-ink">{selectedFinalization.orderCount} orders · {selectedFinalization.lineCount} lines</div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-ink-3">
            <span>
              Finalized {displayDateTime(selectedFinalization.finalizedAt)} by {selectedFinalization.finalizedByEmail ?? selectedFinalization.finalizedBy}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              disabled={!adjustmentAvailable || creditSubmitting}
              title="Create an append-only current-period adjustment"
              onClick={() => {
                setCreditFormOpen((open) => !open)
                setIdempotencyKey(requestKey())
              }}
              data-billing-credit-trigger
            >
              <CreditCard size={13} aria-hidden="true" />
              Add adjustment
            </button>
          </div>

          {creditFormOpen ? (
            <form className="mt-3 rounded-lg bg-surface p-3 ring-1 ring-line" onSubmit={submitCredit} data-billing-credit-form>
              <div className="grid gap-3 sm:grid-cols-[130px_150px_minmax(0,1fr)]">
                <label className="text-[11px] font-bold text-ink-2">
                  Type
                  <select
                    className="filter-sel mt-1 block w-full bg-surface text-ink"
                    value={adjustmentKind}
                    onChange={(event) => {
                      setAdjustmentKind(event.target.value as 'credit' | 'debit')
                      setIdempotencyKey(requestKey())
                    }}
                  >
                    <option value="credit">Credit</option>
                    <option value="debit">Debit</option>
                  </select>
                </label>
                <label className="text-[11px] font-bold text-ink-2">
                  Amount
                  <input
                    className="markup-input-lg mt-1 w-full bg-surface text-ink"
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    required
                    value={amount}
                    onChange={(event) => changeAmount(event.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label className="text-[11px] font-bold text-ink-2">
                  Reason
                  <input
                    className="markup-input-lg mt-1 w-full bg-surface text-ink"
                    type="text"
                    minLength={3}
                    maxLength={500}
                    required
                    value={reason}
                    onChange={(event) => changeReason(event.target.value)}
                    placeholder="Required audit reason"
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" className="btn btn-ghost btn-xs" disabled={creditSubmitting} onClick={resetCreditDraft}>Cancel</button>
                <button type="submit" className="btn btn-primary btn-xs" disabled={creditSubmitting}>
                  {creditSubmitting ? 'Creating…' : `Create ${adjustmentKind}`}
                </button>
              </div>
            </form>
          ) : null}

          <div className="mt-3" data-billing-credit-history>
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-ink-3">
              <ReceiptText size={13} aria-hidden="true" />
              Adjustment history
            </div>
            {creditNotesLoading ? (
              <div className="mt-1 text-[11px] text-ink-3">Loading adjustments…</div>
            ) : creditNotesError ? (
              <div role="alert" className="mt-1 text-[11px] font-semibold text-rose-700">{creditNotesError}</div>
            ) : creditNotes.length === 0 ? (
              <div className="mt-1 text-[11px] text-ink-3">No adjustments.</div>
            ) : (
              <ul className="mt-2 grid gap-1.5">
                {creditNotes.map((note) => (
                  <li key={note.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-line">
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold text-ink">{note.reason}</div>
                      <div className="mt-0.5 text-[10px] text-ink-3">
                        {displayDateTime(note.createdAt)} · {note.createdByEmail ?? note.createdBy}
                      </div>
                      <div className="mt-0.5 text-[10px] text-ink-3">
                        {note.adjustmentSource} · current period {note.effectiveDate?.slice(0, 10) ?? 'legacy'}
                        {note.sourceOrderId ? ` · order ${note.sourceOrderId}` : ''}
                        {` · original ${note.sourceFinalizationId}`}
                      </div>
                    </div>
                    <div className={`text-[12px] font-extrabold tabular-nums ${note.adjustmentKind === 'credit' ? 'text-rose-700' : 'text-brand'}`}>
                      {displayMoney(note.signedAmount)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
