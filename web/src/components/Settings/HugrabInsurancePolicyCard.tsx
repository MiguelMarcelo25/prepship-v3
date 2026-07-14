import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ShieldCheck, ShieldOff } from 'lucide-react'
import { apiClient } from '../../lib/v2-apiClient'
import { AutomationSwitch } from '../Views/settings-ui'

const QUERY_KEY = ['settings', 'hugrab-default-insurance'] as const

export function HugrabInsurancePolicyCard({ queriesEnabled = true }: { queriesEnabled?: boolean } = {}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const policyQuery = useQuery<boolean>({
    queryKey: QUERY_KEY,
    enabled: queriesEnabled,
    queryFn: () => apiClient.fetchHugrabDefaultInsurancePolicy(),
  })
  const enabled = policyQuery.data ?? true
  const loading = policyQuery.data == null && (!queriesEnabled || policyQuery.isPending)

  async function changePolicy(next: boolean) {
    if (saving || next === enabled) return
    const previous = enabled
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    queryClient.setQueryData<boolean>(QUERY_KEY, next)
    try {
      await apiClient.saveHugrabDefaultInsurancePolicy(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (error) {
      queryClient.setQueryData<boolean>(QUERY_KEY, previous)
      setSaveError(error instanceof Error ? error.message : 'Could not save the HUGRAB insurance setting')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {enabled ? (
              <ShieldCheck size={17} className="text-emerald-600" aria-hidden />
            ) : (
              <ShieldOff size={17} className="text-amber-600" aria-hidden />
            )}
            <h3 className="m-0 text-[14px] font-extrabold tracking-tight text-ink">
              HUGRAB automatic insurance
            </h3>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-wide text-ink-3 ring-1 ring-line">
              Default on
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-[12px] leading-snug text-ink-3">
            When enabled, PrepShip requires at least $100 coverage on HUGRAB quotes and labels.
            When disabled, the backend honors the insurance selected by the operator, including none.
          </p>
        </div>
        <AutomationSwitch
          checked={enabled}
          onChange={(next) => void changePolicy(next)}
          disabled={loading || policyQuery.isError}
          saving={saving}
          label={enabled ? 'Enabled' : 'Disabled'}
          ariaLabel="HUGRAB automatic $100 insurance"
        />
      </div>

      {!enabled ? (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[11.5px] leading-snug text-amber-700 ring-1 ring-amber-500/30">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>Future HUGRAB labels can be purchased without automatic coverage unless an operator selects insurance.</span>
        </div>
      ) : null}

      {loading ? <p className="mt-2 text-2xs text-ink-3">Loading policy…</p> : null}
      {policyQuery.isError ? (
        <button
          type="button"
          onClick={() => void policyQuery.refetch()}
          className="mt-2 text-[11.5px] font-semibold text-brand hover:underline"
        >
          Policy unavailable — retry
        </button>
      ) : null}
      {saved ? (
        <p className="mt-2 text-2xs font-semibold text-emerald-600">
          Saved — re-rate HUGRAB orders to apply this policy.
        </p>
      ) : null}
      {saveError ? <p className="mt-2 text-2xs font-semibold text-rose-600">{saveError}</p> : null}
    </div>
  )
}
