// Shared React Query timing constants for the v2 hook shims.
//
// Extracted verbatim from v2Hooks.ts (PS-157) so per-domain hook modules
// (e.g. usePackages.ts) can split out of the v2Hooks barrel without
// duplicating these values. v2Hooks.ts re-imports them, keeping a single
// source of truth. Values are byte-for-byte identical to the originals.

export const ORDERS_STALE_MS = 30_000;
export const ORDERS_CACHE_MS = 10 * 60_000;
export const SHARED_DATA_STALE_MS = 5 * 60_000;
export const SHARED_DATA_CACHE_MS = 30 * 60_000;

// ──────────────────────────────────────────────────────────────────
// Shared DTOs / helpers / types used by MORE THAN ONE per-domain hook
// module (PS-157). Extracted verbatim from v2Hooks.ts so the per-domain
// files can split out without cross-importing each other (which would
// risk circular imports). v2Hooks.ts re-exports the public ones so
// external `from '../hooks/v2Hooks'` imports stay byte-unchanged.
// ──────────────────────────────────────────────────────────────────

// Loose DTOs — property access flows as `any`.
// OrderSummaryDto is produced by useOrders; OrderFullDto by useOrderDetail.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrderSummaryDto = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrderFullDto = any;

// Used by both useLocations and useShippingAccounts (the "support data"
// hooks that OrdersView lazily enables via { enabled }).
export type SharedDataHookOptions = {
  enabled?: boolean;
};

// Used by useOrders (transform helpers) and useShippingAccounts (account
// mapping). Lives in shared so neither hook file imports the other.
export function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Shared by useClients, useAllClients, and useInventory (clientName lookup).
export type V4ClientFullRow = {
  id: number;
  name: string;
  storeIds: number[] | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  hasShipStationV1Credentials?: boolean;
  hasShipStationV2Credentials?: boolean;
  rateSourceClientId: number | null;
  active: boolean;
};

export interface ClientDto {
  clientId: number;
  name: string;
  storeIds: number[];
  contactName: string;
  email: string;
  phone: string;
  active: boolean;
  hasOwnAccount: boolean;
  rateSourceClientId: number | null;
  rateSourceName: string;
}

export interface UseClientsResult {
  clients: ClientDto[];
  isLoading: boolean;
  error: Error | null;
}

// Shared by useClients and useAllClients (identical transform; the only
// difference between those hooks is the activeOnly vs includeInactive query).
export function transformClientRowV4toV2(
  row: V4ClientFullRow,
  namesById: Map<number, string>
): ClientDto {
  const rateSourceId = row.rateSourceClientId ?? null;
  return {
    clientId: row.id,
    name: row.name,
    storeIds: row.storeIds ?? [],
    contactName: row.contactName ?? '',
    email: row.email ?? '',
    phone: row.phone ?? '',
    active: row.active,
    hasOwnAccount: Boolean(
      row.hasShipStationV1Credentials ||
        row.hasShipStationV2Credentials
    ),
    rateSourceClientId: rateSourceId,
    rateSourceName:
      rateSourceId != null ? namesById.get(rateSourceId) ?? '' : '',
  };
}
