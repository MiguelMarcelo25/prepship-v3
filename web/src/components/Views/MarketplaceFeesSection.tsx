// PS-239: Settings → Marketplace Fees. Self-contained CRUD for the per-store/
// client marketplace-fee rules persisted in the `marketplace_fee_rules` settings
// KV. The FE only stores rules — all fee MATH is backend-owned (rate-money +
// marketplace-fee services); these rules drive the Marketplace Fee + Profit
// columns on Awaiting/Shipped. No fee computation happens here.
import { useEffect, useState } from 'react'
import { Plus, Trash2, Save } from 'lucide-react'
import { apiClient } from '../../api/client'
import { SkeletonStack, StatusLine } from './settings-ui'

type FeeRuleKind = 'flat' | 'tiered'

interface FeeRule {
  clientId?: number | null
  storeId?: number | null
  marketplace?: string | null
  kind: FeeRuleKind
  percent?: number | null
  threshold?: number | null
  belowPercent?: number | null
  atOrAbovePercent?: number | null
  disabled?: boolean
}

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }

const FIELD = 'h-7 px-2 rounded ring-1 ring-line bg-surface text-[12px] text-ink focus:ring-brand/40 focus:ring-2 outline-none transition'
const NUM_FIELD = `${FIELD} w-[72px] text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`

function numOrNull(value: string): number | null {
  if (value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function newRule(): FeeRule {
  return { kind: 'tiered', threshold: 15, belowPercent: 8, atOrAbovePercent: 15 }
}

export function MarketplaceFeesSection() {
  const [rules, setRules] = useState<FeeRule[] | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const data = await apiClient.fetchMarketplaceFeeRules()
      if (cancelled) return
      const loaded = Array.isArray(data?.rules) ? (data.rules as FeeRule[]) : []
      setRules(loaded)
    })()
    return () => { cancelled = true }
  }, [])

  function update(index: number, patch: Partial<FeeRule>) {
    setRules((prev) => (prev ? prev.map((r, i) => (i === index ? { ...r, ...patch } : r)) : prev))
    setSave({ kind: 'idle' })
  }

  function addRule() {
    setRules((prev) => [...(prev ?? []), newRule()])
    setSave({ kind: 'idle' })
  }

  function removeRule(index: number) {
    setRules((prev) => (prev ? prev.filter((_, i) => i !== index) : prev))
    setSave({ kind: 'idle' })
  }

  async function persist() {
    if (!rules) return
    setSave({ kind: 'saving' })
    try {
      await apiClient.saveMarketplaceFeeRules({ version: 1, rules })
      setSave({ kind: 'saved', message: `Saved ${rules.length} rule${rules.length === 1 ? '' : 's'}.` })
    } catch (err) {
      setSave({ kind: 'error', message: err instanceof Error ? err.message : 'Save failed' })
    }
  }

  if (rules === null) return <SkeletonStack rows={4} />

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ink-3 leading-relaxed">
        A commission on each order's product subtotal (pre-tax, pre-shipping), shown in the
        <span className="font-semibold text-ink"> Marketplace Fee</span> and
        <span className="font-semibold text-ink"> Profit</span> columns. Most-specific rule wins:
        a <em>store</em> rule overrides a <em>client</em> rule. Leave Client/Store blank for a
        catch-all. Profit = subtotal − fee − best rate (incl. markup).
      </p>

      {rules.length === 0 ? (
        <div className="text-[13px] text-ink-3 italic px-1 py-2">No rules yet — add one below.</div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, index) => (
            <div key={index} className="rounded-xl ring-1 ring-line bg-surface p-3 space-y-2 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-ink-3">Client ID</label>
                <input className={NUM_FIELD} type="number" min="0" placeholder="any"
                  value={rule.clientId ?? ''} onChange={(e) => update(index, { clientId: numOrNull(e.target.value) })} />
                <label className="text-[11px] text-ink-3">Store ID</label>
                <input className={NUM_FIELD} type="number" min="0" placeholder="any"
                  value={rule.storeId ?? ''} onChange={(e) => update(index, { storeId: numOrNull(e.target.value) })} />
                <label className="text-[11px] text-ink-3">Marketplace</label>
                <input className={`${FIELD} w-[110px]`} type="text" placeholder="any (amazon…)"
                  value={rule.marketplace ?? ''} onChange={(e) => update(index, { marketplace: e.target.value.trim() || null })} />
                <button type="button" onClick={() => removeRule(index)}
                  className="ml-auto inline-flex items-center gap-1 h-7 px-2 rounded ring-1 ring-line text-[11px] text-rose-600 hover:bg-rose-50 transition"
                  aria-label="Remove rule">
                  <Trash2 size={13} /> Remove
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className={FIELD} value={rule.kind}
                  onChange={(e) => update(index, { kind: e.target.value as FeeRuleKind })} aria-label="Fee kind">
                  <option value="flat">Flat %</option>
                  <option value="tiered">Tiered</option>
                </select>
                {rule.kind === 'flat' ? (
                  <>
                    <label className="text-[11px] text-ink-3">Percent</label>
                    <input className={NUM_FIELD} type="number" min="0" step="0.5" placeholder="12"
                      value={rule.percent ?? ''} onChange={(e) => update(index, { percent: numOrNull(e.target.value) })} />
                  </>
                ) : (
                  <>
                    <label className="text-[11px] text-ink-3">≥ $</label>
                    <input className={NUM_FIELD} type="number" min="0" step="1" placeholder="15"
                      value={rule.threshold ?? ''} onChange={(e) => update(index, { threshold: numOrNull(e.target.value) })} />
                    <label className="text-[11px] text-ink-3">below %</label>
                    <input className={NUM_FIELD} type="number" min="0" step="0.5" placeholder="8"
                      value={rule.belowPercent ?? ''} onChange={(e) => update(index, { belowPercent: numOrNull(e.target.value) })} />
                    <label className="text-[11px] text-ink-3">at/above %</label>
                    <input className={NUM_FIELD} type="number" min="0" step="0.5" placeholder="15"
                      value={rule.atOrAbovePercent ?? ''} onChange={(e) => update(index, { atOrAbovePercent: numOrNull(e.target.value) })} />
                  </>
                )}
                <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-ink-3">
                  <input type="checkbox" checked={!!rule.disabled}
                    onChange={(e) => update(index, { disabled: e.target.checked })} /> Disabled
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button type="button" onClick={addRule}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg ring-1 ring-line bg-surface-2 hover:bg-line/40 text-[12px] text-ink transition">
          <Plus size={14} /> Add rule
        </button>
        <button type="button" onClick={() => void persist()} disabled={save.kind === 'saving'}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-brand text-white text-[12px] font-semibold hover:bg-brand/90 disabled:opacity-60 transition">
          <Save size={14} /> {save.kind === 'saving' ? 'Saving…' : 'Save rules'}
        </button>
        {save.kind === 'saved' ? <StatusLine kind="success" message={save.message ?? 'Saved.'} /> : null}
        {save.kind === 'error' ? <StatusLine kind="error" message={`Save failed: ${save.message}`} /> : null}
      </div>
    </div>
  )
}
