// PS-242: pure option logic for the Marketplace Fee Client/Store selectors.
// No React, no fee math — just builds the dropdown options from the canonical
// client/store lists and preserves unknown/stale saved IDs. Kept separate so the
// selector component stays small and this logic is unit-testable (the ps-242 guard
// imports + executes these directly). The persisted rule shape is unchanged:
// numeric clientId/storeId, or null for the "Any" catch-all.

export interface ClientLite {
  clientId: number;
  name: string;
}

export interface StoreLite {
  storeId: number;
  clientId: number | null;
  storeName: string;
}

export interface ScopeOption {
  id: number;
  label: string;
}

function numOrNullFrom(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Map the loose fetchClients() rows to the minimal client shape the selectors need. */
export function toClientLites(rows: unknown[]): ClientLite[] {
  const out: ClientLite[] = []
  for (const raw of rows ?? []) {
    const r = raw as Record<string, unknown>
    const id = numOrNullFrom(r?.clientId ?? r?.id)
    if (id == null) continue
    out.push({ clientId: id, name: String(r?.name ?? '') })
  }
  return out
}

/** Map the loose fetchStores() rows to the minimal store shape the selectors need. */
export function toStoreLites(rows: unknown[]): StoreLite[] {
  const out: StoreLite[] = []
  for (const raw of rows ?? []) {
    const r = raw as Record<string, unknown>
    const id = numOrNullFrom(r?.storeId)
    if (id == null) continue
    out.push({ storeId: id, clientId: numOrNullFrom(r?.clientId), storeName: String(r?.storeName ?? '') })
  }
  return out
}

/** "KF Goods — Client ID 11" */
export function clientOptionLabel(name: string, id: number): string {
  const safe = (name ?? '').trim() || `Client ${id}`;
  return `${safe} — Client ID ${id}`;
}

/** "Walmart - DJC — Store ID 376661" */
export function storeOptionLabel(name: string, id: number): string {
  const safe = (name ?? '').trim() || `Store ${id}`;
  return `${safe} — Store ID ${id}`;
}

/** Parse a <select> value back to the persisted scope value: '' → null (catch-all). */
export function parseScopeValue(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Client options, de-duped + alpha-sorted. */
export function buildClientOptions(clients: ClientLite[]): ScopeOption[] {
  const seen = new Set<number>();
  const out: ScopeOption[] = [];
  for (const c of clients) {
    if (!Number.isFinite(c?.clientId) || seen.has(c.clientId)) continue;
    seen.add(c.clientId);
    out.push({ id: c.clientId, label: clientOptionLabel(c.name, c.clientId) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Store options for the picker. When a client is selected, only that client's
 * stores are offered (so an incompatible cross-client pair can't be picked);
 * with no client selected, every store is offered.
 */
export function buildStoreOptions(stores: StoreLite[], selectedClientId: number | null): ScopeOption[] {
  const seen = new Set<number>();
  const out: ScopeOption[] = [];
  for (const s of stores) {
    if (!Number.isFinite(s?.storeId) || seen.has(s.storeId)) continue;
    if (selectedClientId != null && s.clientId !== selectedClientId) continue;
    seen.add(s.storeId);
    out.push({ id: s.storeId, label: storeOptionLabel(s.storeName, s.storeId) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * If a saved clientId isn't in the known list, return a preserved "Unknown
 * client — ID ####" option so the value is never silently dropped. null = nothing extra.
 */
export function savedClientExtraOption(clientId: number | null | undefined, clients: ClientLite[]): ScopeOption | null {
  if (clientId == null) return null;
  if (buildClientOptions(clients).some((o) => o.id === clientId)) return null;
  return { id: clientId, label: `Unknown client — ID ${clientId}` };
}

/**
 * If a saved storeId isn't in the CLIENT-FILTERED option set, return a preserved
 * extra option: "Unknown store — ID ####" when truly unknown, or
 * "<name> — Store ID #### (other client)" when it belongs to a different client
 * (so the operator can SEE the mismatch rather than have it vanish).
 */
export function savedStoreExtraOption(
  storeId: number | null | undefined,
  stores: StoreLite[],
  selectedClientId: number | null,
): ScopeOption | null {
  if (storeId == null) return null;
  if (buildStoreOptions(stores, selectedClientId).some((o) => o.id === storeId)) return null;
  const known = stores.find((s) => s.storeId === storeId);
  if (!known) return { id: storeId, label: `Unknown store — ID ${storeId}` };
  return { id: storeId, label: `${storeOptionLabel(known.storeName, storeId)} (other client)` };
}

/**
 * After the client changes, is the current store still valid for it? A known
 * store from a different client is invalid (caller clears it so an impossible
 * pair is never saved). Catch-all store / catch-all client / unknown store = kept.
 */
export function storeStillValidForClient(
  storeId: number | null | undefined,
  newClientId: number | null,
  stores: StoreLite[],
): boolean {
  if (storeId == null || newClientId == null) return true;
  const known = stores.find((s) => s.storeId === storeId);
  if (!known) return true;
  return known.clientId === newClientId;
}
