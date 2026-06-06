// PS-106 slice 3 — Settings control for the direct-store vs ShipStation carrier policy.
//
// Reads/writes the backend `block_shipstation_for_direct_store` setting. The backend is
// the authority and fails safe to audit_only; this control just makes the mode clickable.
// Default/safe rollout: Audit only (reports would-blocks, never blocks a purchase).

import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react'
import { apiClient } from '../../lib/v2-apiClient'

type Mode = 'enforce' | 'audit_only' | 'disabled'

const OPTIONS: Array<{
  mode: Mode
  label: string
  blurb: string
  icon: typeof ShieldCheck
}> = [
  {
    mode: 'audit_only',
    label: 'Audit only',
    blurb: 'Recommended. Logs when a direct-store order would use a ShipStation carrier, but does NOT block it. Use this to validate the rule against real orders before enforcing.',
    icon: ShieldAlert,
  },
  {
    mode: 'enforce',
    label: 'Enforce',
    blurb: 'Blocks direct-store orders (Walmart/eBay/direct connectors) from rating or buying postage through ShipStation carrier accounts. Turn on only after audit logs look clean.',
    icon: ShieldCheck,
  },
  {
    mode: 'disabled',
    label: 'Off',
    blurb: 'No restriction. ShipStation carriers may appear for direct-store orders if other carrier/account rules allow them. Risky — other safety rules (selected-rate proof, scope) still apply.',
    icon: ShieldOff,
  },
]

export function CarrierEligibilityPolicyCard() {
  const [mode, setMode] = useState<Mode>('audit_only')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Mode | null>(null)
  const [savedAt, setSavedAt] = useState<Mode | null>(null)

  useEffect(() => {
    let active = true
    void apiClient.fetchCarrierEligibilityPolicy().then((m) => {
      if (active) { setMode(m); setLoading(false) }
    }).catch(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function choose(next: Mode) {
    if (next === mode || saving) return
    const prev = mode
    setMode(next)
    setSaving(next)
    try {
      await apiClient.saveCarrierEligibilityPolicy(next)
      setSavedAt(next)
      setTimeout(() => setSavedAt((s) => (s === next ? null : s)), 2500)
    } catch {
      setMode(prev) // revert on failure
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-[14px] font-extrabold text-ink tracking-tight m-0">Direct-store carrier policy</h3>
        {loading ? <span className="text-2xs text-ink-3">Loading…</span> : null}
      </div>
      <p className="text-[12px] text-ink-3 mb-3 leading-snug">
        ShipStation carrier accounts should only be used for ShipStation-sourced orders.
        This controls whether direct-store orders (Walmart/eBay/direct connectors) are blocked
        from using ShipStation carriers.
      </p>
      <div className="flex flex-col gap-2">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon
          const active = mode === opt.mode
          return (
            <button
              key={opt.mode}
              type="button"
              disabled={loading || saving != null}
              onClick={() => void choose(opt.mode)}
              aria-pressed={active}
              className={[
                'w-full text-left rounded-card border px-3 py-2.5 transition-colors flex gap-3 items-start',
                active ? 'border-brand bg-brand/5 ring-1 ring-brand' : 'border-line bg-surface hover:bg-surface-2',
                (loading || saving != null) ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              <Icon size={16} strokeWidth={2.2} className={active ? 'text-brand mt-0.5' : 'text-ink-3 mt-0.5'} aria-hidden />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className={`text-[13px] font-bold ${active ? 'text-brand' : 'text-ink'}`}>{opt.label}</span>
                  {opt.mode === 'audit_only' ? <span className="text-[9.5px] font-extrabold uppercase tracking-wide text-ink-3 bg-surface-2 ring-1 ring-line rounded px-1.5 py-0.5">Default</span> : null}
                  {saving === opt.mode ? <span className="text-2xs text-ink-3">Saving…</span> : null}
                  {savedAt === opt.mode ? <span className="text-2xs text-emerald-600 font-semibold">Saved</span> : null}
                </span>
                <span className="block text-[11.5px] text-ink-3 leading-snug mt-0.5">{opt.blurb}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
