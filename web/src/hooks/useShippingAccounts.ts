import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  SHARED_DATA_STALE_MS,
  SHARED_DATA_CACHE_MS,
  type SharedDataHookOptions,
  toProviderAccountId,
} from './v2Hooks-shared';

// ──────────────────────────────────────────────────────────────────
// useShippingAccounts — v4 returns ShipStation's `{carriers: [...]}`;
// adapt each carrier to v2's CarrierAccountDto shape.
// ──────────────────────────────────────────────────────────────────

export interface CarrierAccountDto {
  carrierId: string;
  carrierCode: string;
  shippingProviderId: number;
  nickname: string;
  clientId: number | null;
  code: string;
  _label: string;
  sourceClientName?: string;
}

export interface UseShippingAccountsResult {
  accounts: CarrierAccountDto[];
  isLoading: boolean;
  error: Error | null;
}

type V4Carrier = {
  carrier_id: string;
  carrier_code: string;
  nickname?: string;
  friendly_name?: string;
  source_client_name?: string;
  source_client_id?: number | null;
};

type V4CarriersResponse = { carriers: V4Carrier[] };

// Direct carrier accounts from /carrier-accounts (Walmart, etc.). The
// /rates/multi endpoint only enumerates ShipStation carriers, so we
// fetch this in parallel and merge — keeps the Rate Browser sidebar in
// sync with what's connected in Settings without a backend deploy.
type V4DirectCarrierRow = {
  id: number;
  clientId?: number | null;
  provider: string;
  label?: string | null;
  accountIdentifier?: string | null;
  active?: boolean;
};
type V4DirectCarriersResponse = { data?: V4DirectCarrierRow[] };

// Shift direct-carrier ids well above the ShipStation 6-digit range so
// the synthetic numeric shippingProviderId can't collide with real ones.
const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;

// Marketplace order sources, NOT shipping carriers — they should never
// surface in the Rate Browser sidebar regardless of being saved in the
// carrier_accounts table. Mirrors STORE_PROVIDERS in the Settings card
// (kept in sync manually since they live in different files; if you add
// a store here, also add it there).
const STORE_PROVIDER_KEYS = new Set<string>([
  'walmart',
  'amazon',
  'ebay',
  'shopify',
  'etsy',
  'tiktok_shop',
  'woocommerce',
  'bigcommerce',
]);

// PS-200 S1: the direct-carrier list comes from the v4 backend. The old
// rationale for staying on the Vercel function ("Render's code lives in a
// separate repo and may not match") inverted — THIS repo is the Render
// deploy, and the route delegates to the same credential-accounts service
// the Vercel function used.
async function fetchDirectCarrierAccounts(): Promise<V4DirectCarriersResponse> {
  try {
    const json = await api.get<V4DirectCarriersResponse>('/carrier-accounts?source=admin');
    // eslint-disable-next-line no-console
    console.debug('[useShippingAccounts] direct carriers:', json?.data?.length ?? 0);
    return json;
  } catch (err) {
    // Surface in console too — the merged hook (useShippingAccounts below)
    // intentionally swallows this error when ShipStation succeeds, so a
    // failure here is invisible in the UI. That makes "my direct UPS isn't
    // in the Rate Browser sidebar" near-impossible to diagnose without
    // poking at Network. Console warn is the cheapest fix.
    // eslint-disable-next-line no-console
    console.warn(
      '[useShippingAccounts] direct carrier list failed:',
      err instanceof Error ? err.message : err
    );
    throw err;
  }
}

export function useShippingAccounts(options: SharedDataHookOptions = {}): UseShippingAccountsResult {
  const enabled = options.enabled ?? true;
  const query = useQuery<V4CarriersResponse>({
    queryKey: ['v2-hooks:carriers'],
    queryFn: () => api.get<V4CarriersResponse>('/rates/multi'),
    enabled,
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  });

  const directQuery = useQuery<V4DirectCarriersResponse>({
    queryKey: ['v2-hooks:carrier-accounts'],
    queryFn: fetchDirectCarrierAccounts,
    enabled,
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  });

  // SettingsView keys rows by `shippingProviderId` — must be unique per account.
  // ShipStation carrier ids are `se-433542`; v2 uses the numeric provider id.
  const accounts = useMemo<CarrierAccountDto[]>(
    () => {
      const ssAccounts: CarrierAccountDto[] = (query.data?.carriers ?? []).map((c, i) => ({
        carrierId: c.carrier_id,
        carrierCode: c.carrier_code,
        shippingProviderId: toProviderAccountId(c.carrier_id) ?? i + 1,
        nickname: c.nickname ?? c.friendly_name ?? c.carrier_code,
        clientId: c.source_client_id ?? null,
        code: c.carrier_code,
        _label: c.friendly_name ?? c.nickname ?? c.carrier_code,
        sourceClientName: c.source_client_name,
      }));
      const directAccounts: CarrierAccountDto[] = (directQuery.data?.data ?? [])
        .filter((row) => row && row.active !== false && row.provider)
        // Exclude marketplace stores — they're order sources, not carriers.
        .filter((row) => !STORE_PROVIDER_KEYS.has(row.provider))
        .map((row) => {
          const friendly = row.label || row.provider;
          const synthId = `se-${DIRECT_CARRIER_PROVIDER_ID_OFFSET + row.id}`;
          return {
            carrierId: synthId,
            carrierCode: row.provider,
            shippingProviderId: DIRECT_CARRIER_PROVIDER_ID_OFFSET + row.id,
            nickname: friendly,
            clientId: row.clientId ?? null,
            code: row.provider,
            _label: friendly,
            sourceClientName: 'Direct carrier accounts',
          };
        });
      return [...ssAccounts, ...directAccounts];
    },
    [query.data, directQuery.data]
  );

  // Only treat the hook as errored when BOTH sources failed. ShipStation
  // (via Render /rates/multi) and direct carriers (via v4
  // /carrier-accounts) are independent — losing one shouldn't make
  // the Settings UI look broken when the other is healthy. Common case
  // for this: Render's JWT or ShipStation config drifts and /rates/multi
  // returns 401, while direct UPS / FedEx / USPS continue working.
  const ssQueryError = (query.error as Error | null) ?? null;
  const directQueryError = (directQuery.error as Error | null) ?? null;
  const mergedError = ssQueryError && directQueryError
    ? ssQueryError
    : null;

  return {
    accounts,
    isLoading: enabled && (query.isLoading || directQuery.isLoading),
    error: mergedError,
  };
}
