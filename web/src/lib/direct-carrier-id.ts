// PS-286 (slice): the PURE synthetic-provider-id classification, extracted from
// web/src/lib/v2-apiClient/shared.ts so it can be imported WITHOUT dragging in the
// network-client barrel (api-base / import.meta.env). A direct-carrier saved rate
// stores a synthetic provider id (DIRECT_CARRIER_PROVIDER_ID_OFFSET + carrier_accounts.id);
// a direct STORE/marketplace account uses the 20M offset. shared.ts re-exports these,
// so there is still ONE source of truth for the offsets and the predicate.

export const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
export const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;

export type DirectAccountRef = {
  accountId: number;
  sourceTable: 'carrier_accounts' | 'store_accounts';
};

// Pure provider-id reader (mirrors the se-<n> / numeric / string handling used at
// the proof boundary) — no network, no env.
export function toDirectProviderId(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function directAccountRefFromProviderId(providerId: number | null): DirectAccountRef | null {
  if (providerId == null) return null;
  if (providerId >= DIRECT_STORE_PROVIDER_ID_OFFSET) {
    const accountId = providerId - DIRECT_STORE_PROVIDER_ID_OFFSET;
    return Number.isFinite(accountId) && accountId > 0
      ? { accountId, sourceTable: 'store_accounts' }
      : null;
  }
  if (providerId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET) {
    const accountId = providerId - DIRECT_CARRIER_PROVIDER_ID_OFFSET;
    return Number.isFinite(accountId) && accountId > 0
      ? { accountId, sourceTable: 'carrier_accounts' }
      : null;
  }
  return null;
}

export function isDirectCarrierId(value: unknown): boolean {
  return directAccountRefFromProviderId(toDirectProviderId(value)) != null;
}
