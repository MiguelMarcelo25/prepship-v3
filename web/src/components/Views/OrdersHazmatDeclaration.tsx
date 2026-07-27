import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import {
  apiClient,
  type HazmatDeclarationDraft,
  type HazmatMaterialDraft,
  type OrderHazmatDto,
} from '../../lib/v2-apiClient'

type Props = {
  orderId: number
  shipped: boolean
  rawOrder?: unknown
}

const clearDeclaration = (): HazmatDeclarationDraft => ({ status: 'clear', materials: [] })

function displayedDeclaration(state: OrderHazmatDto, shipped: boolean): HazmatDeclarationDraft {
  // Per user override unlock shipped data on 2026-07-25: terminal views render
  // only the immutable purchase snapshot and never expose declaration writes.
  if (shipped) return state.frozenPurchaseFacts?.declaration ?? clearDeclaration()
  return state.declaration ?? clearDeclaration()
}

function importedHazmatEvidence(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  const candidates = [
    root.advanced_options,
    root.advancedOptions,
    (root.shipment as Record<string, unknown> | undefined)?.advanced_options,
    (root.shipment as Record<string, unknown> | undefined)?.advancedOptions,
  ]
  const value = candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
  if (!value) return null
  const options = value as Record<string, unknown>
  const evidence = Object.fromEntries(
    Object.entries(options).filter(([key]) =>
      /dangerous|hazmat|dry_ice|limited_quantity|regulated_content|battery/i.test(key)),
  )
  return Object.keys(evidence).length ? evidence : null
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function materialDraft(): HazmatMaterialDraft {
  return {
    unNaNumber: '',
    properShippingName: '',
    hazardClass: '',
    packingGroup: null,
    amount: null,
    amountUnit: '',
    quantity: null,
    transportMean: '',
    regulationLevel: '',
  }
}

export function OrdersHazmatDeclaration({ orderId, shipped, rawOrder }: Props) {
  const [state, setState] = useState<OrderHazmatDto | null>(null)
  const [draft, setDraft] = useState<HazmatDeclarationDraft>(clearDeclaration)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'validate' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const evidence = useMemo(() => importedHazmatEvidence(rawOrder), [rawOrder])

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    setNotice(null)
    void apiClient.fetchOrderHazmat(orderId)
      .then((next) => {
        if (!current) return
        setState(next)
        setDraft(displayedDeclaration(next, shipped))
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : 'Hazmat details could not be loaded.')
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => { current = false }
  }, [orderId, shipped])

  if (loading || !state?.capabilities.featureEnabled) return null

  const editable = !shipped && state.capabilities.writeEnabled
  const profiles = Object.values(state.capabilities.profiles).filter((profile) => profile.visible)
  const supportedProfiles = profiles.filter((profile) => profile.purchaseSupported)
  const issues = shipped ? [] : state.validation.issues
  const update = <K extends keyof HazmatDeclarationDraft>(key: K, value: HazmatDeclarationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setNotice(null)
  }
  const updateMaterial = (index: number, patch: Partial<HazmatMaterialDraft>) => {
    setDraft((current) => ({
      ...current,
      materials: (current.materials ?? []).map((material, position) =>
        position === index ? { ...material, ...patch } : material),
    }))
    setNotice(null)
  }

  const validate = async () => {
    setBusy('validate')
    setError(null)
    setNotice(null)
    try {
      const result = await apiClient.validateOrderHazmat(orderId, {
        expectedRevision: state.revision,
        declaration: draft,
      })
      setDraft(result.declaration)
      setState((current) => current ? { ...current, validation: result.validation } : current)
      setNotice(result.validation.valid ? 'Declaration is complete.' : 'Correct the highlighted declaration issues.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Hazmat validation failed.')
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const next = await apiClient.saveOrderHazmat(orderId, {
        expectedRevision: state.revision,
        declaration: draft,
      })
      setState(next)
      setDraft(next.declaration ?? clearDeclaration())
      setNotice(next.invalidatedRate
        ? 'Saved. The previous rate was cleared; re-rate before buying a label.'
        : next.changed ? 'Hazmat declaration saved.' : 'No declaration changes to save.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Hazmat declaration could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50/50 p-2.5" data-testid="order-hazmat-declaration">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-semibold text-amber-950">Hazardous materials</div>
          <div className="mt-0.5 text-[10px] leading-snug text-amber-800">
            Carrier acceptance and compliant packaging remain the operator&apos;s responsibility. Saving never buys postage.
          </div>
        </div>
      </div>

      {/* Carrier capability is diagnostic detail, not something the operator
          fills in. Rendering every provider's certification caveat inline
          buried the two fields that actually need typing, so it collapses to
          a one-line summary and opens only when asked -- or automatically
          when nothing can actually ship hazmat. */}
      {profiles.length > 0 ? (
        <details className="mt-2 rounded border border-amber-200 bg-surface" open={supportedProfiles.length === 0}>
          <summary className="cursor-pointer px-2 py-1.5 text-[10.5px] font-semibold text-ink-2">
            Carrier support:{' '}
            {supportedProfiles.length > 0 ? (
              <span className="text-emerald-700">
                {supportedProfiles.map((profile) => profile.label).join(', ')}
              </span>
            ) : (
              <span className="text-amber-700">none certified for hazmat yet</span>
            )}
            <span className="font-normal text-ink-3">
              {' '}
              ({supportedProfiles.length} of {profiles.length})
            </span>
          </summary>
          <div className="grid grid-cols-2 gap-1.5 px-2 pb-2 text-[10.5px]">
            {profiles.map((profile) => (
              <div key={profile.profile} className="rounded border border-line bg-surface px-2 py-1.5">
                <div className="font-semibold text-ink-2">{profile.label}</div>
                <div className={profile.purchaseSupported ? 'text-emerald-700' : 'text-amber-700'}>
                  {profile.purchaseSupported ? 'Rate + purchase enabled' : profile.unavailableReason ?? 'Unavailable'}
                </div>
                {profile.warnings.map((warning) => (
                  <div key={warning} className="mt-0.5 text-[9px] leading-snug text-ink-3">{warning}</div>
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {evidence ? (
        <details className="mt-2 rounded border border-line bg-surface px-2 py-1.5">
          <summary className="cursor-pointer text-[10.5px] font-semibold text-ink-2">
            Imported ShipStation evidence (read-only)
          </summary>
          <div className="mt-1 text-[9.5px] text-ink-3">Provenance: stored source order payload. It is not purchase authority.</div>
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[9px] text-ink-2">{JSON.stringify(evidence, null, 2)}</pre>
        </details>
      ) : null}

      {/* Mirrors ShipStation's Other Shipping Options: one checkbox to declare,
          then the two contact fields. Everything else is regulatory detail and
          lives under Advanced. */}
      <label className="mt-2 flex items-center gap-2 rounded border border-line bg-surface px-2 py-1.5 text-[11px] font-semibold text-ink">
        <input
          type="checkbox"
          aria-label="This shipment contains dangerous goods"
          checked={draft.status === 'active'}
          disabled={!editable}
          onChange={(event) => setDraft(event.target.checked
            ? { ...draft, status: 'active' }
            : clearDeclaration())}
        />
        This shipment contains dangerous goods
      </label>

      {draft.status === 'active' ? (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <input
              className="h-7 rounded border border-line bg-surface px-2 text-[11px]"
              placeholder="Name contact"
              aria-label="Dangerous-goods contact name"
              disabled={!editable}
              value={draft.emergencyContactName ?? ''}
              onChange={(event) => update('emergencyContactName', event.target.value || null)}
            />
            <input
              className="h-7 rounded border border-line bg-surface px-2 text-[11px]"
              placeholder="Phone contact"
              aria-label="Dangerous-goods contact phone"
              disabled={!editable}
              value={draft.emergencyContactPhone ?? ''}
              onChange={(event) => update('emergencyContactPhone', event.target.value || null)}
            />
          </div>

          {/* Opens itself when validation flags something in here, so a
              required regulatory field can never hide behind a summary. */}
          <details
            className="rounded border border-line bg-surface"
            open={issues.length > 0}
          >
            <summary className="cursor-pointer px-2 py-1.5 text-[10.5px] font-semibold text-ink-2">
              Advanced declaration details
              {issues.length > 0 ? (
                <span className="ml-1 font-normal text-amber-700">
                  ({issues.length} to resolve)
                </span>
              ) : null}
            </summary>
            <div className="space-y-2 px-2 pb-2">
          <div className="grid grid-cols-2 gap-1.5 text-[10.5px] text-ink-2">
            {[
              ['limitedQuantity', 'Limited quantity'],
              ['containsBattery', 'Contains battery'],
              ['dryIce', 'Dry ice'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 rounded border border-line bg-surface px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={draft[key as keyof HazmatDeclarationDraft] === true}
                  disabled={!editable}
                  onChange={(event) => update(key as keyof HazmatDeclarationDraft, event.target.checked as never)}
                />
                {label}
              </label>
            ))}
          </div>

          {draft.dryIce ? (
            <div className="grid grid-cols-2 gap-1.5">
              <input
                className="h-7 rounded border border-line bg-surface px-2 text-[11px]"
                type="number"
                min="0"
                step="0.0001"
                placeholder="Dry ice weight"
                disabled={!editable}
                value={draft.dryIceWeightValue ?? ''}
                onChange={(event) => update('dryIceWeightValue', numberOrNull(event.target.value))}
              />
              <select
                aria-label="Dry ice weight unit"
                className="h-7 rounded border border-line bg-surface px-2 text-[11px]"
                disabled={!editable}
                value={draft.dryIceWeightUnit ?? ''}
                onChange={(event) => update('dryIceWeightUnit', event.target.value || null)}
              >
                <option value="">Weight unit</option>
                <option value="pound">Pounds</option>
                <option value="kilogram">Kilograms</option>
              </select>
            </div>
          ) : null}

          {/* Contact name/phone are promoted above; only the regulatory
              fields remain here. */}
          <div className="grid grid-cols-2 gap-1.5">
            <input className="h-7 rounded border border-line bg-surface px-2 text-[11px]" placeholder="USPS category" disabled={!editable} value={draft.uspsCategory ?? ''} onChange={(event) => update('uspsCategory', event.target.value || null)} />
            <input className="h-7 rounded border border-line bg-surface px-2 text-[11px]" placeholder="Other regulated content evidence" disabled={!editable} value={draft.regulatedContentType ?? ''} onChange={(event) => update('regulatedContentType', event.target.value || null)} />
          </div>
          <label className="block text-[10.5px] text-ink-2">
            USPS package-level declaration
            <select
              className="mt-1 h-7 w-full rounded border border-line bg-surface px-2 text-[11px]"
              disabled={!editable}
              value={draft.uspsPackageLevel == null ? '' : draft.uspsPackageLevel ? 'yes' : 'no'}
              onChange={(event) => update(
                'uspsPackageLevel',
                event.target.value === '' ? null : event.target.value === 'yes',
              )}
            >
              <option value="">Select declaration</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Declared materials</span>
              <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-brand disabled:opacity-50" disabled={!editable} onClick={() => update('materials', [...(draft.materials ?? []), materialDraft()])}>
                <Plus size={10} /> Add material
              </button>
            </div>
            {(draft.materials ?? []).map((material, index) => (
              <div key={index} className="mt-1.5 rounded border border-line bg-surface p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="UN/NA number" disabled={!editable} value={material.unNaNumber ?? ''} onChange={(event) => updateMaterial(index, { unNaNumber: event.target.value })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="Proper shipping name" disabled={!editable} value={material.properShippingName ?? ''} onChange={(event) => updateMaterial(index, { properShippingName: event.target.value })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="Hazard class" disabled={!editable} value={material.hazardClass ?? ''} onChange={(event) => updateMaterial(index, { hazardClass: event.target.value })} />
                  <select className="h-7 rounded border border-line px-2 text-[10.5px]" disabled={!editable} value={material.packingGroup ?? ''} onChange={(event) => updateMaterial(index, { packingGroup: (event.target.value || null) as HazmatMaterialDraft['packingGroup'] })}>
                    <option value="">Packing group</option><option value="i">I</option><option value="ii">II</option><option value="iii">III</option>
                  </select>
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" type="number" min="0" placeholder="Amount" disabled={!editable} value={material.amount ?? ''} onChange={(event) => updateMaterial(index, { amount: numberOrNull(event.target.value) })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="Amount unit" disabled={!editable} value={material.amountUnit ?? ''} onChange={(event) => updateMaterial(index, { amountUnit: event.target.value })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" type="number" min="1" step="1" placeholder="Package quantity" disabled={!editable} value={material.quantity ?? ''} onChange={(event) => updateMaterial(index, { quantity: numberOrNull(event.target.value) })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="Transport mean (e.g. ground)" disabled={!editable} value={material.transportMean ?? ''} onChange={(event) => updateMaterial(index, { transportMean: event.target.value })} />
                  <input className="h-7 rounded border border-line px-2 text-[10.5px]" placeholder="Regulation level" disabled={!editable} value={material.regulationLevel ?? ''} onChange={(event) => updateMaterial(index, { regulationLevel: event.target.value })} />
                </div>
                <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-danger disabled:opacity-50" disabled={!editable} onClick={() => update('materials', (draft.materials ?? []).filter((_, position) => position !== index))}>
                  <Trash2 size={10} /> Remove
                </button>
              </div>
            ))}
          </div>
            </div>
          </details>
        </div>
      ) : null}

      {issues.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[10px] text-danger">
          {issues.map((issue) => <li key={`${issue.path}:${issue.code}`}>{issue.message}</li>)}
        </ul>
      ) : null}
      {error ? <div className="mt-2 text-[10px] text-danger">{error}</div> : null}
      {notice ? <div className="mt-2 text-[10px] font-medium text-ink-2">{notice}</div> : null}
      {state.requiresRerate ? <div className="mt-2 text-[10px] font-semibold text-amber-800">Re-rate required before label purchase.</div> : null}
      {shipped && state.frozenPurchaseFacts ? (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-ink-3"><ShieldCheck size={11} /> Shipped hazmat snapshot is immutable.</div>
      ) : null}

      <div className="mt-2 flex gap-1.5">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!editable || busy !== null} onClick={() => void validate()}>{busy === 'validate' ? 'Validating…' : 'Validate'}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!editable || busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save declaration'}</button>
      </div>
      {!editable && !shipped ? <div className="mt-1.5 text-[9.5px] text-ink-3">Hazmat writes are not enabled for this account or role.</div> : null}
    </div>
  )
}
