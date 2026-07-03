// PS-373 (slice 2): admin drilldown for a client's FROZEN storage proof.
//
// The billing "Storage" line shows one total; this modal opens the evidence the
// backend froze at generate time — per-SKU cubic-foot-DAYS, each SKU's on-hand
// segments over the month, the daily rate, and any clamped-negative exceptions.
// It is a THIN CONSUMER: it fetches /billing/storage-proof (financials:read +
// per-client scope on the backend) and renders the sidecar verbatim. It owns no
// storage math — the backend rate/billing owner is the single source of truth,
// so what shows here is exactly how the invoiced total was built.
import { Fragment, useEffect, useState } from 'react'
import { apiClient } from '../../api/client'

type StorageSegment = {
  fromDay: string
  toDay: string
  balance: number
  billedQty: number
  days: number
  cuFtDays: number
}

type SkuStorageProof = {
  inventoryId: number
  sku: string
  cuFtPerUnit: number
  segments: StorageSegment[]
  cuFtDays: number
  amount: number
  hadNegativeBalance: boolean
  negativeDays: number
}

type StorageProofResponse = {
  found: boolean
  proof: { skuProofs: SkuStorageProof[]; exceptions: Array<{ inventoryId: number; sku: string; negativeDays: number }> } | null
  daysInMonth?: number
  monthlyRatePerCuFt?: string | number
  dailyRatePerCuFt?: string | number
  totalCuFtDays?: string | number
  amount?: string | number
  skuCount?: number
  exceptionCount?: number
  periodStart?: string
  periodEnd?: string
  updatedAt?: string
}

