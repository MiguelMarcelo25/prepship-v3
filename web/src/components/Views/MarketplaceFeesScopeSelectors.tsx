// PS-242: populated Client / Store / Marketplace selectors for one Marketplace
// Fee rule. Replaces the raw numeric ID inputs so operators pick by name (no
// manual ID typing — fixes the mobile numeric-keyboard report). All fee MATH stays
// backend-owned; this only edits the rule's scope (numeric clientId/storeId, or
// null for the "Any" catch-all). Pure option logic lives in
// marketplace-fee-scope-options.ts so this stays small.
import {
  buildClientOptions,
  buildStoreOptions,
  parseScopeValue,
  savedClientExtraOption,
  savedStoreExtraOption,
  storeStillValidForClient,
  type ClientLite,
  type StoreLite,
} from './marketplace-fee-scope-options'

export interface ScopePatch {
  clientId?: number | null
  storeId?: number | null
  marketplace?: string | null
}

interface Props {
  clientId?: number | null
  storeId?: number | null
  marketplace?: string | null
  clients: ClientLite[]
  stores: StoreLite[]
  optionsLoading: boolean
  onChange: (patch: ScopePatch) => void
}

const SELECT =
  'h-7 px-2 rounded ring-1 ring-line bg-surface text-[12px] text-ink focus:ring-brand/40 focus:ring-2 outline-none transition min-w-0 max-w-[180px]'
const TEXT =
  'h-7 px-2 rounded ring-1 ring-line bg-surface text-[12px] text-ink focus:ring-brand/40 focus:ring-2 outline-none transition w-[120px] min-w-0'

export function MarketplaceFeeScopeSelectors({
  clientId,
  storeId,
  marketplace,
  clients,
  stores,
  optionsLoading,
  onChange,
}: Props) {
  const selectedClientId = clientId ?? null
  const clientOptions = buildClientOptions(clients)
  const storeOptions = buildStoreOptions(stores, selectedClientId)
  const clientExtra = savedClientExtraOption(clientId, clients)
  const storeExtra = savedStoreExtraOption(storeId, stores, selectedClientId)

  function handleClient(value: string) {
    const nextClientId = parseScopeValue(value)
    const patch: ScopePatch = { clientId: nextClientId }
    // Never silently save an impossible client/store pair: drop a now-incompatible store.
    if (!storeStillValidForClient(storeId, nextClientId, stores)) patch.storeId = null
    onChange(patch)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <label className="text-[11px] text-ink-3">Client</label>
      <select
        className={SELECT}
        value={clientId ?? ''}
        onChange={(e) => handleClient(e.target.value)}
        aria-label="Client"
      >
        <option value="">Any client</option>
        {clientExtra ? <option value={clientExtra.id}>{clientExtra.label}</option> : null}
        {clientOptions.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>

      <label className="text-[11px] text-ink-3">Store</label>
      <select
        className={SELECT}
        value={storeId ?? ''}
        onChange={(e) => onChange({ storeId: parseScopeValue(e.target.value) })}
        aria-label="Store"
      >
        <option value="">Any store</option>
        {storeExtra ? <option value={storeExtra.id}>{storeExtra.label}</option> : null}
        {storeOptions.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>

      <label className="text-[11px] text-ink-3">Marketplace</label>
      <input
        className={TEXT}
        type="text"
        placeholder="any (amazon…)"
        value={marketplace ?? ''}
        onChange={(e) => onChange({ marketplace: e.target.value.trim() || null })}
        aria-label="Marketplace"
      />

      {optionsLoading ? <span className="text-[10.5px] text-ink-3 italic">loading…</span> : null}
    </div>
  )
}