export type BillingStorageProofModalProps = {
  clientId: number | null
  clientName: string
  from: string
  to: string
  onClose: () => void
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const money = (v: string | number | null | undefined): string => `$${num(v).toFixed(2)}`
const cuft = (v: string | number | null | undefined): string =>
  num(v).toLocaleString(undefined, { maximumFractionDigits: 2 })

export default function BillingStorageProofModal(props: BillingStorageProofModalProps) {
  const { clientId, clientName, from, to, onClose } = props
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<StorageProofResponse | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (clientId == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    apiClient
      .fetchBillingStorageProof(clientId, from, to)
      .then((res) => {
        if (!cancelled) setData(res as StorageProofResponse)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load storage proof')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [clientId, from, to])

  const skuProofs = data?.proof?.skuProofs ?? []
  const exceptions = data?.proof?.exceptions ?? []

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div
      data-billing-storage-proof-modal
      role="dialog"
      aria-label="Storage fee proof"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          color: 'var(--text)',
          borderRadius: 12,
          padding: 20,
          width: 720,
          maxWidth: '94vw',
          maxHeight: '88vh',
          overflow: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Storage fee proof</h3>
            <div style={{ fontSize: 11.5, opacity: 0.8 }}>
              Client <strong>{clientName}</strong> · {from} → {to}
            </div>
          </div>
          <button className="btn btn-secondary btn-xs" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '28px 0', textAlign: 'center', opacity: 0.7 }}>Loading storage proof…</div>
        ) : error ? (
          <div role="alert" style={{ marginTop: 14, color: '#b91c1c', fontSize: 12 }}>
            {error}
          </div>
        ) : !data?.found ? (
          <div style={{ marginTop: 16, padding: 14, background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, fontSize: 12, opacity: 0.85 }}>
            No frozen storage proof for this period. Either the client has no storage rate, or billing hasn’t been
            generated for this range yet — run <strong>Update Billing</strong>, then reopen this drilldown.
          </div>
        ) : (
          <>
            {/* Period summary — the numbers behind the one storage line. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 10,
                margin: '16px 0',
              }}
            >
              {[
                ['Storage total', money(data.amount)],
                ['Total cuft-days', cuft(data.totalCuFtDays)],
                ['Days in month', String(data.daysInMonth ?? '—')],
                ['Rate ($/cuft/mo)', `$${num(data.monthlyRatePerCuFt).toFixed(4)}`],
              ].map(([label, value]) => (
                <div key={label} style={{ background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, opacity: 0.7 }}>{label}</div>
                  <div
                    style={{ fontSize: 15, fontWeight: 700 }}
                    data-testid={label === 'Storage total' ? 'storage-proof-total' : undefined}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 11.5, opacity: 0.75, marginBottom: 8 }}>
              Daily rate ${num(data.dailyRatePerCuFt).toFixed(6)} /cuft/day (rate ÷ days in month). Each SKU is billed
              its own cuft-days; the line total is the sum of the per-SKU rows below.
            </div>

            {/* Per-SKU proof rows — click a row to see its on-hand segments. */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border, #ddd)' }}>
                  <th style={{ padding: '6px 8px' }}>SKU</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>cuft/unit</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>cuft-days</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: '6px 8px', textAlign: 'center' }}>Intervals</th>
                </tr>
              </thead>
              <tbody>
                {skuProofs.map((s) => {
                  const isOpen = expanded.has(s.inventoryId)
                  return (
                    <Fragment key={s.inventoryId}>
                      <tr
                        data-storage-proof-sku={s.sku}
                        onClick={() => toggle(s.inventoryId)}
                        style={{ cursor: 'pointer', borderBottom: '1px solid var(--border, #eee)' }}
                      >
                        <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                          {isOpen ? '▾' : '▸'} {s.sku}
                          {s.hadNegativeBalance ? (
                            <span
                              title={`On-hand went negative for ${s.negativeDays} day(s) — billed at 0`}
                              style={{
                                marginLeft: 6,
                                fontSize: 8.5,
                                fontWeight: 700,
                                color: '#b45309',
                                background: '#fef3c7',
                                border: '1px solid #fde68a',
                                borderRadius: 4,
                                padding: '0 3px',
                              }}
                            >
                              NEG
                            </span>
                          ) : null}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{num(s.cuFtPerUnit).toFixed(3)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{cuft(s.cuFtDays)}</td>
                        <td data-testid="storage-proof-sku-amount" style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{money(s.amount)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', opacity: 0.7 }}>{s.segments.length}</td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td colSpan={5} style={{ padding: '0 8px 10px 22px' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, opacity: 0.9 }}>
                              <thead>
                                <tr style={{ textAlign: 'left', color: 'var(--text2, #666)' }}>
                                  <th style={{ padding: '3px 6px' }}>From</th>
                                  <th style={{ padding: '3px 6px' }}>To</th>
                                  <th style={{ padding: '3px 6px', textAlign: 'right' }}>On hand</th>
                                  <th style={{ padding: '3px 6px', textAlign: 'right' }}>Billed qty</th>
                                  <th style={{ padding: '3px 6px', textAlign: 'right' }}>Days</th>
                                  <th style={{ padding: '3px 6px', textAlign: 'right' }}>cuft-days</th>
                                </tr>
                              </thead>
                              <tbody>
                                {s.segments.map((seg, i) => (
                                  <tr key={i}>
                                    <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>{seg.fromDay}</td>
                                    <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>{seg.toDay}</td>
                                    <td style={{ padding: '3px 6px', textAlign: 'right', color: seg.balance < 0 ? '#b91c1c' : undefined }}>
                                      {seg.balance}
                                    </td>
                                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{seg.billedQty}</td>
                                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{seg.days}</td>
                                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{cuft(seg.cuFtDays)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
                {skuProofs.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '12px 8px', opacity: 0.6 }}>
                      No billable SKUs in this period.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            {exceptions.length ? (
              <div style={{ marginTop: 14, padding: 12, background: 'rgba(245, 158, 11, 0.10)', border: '1px solid #fde68a', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, color: '#b45309', fontSize: 12, marginBottom: 4 }}>
                  {exceptions.length} negative-balance exception{exceptions.length === 1 ? '' : 's'}
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.85 }}>
                  These SKUs went below zero on hand (over-ship or a bad adjustment) and were billed at 0 for the
                  affected days — review the inventory ledger:
                </div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, fontFamily: 'monospace' }}>
                  {exceptions.map((ex) => (
                    <li key={ex.inventoryId}>
                      {ex.sku} — {ex.negativeDays} day{ex.negativeDays === 1 ? '' : 's'} negative
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data.updatedAt ? (
              <div style={{ marginTop: 12, fontSize: 10.5, opacity: 0.6 }}>
                Frozen at generate time · last updated {new Date(data.updatedAt).toLocaleString()}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
