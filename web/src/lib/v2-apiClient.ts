/**
 * v2 apiClient adapter → v4 api (barrel).
 *
 * PS-167 (safe-partial): the helper/type/singleton leaf layer was extracted
 * verbatim into ./v2-apiClient/shared.ts. This barrel keeps the full apiClient
 * method surface + the public `apiClient` export, and re-exports every shared
 * leaf symbol (`export *`) so existing imports from this path are unchanged.
 * See the original module JSDoc in ./v2-apiClient/shared.ts.
 */

import { ApiRequestError, api, qs } from './api';
import { API_BASE } from './api-base';
// PS-325 (slice 4): the additive analytics provenance envelope, shared backend+frontend.
import type { DashboardProvenance } from '../../../src/lib/analytics-provenance';
import { getCachedAuthToken } from './auth-session-cache';
import { buildManifestCsv, manifestRowsFromResponse } from '../components/Views/manifests-parity';
import { directCarrierVisibleForScope } from '../../../src/lib/direct-carrier-scope';

import {
  authHeaders,
  parseDownloadFilename,
  HIDDEN_CLIENT_NAMES,
  STALE_MOCK_LABEL_HOSTS,
  DIRECT_CARRIER_PROVIDER_ID_OFFSET,
  DIRECT_STORE_PROVIDER_ID_OFFSET,
  STORE_PROVIDER_KEYS,
  SYNTHETIC_STORE_ID_OFFSETS,
  DIRECT_ACCOUNT_PROVIDER_LABELS,
  HIDDEN_CLIENT_IDS,
  TEST_CLIENT_IDS,
  isHiddenClient,
  normalizeSyntheticTestStoreQuery,
  isMockLabelPath,
  normalizeMockLabelUrl,
  normalizeLabelResponse,
  parseFiniteNumber,
  normalizePackageDto,
  normalizePackageResponse,
  normalizePackageMutationPayload,
  normalizePackageReceivePayload,
  normalizePackageAdjustPayload,
  normalizePackageLedgerEntry,
  normalizePackageMovementResponse,
  normalizeProductDefaultsPayload,
  inventoryStatus,
  normalizeInventoryDto,
  filterRowsToActiveClients,
  normalizeClientDtoRows,
  normalizeClientMutationPayload,
  toIsoDayStart,
  toIsoDayEnd,
  normalizeAnalysisRange,
  safe,
  WARN_THROTTLE_MS,
  warnLastSeen,
  warnThrottled,
  CachedRead,
  cachedReads,
  CachedSafeOptions,
  clearCachedReads,
  cachedSafe,
  notImpl,
  translateRatePayloadToV4,
  toProviderAccountId,
  normalizeCarrierAccountDto,
  DirectCarrierAccountRow,
  DirectCarrierRateError,
  normalizeProviderKey,
  isStoreProvider,
  normalizeClientIdList,
  DirectAccountRef,
  directProviderIdFromAccount,
  directAccountRefFromProviderId,
  isDirectCarrierId,
  LabelEndpointRoute,
  classifyLabelEndpoint,
  directAccountKey,
  looksLikeOpaqueAccountIdentifier,
  storeAccountMatchesOrder,
  directCarrierAccountVisibleForOrder,
  normalizeDirectCarrierAccountDto,
  fetchDirectCarrierAccountRows,
  rateBrowseInflight,
  translateRateToLegacyDisplayShape,
  fetchBlob,
  DailyStatsSummary,
  SettingsRow,
  OrderDimsRow,
} from './v2-apiClient/shared';
// Re-export the shared leaf symbols so external imports from this path keep resolving
// (HIDDEN_CLIENT_IDS, TEST_CLIENT_IDS, isDirectCarrierId, DirectCarrierRateError, …).
export * from './v2-apiClient/shared';

// PS-167: stableRateBrowseKey + parseDailyStatsSummary are kept in the barrel (not moved to
// ./v2-apiClient/shared) because text-blob guards grep THIS file for strings unique to their
// bodies — recalculate-best-rate-strict reads 'insuranceProvider'/'insuredValue'; daily-strip-progress
// reads /rootDto.summary/. Moving them silently breaks those guards. Pinned by
// scripts/ps-167-apiclient-shared-extraction-guard.ts (test:ps-167-apiclient-shared-extraction).
function stableRateBrowseKey(body: Record<string, unknown>): string {
  const keys = [
    'weightOz',
    'toZip',
    'toCountry',
    'toState',
    'toCity',
    'residential',
    'dimsL',
    'dimsW',
    'dimsH',
    'storeId',
    'clientId',
    'confirmation',
    'carrierIds',
    'preferredCarrierId',
    'insuranceProvider',
    'insuredValue',
    'forceRefresh',
    'forceLive',
    'cachedOnly',
    'orderId',
    'externalOrderId',
    'orderNumber',
  ];
  const keyed: Record<string, unknown> = {};
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === '') continue;
    keyed[key] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return JSON.stringify(keyed);
}

function parseDailyStatsSummary(value: unknown): DailyStatsSummary {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid daily stats response');
  }

  const rootDto = value as Record<string, unknown>;
  const summary = rootDto.summary;
  const dto = summary != null && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : rootDto;
  const window = dto.window;
  if (window == null || typeof window !== 'object' || Array.isArray(window)) {
    throw new Error('invalid daily stats window');
  }

  const windowDto = window as Record<string, unknown>;
  const from = windowDto.from;
  const to = windowDto.to;
  const fromLabel = windowDto.fromLabel;
  const toLabel = windowDto.toLabel;
  const totalOrders = dto.totalOrders;
  const needToShip = dto.needToShip;
  const upcomingOrders = dto.upcomingOrders;

  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof fromLabel !== 'string' ||
    typeof toLabel !== 'string' ||
    typeof totalOrders !== 'number' ||
    typeof needToShip !== 'number' ||
    typeof upcomingOrders !== 'number' ||
    !Number.isFinite(totalOrders) ||
    !Number.isFinite(needToShip) ||
    !Number.isFinite(upcomingOrders)
  ) {
    throw new Error('invalid daily stats fields');
  }

  return {
    window: { from, to, fromLabel, toLabel },
    totalOrders,
    needToShip,
    upcomingOrders,
  };
}

async function postRateBrowseTransport(data: Record<string, unknown>): Promise<any> {
  const body = translateRatePayloadToV4(data);
  const requestedCarrierIds = Array.isArray(body.carrierIds)
    ? body.carrierIds.map((value) => String(value)).filter(Boolean)
    : [];
  const preferredCarrierId =
    typeof body.preferredCarrierId === 'string'
      ? body.preferredCarrierId
      : requestedCarrierIds[0];
  const requestKey = stableRateBrowseKey({
    ...body,
    carrierIds: requestedCarrierIds,
    preferredCarrierId,
  });
  const existing = rateBrowseInflight.get(requestKey);
  if (existing) return existing;

  const inFlight = api.post<any>('/rates/browse', {
    ...body,
    ...(requestedCarrierIds.length ? { carrierIds: requestedCarrierIds } : {}),
    ...(preferredCarrierId ? { preferredCarrierId } : {}),
  });
  rateBrowseInflight.set(requestKey, inFlight);
  try {
    return await inFlight;
  } finally {
    rateBrowseInflight.delete(requestKey);
  }
}

function toLegacyRateArray(backendResult: any): any[] {
  const rows = (Array.isArray(backendResult?.rates) ? backendResult.rates : [])
    .map((rate: unknown) => translateRateToLegacyDisplayShape(rate));
  Object.defineProperty(rows, 'carrierDiagnostics', {
    value: Array.isArray(backendResult?.carrierDiagnostics) ? backendResult.carrierDiagnostics : [],
    enumerable: false,
  });
  Object.defineProperty(rows, 'directCarrierDiagnostics', {
    value: Array.isArray(backendResult?.directCarrierDiagnostics) ? backendResult.directCarrierDiagnostics : [],
    enumerable: false,
  });
  Object.defineProperty(rows, 'directCarrierErrors', {
    value: Array.isArray(backendResult?.directCarrierErrors) ? backendResult.directCarrierErrors : [],
    enumerable: false,
  });
  Object.defineProperty(rows, 'directCarrierMetas', {
    value: Array.isArray(backendResult?.directCarrierMetas) ? backendResult.directCarrierMetas : [],
    enumerable: false,
  });
  return rows;
}

function billingClientFilterParams(clientFilter?: number | number[]) {
  if (Array.isArray(clientFilter)) {
    const ids = [...new Set(clientFilter)]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length === 1) return { clientId: ids[0] };
    if (ids.length > 1) return { clientIds: ids.join(',') };
    return {};
  }
  const clientId = Number(clientFilter);
  return Number.isInteger(clientId) && clientId > 0 ? { clientId } : {};
}

export const apiClient = {
  // ─── Auth / token (no-op — v4 uses Supabase) ────────────────────────────────

  // ─── Init / bootstrap ───────────────────────────────────────────────────────
  fetchCounts(filter?: { dateStart?: string; dateEnd?: string }): Promise<any> {
    // v2 sidebar parity: counts are grouped by real ShipStation storeId.
    // /init/counts returns the legacy { byStatus, byStatusStore } shape.
    const hasDate = Boolean(filter?.dateStart || filter?.dateEnd);
    const dateFrom = toIsoDayStart(filter?.dateStart);
    const dateTo = toIsoDayEnd(filter?.dateEnd);
    return cachedSafe(
      'fetchCounts',
      `fetchCounts:${dateFrom ?? ''}:${dateTo ?? ''}`,
      120_000,
      15 * 60_000,
      async () => {
        if (hasDate) {
          const legacyCounts = await api.get<any>(`/init/counts${qs({ dateFrom, dateTo })}`, {
            timeoutMs: 25_000,
          });
          return {
            byStatus: Array.isArray(legacyCounts?.byStatus)
              ? legacyCounts.byStatus
              : [
                  { orderStatus: 'awaiting_shipment', cnt: legacyCounts?.awaiting ?? 0 },
                  { orderStatus: 'shipped', cnt: legacyCounts?.shipped ?? 0 },
                  { orderStatus: 'cancelled', cnt: legacyCounts?.cancelled ?? 0 },
                ],
            byStatusStore: Array.isArray(legacyCounts?.byStatusStore)
              ? legacyCounts.byStatusStore
              : [],
          };
        }

        const legacyCounts = await api.get<any>('/init/counts', { timeoutMs: 25_000 });
        return {
          byStatus: Array.isArray(legacyCounts?.byStatus)
            ? legacyCounts.byStatus
            : [
                { orderStatus: 'awaiting_shipment', cnt: legacyCounts?.awaiting ?? 0 },
                { orderStatus: 'shipped', cnt: legacyCounts?.shipped ?? 0 },
                { orderStatus: 'cancelled', cnt: legacyCounts?.cancelled ?? 0 },
              ],
          byStatusStore: Array.isArray(legacyCounts?.byStatusStore)
            ? legacyCounts.byStatusStore
            : [],
        };

        // Fetch clients alongside stats so we can resolve hidden-client IDs by
        // name even if fetchStores hasn't populated HIDDEN_CLIENT_IDS yet.
        const [counts, clientStatsRes, clientsRes] = await Promise.all([
          hasDate
            ? // Probe the list endpoint per status; total comes from pagination.
              Promise.all([
                api
                  .get<any>(
                    `/orders${qs({ status: 'awaiting_shipment', pageSize: 1, dateFrom, dateTo })}`
                  )
                  .catch(() => null),
                api
                  .get<any>(
                    `/orders${qs({ status: 'shipped', pageSize: 1, dateFrom, dateTo })}`
                  )
                  .catch(() => null),
                api
                  .get<any>(
                    `/orders${qs({ status: 'cancelled', pageSize: 1, dateFrom, dateTo })}`
                  )
                  .catch(() => null),
              ]).then(([a, s, x]) => ({
                awaiting: a?.pagination?.total ?? 0,
                shipped: s?.pagination?.total ?? 0,
                cancelled: x?.pagination?.total ?? 0,
              }))
            : api.get<any>('/init/counts'),
          api
            .get<any>(`/clients/order-stats${qs({ dateFrom, dateTo })}`)
            .catch(() => ({ data: [] })),
          api.get<any>('/clients?includeInactive=true').catch(() => []),
        ]);

        const clientsArr = Array.isArray(clientsRes) ? clientsRes : [];
        for (const c of clientsArr) isHiddenClient(c); // populates HIDDEN_CLIENT_IDS by side-effect

        // /clients/order-stats returns { data: [...] } (envelope), not a raw array
        const statsArr = Array.isArray(clientStatsRes)
          ? clientStatsRes
          : Array.isArray(clientStatsRes?.data)
            ? clientStatsRes.data
            : [];
        const byStatusStore: { orderStatus: string; storeId: number; cnt: number }[] = [];
        // Totals derived from the VISIBLE per-client rows so the top-level badge
        // equals the sum of its children. /init/counts would include hidden
        // clients (e.g. "Api Shipments"), leaving the header > sum(rows).
        let awaitingTotal = 0;
        let shippedTotal = 0;
        let cancelledTotal = 0;
        for (const row of statsArr) {
          const cid = row?.clientId ?? row?.client_id;
          if (cid == null) continue;
          // Test clients flow THROUGH so they appear in the sidebar (pinned
          // to the bottom by the sort in sidebar-data.ts). Only truly-hidden
          // clients (e.g. api shipments) are dropped from the list.
          const isTestRow = TEST_CLIENT_IDS.has(cid);
          if (HIDDEN_CLIENT_IDS.has(cid) && !isTestRow) continue;
          const a = row?.awaiting ?? 0;
          const s = row?.shipped ?? 0;
          const x = row?.cancelled ?? 0;
          if (a > 0) byStatusStore.push({ orderStatus: 'awaiting_shipment', storeId: cid, cnt: a });
          if (s > 0) byStatusStore.push({ orderStatus: 'shipped', storeId: cid, cnt: s });
          if (x > 0) byStatusStore.push({ orderStatus: 'cancelled', storeId: cid, cnt: x });
          // Exclude test clients from the rolled-up status badges so
          // "Awaiting Shipment · 23" stays a real-work number.
          awaitingTotal += a;
          shippedTotal += s;
          cancelledTotal += x;
        }

        // Orders with clientId=null (unassigned) aren't in /clients/order-stats
        // but ARE in /init/counts. Add the difference back in as "Unassigned"
        // rollups so the top badge stays an honest global count without needing
        // a store row.
        const globalAwaiting = counts?.awaiting ?? 0;
        const globalShipped = counts?.shipped ?? 0;
        const globalCancelled = counts?.cancelled ?? 0;
        const hiddenAwaiting = statsArr
          .filter((r: any) => HIDDEN_CLIENT_IDS.has(r?.clientId ?? r?.client_id))
          .reduce((a: number, r: any) => a + (r?.awaiting ?? 0), 0);
        const hiddenShipped = statsArr
          .filter((r: any) => HIDDEN_CLIENT_IDS.has(r?.clientId ?? r?.client_id))
          .reduce((a: number, r: any) => a + (r?.shipped ?? 0), 0);
        const hiddenCancelled = statsArr
          .filter((r: any) => HIDDEN_CLIENT_IDS.has(r?.clientId ?? r?.client_id))
          .reduce((a: number, r: any) => a + (r?.cancelled ?? 0), 0);
        const unassignedAwaiting = Math.max(0, globalAwaiting - awaitingTotal - hiddenAwaiting);
        const unassignedShipped = Math.max(0, globalShipped - shippedTotal - hiddenShipped);
        const unassignedCancelled = Math.max(0, globalCancelled - cancelledTotal - hiddenCancelled);
        awaitingTotal += unassignedAwaiting;
        shippedTotal += unassignedShipped;
        cancelledTotal += unassignedCancelled;

        const byStatus = [
          { orderStatus: 'awaiting_shipment', cnt: awaitingTotal },
          { orderStatus: 'shipped', cnt: shippedTotal },
          { orderStatus: 'cancelled', cnt: cancelledTotal },
        ];

        return { byStatus, byStatusStore };
      },
      { byStatus: [], byStatusStore: [] },
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 15 * 60_000, throwOnError: true }
    );
  },

  fetchStores(): Promise<any[]> {
    // v2 sidebar parity: return one row per ShipStation storeId, named from
    // the owning client.
    return cachedSafe(
      'fetchStores',
      'fetchStores',
      60_000,
      10 * 60_000,
      async () => {
        const [storesRes, clientRowsRes] = await Promise.all([
          api.get<any>('/init/stores', { timeoutMs: 25_000 }).catch(() => ({ data: [] })),
          api.get<any>('/clients?includeInactive=true', { timeoutMs: 25_000 }).catch(() => []),
        ]);
        const clientRows = Array.isArray(clientRowsRes) ? clientRowsRes : [];
        const clientsById = new Map<number, any>();
        for (const client of clientRows) {
          if (typeof client?.id === 'number') clientsById.set(client.id, client);
          isHiddenClient(client);
        }
        const storesArr = Array.isArray(storesRes?.data)
          ? storesRes.data
          : Array.isArray(storesRes)
            ? storesRes
            : [];
        return storesArr
          .filter((store: any) => !HIDDEN_CLIENT_IDS.has(store?.clientId))
          .map((store: any) => {
            const client = clientsById.get(store?.clientId);
            return {
              storeId: store?.storeId,
              clientId: store?.clientId,
              storeName: store?.clientName ?? client?.name ?? `Store ${store?.storeId}`,
              active: store?.active ?? true,
              isTest: client?.isTest === true,
            };
          })
          .filter((store: any) => Number.isFinite(store.storeId));

        const clients = await api.get<any>('/clients?includeInactive=true');
        const arr = Array.isArray(clients) ? clients : [];
        // Call isHiddenClient on every client first so HIDDEN_CLIENT_IDS +
        // TEST_CLIENT_IDS get populated as a side-effect (downstream filters
        // rely on those sets). Then keep test clients in the returned list
        // so the sidebar can render them; drop only non-test hidden clients.
        return arr
          .filter((c: any) => {
            const hidden = isHiddenClient(c);
            return c?.isTest === true || !hidden;
          })
          .map((c: any) => ({
            storeId: c?.id,
            clientId: c?.id,
            storeName: c?.name ?? `Client ${c?.id}`,
            active: true,
            isTest: c?.isTest === true,
          }));
      },
      []
    );
  },


  // ─── Clients ────────────────────────────────────────────────────────────────
  fetchClients(): Promise<any[]> {
    return cachedSafe(
      'fetchClients',
      'fetchClients',
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(`/clients${qs({ activeOnly: true })}`, { timeoutMs: 25_000 });
        return normalizeClientDtoRows(Array.isArray(res) ? res : []);
      },
      [],
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  listClients(): Promise<any[]> {
    return apiClient.fetchClients();
  },


  createClient(data: Record<string, unknown>): Promise<any> {
    return api.post<any>('/clients', normalizeClientMutationPayload(data)).then((res) => {
      clearCachedReads('fetchClients', 'fetchStores', 'fetchCounts');
      return res;
    });
  },

  createClientRecord(data: Record<string, unknown>): Promise<any> {
    return apiClient.createClient(data);
  },

  updateClient(clientId: number, data: Record<string, unknown>): Promise<any> {
    return api.patch<any>(`/clients/${clientId}`, normalizeClientMutationPayload(data)).then((res) => {
      clearCachedReads('fetchClients', 'fetchStores', 'fetchCounts');
      return res;
    });
  },

  updateClientRecord(clientId: number, data: Record<string, unknown>): Promise<any> {
    return apiClient.updateClient(clientId, data);
  },

  deleteClientRecord(clientId: number): Promise<any> {
    return safe(
      'deleteClientRecord',
      async () => {
        const res = await api.delete<any>(`/clients/${clientId}`);
        clearCachedReads('fetchClients', 'fetchStores', 'fetchCounts');
        return res;
      },
      { ok: true }
    );
  },

  syncClientsFromStores(): Promise<any> {
    return safe(
      'syncClientsFromStores',
      async () => {
        const res = await api.post<any>('/clients/sync-stores', {});
        clearCachedReads('fetchClients', 'fetchStores', 'fetchCounts');
        return {
          ...res,
          clients: normalizeClientDtoRows(Array.isArray(res?.clients) ? res.clients : []),
        };
      },
      {}
    );
  },

  // ─── Carrier accounts ───────────────────────────────────────────────────────
  fetchCarrierAccounts(): Promise<any[]> {
    return cachedSafe(
      'fetchCarrierAccounts',
      'fetchCarrierAccounts',
      60_000,
      10 * 60_000,
      async () => {
        const res = await api.get<any>('/init/carrier-accounts', { timeoutMs: 25_000 });
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.carriers)) return res.carriers;
        return [];
      },
      []
    );
  },

  // v2 signature: GET /carriers-for-store?storeId=X — returned store-scoped
  // carriers. v4 scopes by client/store credential source so order-specific
  // rate browsing never mixes DRP and KFG ShipStation accounts.
  fetchCarriersForStore(
    storeId?: number | null,
    clientId?: number | null
  ): Promise<{ carriers: any[] }> {
    return safe(
      'fetchCarriersForStore',
      async () => {
        const [res, directRows] = await Promise.all([
          api.get<any>(
            `/rates/carriers-for-store${qs({
              storeId: storeId ?? undefined,
              clientId: clientId ?? undefined,
            })}`
          ),
          fetchDirectCarrierAccountRows().catch((err) => {
            console.warn(
              '[v2-apiClient] fetchCarriersForStore direct accounts failed:',
              err instanceof Error ? err.message : err
            );
            return [] as DirectCarrierAccountRow[];
          }),
        ]);
        const raw = Array.isArray(res?.carriers)
          ? res.carriers
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res)
              ? res
              : [];
        return {
          carriers: [
            ...raw.map(normalizeCarrierAccountDto),
            ...directRows
              .filter((row) => directCarrierAccountVisibleForOrder(row, { storeId, clientId }))
              .map(normalizeDirectCarrierAccountDto),
          ],
        };
      },
      { carriers: [] }
    );
  },

  // ─── Column preferences (settings kv store) ─────────────────────────────────
  fetchColumnPrefs(): Promise<any> {
    return cachedSafe(
      'fetchColumnPrefs',
      'fetchColumnPrefs',
      5 * 60_000,
      30 * 60_000,
      async () => {
        const row = await api.get<SettingsRow>('/settings/orders.columnPrefs', { timeoutMs: 25_000 });
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      },
      null,
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  saveColumnPrefs(prefs: unknown): Promise<any> {
    return safe(
      'saveColumnPrefs',
      async () => {
        const res = await api.put<any>('/settings/orders.columnPrefs', {
          value: JSON.stringify(prefs ?? null),
        });
        clearCachedReads('fetchColumnPrefs');
        return res;
      },
      {}
    );
  },

  // ─── PS-239: marketplace-fee rules (settings kv store) ──────────────────────
  fetchMarketplaceFeeRules(): Promise<any> {
    return safe(
      'fetchMarketplaceFeeRules',
      async () => {
        const row = await api.get<{ value?: string | null }>('/settings/marketplace_fee_rules', { timeoutMs: 25_000 });
        try {
          return JSON.parse(row?.value ?? '');
        } catch {
          return null;
        }
      },
      null,
    );
  },

  saveMarketplaceFeeRules(payload: unknown): Promise<any> {
    return safe(
      'saveMarketplaceFeeRules',
      () => api.put<any>('/settings/marketplace_fee_rules', {
        value: JSON.stringify(payload ?? { version: 1, rules: [] }),
      }),
      {},
    );
  },

  // ─── PS-106: direct-store vs ShipStation carrier-family policy ───────────────
  // Reads/writes the `block_shipstation_for_direct_store` setting via the generic
  // settings endpoints. The backend defaults to (and fails safe to) audit_only.
  fetchCarrierEligibilityPolicy(): Promise<'enforce' | 'audit_only' | 'disabled'> {
    return safe(
      'fetchCarrierEligibilityPolicy',
      async () => {
        const row = await api.get<{ value?: string | null }>('/settings/block_shipstation_for_direct_store', { timeoutMs: 25_000 });
        const v = (row?.value ?? '').trim().toLowerCase();
        return v === 'enforce' || v === 'disabled' ? v : 'audit_only';
      },
      'audit_only' as const,
    );
  },

  saveCarrierEligibilityPolicy(mode: 'enforce' | 'audit_only' | 'disabled'): Promise<any> {
    return safe(
      'saveCarrierEligibilityPolicy',
      () => api.put<any>('/settings/block_shipstation_for_direct_store', { value: mode }),
      {},
    );
  },

  // ─── Sync status ────────────────────────────────────────────────────────────
  fetchLegacySyncStatus(): Promise<any> {
    return cachedSafe(
      'fetchLegacySyncStatus',
      'fetchLegacySyncStatus',
      90_000,
      10 * 60_000,
      () => api.get<any>('/sync/status', { timeoutMs: 25_000 }),
      {},
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 10 * 60_000, throwOnError: true }
    );
  },

  fetchSyncWorkerStatus(): Promise<any> {
    return cachedSafe(
      'fetchSyncWorkerStatus',
      'fetchSyncWorkerStatus',
      90_000,
      10 * 60_000,
      () => api.get<any>('/worker/status', { timeoutMs: 25_000 }),
      { enabled: false },
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 10 * 60_000 }
    );
  },

  triggerLegacySync(mode?: 'incremental' | 'full'): Promise<any> {
    return safe(
      'triggerLegacySync',
      () =>
        api.post<any>(
          '/sync/orders',
          mode === 'full' ? { full: true, fullResync: true } : {}
        ),
      { queued: false, error: 'Failed to queue order sync' }
    );
  },



  clearAndRefetchAllRates(): Promise<any> {
    return safe<any>(
      'clearAndRefetchAllRates',
      async () => {
        const res = await api.post<any>('/rates/cache-clear-and-refetch', {});
        const cleared = Number(res?.cleared ?? 0);
        return {
          ok: true,
          ordersQueued: 0,
          jobId: res?.jobId ?? null,
          message: `Cleared ${cleared} cached rates — best-rate refetch started`,
          cleared: { deleted: cleared },
          queued: null,
        };
      },
      {
        ok: false,
        ordersQueued: 0,
        message: 'Clear & refetch failed',
        cleared: null,
        queued: null,
      }
    );
  },

  // ─── Orders: list / detail / mutations ──────────────────────────────────────
  // v4 route: GET /orders → { data: Order[], pagination: { page, pageSize, total, totalPages } }
  //   query: { page, pageSize, status, clientId, storeId, excludeClientId,
  //            dateFrom (ISO), dateTo (ISO), search }
  // v2 callers expect:
  //   query: { page, pageSize, orderStatus, clientId, storeId, dateStart, dateEnd }
  //   response: { orders: Order[], total, pages, currentPage }
  //   each row keyed by `orderId` (not `id`)
  // This adapter translates both directions so the v2 UI renders.
  fetchOrders(query: Record<string, unknown>): Promise<any> {
    return (async () => {
        const q: Record<string, unknown> = { ...query };
        if (q.orderStatus !== undefined) {
          q.status = q.orderStatus;
          delete q.orderStatus;
        }
        if (q.dateStart !== undefined) {
          const iso = toIsoDayStart(q.dateStart as string | undefined | null);
          if (iso) q.dateFrom = iso;
          delete q.dateStart;
        }
        if (q.dateEnd !== undefined) {
          const iso = toIsoDayEnd(q.dateEnd as string | undefined | null);
          if (iso) q.dateTo = iso;
          delete q.dateEnd;
        }
        if (q.sortBy === 'sku') {
          q.sort = 'sku';
          delete q.sortBy;
        }
        normalizeSyntheticTestStoreQuery(q);
        const res = await api.get<{
          data: Array<Record<string, any>>;
          pagination: { page: number; pageSize: number; total: number; totalPages: number };
        }>(`/orders${qs(q as any)}`);
        const rows = Array.isArray(res?.data) ? res.data : [];
        const orders = rows.map((row) => ({
          ...row,
          orderId: row.orderId ?? row.id,
        }));
        const pagination = res?.pagination ?? { page: 1, pageSize: 0, total: 0, totalPages: 1 };
        return {
          orders,
          total: pagination.total ?? 0,
          pages: pagination.totalPages ?? 1,
          currentPage: pagination.page ?? 1,
        };
    })();
  },

  listOrders(query: Record<string, unknown>): Promise<any> {
    return apiClient.fetchOrders(query);
  },

  async fetchMatchingOrderIds(query: Record<string, unknown>): Promise<{
    ids: number[];
    total: number;
    truncated: boolean;
    selectionLimit: number;
  }> {
    const q: Record<string, unknown> = { ...query, idsOnly: true };
    if (q.orderStatus !== undefined) {
      q.status = q.orderStatus;
      delete q.orderStatus;
    }
    if (q.dateStart !== undefined) {
      const iso = toIsoDayStart(q.dateStart as string | undefined | null);
      if (iso) q.dateFrom = iso;
      delete q.dateStart;
    }
    if (q.dateEnd !== undefined) {
      const iso = toIsoDayEnd(q.dateEnd as string | undefined | null);
      if (iso) q.dateTo = iso;
      delete q.dateEnd;
    }
    if (q.sortBy === 'sku') {
      q.sort = 'sku';
      delete q.sortBy;
    }
    normalizeSyntheticTestStoreQuery(q);
    const res = await api.get<{
      data?: number[];
      ids?: number[];
      total?: number;
      truncated?: boolean;
      selectionLimit?: number;
    }>(`/orders${qs(q as any)}`);
    const rawIds = Array.isArray(res?.ids) ? res.ids : Array.isArray(res?.data) ? res.data : [];
    const ids = rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
    return {
      ids,
      total: Number(res?.total ?? ids.length) || ids.length,
      truncated: res?.truncated === true,
      selectionLimit: Number(res?.selectionLimit ?? q.selectionLimit ?? 5000) || 5000,
    };
  },

  async fetchMatchingOrdersForSelection(query: Record<string, unknown>): Promise<any[]> {
    const baseQuery = { ...query };
    const first = await apiClient.fetchOrders({ ...baseQuery, page: 1, pageSize: 200 });
    const orders = Array.isArray(first?.orders) ? [...first.orders] : [];
    const totalPages = Math.max(1, Number(first?.pages ?? 1) || 1);
    for (let page = 2; page <= totalPages; page += 1) {
      const next = await apiClient.fetchOrders({ ...baseQuery, page, pageSize: 200 });
      if (Array.isArray(next?.orders)) orders.push(...next.orders);
    }
    return orders;
  },

  fetchOrderFull(orderId: number): Promise<any> {
    return api.get<any>(`/orders/${orderId}/full`);
  },

  // v2 parity: plain single-order read (no hydration). Use when callers only
  // need the raw order row — `fetchOrderFull` is the hydrated variant.

  // Returns every distinct SKU that appears in orders.items. Used by the
  // OrdersView SKU filter dropdown so the list shows ALL SKUs in the
  // system rather than only the ones present on the current paginated
  // page (~50 orders). Backend filters out adjustment-rows and excluded
  // stores so the result matches what the dropdown would otherwise show
  // — just over the full universe instead of the visible slice.
  fetchDistinctSkus(filters: {
    status?: string
    clientId?: number
    storeId?: number
    dateFrom?: string
    dateTo?: string
    includeInactiveClients?: boolean
  } = {}): Promise<string[]> {
    const q: Record<string, string> = {}
    if (filters.status) q.status = filters.status
    if (filters.clientId != null) q.clientId = String(filters.clientId)
    if (filters.storeId != null) {
      if (filters.storeId < 0 && filters.clientId == null) q.clientId = String(Math.abs(filters.storeId))
      else q.storeId = String(filters.storeId)
    }
    if (filters.dateFrom) q.dateFrom = filters.dateFrom
    if (filters.dateTo) q.dateTo = filters.dateTo
    if (filters.includeInactiveClients) q.includeInactiveClients = 'true'
    const queryString = qs(q)
    return cachedSafe(
      'fetchDistinctSkus',
      `fetchDistinctSkus:${queryString}`,
      5 * 60_000,
      15 * 60_000,
      async () => {
        const res = await api.get<{ skus: string[] }>(`/orders/distinct-skus${queryString}`, {
          timeoutMs: 25_000,
        })
        return Array.isArray(res?.skus) ? res.skus : []
      },
      []
    )
  },

  // Resolve a marketplace-facing orderNumber (text) → local PK (number).
  // Used by the Packages ledger view to make order numbers embedded
  // inside reason text clickable. Returns null if the order was purged
  // or never existed — caller should show a "order no longer exists"
  // toast instead of opening a drawer with stale data.
  findOrderByNumber(orderNumber: string): Promise<{ id: number; orderNumber: string; orderStatus: string | null } | null> {
    return safe(
      'findOrderByNumber',
      async () => {
        const trimmed = String(orderNumber ?? '').trim()
        if (!trimmed) return null
        // Encode in case the number contains characters URL routers
        // care about ('+', '#', '/', etc.). Marketplace IDs rarely
        // do, but PrepShip's "TESTING-…" + custom client formats are
        // controlled by humans, so be defensive.
        const res = await api.get<any>(`/orders/by-number/${encodeURIComponent(trimmed)}`)
        if (!res || typeof res.id !== 'number') return null
        return {
          id: res.id,
          orderNumber: String(res.orderNumber ?? trimmed),
          orderStatus: res.orderStatus ?? null,
        }
      },
      null
    )
  },


  setOrderResidential(orderId: number, residential: boolean | null): Promise<any> {
    return safe(
      'setOrderResidential',
      () => api.patch<any>(`/orders/${orderId}`, { residential }),
      {}
    );
  },

  // Mark an order as shipped externally (no label was bought through
  // PrepShip). The 2-arg signature is preserved for callers that just
  // want the local flip; the 3-arg variant lets the side-panel popover
  // pass through tracking + notify toggles. None of the new fields are
  // required — when omitted the backend skips the optional ShipStation
  // notification call and behaves like the historical flow.
  markOrderShippedExternal(
    orderId: number,
    source: string,
    extras?: {
      trackingNumber?: string | null
      carrierCode?: string | null
      notifyCustomer?: boolean
      notifyMarketplace?: boolean
    }
  ): Promise<any> {
    const body: Record<string, unknown> = { source }
    if (extras?.trackingNumber != null) body.trackingNumber = extras.trackingNumber
    if (extras?.carrierCode != null) body.carrierCode = extras.carrierCode
    if (extras?.notifyCustomer != null) body.notifyCustomer = extras.notifyCustomer
    if (extras?.notifyMarketplace != null) body.notifyMarketplace = extras.notifyMarketplace
    return safe(
      'markOrderShippedExternal',
      () => api.post<any>(`/orders/${orderId}/shipped-external`, body),
      { ok: false }
    );
  },

  setOrderSelectedPid(orderId: number, pid: number | null): Promise<any> {
    return safe(
      'setOrderSelectedPid',
      () => api.patch<any>(`/orders/${orderId}`, { selectedPid: pid }),
      {}
    );
  },

  setOrderSelectedPackageId(
    orderId: number,
    pid: string | number | null
  ): Promise<any> {
    return safe(
      'setOrderSelectedPackageId',
      () =>
        api.patch<any>(`/orders/${orderId}`, {
          selectedPackageId: pid == null ? null : String(pid),
        }),
      {}
    );
  },

  saveOrderRecipientOverride(
    orderId: number,
    recipientOverride: {
      name?: string | null
      company?: string | null
      street1?: string | null
      street2?: string | null
      city?: string | null
      state?: string | null
      postalCode?: string | null
      country?: string | null
      phone?: string | null
    }
  ): Promise<any> {
    return api.patch<any>(`/orders/${orderId}`, { recipientOverride });
  },

  // PS-037: persist the chosen package as the reusable default for this order's
  // exact client + SKU+qty combination. Backend derives the combo key from the
  // order's items (the client only supplies package + optional dims snapshot).
  saveComboPackageDefault(
    orderId: number,
    input: {
      packageId?: string | number | null
      length?: number | null
      width?: number | null
      height?: number | null
      weightOz?: number | null
      // PS-121: true ONLY from the explicit "Save weights & dims as SKU defaults" action →
      // backend invalidates + targeted-recalcs the same SKU+qty group's stale sibling rates.
      recalcGroup?: boolean
    }
  ): Promise<any> {
    return safe(
      'saveComboPackageDefault',
      () =>
        api
          .post<{ data: any }>(`/orders/${orderId}/save-combo-package-default`, {
            packageId: input.packageId ?? null,
            length: input.length ?? null,
            width: input.width ?? null,
            height: input.height ?? null,
            weightOz: input.weightOz ?? null,
            ...(input.recalcGroup ? { recalcGroup: true } : {}),
          })
          .then((r) => r.data),
      { saved: false }
    );
  },

  saveOrderBestRate(
    orderId: number,
    rate: unknown,
    dimsLabel?: string | null
  ): Promise<any> {
    return safe(
      'saveOrderBestRate',
      () =>
        api.patch<any>(`/orders/${orderId}`, {
          bestRateJson: rate,
          bestRateDims: dimsLabel ?? null,
        }),
      {}
    );
  },

  // PS-302: the backend-owned Apply Best Rate COMMAND. Persists dims + weight + selected
  // provider + best_rate_json in ONE atomic backend operation (no partial-save race),
  // replacing the FE's saveOrderDims + setOrderSelectedPid + saveOrderBestRate orchestration.
  // currentRequestFingerprint is intentionally NOT sent here: the optional backend proof
  // check is omitted so this is behavior-equivalent to the legacy 3-call save (same fields
  // persisted, same eligibility gate) — just atomic. Backend owns the validation/persist.
  applyBestRate(
    orderId: number,
    payload: {
      bestRateJson: unknown
      bestRateDims?: string | null
      selectedPid?: number | null
      weightOz?: number | null
    }
  ): Promise<any> {
    return safe(
      'applyBestRate',
      () =>
        api.post<any>(`/orders/${orderId}/apply-best-rate`, {
          bestRateJson: payload.bestRateJson,
          bestRateDims: payload.bestRateDims ?? null,
          selectedPid: payload.selectedPid ?? null,
          weightOz: payload.weightOz ?? null,
        }),
      {}
    );
  },

  // PS-179: updateOrderBestRateSelectionStrict removed — the backend persists
  // strict-recalc outcomes inside /browse (PS-175/PS-178); zero FE callers
  // remained. Pinned removed by test:ps-159-apiclient-deadmethods.

  createManualOrder(payload: Record<string, unknown>): Promise<any> {
    return api.post<any>('/orders/manual', payload);
  },

  // ─── Orders: stats / picklist / export / dims ───────────────────────────────
  fetchDailyStats(query?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<DailyStatsSummary> {
    // Coerce UI date strings (YYYY-MM-DD) to the ISO datetimes expected by
    // /orders/daily-stats. With no dates, the server applies its default
    // shift window.
    const queryString = qs({
      dateFrom: toIsoDayStart(query?.dateFrom),
      dateTo: toIsoDayEnd(query?.dateTo),
    });
    const cacheKey = `fetchDailyStats:${queryString}`;
    const now = Date.now();
    const existing = cachedReads.get(cacheKey) as CachedRead<DailyStatsSummary> | undefined;
    if (existing?.hasValue && existing.expiresAt > now) {
      return Promise.resolve(existing.value as DailyStatsSummary);
    }
    if (existing?.inFlight) return existing.inFlight;

    const inFlight = (async () => {
      try {
        // V2 parity: the daily stats endpoint applies only the configured
        // excluded store IDs server-side.
        const res = await api.get<unknown>(`/orders/daily-stats${queryString}`, { timeoutMs: 25_000 });
        const parsed = parseDailyStatsSummary(res);
        const settledAt = Date.now();
        cachedReads.set(cacheKey, {
          hasValue: true,
          value: parsed,
          expiresAt: settledAt + 5 * 60_000,
          staleUntil: settledAt + 30 * 60_000,
        });
        return parsed;
      } catch (err) {
        const current = cachedReads.get(cacheKey) as CachedRead<DailyStatsSummary> | undefined;
        if (current?.hasValue && current.staleUntil > Date.now()) {
          warnThrottled(
            'cached-stale:fetchDailyStats',
            '[v2-apiClient] fetchDailyStats failed; using cached value:',
            err instanceof Error ? err.message : err
          );
          return current.value as DailyStatsSummary;
        }
        warnThrottled(
          'cached:fetchDailyStats',
          '[v2-apiClient] fetchDailyStats failed:',
          err instanceof Error ? err.message : err
        );
        throw err;
      } finally {
        const current = cachedReads.get(cacheKey) as CachedRead<DailyStatsSummary> | undefined;
        if (current?.inFlight) {
          delete current.inFlight;
        }
      }
    })();

    cachedReads.set(cacheKey, {
      ...(existing ?? { hasValue: false, expiresAt: 0, staleUntil: 0 }),
      inFlight,
    });
    return inFlight;
  },

  fetchPicklist(query: {
    status?: string;
    clientId?: number;
    storeId?: number;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<any> {
    // v4 returns rows with snake_case (`total_qty`, `client_name`, `image_url`).
    // v2 picklist UI + `buildPicklistPrintHtml` consume camelCase
    // (`totalQty`, `clientName`, `imageUrl`) — renaming would render `undefined`
    // in the "Qty to Pick" column and fall back to the 📦 placeholder image.
    return safe(
      'fetchPicklist',
      async () => {
        const q: Record<string, unknown> = { ...query };
        normalizeSyntheticTestStoreQuery(q);
        const res = await api.get<any>(
          `/orders/picklist${qs({
            status: q.status,
            clientId: q.clientId,
            storeId: q.storeId,
            dateFrom: q.dateFrom,
            dateTo: q.dateTo,
          } as any)}`
        );
        const rawSkus = Array.isArray(res?.skus) ? res.skus : [];
        const skus = rawSkus.map((r: any) => ({
          ...r,
          clientId: r?.clientId ?? r?.client_id ?? null,
          clientName: r?.clientName ?? r?.client_name ?? null,
          imageUrl: r?.imageUrl ?? r?.image_url ?? null,
          totalQty: r?.totalQty ?? r?.total_qty ?? 0,
          orderCount: r?.orderCount ?? r?.order_count ?? 0,
          sku: r?.sku ?? '',
          name: r?.name ?? '',
        }));
        return {
          skus,
          totalSkus: res?.totalSkus ?? skus.length,
          totalUnits:
            res?.totalUnits ??
            skus.reduce((a: number, s: any) => a + (s?.totalQty ?? 0), 0),
        };
      },
      { skus: [], totalSkus: 0, totalUnits: 0 }
    );
  },

  downloadOrdersExport(query?: {
    orderStatus?: string;
    pageSize?: number;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<{ blob: Blob; filename: string }> {
    // v4 expects `status` (not `orderStatus`) and ISO datetimes (not YYYY-MM-DD).
    // Caps at 5000 rows server-side, ignores pageSize.
    const query2 = qs({
      status: query?.orderStatus,
      dateFrom: toIsoDayStart(query?.dateFrom),
      dateTo: toIsoDayEnd(query?.dateTo),
    });
    return fetchBlob(
      'downloadOrdersExport',
      `/orders/export${query2}`,
      `orders_export_${Date.now()}.csv`
    );
  },


  saveOrderDims(
    orderId: number,
    dims:
      | { l?: number; w?: number; h?: number; weightOz?: number }
      | { length?: number; width?: number; height?: number; weightOz?: number }
      | Record<string, unknown>
  ): Promise<any> {
    // v2-copied UI call sites send { length, width, height }; v4 accepts
    // { l, w, h }. Translate either shape to v4 so both work.
    const anyDims = dims as Record<string, unknown>;
    const rawL = anyDims.l ?? anyDims.length;
    const rawW = anyDims.w ?? anyDims.width;
    const rawH = anyDims.h ?? anyDims.height;
    const l = parseFiniteNumber(rawL);
    const w = parseFiniteNumber(rawW);
    const h = parseFiniteNumber(rawH);
    const weightOz =
      anyDims.weightOz === undefined ? undefined : parseFiniteNumber(anyDims.weightOz);
    const payload: Record<string, number> = {};
    if (rawL != null && l != null) payload.l = l;
    if (rawW != null && w != null) payload.w = w;
    if (rawH != null && h != null) payload.h = h;
    if (weightOz !== undefined && weightOz != null) payload.weightOz = weightOz;
    return safe(
      'saveOrderDims',
      () =>
        api
          .post<{ data: any }>(`/orders/${orderId}/save-dims`, payload)
          .then((r) => r.data),
      {}
    );
  },

  // ─── Labels ────────────────────────────────────────────────────────────────
  // Throws on failure — callers (OrdersView) use try/catch to surface toasts
  // and keep flow-control semantics intact. Other methods in this file return
  // safe fallbacks, but labels MUST surface errors to the UI.
  // PS-179: saveOrderDimsStrict removed — the backend persists strict-recalc
  // dims inside /browse (PS-175/PS-178); zero FE callers remained. Pinned
  // removed by test:ps-159-apiclient-deadmethods.
  createLabel(payload: unknown): Promise<any> {
    // PS-202: ONE label owner. Direct carrier-account purchases (synthetic
    // 10M+/20M+ provider ids: Shipp, Walmart Shipping, direct UPS, EasyPost)
    // now go through the SAME v4 POST /labels as ShipStation — createLabelV2
    // resolves the account, applies the proof gate/safety/eligibility, buys
    // via the carrier connector, and runs the identical persistence/deduction/
    // confirmation tail. The legacy Vercel direct-label branch is deleted
    // (that endpoint itself is decommissioned by PS-200). store_accounts rates
    // (walmart_shipping) are now purchasable: createLabelV2 routes them to the
    // marketplace shipping connector with the live-verified PO (PS-199).
    return api.post<any>('/labels', payload).then(normalizeLabelResponse);
  },

  // PS-139: removed dead FE method createLabelBatch (0 callers; the backend /labels/create-batch
  // route + the parity-kept backend createLabelBatch service are untouched).

  // PS-139: removed dead FE method returnLabel (0 callers; backend /labels/:id/return stays live).
  retrieveLabel(orderLookup: number | string, fresh = false): Promise<any> {
    const path = `/labels/${encodeURIComponent(String(orderLookup))}/retrieve${fresh ? '?fresh=true' : ''}`;
    return api.get<any>(path).then(normalizeLabelResponse);
  },

  // PS-219: void a shipped label at its OWNING provider (PS-211 backend). Pure
  // pass-through to POST /labels/:shipmentId/void. `shipmentId` MUST be the
  // LOCAL shipments.id PK the backend stamps on order.labelVoidability.shipmentId
  // — never an order id, a ShipStation shipment id, or a synthetic direct-carrier
  // id (the void route's or(id, labelShipmentId) lookup would otherwise match the
  // wrong row). Resolves the structured VoidLabelResponseDto on HTTP 200
  // ('voided' / 'already_voided'); throws ApiRequestError with `.status` on
  // 409 (not_supported / not_voidable), 502 (provider_failed), or 404.
  voidLabel(shipmentId: number): Promise<any> {
    return api.post<any>(`/labels/${encodeURIComponent(String(shipmentId))}/void`, {});
  },

  async openLabel(url: string): Promise<void> {
    // Back-compat thin wrapper. New code should call openLabelPdf()
    // which handles auth-gated URLs via blob proxy. This wrapper still
    // works for ShipStation CDN URLs (no auth needed) but will silently
    // 401 if the URL points at our auth-gated API origin — same failure
    // mode the boss reported on 2026-05-14 ("Check internet connection"
    // toast in Chrome's download manager). Prefer openLabelPdf().
    await this.openLabelPdf(url);
  },

  /**
   * Open a label PDF in a new tab, handling all the failure modes that
   * `window.open(labelUrl)` directly does NOT handle:
   *
   *   1. **Mock label URLs** that come from the backend as `/labels/mock/N`
   *      relative paths or with a stale host — normalized via
   *      `normalizeMockLabelUrl()` before opening.
   *
   *   2. **Auth-gated URLs on our API origin** — `window.open` cannot
   *      attach the Supabase Bearer token, so any auth-gated endpoint
   *      returns 401 and Chrome surfaces it as the misleading
   *      "Check internet connection" download error. We detect API-origin
   *      URLs and fetch them with the Bearer token, then open the
   *      response as a `blob:` URL (browser-internal, no further auth).
   *
   *   3. **External CDN URLs** (ShipStation v2 downloads, third-party
   *      carrier label hosts) — opened directly via `window.open` since
   *      they don't need our auth and `fetch` on them would CORS-fail.
   *
   *   4. **Pre-allocated popup windows** — call sites that opened a
   *      blank tab synchronously (to survive popup blockers) can pass
   *      it via `options.popup`; we redirect that tab to the resolved
   *      URL instead of opening a fresh one.
   *
   * Returns `true` on success, `false` on a hard failure that even
   * the fallback `window.open` couldn't recover. Never throws — call
   * sites can `void` the promise without a try/catch.
   *
   * 2026-05-14: introduced after the operator's boss reported every
   * label download failing with "Check internet connection" in Chrome.
   * Root cause was `window.open(data.labelUrl)` direct calls in
   * OrdersView reprintLabel + create-label success paths bypassing
   * both the URL normalizer AND the Bearer auth header. Mirrors the
   * battle-tested `openBillingInvoice` pattern below in this file.
   */
  async openLabelPdf(
    url: string,
    options?: { popup?: Window | null }
  ): Promise<boolean> {
    if (!url) return false;

    // Step 1: rewrite stale mock-label hosts / relative paths to point
    // at the configured API_BASE. normalizeMockLabelUrl is a no-op for
    // anything that isn't a /labels/mock/N URL.
    const normalizedRaw = normalizeMockLabelUrl(url);
    const target = typeof normalizedRaw === 'string' ? normalizedRaw : url;

    const popup = options?.popup ?? null;
    const openIn = (resolvedUrl: string) => {
      if (popup && !popup.closed) {
        popup.location.href = resolvedUrl;
        return true;
      } else {
        return Boolean(window.open(resolvedUrl, '_blank', 'noopener,noreferrer'));
      }
    };

    const openBlob = (blob: Blob) => {
      const blobUrl = URL.createObjectURL(blob);
      const opened = openIn(blobUrl);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return opened;
    };

    // Some historical labels are stored as data:application/pdf;base64 URLs.
    // Chrome blocks top-frame navigation from about:blank to data: URLs, so
    // convert those bytes into a browser-safe blob: URL before redirecting.
    if (/^data:/i.test(target)) {
      try {
        const blob = await fetch(target).then((res) => res.blob());
        return openBlob(blob);
      } catch (err) {
        console.error('[openLabelPdf] data-url conversion failed:', err);
        return false;
      }
    }

    // Step 2: figure out whether this URL is on OUR API origin (needs
    // Bearer auth → use blob proxy) or a third-party CDN (open direct).
    let needsAuth = false;
    try {
      const apiOrigin = new URL(API_BASE).origin;
      const targetOrigin = new URL(target, API_BASE).origin;
      needsAuth = targetOrigin === apiOrigin;
    } catch {
      // Malformed URL. Try the direct-open fallback and let the browser
      // show whatever error makes sense instead of failing silently.
      return openIn(target);
    }

    // Step 3: external CDN — direct open is correct. ShipStation v2
    // download URLs (api.shipengine.com) and most carrier-direct CDNs
    // sit here. They don't need our Bearer token and a fetch+blob proxy
    // would just CORS-fail.
    if (!needsAuth) {
      return openIn(target);
    }

    // Step 4: API-origin URL — proxy through fetch with Bearer auth so
    // the response actually arrives, then open as a blob: URL.
    try {
      const accessToken = await getCachedAuthToken();
      const headers: Record<string, string> = {
        Accept: 'application/pdf,application/octet-stream,*/*',
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const res = await fetch(target, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Label fetch ${res.status}: ${body.slice(0, 200) || res.statusText}`
        );
      }

      const blob = await res.blob();
      // Sanity check: if the API returned an HTML 401 page despite
      // status 200 (some upstream proxies do this), the blob's MIME
      // type will say so. Surface a clear error rather than opening
      // an HTML page disguised as a PDF.
      if (blob.type && blob.type.includes('text/html')) {
        throw new Error(
          'Label endpoint returned HTML instead of PDF — token may be expired.'
        );
      }
      return openBlob(blob);
    } catch (err) {
      console.error('[openLabelPdf] auth-fetch failed; falling back to direct open:', err);
      // Last-ditch: open the original URL directly. The user will see
      // whatever error the browser surfaces (likely 401 HTML), which
      // is at least more informative than the operator-reported
      // "Check internet connection" silent failure of the previous
      // window.open-only path.
      return openIn(target);
    }
  },

  // ─── Print queue ───────────────────────────────────────────────────────────
  fetchQueue(clientId?: number | null, historyVisible = false): Promise<any> {
    return safe(
      'fetchQueue',
      () =>
        api.get<any>(
          `/print-queue${qs({
            clientId: clientId ?? undefined,
            includePrinted: historyVisible ? '1' : undefined,
          })}`
        ),
      { entries: [], count: 0 }
    );
  },

  addToQueue(payload: Record<string, unknown>): Promise<any> {
    return safe('addToQueue', () => api.post<any>('/print-queue/add', payload), {});
  },

  startQueueSendJob(payload: {
    orders: Array<Record<string, unknown>>;
    preflight_skips?: Array<Record<string, unknown>>;
    concurrency?: number;
  }): Promise<any> {
    return api.post<any>('/print-queue/batch-send', payload);
  },

  fetchQueueSendJobStatus(jobId: string): Promise<any> {
    return api.get<any>(`/print-queue/batch-send/status/${encodeURIComponent(jobId)}`);
  },

  // PS-195: clears require EXPLICIT entry targeting — the backend rejects
  // blanket clears without ids and refuses entries inside a running merge.
  clearQueue(clientId: number, entryIds: string[]): Promise<any> {
    return safe(
      'clearQueue',
      () => api.post<any>('/print-queue/clear', {
        client_id: clientId,
        queue_entry_ids: entryIds,
        confirmation: 'REMOVE_UNPRINTED_LABELS',
      }),
      { cleared_count: 0, blocked_in_flight: 0 }
    );
  },

  confirmPrintedQueueEntries(clientId: number | null | undefined, entryIds: string[]): Promise<any> {
    return safe(
      'confirmPrintedQueueEntries',
      () => api.post<any>('/print-queue/confirm-printed', {
        client_id: clientId ?? undefined,
        queue_entry_ids: entryIds,
        confirmation: 'PRINTED',
      }),
      { confirmed_count: 0, confirmed_entry_ids: [] }
    );
  },

  removeFromQueue(entryId: string, _clientId?: number | null): Promise<any> {
    // v4's api.delete helper doesn't accept a body; v4 endpoint treats
    // client_id in the body as optional so omitting it is safe.
    return safe(
      'removeFromQueue',
      () => api.delete<any>(`/print-queue/${encodeURIComponent(entryId)}`),
      { removed_entry: entryId }
    );
  },

  startQueuePrintJob(
    clientId: number | null | undefined,
    entryIds: string[],
    combine = true
  ): Promise<any> {
    return api.post<any>('/print-queue/print', {
      client_id: clientId ?? undefined,
      queue_entry_ids: entryIds,
      merge_headers: combine,
    });
  },

  fetchQueuePrintJobStatus(jobId: string): Promise<any> {
    return api.get<any>(`/print-queue/print/status/${encodeURIComponent(jobId)}`);
  },

  // PS-194: the most recent merge job (durable snapshot). Used to re-seed the
  // Confirm-Printed gate after a page refresh — successful_entry_ids is
  // backend truth for "these labels went through a merged print PDF".
  fetchQueuePrintLastJob(): Promise<{ job: Record<string, unknown> | null }> {
    return safe(
      'fetchQueuePrintLastJob',
      () => api.get<{ job: Record<string, unknown> | null }>('/print-queue/print/last'),
      { job: null },
    );
  },

  // PS-139: removed dead FE method downloadQueuePrintJob (0 callers; superseded by the PS-065
  // signed-URL flow openQueuePrintJobPdf / fetchQueuePrintJobSignedUrl).
  fetchQueuePrintJobSignedUrl(
    jobId: string,
    disposition: 'inline' | 'attachment' = 'inline'
  ): Promise<{
    url: string;
    filename: string;
    expires_at: string;
    disposition: 'inline' | 'attachment';
    chunk_count?: number;
    chunks?: Array<{
      chunk_number: number;
      status: string;
      label_count: number;
      file_name: string;
      file_size: number | null;
      error: string | null;
      url: string | null;
      expires_at: string | null;
      disposition: 'inline' | 'attachment';
    }>;
  }> {
    return api.get<any>(
      `/print-queue/print/signed-url/${encodeURIComponent(jobId)}${qs({ disposition })}`
    );
  },

  async openQueuePrintJobPdf(
    jobId: string,
    options?: { popup?: Window | null; disposition?: 'inline' | 'attachment' }
  ): Promise<boolean> {
    try {
      const signed = await this.fetchQueuePrintJobSignedUrl(
        jobId,
        options?.disposition ?? 'inline'
      );
      if (!signed?.url) throw new Error('PDF link was not returned');
      const popup = options?.popup ?? null;
      if (popup && !popup.closed) {
        popup.location.href = signed.url;
        return true;
      }
      return Boolean(window.open(signed.url, '_blank', 'noopener,noreferrer'));
    } catch (err) {
      console.error('[print-queue] signed PDF link failed:', err);
      return false;
    }
  },

  // PS-139: removed dead FE method fetchQueuePrintJobPdfUrl (0 live callers; superseded by the
  // PS-065 signed-URL helpers — print-queue-signed-pdf-guard asserts its ABSENCE).

  // Fetch the billing invoice HTML with Bearer auth and open it in a new
  // tab via blob URL. window.open can't carry a bearer token and the
  // invoice endpoint (GET /billing/invoice) is auth-gated, so a direct
  // href falls back to a 401 HTML page on Vercel. This mirrors the
  // print-queue PDF flow.
  async openBillingInvoice(
    clientId: number,
    from: string,
    to: string
  ): Promise<boolean> {
    try {
      const accessToken = await getCachedAuthToken();
      if (!accessToken) throw new Error('Not authenticated');
      // PS-208: pass the operator-picked days VERBATIM (plain YYYY-MM-DD).
      // The backend (src/lib/time/billing-day.ts) owns calendar-day semantics;
      // the FE must never convert a billing day to an instant.
      const qs = new URLSearchParams({
        clientId: String(clientId),
        dateFrom: from,
        dateTo: to,
      }).toString();
      const res = await fetch(`${API_BASE}/billing/invoice?${qs}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Invoice failed: ${msg}`);
      }
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    } catch (err) {
      console.error('[invoice] open failed:', (err as Error).message);
      return false;
    }
  },

  // PS-208: download the SAME invoice as an Excel workbook. Identical query
  // params and auth pattern as openBillingInvoice — the backend builds the
  // XLSX from the same dataset as the HTML, so the two can never disagree.
  async openBillingInvoiceXlsx(
    clientId: number,
    from: string,
    to: string
  ): Promise<boolean> {
    try {
      const accessToken = await getCachedAuthToken();
      if (!accessToken) throw new Error('Not authenticated');
      const qs = new URLSearchParams({
        clientId: String(clientId),
        dateFrom: from,
        dateTo: to,
      }).toString();
      const res = await fetch(`${API_BASE}/billing/invoice.xlsx?${qs}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Invoice XLSX failed: ${msg}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${clientId}-${from}-${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    } catch (err) {
      console.error('[invoice] xlsx download failed:', (err as Error).message);
      return false;
    }
  },

  // PS-468: download the SAME invoice as a CSV. Identical query params and auth
  // pattern as openBillingInvoiceXlsx — the backend serializes the CSV from the
  // same billingInvoiceData dataset with the same column derivation as the XLSX
  // Line Items sheet, so the exports can never disagree.
  async openBillingInvoiceCsv(
    clientId: number,
    from: string,
    to: string
  ): Promise<boolean> {
    try {
      const accessToken = await getCachedAuthToken();
      if (!accessToken) throw new Error('Not authenticated');
      const qs = new URLSearchParams({
        clientId: String(clientId),
        dateFrom: from,
        dateTo: to,
      }).toString();
      const res = await fetch(`${API_BASE}/billing/invoice.csv?${qs}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Invoice CSV failed: ${msg}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${clientId}-${from}-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    } catch (err) {
      console.error('[invoice] csv download failed:', (err as Error).message);
      return false;
    }
  },

  // ─── Products ──────────────────────────────────────────────────────────────

  async fetchProductsBySku(sku: string): Promise<any> {
    // A missing product is expected (many order SKUs have no product record
    // yet), so swallow errors silently instead of piping through safe() which
    // would log a warning for every row lookup.
    try {
      return await api.get<any>(`/products/by-sku/${encodeURIComponent(sku)}`);
    } catch {
      return null;
    }
  },


  saveProductDefaultsV2(data: Record<string, unknown>): Promise<any> {
    return api.post<any>('/products/save-defaults', normalizeProductDefaultsPayload(data));
  },

  // Multi-SKU fallback for the shipping panel: when an order has more than one
  // SKU, savePanelSkuDefaults skips the per-SKU save (no clean way to allocate
  // one parcel's weight/dims across many lines), but the package selection IS
  // still meaningful for every SKU on the order. This endpoint stamps just
  // inventory.package_id for each provided SKU under the given clientId.

  // ─── Inventory ─────────────────────────────────────────────────────────────
  fetchInventoryPage(query?: Record<string, unknown>): Promise<{
    items: any[];
    total: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.max(1, Math.min(2000, Number(query?.pageSize) || 50));
    const requestQuery = { ...(query ?? {}), page, pageSize };
    return cachedSafe(
      'fetchInventoryPage',
      `fetchInventoryPage:${JSON.stringify(requestQuery)}`,
      30_000,
      5 * 60_000,
      async () => {
        const [res, clientRows]: [any, any[]] = await Promise.all([
          api.get<any>(`/inventory${qs(requestQuery as any)}`),
          apiClient.fetchClients().catch(() => []),
        ]);
        const clientNamesById = new Map<number, string>(
          clientRows.map((client: any) => [Number(client.clientId ?? client.id), String(client.name ?? '')])
        );
        const activeClientIds = new Set<number>(
          clientRows
            .map((client: any) => Number(client.clientId ?? client.id))
            .filter(Number.isFinite)
        );

        const data = Array.isArray(res)
          ? res
          : Array.isArray(res?.data)
            ? res.data
            : [];
        const pagination = res?.pagination ?? {};
        const total = Number(pagination.total ?? res?.total ?? data.length) || 0;
        const responsePage = Number(pagination.page ?? res?.page ?? page) || page;
        const responsePageSize = Number(pagination.pageSize ?? res?.pageSize ?? pageSize) || pageSize;
        const totalPages =
          Number(pagination.totalPages ?? res?.totalPages ?? res?.pages) ||
          Math.max(1, Math.ceil(total / responsePageSize));

        return {
          items: filterRowsToActiveClients(data, activeClientIds).map((row) =>
            normalizeInventoryDto(row, clientNamesById)
          ),
          total,
          totalPages,
          page: responsePage,
          pageSize: responsePageSize,
        };
      },
      {
        items: [],
        total: 0,
        totalPages: 1,
        page: Number(query?.page) || 1,
        pageSize: Number(query?.pageSize) || 50,
      },
      { warn: false, fallbackTtlMs: 60_000, fallbackStaleMs: 5 * 60_000, throwOnError: true }
    );
  },

  // Auto-paginates through all pages so the Inventory main view shows EVERY
  // SKU instead of just the first 50 (which was the previous bug — the
  // backend GET /inventory caps pageSize at 200 and defaults to 50, and
  // there's no infinite-scroll UI on the inventory grid, so without
  // explicit pagination here, "All Clients" appeared to be missing rows).
  //
  // Strategy: fetch page 1 at the maximum pageSize (200), read total/pages
  // from the response, then fetch remaining pages in parallel up to a hard
  // cap (PAGE_CAP × 200 = max 10,000 SKUs returned). 10k is well above any
  // realistic single-tenant catalog; if a customer ever exceeds it, the
  // backend would need a streaming endpoint or the UI would need infinite
  // scroll — at which point this helper would change shape.
  fetchInventory(query?: Record<string, unknown>): Promise<any[]> {
    return (async () => {
        const PAGE_SIZE = 200;
        const PAGE_CAP = 50; // 200 × 50 = 10,000 SKUs hard cap
        const baseQ: Record<string, unknown> = { ...(query ?? {}), pageSize: PAGE_SIZE, page: 1 };

        const [first, clientRows]: [any, any[]] = await Promise.all([
          api.get<any>(`/inventory${qs(baseQ as any)}`),
          apiClient.fetchClients().catch(() => []),
        ]);
        const clientNamesById = new Map<number, string>(
          clientRows.map((client: any) => [Number(client.clientId ?? client.id), String(client.name ?? '')])
        );
        const activeClientIds = new Set<number>(
          clientRows
            .map((client: any) => Number(client.clientId ?? client.id))
            .filter(Number.isFinite)
        );

        // Backend response shape can be either a bare array (legacy) or
        // a paginated envelope { data, total, pages, page, pageSize }.
        // The paginated case is what triggers the multi-page fetch.
        if (Array.isArray(first)) {
          return filterRowsToActiveClients(first, activeClientIds).map((row) =>
            normalizeInventoryDto(row, clientNamesById)
          );
        }
        const firstData: any[] = Array.isArray(first?.data) ? first.data : [];
        const responseTotalPages =
          Number(first?.pagination?.totalPages) ||
          Number(first?.totalPages) ||
          Number(first?.pages) ||
          1;
        const totalPages = Number.isFinite(responseTotalPages)
          ? Math.min(responseTotalPages, PAGE_CAP)
          : 1;

        if (totalPages <= 1) {
          return filterRowsToActiveClients(firstData, activeClientIds).map((row) =>
            normalizeInventoryDto(row, clientNamesById)
          );
        }

        // Fetch pages 2..N in parallel. If any fails, skip it (we'd rather
        // show a partial list than throw and show nothing).
        const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const remaining = await Promise.all(
          remainingPages.map((page) =>
            api
              .get<any>(`/inventory${qs({ ...(query ?? {}), pageSize: PAGE_SIZE, page } as any)}`)
              .then((res: any) => (Array.isArray(res?.data) ? res.data : []))
              .catch((err: unknown) => {
                console.warn(`[fetchInventory] page ${page} failed:`, err instanceof Error ? err.message : err);
                return [] as any[];
              })
          )
        );

        const allRows = [...firstData, ...remaining.flat()];
        return filterRowsToActiveClients(allRows, activeClientIds).map((row) =>
          normalizeInventoryDto(row, clientNamesById)
        );
    })();
  },


  updateInventoryItem(invSkuId: number, data: Record<string, unknown>): Promise<any> {
    // v2 InventoryView sends legacy keys that v4's zod body schema doesn't
    // accept. Translate before PATCH — anything unmapped gets silently dropped
    // by v4's zod. Also strip product-dim keys (v4 only has generic length/
    // width/height; no separate package vs product dims).
    //
    // v2 key → v4 key:
    //   minStock         → reorderLevel
    //   units_per_pack   → unitsPerPack
    //   productLength    → (dropped)
    //   productWidth     → (dropped)
    //   productHeight    → (dropped)
    //
    // Pass-through (v4 already matches): baseUnitQty, length, width, height,
    //   weightOz, cuFtOverride, packageId, sku, name, imageUrl, stockQty,
    //   reorderLevel, unitsPerPack, active, clientId.
    const PASS_THROUGH = new Set([
      'baseUnitQty',
      'length',
      'width',
      'height',
      'weightOz',
      'cuFtOverride',
      'packageId',
      'sku',
      'name',
      'imageUrl',
      'stockQty',
      'reorderLevel',
      'unitsPerPack',
      'active',
      'clientId',
    ]);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      if (k === 'minStock') {
        payload.reorderLevel = v;
      } else if (k === 'units_per_pack') {
        payload.unitsPerPack = v;
      } else if (k === 'productLength' || k === 'productWidth' || k === 'productHeight') {
        // v4 doesn't split product vs package dims — drop these silently.
        continue;
      } else if (PASS_THROUGH.has(k)) {
        payload[k] = v;
      }
      // Unknown keys dropped to avoid zod 400s.
    }
    // 2026-05-12: don't wrap in safe() — callers (handleToggleRowActive
    // in InventoryView, the Edit-SKU save handler) wrap the call in
    // their own try/catch and ROLL BACK optimistic state on error.
    // safe()'s "log warning + return {}" swallow turned every PATCH
    // failure into a silent success, which is why the active toggle
    // appeared to do nothing for a week before the zod-strip bug was
    // also found. Let errors propagate so the catch path actually runs.
    return api.patch<any>(`/inventory/${invSkuId}`, payload);
  },

  fetchInventoryAlerts(clientId?: number): Promise<any[]> {
    // v4 has no /inventory/alerts endpoint yet — derive client-side from
    // the lowStock flag on the list endpoint. Server caps pageSize at 200
    // (see src/lib/pagination.ts) — exceed it and the zod validator 400s.
    //
    // v2 UI expects enriched rows with clientName + currentStock (the v4
    // row only has stockQty + clientId). Join /clients here so the alerts
    // banner doesn't render "undefined" for the client label.
    return safe(
      'fetchInventoryAlerts',
      async () => {
        const [res, clientsRes] = await Promise.all([
          api.get<any>(
            `/inventory${qs({ clientId, lowStock: true, pageSize: 200 } as any)}`
          ),
          apiClient.fetchClients().catch(() => []),
        ]);
        const rows = Array.isArray(res)
          ? res
          : Array.isArray(res?.data)
            ? res.data
            : [];
        const clientsArr = Array.isArray(clientsRes) ? clientsRes : [];
        const nameById = new Map<number, string>();
        for (const c of clientsArr) {
          if (c?.id != null) nameById.set(c.id, c?.name ?? '');
        }
        return filterRowsToActiveClients(rows, new Set(nameById.keys())).map((row: any) =>
          normalizeInventoryDto(
            {
              ...row,
              clientName:
                row?.clientId != null ? nameById.get(row.clientId) ?? null : null,
            },
            nameById
          )
        );
      },
      []
    );
  },


  fetchInventoryLedger(query: Record<string, unknown>): Promise<any[]> {
    const PAGE_SIZE = 2000;
    const firstQuery: Record<string, unknown> = { ...(query ?? {}), pageSize: PAGE_SIZE, page: 1 };
    delete firstQuery.limit;

    return api.get<any>(`/inventory/ledger${qs(firstQuery as any)}`).then(async (first) => {
      const firstRows = Array.isArray(first)
        ? first
        : Array.isArray(first?.data)
          ? first.data
          : [];
      const pagination = first?.pagination ?? {};
      const totalPages =
        Number(pagination.totalPages ?? first?.totalPages ?? first?.pages) ||
        Math.max(1, Math.ceil((Number(pagination.total ?? firstRows.length) || firstRows.length) / PAGE_SIZE));
      const pageCap = Math.max(1, Math.trunc(totalPages));
      if (pageCap <= 1) return firstRows;

      const remainingRequests: Array<Promise<any>> = [];
      for (let page = 2; page <= pageCap; page += 1) {
        remainingRequests.push(
          api.get<any>(`/inventory/ledger${qs({ ...(query ?? {}), pageSize: PAGE_SIZE, page } as any)}`)
        );
      }

      const remainingPages = await Promise.all(remainingRequests);
      const remainingRows = remainingPages.flatMap((res) => {
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      });
      return [...firstRows, ...remainingRows];
    });
  },

  deleteInventoryLedgerEntry(ledgerId: number): Promise<any> {
    return api.delete<any>(`/inventory/ledger/${ledgerId}`);
  },

  fetchInventorySkuOrders(
    invSkuId: number,
    options?: number | { days?: number; from?: string; to?: string; dateFrom?: string; dateTo?: string }
  ): Promise<any> {
    // v4 returns {sku, name, orders: [{order_id, order_number, order_date,
    // order_status, ship_to_name, carrier_code, service_code, qty, ...}]}.
    // v2 UI reads camelCase rows + {day, units}[] for the 30-day chart.
    // Reshape rows and synthesize dailySales by bucketing qty per day.
    const windowDays = typeof options === 'number' ? options : options?.days ?? 30;
    const query =
      typeof options === 'object' && options !== null
        ? normalizeAnalysisRange({
            days: options.days ?? windowDays,
            from: options.from,
            to: options.to,
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
          })
        : { days: windowDays };
    return safe(
      'fetchInventorySkuOrders',
      async () => {
        const res = await api.get<any>(
          `/inventory/${invSkuId}/sku-orders${qs(query as any)}`
        );
        const rawOrders = Array.isArray(res?.orders) ? res.orders : [];
        const orders = rawOrders.map((r: any) => ({
          orderId: r?.order_id ?? r?.orderId ?? null,
          orderNumber: r?.order_number ?? r?.orderNumber ?? '',
          orderDate: r?.order_date ?? r?.orderDate ?? null,
          orderStatus: r?.order_status ?? r?.orderStatus ?? '',
          shipToName: r?.ship_to_name ?? r?.shipToName ?? null,
          carrierCode: r?.carrier_code ?? r?.carrierCode ?? null,
          serviceCode: r?.service_code ?? r?.serviceCode ?? null,
          unitPrice:
            r?.unit_price == null && r?.unitPrice == null
              ? null
              : Number(r?.unit_price ?? r?.unitPrice),
          itemName: r?.item_name ?? r?.itemName ?? null,
          qty: Number(r?.qty ?? 0),
          shippingCost:
            r?.shipping_cost == null && r?.shippingCost == null
              ? null
              : Number(r?.shipping_cost ?? r?.shippingCost),
          shippingTotal:
            r?.shipping_total == null && r?.shippingTotal == null
              ? null
              : Number(r?.shipping_total ?? r?.shippingTotal),
          standardShippingCost:
            r?.standard_shipping_cost == null && r?.standardShippingCost == null
              ? null
              : Number(r?.standard_shipping_cost ?? r?.standardShippingCost),
          standardShippingTotal:
            r?.standard_shipping_total == null && r?.standardShippingTotal == null
              ? null
              : Number(r?.standard_shipping_total ?? r?.standardShippingTotal),
          externallyShipped: Boolean(
            r?.is_external_shipped
              ?? r?.isExternalShipped
              ?? r?.externally_shipped
              ?? r?.externallyShipped
          ),
        }));

        const rawDailySales = Array.isArray(res?.dailySales)
          ? res.dailySales
          : Array.isArray(res?.daily_sales)
            ? res.daily_sales
            : null;
        const dailySales: { day: string; units: number }[] = rawDailySales
          ? rawDailySales.map((r: any) => ({
              day: String(r?.day ?? ''),
              units: Number(r?.units ?? 0),
            }))
          : (() => {
              // Fallback for older v4 responses: bucket returned orders per day.
              const bucket = new Map<string, number>();
              for (const o of orders) {
                if (!o.orderDate) continue;
                const day = String(o.orderDate).slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
                bucket.set(day, (bucket.get(day) ?? 0) + o.qty);
              }
              const padded: { day: string; units: number }[] = [];
              const today = new Date();
              today.setUTCHours(0, 0, 0, 0);
              for (let i = windowDays - 1; i >= 0; i -= 1) {
                const d = new Date(today);
                d.setUTCDate(d.getUTCDate() - i);
                const day = d.toISOString().slice(0, 10);
                padded.push({ day, units: bucket.get(day) ?? 0 });
              }
              return padded;
            })();

        const totalUnits =
          Number(res?.totalUnits ?? res?.total_units) ||
          dailySales.reduce((acc, row) => acc + (row.units || 0), 0);

        return {
          sku: res?.sku ?? '',
          name: res?.name ?? '',
          clientId: res?.clientId ?? res?.client_id ?? null,
          orders,
          dailySales,
          totalUnits,
          standardShipCount: Number(res?.standardShipCount ?? res?.standard_ship_count ?? 0),
          standardShippingTotal: Number(res?.standardShippingTotal ?? res?.standard_shipping_total ?? 0),
          avgStandardShippingCost: Number(res?.avgStandardShippingCost ?? res?.avg_standard_shipping_cost ?? 0),
        };
      },
      {
        orders: [],
        name: '',
        sku: '',
        clientId: null,
        dailySales: [],
        totalUnits: 0,
        standardShipCount: 0,
        standardShippingTotal: 0,
        avgStandardShippingCost: 0,
      }
    );
  },

  receiveInventory(data: Record<string, unknown>): Promise<any> {
    // v2 receiveInventory can submit a client-scoped batch of SKU rows. v4
    // supports both that bulk route and the older per-inventory-id route.
    if (Array.isArray((data as any)?.items)) {
      return api.post<any>('/inventory/receive', {
        clientId: (data as any).clientId ?? null,
        note: (data as any).note,
        receivedAt: (data as any).receivedAt,
        items: ((data as any).items as any[]).map((item) => ({
          invSkuId: item?.invSkuId ?? item?.inventoryId,
          sku: item?.sku,
          name: item?.name,
          // PS-324: forward the pack-count intent; the backend expands it via the canonical
          // units_per_pack. `qty` (pre-multiplied units) is still forwarded for back-compat.
          packs: item?.packs != null ? Number(item.packs) : undefined,
          qty: item?.qty != null ? Number(item.qty) : undefined,
          note: item?.note,
        })),
      });
    }

    const invId = (data as any)?.invSkuId ?? (data as any)?.inventoryId;
    if (!invId) {
      throw new Error('Inventory item is required to receive stock');
    }
    return api.post<any>(`/inventory/${invId}/receive`, {
      qty: (data as any).qty,
      note: (data as any).note,
      orderId: (data as any).orderId,
      receivedAt: (data as any).receivedAt,
    }).then((res) => (Array.isArray(res) ? res : [res]));
  },

  submitInventoryReceive(data: Record<string, unknown>): Promise<any> {
    // v4's POST /inventory/:id/receive returns {inventory, ledger} (not a flat
    // item row). v2 InventoryView reads result.received as an array of
    // {sku, qty, newStock} for its toast string. Reshape each entry so the
    // UI's "Received X SKU(s): ABC (5 units → 100 total)" renders correctly.
    return apiClient.receiveInventory(data).then((raw) => {
      const resultRows = Array.isArray((raw as any)?.results) ? (raw as any).results : [];
      const failedRows = resultRows.filter((row: any) => !row?.ok);
      const entries = Array.isArray((raw as any)?.received)
        ? (raw as any).received
        : resultRows.length
          ? resultRows.filter((row: any) => row?.ok)
          : Array.isArray(raw)
            ? raw
            : [raw];
      const received = entries.map((e: any) => ({
        invSkuId: e?.invSkuId ?? e?.inventory?.id ?? e?.inventoryId ?? null,
        sku: e?.inventory?.sku ?? e?.sku ?? '',
        name: e?.inventory?.name ?? e?.name ?? '',
        qty: e?.ledger?.qty ?? e?.qty ?? (data as any)?.qty ?? 0,
        newStock: e?.inventory?.stockQty ?? e?.newStock ?? e?.stockQty ?? 0,
        ledgerId: e?.ledger?.id ?? e?.ledgerId ?? null,
      }));
      const error = failedRows
        .map((row: any) => `${row?.sku || 'SKU'}: ${row?.error || 'Receive failed'}`)
        .join('; ');
      return {
        ok: ((raw as any)?.ok ?? failedRows.length === 0) && received.length > 0,
        received,
        failed: (raw as any)?.failed ?? failedRows.length,
        error: received.length ? error || undefined : error || 'No inventory rows were received',
      } as { ok: boolean; received: any[]; failed?: number; error?: string };
    });
  },

  adjustInventory(data: Record<string, unknown>): Promise<any> {
    const invId = (data as any)?.invSkuId ?? (data as any)?.inventoryId;
    if (!invId) {
      throw new Error('Inventory item is required to adjust stock');
    }
    return api.post<any>(`/inventory/${invId}/adjust`, {
      qty: (data as any).qty,
      note: (data as any).note,
      orderId: (data as any).orderId,
      type: (data as any).type,
      adjustedAt: (data as any).adjustedAt,
    });
  },

  submitInventoryAdjustment(data: Record<string, unknown>): Promise<any> {
    // v4's POST /inventory/:id/adjust returns {inventory, ledger}. Toast was
    // reading result.stockQty (undefined on current backend, would be defined
    // if backend flattened). Check the nested path first, fall back to flat
    // in case the server contract changes.
    return apiClient.adjustInventory(data).then((result) => ({
      ok: true,
      newStock:
        (result as any)?.inventory?.stockQty ??
        (result as any)?.stockQty ??
        0,
    } as { ok: boolean; newStock: number }));
  },

  populateInventory(): Promise<any> {
    // v2's "populate" is closest to v4's /import-from-orders (seed SKUs from orders).
    return safe(
      'populateInventory',
      () => api.post<any>('/inventory/import-from-orders', {}),
      {}
    );
  },

  importInventoryDimensions(_clientId?: number): Promise<any> {
    // v2's /import-dims isn't 1:1 with v4 — /sync-products is the closest
    // (pulls dims from ShipStation products). Callers may want a dedicated
    // endpoint; for now this returns a sync-products result.
    return safe(
      'importInventoryDimensions',
      () => api.post<any>('/inventory/sync-products', {}),
      {}
    );
  },

  bulkUpdateInventoryDimensions(data: Record<string, unknown>): Promise<any> {
    return safe(
      'bulkUpdateInventoryDimensions',
      () => api.post<any>('/inventory/bulk-update-dims', data),
      { updated: 0, skipped: 0 }
    );
  },

  setInventoryParent(invSkuId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'setInventoryParent',
      () => api.put<any>(`/inventory/${invSkuId}/set-parent`, data),
      {}
    );
  },

  // ─── Parent SKUs ────────────────────────────────────────────────────────────
  listParentSkus(clientId: number): Promise<any[]> {
    return safe(
      'listParentSkus',
      async () => {
        const res = await api.get<any>(`/parent-skus${qs({ clientId })}`);
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

  createParentSku(data: Record<string, unknown>): Promise<any> {
    return safe('createParentSku', () => api.post<any>('/parent-skus', data), {});
  },


  // ─── Locations ─────────────────────────────────────────────────────────────
  fetchLocations(): Promise<any[]> {
    // v4 returns rows with `id`; v2 consumers (LocationsView, useLocations)
    // read `locationId`. Normalize here so every caller gets the v2 shape.
    return cachedSafe(
      'fetchLocations',
      'fetchLocations',
      60_000,
      10 * 60_000,
      async () => {
        const res = await api.get<any>('/locations', { timeoutMs: 25_000 });
        const rows = Array.isArray(res)
          ? res
          : Array.isArray(res?.data)
            ? res.data
            : [];
        return rows.map((r: any) => ({ ...r, locationId: r?.locationId ?? r?.id }));
      },
      []
    );
  },


  createLocation(data: Record<string, unknown>): Promise<any> {
    return safe('createLocation', () => api.post<any>('/locations', data), {});
  },

  createLocationMutation(data: Record<string, unknown>): Promise<any> {
    return apiClient.createLocation(data);
  },

  updateLocation(locationId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'updateLocation',
      () => api.patch<any>(`/locations/${locationId}`, data),
      {}
    );
  },

  updateLocationMutation(
    locationId: number,
    data: Record<string, unknown>
  ): Promise<any> {
    return apiClient.updateLocation(locationId, data);
  },

  deleteLocation(locationId: number): Promise<any> {
    return safe(
      'deleteLocation',
      () => api.delete<any>(`/locations/${locationId}`),
      { ok: true }
    );
  },

  deleteLocationMutation(locationId: number): Promise<any> {
    return apiClient.deleteLocation(locationId);
  },

  setDefaultLocation(locationId: number): Promise<any> {
    return safe(
      'setDefaultLocation',
      () => api.post<any>(`/locations/${locationId}/default`, {}),
      {}
    );
  },

  // ─── Packages ──────────────────────────────────────────────────────────────
  fetchPackages(source?: string): Promise<any[]> {
    return cachedSafe(
      'fetchPackages',
      `fetchPackages:${source ?? ''}`,
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(`/packages${qs({ source })}`, { timeoutMs: 25_000 });
        if (Array.isArray(res)) return res.map(normalizePackageDto);
        if (Array.isArray(res?.data)) return res.data.map(normalizePackageDto);
        return [];
      },
      [],
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },


  createPackageMutation(data: Record<string, unknown>): Promise<any> {
    return safe(
      'createPackageMutation',
      async () => {
        const response = {
          ...normalizePackageResponse(
            await api.post<any>('/packages', normalizePackageMutationPayload(data))
          ),
          ok: true,
        };
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      {}
    );
  },

  autoCreatePackageByDimensions(data: Record<string, unknown>): Promise<any> {
    return safe(
      'autoCreatePackageByDimensions',
      async () => {
        const response = normalizePackageResponse(await api.post<any>('/packages/auto-create', data));
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      {}
    );
  },

  updatePackageMutation(
    packageId: number,
    data: Record<string, unknown>
  ): Promise<any> {
    return safe(
      'updatePackageMutation',
      async () => {
        const response = {
          ...normalizePackageResponse(
            await api.patch<any>(
              `/packages/${packageId}`,
              normalizePackageMutationPayload(data)
            )
          ),
          ok: true,
        };
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      {}
    );
  },

  deletePackageMutation(packageId: number): Promise<any> {
    return safe(
      'deletePackageMutation',
      async () => {
        const response = { ...(await api.delete<any>(`/packages/${packageId}`)), ok: true };
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      { ok: true }
    );
  },

  setPackageReorderLevel(packageId: number, reorderLevel: number): Promise<any> {
    // v4 doesn't expose a dedicated /reorder-level route; use the general
    // PATCH body, which already accepts reorderLevel.
    return safe(
      'setPackageReorderLevel',
      async () => {
        const response = await api.patch<any>(`/packages/${packageId}`, { reorderLevel });
        clearCachedReads('fetchPackages');
        return response;
      },
      { ok: false }
    );
  },

  receivePackage(packageId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'receivePackage',
      async () => {
        const response = normalizePackageMovementResponse(
          await api.post<any>(
            `/packages/${packageId}/receive`,
            normalizePackageReceivePayload(data)
          )
        );
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      {}
    );
  },

  adjustPackage(packageId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'adjustPackage',
      async () => {
        const response = normalizePackageMovementResponse(
          await api.post<any>(
            `/packages/${packageId}/adjust`,
            normalizePackageAdjustPayload(data)
          )
        );
        clearCachedReads('fetchPackages', 'fetchPackagesUsageSummary');
        return response;
      },
      {}
    );
  },

  fetchPackageLedger(packageId: number): Promise<any[]> {
    return safe(
      'fetchPackageLedger',
      async () => {
        const res = await api.get<any>(`/packages/${packageId}/ledger`);
        if (Array.isArray(res?.data)) return res.data.map(normalizePackageLedgerEntry);
        if (Array.isArray(res)) return res.map(normalizePackageLedgerEntry);
        return [];
      },
      []
    );
  },

  // SQL-side aggregate that replaces the old N+1 fan-out
  // (one fetchPackageLedger per package on every PackagesView mount).
  // Returns one entry per package that had ANY shipment activity in the
  // window. Packages with zero usage are omitted from the response and
  // should be treated as 0 by callers — this keeps the payload tiny.
  fetchPackagesUsageSummary(days = 30): Promise<{ packageId: number; used: number }[]> {
    return cachedSafe(
      'fetchPackagesUsageSummary',
      `fetchPackagesUsageSummary:${days}`,
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(`/packages/usage-summary?days=${days}`);
        if (Array.isArray(res?.data)) {
          return res.data.map((r: any) => ({
            packageId: Number(r?.packageId ?? r?.package_id ?? 0),
            used: Number(r?.used ?? 0) || 0,
          }));
        }
        return [];
      },
      [],
      { fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  syncCarrierPackages(): Promise<any> {
    return safe(
      'syncCarrierPackages',
      () => api.post<any>('/packages/sync', {}),
      { inserted: 0, skipped: 0, message: '' }
    );
  },

  // ─── Billing ───────────────────────────────────────────────────────────────
  backfillPackageStartDate(): Promise<any> {
    return safe(
      'backfillPackageStartDate',
      () => api.post<any>('/packages/backfill-start-date', {}),
      {
        updated: 0,
        startDate: '2026-04-01T00:00:00.000Z',
        message: '',
      }
    );
  },

  importStandardPackageDimensions(): Promise<any> {
    return safe(
      'importStandardPackageDimensions',
      () => api.post<any>('/packages/import-standard-dimensions', {}),
      {
        inserted: 0,
        skippedExisting: 0,
        skippedInvalid: 0,
        skippedDuplicates: 0,
        totalValid: 0,
        rawLineCount: 0,
        message: '',
      }
    );
  },

  fetchBillingConfigs(): Promise<any[]> {
    return cachedSafe(
      'fetchBillingConfigs',
      'fetchBillingConfigs',
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>('/billing/config');
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      [],
      { fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  updateBillingConfig(clientId: number, data: Record<string, unknown>): Promise<any> {
    // Translate legacy snake_case keys from v2 callers to v4's camelCase zod
    // schema. Drop keys v4 doesn't support (e.g. storageFeePerCuFt) so they
    // don't trigger a 400 rejection. v4 accepted keys (per src/routes/billing.ts
    // configBody): pickPackFee, pickPackMaxUnits, additionalUnitFee,
    // packageCostMarkup, shippingMarkupPct, shippingMarkupFlat, billingMode,
    // active.
    const rename: Record<string, string> = {
      billing_mode: 'billingMode',
      pick_pack_fee: 'pickPackFee',
      pick_pack_max_units: 'pickPackMaxUnits',
      additional_unit_fee: 'additionalUnitFee',
      package_cost_markup: 'packageCostMarkup',
      shipping_markup_pct: 'shippingMarkupPct',
      shipping_markup_flat: 'shippingMarkupFlat',
      hugrab_shipping_rate_override_enabled: 'hugrabShippingRateOverrideEnabled',
      hugrab_shipping_rate_override_threshold: 'hugrabShippingRateOverrideThreshold',
      hugrab_shipping_rate_override_amount: 'hugrabShippingRateOverrideAmount',
    };
    const ACCEPTED = new Set([
      'pickPackFee',
      'pickPackMaxUnits',
      'additionalUnitFee',
      'packageCostMarkup',
      'shippingMarkupPct',
      'shippingMarkupFlat',
      'hugrabShippingRateOverrideEnabled',
      'hugrabShippingRateOverrideThreshold',
      'hugrabShippingRateOverrideAmount',
      'billingMode',
      'active',
    ]);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      const outKey = rename[k] ?? k;
      if (!ACCEPTED.has(outKey)) continue; // silently drop unknown keys
      payload[outKey] = v;
    }
    return safe(
      'updateBillingConfig',
      async () => {
        const res = await api.put<any>(`/billing/config/${clientId}`, payload);
        clearCachedReads('fetchBillingConfigs', 'fetchBillingSummary');
        return res;
      },
      {}
    );
  },

  // PS-220/PS-327: opt a client in/out of the backend shipping margin policy. Admin-only
  // endpoint (the flag is off the drizzle schema; written via raw SQL server-side).
  setClientHouseAccount(clientId: number, enabled: boolean): Promise<any> {
    return safe(
      'setClientHouseAccount',
      async () => {
        const res = await api.patch<any>(`/admin/clients/${clientId}/house-account`, { enabled });
        clearCachedReads('fetchBillingConfigs');
        return res;
      },
      {}
    );
  },

  generateBilling(from: string, to: string, clientId?: number): Promise<any> {
    return safe(
      'generateBilling',
      async () => {
        const res = await api.post<any>('/billing/generate', {
          from,
          to,
          ...(clientId != null ? { clientId } : {}),
        });
        clearCachedReads('fetchBillingSummary', 'fetchShippingMarginAnalytics');
        return res;
      },
      {}
    );
  },

  fetchBillingGenerationStatus(from: string, to: string, clientId?: number): Promise<any> {
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    return safe(
      'fetchBillingGenerationStatus',
      () => api.get<any>(`/billing/generate/status${qs({ dateFrom, dateTo, clientId })}`),
      { upToDate: false, missingFrom: from, missingTo: to }
    );
  },

  fetchBillingSummary(from: string, to: string, clientFilter?: number | number[]): Promise<any[]> {
    // v4's /billing/summary validates `dateFrom`/`dateTo` as ISO datetime
    // (z.string().datetime()) — plain `YYYY-MM-DD` or the legacy `from`/`to`
    // param names will 400. Coerce both.
    //
    // Response shape (per src/services/billing.ts):
    //   { clients: [{clientId, total, byType, count}], grandTotal }
    // v2 BillingView expects a flat array of rows with clientName + per-type
    // totals. Reshape here and resolve clientName via a parallel /clients fetch
    // (the /billing/summary response doesn't join client names).
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    const clientParams = billingClientFilterParams(clientFilter);
    return cachedSafe(
      'fetchBillingSummary',
      `fetchBillingSummary:${dateFrom ?? ''}:${dateTo ?? ''}:${clientParams.clientId ?? clientParams.clientIds ?? ''}`,
      60_000,
      10 * 60_000,
      async () => {
        const [res, clientsRes] = await Promise.all([
          api.get<any>(`/billing/summary${qs({ dateFrom, dateTo, ...clientParams })}`),
          apiClient.fetchClients().catch(() => []),
        ]);

        // Backwards-compat: if server one day changes to a flat array or a
        // {data: []} envelope, pass it through untouched.
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;

        const clientsArr = Array.isArray(clientsRes) ? clientsRes : [];
        const nameById = new Map<number, string>();
        for (const c of clientsArr) {
          if (c?.id != null) nameById.set(c.id, c?.name ?? '');
        }

        const entries = Array.isArray(res?.clients) ? res.clients : [];
        return entries.map((e: any) => {
          const byType = (e?.byType ?? {}) as Record<string, number | undefined>;
          const total = e?.total ?? 0;
          return {
            clientId: e?.clientId,
            clientName:
              (e?.clientId != null ? nameById.get(e.clientId) : undefined) ??
              e?.clientName ??
              'Unknown',
            orderCount: e?.count ?? 0,
            pickPackTotal: byType.pick_pack ?? 0,
            additionalTotal: byType.additional_unit ?? 0,
            packageTotal: byType.package_cost ?? 0,
            shippingTotal: byType.shipping ?? 0,
            total,
            // BillingView's summary table reads row.grandTotal for the final
            // column; expose the same value under both keys so the UI works
            // whether the view is updated or not.
            grandTotal: total,
          };
        });
      },
      [],
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 10 * 60_000, throwOnError: true }
    );
  },

  fetchShippingMarginAnalytics(from: string, to: string, clientFilter?: number | number[]): Promise<any> {
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    const clientParams = billingClientFilterParams(clientFilter);
    return cachedSafe(
      'fetchShippingMarginAnalytics',
      `fetchShippingMarginAnalytics:${dateFrom ?? ''}:${dateTo ?? ''}:${clientParams.clientId ?? clientParams.clientIds ?? ''}`,
      60_000,
      10 * 60_000,
      async () => {
        const res = await api.get<any>(`/billing/shipping-margin${qs({ dateFrom, dateTo, ...clientParams })}`);
        return res?.data ?? res;
      },
      {
        summary: {
          rowCount: 0,
          marginRowCount: 0,
          frozenCount: 0,
          projectedCount: 0,
          missingBillableCount: 0,
          missingActualCostCount: 0,
          missingAnyProofCount: 0,
          actualShippingTotal: 0,
          billableShippingTotal: 0,
          marginTotal: 0,
          marginPct: null,
        },
        clients: [],
        rows: [],
      },
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 10 * 60_000, throwOnError: true }
    );
  },

  fetchBillingDetails(from: string, to: string, clientId: number): Promise<any[]> {
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    // PS-069: do NOT wrap this in safe(...,[]). A real /billing/details failure
    // (500/403/timeout) must REJECT so BillingView's catch can show "details
    // failed to load" instead of a false "No line items found" empty state. A
    // genuine 200 with an empty or `{data:[]}` body still resolves to [] (a
    // legitimate empty range). fetchBillingSummary already throws on error
    // (throwOnError:true) — this brings details to the same honesty.
    return (async () => {
      const res = await api.get<any>(
        `/billing/details${qs({ dateFrom, dateTo, clientId })}`
      );
      if (Array.isArray(res)) return res;
      if (Array.isArray(res?.data)) return res.data;
      return [];
    })();
  },

  // PS-373 (slice 2): admin drilldown for a client's FROZEN storage proof over a
  // billing period. Returns the sidecar the backend froze at generate time
  // ({ found:true, skuCount, proof:{ skuProofs, exceptions }, … }) or
  // { found:false, proof:null } for a period with no storage proof. Not wrapped
  // in safe(...) — a real 403/500 must REJECT so the modal shows an honest error
  // rather than a false "no proof" empty state (same contract as fetchBillingDetails).
  fetchBillingStorageProof(clientId: number, from: string, to: string): Promise<any> {
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    return api.get<any>(`/billing/storage-proof${qs({ dateFrom, dateTo, clientId })}`);
  },

  updateBillingDetail(orderId: number, clientId: number, data: Record<string, unknown>): Promise<any> {
    return api.patch<any>(`/billing/details/${orderId}`, {
      clientId,
      ...data,
    }).then((res) => {
      clearCachedReads('fetchBillingSummary', 'fetchShippingMarginAnalytics');
      return res;
    });
  },

  hugrabBillingShippingFloor(data: {
    action: 'floor' | 'revert';
    dateFrom: string;
    dateTo: string;
    selectedRateBelow?: number;
    targetShipping?: number;
    apply?: boolean;
    expectedCount?: number;
    limit?: number;
  }): Promise<any> {
    return api.post<any>('/billing/hugrab-shipping-floor', data).then((res) => {
      if (data.apply) {
        clearCachedReads('fetchBillingSummary', 'fetchShippingMarginAnalytics');
      }
      return res?.data ?? res;
    });
  },

  fetchBillingPackagePrices(clientId: number): Promise<any[]> {
    return cachedSafe(
      'fetchBillingPackagePrices',
      `fetchBillingPackagePrices:${clientId}`,
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(
          `/billing/package-prices${qs({ clientId })}`
        );
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      [],
      { fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  saveBillingPackagePrices(data: Record<string, unknown>): Promise<any> {
    return safe(
      'saveBillingPackagePrices',
      async () => {
        const res = await api.put<any>('/billing/package-prices', data);
        clearCachedReads('fetchBillingPackagePrices', 'fetchBillingSummary');
        return res;
      },
      {}
    );
  },

  setDefaultPackagePrice(packageId: number, price: number): Promise<any> {
    return safe(
      'setDefaultPackagePrice',
      async () => {
        const res = await api.post<any>('/billing/package-prices/set-default', { packageId, price });
        clearCachedReads('fetchBillingPackagePrices', 'fetchBillingSummary');
        return res;
      },
      {}
    );
  },

  fetchBillingReferenceRates(): Promise<any> {
    return safe(
      'fetchBillingReferenceRates',
      () => api.post<any>('/billing/fetch-ref-rates', {}),
      {}
    );
  },

  fetchBillingReferenceRateStatus(): Promise<any> {
    return safe(
      'fetchBillingReferenceRateStatus',
      () => api.get<any>('/billing/fetch-ref-rates/status'),
      {}
    );
  },

  backfillBillingReferenceRates(data: Record<string, unknown>): Promise<any> {
    return safe(
      'backfillBillingReferenceRates',
      () => api.post<any>('/billing/backfill-ref-rates', data),
      {}
    );
  },

  // ─── Rates ─────────────────────────────────────────────────────────────────
  // Legacy calculator adapter. Transport still goes through the single
  // /rates/browse owner; this method only returns the old array shape consumed
  // by RatesView/NewOrder preview.
  fetchRates(data: Record<string, unknown>): Promise<any[]> {
    return postRateBrowseTransport(data).then((backendResult) => toLegacyRateArray(backendResult));
  },
  fetchCachedRatesBulk(items: Record<string, unknown>[]): Promise<any[]> {
    return safe(
      'fetchCachedRatesBulk',
      async () => {
        const res = await api.post<any>('/rates/cached/bulk', {
          items: items.map((item) => translateRatePayloadToV4(item)),
        });
        return Array.isArray(res?.data)
          ? res.data.map((item: any) => ({
              ...item,
              hit: item?.hit
                ? {
                    ...item.hit,
                    rates: Array.isArray(item.hit.rates)
                      ? item.hit.rates.map(translateRateToLegacyDisplayShape)
                      : [],
                    bestRate: item.hit.bestRate ?? null,
                  }
                : null,
            }))
          : [];
      },
      []
    );
  },

  // Thin wrapper around POST /rates/browse. Backend owns rate ranking, proof,
  // money aliases, freshness, bestRate, and secondBestRate; pass through its
  // DTO without rebuilding fields in the client.
  browseRates(data: Record<string, unknown>): Promise<any> {
    return postRateBrowseTransport(data);
  },

  // Server-aggregated daily order counts split by status. Replaces the
  // previous Dashboard pattern of paginating through every order in the
  // 30-day window (up to 5000 rows!) just to bucket them client-side.
  // Backend does ONE GROUP BY query and returns ~30 rows. See
  // src/routes/orders.ts /daily-counts.


  fetchDashboardDailyCounts(query: { from: string; to: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    data: Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }>;
    meta?: DashboardProvenance | null;
  }> {
    return safe(
      'fetchDashboardDailyCounts',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        const res: any = await api.get<any>(`/dashboard/daily-counts${qs(q)}`);
        const data = Array.isArray(res?.data) ? res.data : [];
        // PS-325 (slice 4): pass the backend provenance envelope through verbatim (additive).
        return { data, meta: (res?.meta as DashboardProvenance | undefined) ?? null };
      },
      { data: [] as Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }>, meta: null }
    );
  },

  startRateBrowseWorkflow(data: Record<string, unknown>): Promise<any> {
    const body = translateRatePayloadToV4(data);
    const requestedCarrierIds = Array.isArray(body.carrierIds)
      ? body.carrierIds.map((value) => String(value)).filter(Boolean)
      : [];
    const preferredCarrierId =
      typeof body.preferredCarrierId === 'string'
        ? body.preferredCarrierId
        : requestedCarrierIds[0];
    return api.post<any>('/rates/browse/workflow', {
      ...body,
      ...(requestedCarrierIds.length ? { carrierIds: requestedCarrierIds } : {}),
      ...(preferredCarrierId ? { preferredCarrierId } : {}),
    });
  },

  fetchRateBrowseWorkflow(jobId: string): Promise<any> {
    return api.get<any>(`/rates/browse/workflow/${encodeURIComponent(jobId)}`);
  },
  // ─── Analysis ──────────────────────────────────────────────────────────────

  // Per-client daily order COUNT (and value) for the Daily Orders Trend
  // multi-line ("All Clients") view. Returns long rows; the caller pivots to
  // one line per client. The chart plots `count` (order count) — `revenue` is
  // returned too for tooltips/future use.
  fetchDashboardDailyRevenueByClient(query: { from: string; to: string; storeId?: number; hideTestOrders?: boolean }): Promise<{
    data: Array<{ day: string; clientId: number | null; revenue: number; count: number }>;
  }> {
    return safe(
      'fetchDashboardDailyRevenueByClient',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        const res: any = await api.get<any>(`/dashboard/daily-revenue-by-client${qs(q)}`);
        const data = Array.isArray(res?.data) ? res.data : [];
        return { data };
      },
      { data: [] as Array<{ day: string; clientId: number | null; revenue: number; count: number }> }
    );
  },

  fetchDashboardSummary(query: { from: string; to: string; sevenFrom?: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    revenue: number;
    units: number;
    bySku: Array<{ sku: string; revenue: number; units30: number; units7: number }>;
    dailyRevenue: Array<{ day: string; revenue: number }>;
    meta?: DashboardProvenance | null;
  }> {
    return safe(
      'fetchDashboardSummary',
      async () => {
        const q: Record<string, string | number | boolean> = {
          from: query.from,
          to: query.to,
        };
        if (query.sevenFrom) q.sevenFrom = query.sevenFrom;
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        const res: any = await api.get<any>(`/dashboard/summary${qs(q)}`);
        return {
          revenue: Number(res?.revenue) || 0,
          units: Number(res?.units) || 0,
          bySku: Array.isArray(res?.bySku) ? res.bySku : [],
          dailyRevenue: Array.isArray(res?.dailyRevenue) ? res.dailyRevenue : [],
          // PS-325 (slice 4): pass the backend provenance envelope through verbatim (additive).
          meta: (res?.meta as DashboardProvenance | undefined) ?? null,
        };
      },
      {
        revenue: 0,
        units: 0,
        bySku: [] as Array<{ sku: string; revenue: number; units30: number; units7: number }>,
        dailyRevenue: [] as Array<{ day: string; revenue: number }>,
        meta: null,
      }
    );
  },

  fetchDashboardShippingMarginAnalytics(query: {
    from: string;
    to: string;
    clientId?: number;
    storeId?: number;
  }): Promise<any> {
    const q: Record<string, string | number> = {
      from: query.from,
      to: query.to,
    };
    if (query.clientId !== undefined) q.clientId = query.clientId;
    if (query.storeId !== undefined) q.storeId = query.storeId;
    return api.get<any>(`/dashboard/shipping-margin${qs(q)}`)
      .then((res: any) => res?.data ?? res)
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) {
          return apiClient.fetchShippingMarginAnalytics(query.from, query.to, query.clientId);
        }
        throw err;
      });
  },

  fetchDashboardSkuTrends(query: {
    from: string;
    to: string;
    top?: number;
    topN?: number;
    clientId?: number;
    storeId?: number;
    hideTestOrders?: boolean;
    includeCancelled?: boolean;
  }): Promise<any> {
    return safe(
      'fetchDashboardSkuTrends',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.top !== undefined) q.top = query.top;
        if (query.topN !== undefined) q.topN = query.topN;
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        if (query.includeCancelled !== undefined) q.includeCancelled = query.includeCancelled;

        const res: any = await api.get<any>(`/dashboard/sku-trends${qs(q)}`);
        const topSkusRaw = Array.isArray(res?.topSkus) ? res.topSkus : [];
        const daysArr = Array.isArray(res?.days) ? res.days : [];
        const dates = daysArr.map((d: any) => d?.day).filter(Boolean);
        const series: Record<string, number[]> = {};
        for (const t of topSkusRaw) {
          if (!t?.sku) continue;
          series[t.sku] = daysArr.map((d: any) => Number(d?.[t.sku]) || 0);
        }
        const topSkus = topSkusRaw
          .map((t: any) => ({
            sku: t.sku,
            name: t.name ?? '',
            total: Number(t.total ?? t.total_qty ?? t.totalQty ?? 0) || 0,
            totalQty: Number(t.total ?? t.total_qty ?? t.totalQty ?? 0) || 0,
          }))
          .sort((left: any, right: any) => right.totalQty - left.totalQty);
        // PS-325 (slice 3b): surface the backend-emitted per-SKU units (additive; series/dates/topSkus
        // above are byte-identical). DashboardView prefers this over re-summing the series.
        const unitsBySku: Record<string, { units30: number; units7: number }> = {};
        for (const u of Array.isArray(res?.unitsBySku) ? res.unitsBySku : []) {
          if (u?.sku) unitsBySku[u.sku] = { units30: Number(u.units30) || 0, units7: Number(u.units7) || 0 };
        }
        return { dates, topSkus, series, unitsBySku };
      },
      { dates: [], topSkus: [], series: {}, unitsBySku: {} }
    );
  },

  fetchDashboardTopSkus(query: {
    from: string;
    to: string;
    limit?: number;
    clientId?: number;
    storeId?: number;
    hideTestOrders?: boolean;
    includeCancelled?: boolean;
  }): Promise<any> {
    return safe(
      'fetchDashboardTopSkus',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.limit !== undefined) q.limit = query.limit;
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        if (query.includeCancelled !== undefined) q.includeCancelled = query.includeCancelled;

        const [breakdown, clientsRes] = await Promise.all([
          api.get<any>(`/dashboard/top-skus${qs(q)}`),
          apiClient.fetchClients().catch(() => []),
        ]);
        const clients = Array.isArray(clientsRes) ? clientsRes : [];
        const nameById = new Map<number, string>();
        for (const c of clients) {
          if (c?.id != null) nameById.set(c.id, c?.name ?? '');
        }
        const parseNum = (v: unknown): number => {
          if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
          if (typeof v === 'string') {
            const n = Number.parseFloat(v);
            return Number.isFinite(n) ? n : 0;
          }
          return 0;
        };
        const rows = Array.isArray(breakdown?.data) ? breakdown.data : [];
        const skus = rows.map((r: any) => {
          const rawInvSkuId =
            r.inv_sku_id ?? r.invSkuId ?? r.inventory_id ?? r.inventoryId ?? null;
          const invSkuId =
            rawInvSkuId == null || rawInvSkuId === '' ? null : Number(rawInvSkuId);

          const standardShipCount = parseNum(
            r.std_ship_count ?? r.standardShipCount ?? r.std_orders ?? 0
          );
          const standardTotalShipping = parseNum(
            r.std_total ?? r.standardTotalShipping ?? r.standardShipTotal
          );
          const standardShipQtyTotal = parseNum(
            r.std_qty_total ?? r.standardShipQtyTotal ?? standardShipCount
          );
          const expeditedShipCount = parseNum(
            r.exp_ship_count ?? r.expeditedShipCount ?? r.exp_orders ?? 0
          );
          const expeditedTotalShipping = parseNum(
            r.exp_total ?? r.expeditedTotalShipping ?? r.expeditedShipTotal
          );
          const expeditedShipQtyTotal = parseNum(
            r.exp_qty_total ?? r.expeditedShipQtyTotal ?? expeditedShipCount
          );
          const shipCountWithCost = parseNum(
            r.ship_count_with_cost ?? r.shipCountWithCost ?? standardShipCount + expeditedShipCount
          );
          const totalShipping = parseNum(r.total_shipping ?? r.totalShipping);
          const totalRevenue = parseNum(r.total_revenue ?? r.totalRevenue);
          const totalQty = parseNum(r.total_qty ?? r.qty);
          const avgSellingPrice =
            totalQty > 0 && totalRevenue > 0
              ? Number((totalRevenue / totalQty).toFixed(2))
              : 0;
          const dailyQtyRaw = r.daily_qty ?? r.dailyQty ?? [];
          const dailyQty: number[] = Array.isArray(dailyQtyRaw)
            ? dailyQtyRaw.map((value: unknown) => {
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : 0;
              })
            : [];

          return {
            sku: r.sku,
            name: r.name ?? '',
            imageUrl: r.image_url ?? r.imageUrl ?? null,
            invSkuId: Number.isFinite(invSkuId) ? invSkuId : null,
            clientId: r.client_id ?? r.clientId ?? null,
            clientName:
              r.client_name ??
              r.clientName ??
              (r.client_id != null ? nameById.get(r.client_id) ?? '' : ''),
            dailyQty,
            orders: parseNum(r.orders),
            pendingOrders: parseNum(r.pending ?? r.pendingOrders),
            externalOrders: parseNum(r.ext_shipped ?? r.externalOrders),
            qty: parseNum(r.total_qty ?? r.qty),
            standardOrders: parseNum(r.std_orders ?? r.standardOrders),
            standardShipCount,
            standardShipQtyTotal,
            standardAvgShipping:
              standardShipQtyTotal > 0
                ? Number((standardTotalShipping / standardShipQtyTotal).toFixed(2))
                : 0,
            standardTotalShipping,
            standardShipTotal: standardTotalShipping,
            expeditedOrders: parseNum(r.exp_orders ?? r.expeditedOrders),
            expeditedShipCount,
            expeditedShipQtyTotal,
            expeditedAvgShipping:
              expeditedShipQtyTotal > 0
                ? Number((expeditedTotalShipping / expeditedShipQtyTotal).toFixed(2))
                : 0,
            expeditedTotalShipping,
            expeditedShipTotal: expeditedTotalShipping,
            shipCountWithCost,
            blendedAvgShipping:
              shipCountWithCost > 0 ? Number((totalShipping / shipCountWithCost).toFixed(2)) : 0,
            totalShipping,
            totalRevenue,
            avgSellingPrice,
            totalSellingFee: parseNum(
              r.total_selling_fee
              ?? r.totalSellingFee
              ?? r.sellingFee
              ?? r.sellingFeeTotal
            ),
          };
        });
        return {
          skus,
          orderCount: breakdown?.totalOrders ?? 0,
        };
      },
      { skus: [], orderCount: 0 }
    );
  },

  // PS-213 — multi-SKU combination sales (Dashboard Combos tab). Backend owns
  // normalization (PS-037 combo key) + scoping; this is a thin pass-through.
  fetchDashboardTopCombos(query: {
    from: string;
    to: string;
    limit?: number;
    clientId?: number;
    storeId?: number;
    hideTestOrders?: boolean;
    includeCancelled?: boolean;
  }): Promise<{
    combos: Array<{
      comboKey: string;
      items: Array<{ sku: string; qty: number; name: string | null }>;
      skuCount: number;
      comboSales: number;
      units: number;
      revenue: number | null;
    }>;
    totalCombos: number;
    multiSkuOrders: number;
  }> {
    return safe(
      'fetchDashboardTopCombos',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.limit !== undefined) q.limit = query.limit;
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        if (query.includeCancelled !== undefined) q.includeCancelled = query.includeCancelled;
        const res: any = await api.get<any>(`/dashboard/top-combos${qs(q)}`);
        return {
          combos: Array.isArray(res?.combos) ? res.combos : [],
          totalCombos: Number(res?.totalCombos ?? 0) || 0,
          multiSkuOrders: Number(res?.multiSkuOrders ?? 0) || 0,
        };
      },
      { combos: [], totalCombos: 0, multiSkuOrders: 0 }
    );
  },

  fetchDashboardInventoryRisk(query?: { clientId?: number; active?: boolean; pageSize?: number }): Promise<{
    items: any[];
    total: number;
    // PS-325 (slice 4): the backend In/Low/Out snapshot (slice 1) was being DROPPED here — restore it
    // so DashboardView prefers the authoritative backend snapshot (+ its computedAt) over the fallback.
    snapshot?: unknown;
  }> {
    const q: Record<string, string | number | boolean> = {};
    if (query?.clientId !== undefined) q.clientId = query.clientId;
    if (query?.active !== undefined) q.active = query.active;
    if (query?.pageSize !== undefined) q.pageSize = query.pageSize;
    return cachedSafe(
      'fetchDashboardInventoryRisk',
      `fetchDashboardInventoryRisk:${JSON.stringify(q)}`,
      60_000,
      10 * 60_000,
      async () => {
        const res: any = await api.get<any>(`/dashboard/inventory-risk${qs(q)}`);
        return {
          items: Array.isArray(res?.items) ? res.items : [],
          total: Number(res?.total) || 0,
          snapshot: res?.snapshot ?? null,
        };
      },
      { items: [], total: 0, snapshot: null },
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 10 * 60_000 }
    );
  },

  fetchAnalysisDailySales(query: Record<string, unknown>): Promise<any> {
    // v2 AnalysisView expects `{dates, topSkus, series: {[sku]: number[]}}`.
    // v4's `/analysis/sku-daily` returns `{topSkus:[{sku,name,total_qty}], days:[{day, [sku]:qty, ...}]}`.
    // Reshape `days[]` → parallel `dates[]` + per-sku `series` arrays.
    return safe(
      'fetchAnalysisDailySales',
      async () => {
        const q = normalizeAnalysisRange(query);
        const res: any = await api.get<any>(`/analysis/sku-daily${qs(q)}`);
        const topSkusRaw = Array.isArray(res?.topSkus) ? res.topSkus : [];
        const daysArr = Array.isArray(res?.days) ? res.days : [];
        const dates = daysArr.map((d: any) => d?.day).filter(Boolean);
        const series: Record<string, number[]> = {};
        for (const t of topSkusRaw) {
          if (!t?.sku) continue;
          series[t.sku] = daysArr.map((d: any) => Number(d?.[t.sku]) || 0);
        }
        const topSkus = topSkusRaw
          .map((t: any) => ({
            sku: t.sku,
            name: t.name ?? '',
            total: Number(t.total ?? t.total_qty ?? t.totalQty ?? 0) || 0,
            totalQty: Number(t.total ?? t.total_qty ?? t.totalQty ?? 0) || 0,
          }))
          .sort((left: any, right: any) => right.totalQty - left.totalQty);
        return { dates, topSkus, series };
      },
      { dates: [], topSkus: [], series: {} }
    );
  },

  fetchAnalysisSkus(query: Record<string, unknown>): Promise<any> {
    // AnalysisView expects `{skus: AnalysisSkuDto[], orderCount}`. The rich
    // per-SKU breakdown (pending/ext/std/exp counts + totals) lives in v4's
    // `/analysis/sku-breakdown`, not `/top-skus`. Also resolve clientName.
    return safe(
      'fetchAnalysisSkus',
      async () => {
        const q = normalizeAnalysisRange(query);
        const [breakdown, clientsRes] = await Promise.all([
          api.get<any>(`/analysis/sku-breakdown${qs(q)}`),
          apiClient.fetchClients().catch(() => []),
        ]);
        const clients = Array.isArray(clientsRes) ? clientsRes : [];
        const nameById = new Map<number, string>();
        for (const c of clients) {
          if (c?.id != null) nameById.set(c.id, c?.name ?? '');
        }
        const parseNum = (v: unknown): number => {
          if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
          if (typeof v === 'string') {
            const n = Number.parseFloat(v);
            return Number.isFinite(n) ? n : 0;
          }
          return 0;
        };
        const rows = Array.isArray(breakdown?.data) ? breakdown.data : [];
        const skus = rows.map((r: any) => {
          const rawInvSkuId =
            r.inv_sku_id ?? r.invSkuId ?? r.inventory_id ?? r.inventoryId ?? null;
          const invSkuId =
            rawInvSkuId == null || rawInvSkuId === '' ? null : Number(rawInvSkuId);

          const standardShipCount = parseNum(
            r.std_ship_count ?? r.standardShipCount ?? r.std_orders ?? 0
          );
          const standardTotalShipping = parseNum(
            r.std_total ?? r.standardTotalShipping ?? r.standardShipTotal
          );
          // Per-UNIT shipping (boss directive 2026-05-07): qty totals
          // for std/exp orders so the FE can compute avg-per-unit
          // instead of avg-per-order. Falls back to ship-count when
          // the new fields aren't present (older API responses).
          const standardShipQtyTotal = parseNum(
            r.std_qty_total ?? r.standardShipQtyTotal ?? standardShipCount
          );
          const expeditedShipCount = parseNum(
            r.exp_ship_count ?? r.expeditedShipCount ?? r.exp_orders ?? 0
          );
          const expeditedTotalShipping = parseNum(
            r.exp_total ?? r.expeditedTotalShipping ?? r.expeditedShipTotal
          );
          const expeditedShipQtyTotal = parseNum(
            r.exp_qty_total ?? r.expeditedShipQtyTotal ?? expeditedShipCount
          );
          const shipCountWithCost = parseNum(
            r.ship_count_with_cost ?? r.shipCountWithCost ?? standardShipCount + expeditedShipCount
          );
          const totalShipping = parseNum(r.total_shipping ?? r.totalShipping);
          // 2026-05-12 new columns: revenue + avg selling price.
          // total_revenue is the server-side SUM(unit_price × qty);
          // avg selling price = revenue / units (computed FE-side so
          // we don't ship two numbers when one suffices). Falls back
          // to 0 when the SKU has no unit_price set on its line items.
          const totalRevenue = parseNum(r.total_revenue ?? r.totalRevenue);
          const totalQty = parseNum(r.total_qty ?? r.qty);
          const avgSellingPrice =
            totalQty > 0 && totalRevenue > 0
              ? Number((totalRevenue / totalQty).toFixed(2))
              : 0;

          // Units-trend sparkline source: aligned [units/day] array,
          // one slot per date bucket in the selected range. Empty/missing
          // → empty array so AnalysisDataTable just renders a flat baseline.
          const dailyQtyRaw = r.daily_qty ?? r.dailyQty ?? [];
          const dailyQty: number[] = Array.isArray(dailyQtyRaw)
            ? dailyQtyRaw.map((value: unknown) => {
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : 0;
              })
            : [];

          return {
            sku: r.sku,
            name: r.name ?? '',
            imageUrl: r.image_url ?? r.imageUrl ?? null,
            invSkuId: Number.isFinite(invSkuId) ? invSkuId : null,
            clientId: r.client_id ?? r.clientId ?? null,
            clientName:
              r.client_name ??
              r.clientName ??
              (r.client_id != null ? nameById.get(r.client_id) ?? '' : ''),
            dailyQty,
            orders: parseNum(r.orders),
            pendingOrders: parseNum(r.pending ?? r.pendingOrders),
            externalOrders: parseNum(r.ext_shipped ?? r.externalOrders),
            qty: parseNum(r.total_qty ?? r.qty),
            standardOrders: parseNum(r.std_orders ?? r.standardOrders),
            standardShipCount,
            standardShipQtyTotal,
            // Per-UNIT avg: divide total cost by total UNITS shipped via
            // std (not by order count). For an order with 2 units at
            // $23 label cost, this yields $11.50/unit instead of $23.
            standardAvgShipping:
              standardShipQtyTotal > 0
                ? Number((standardTotalShipping / standardShipQtyTotal).toFixed(2))
                : 0,
            standardTotalShipping,
            standardShipTotal: standardTotalShipping,
            expeditedOrders: parseNum(r.exp_orders ?? r.expeditedOrders),
            expeditedShipCount,
            expeditedShipQtyTotal,
            expeditedAvgShipping:
              expeditedShipQtyTotal > 0
                ? Number((expeditedTotalShipping / expeditedShipQtyTotal).toFixed(2))
                : 0,
            expeditedTotalShipping,
            expeditedShipTotal: expeditedTotalShipping,
            shipCountWithCost,
            blendedAvgShipping:
              shipCountWithCost > 0 ? Number((totalShipping / shipCountWithCost).toFixed(2)) : 0,
            totalShipping,
            totalRevenue,
            avgSellingPrice,
            // 2026-05-13: per-SKU seller-fee total (Walmart first;
            // future marketplaces add in via similar fetcher endpoints).
            // Backend returns total_selling_fee; legacy aliases (camel
            // / sellingFee / sellingFeeTotal) are coalesced to be
            // resilient against shape drift. Profit is derived FE-side
            // as revenue - shipping - sellingFee for the new Profit
            // column on the Analysis page.
            totalSellingFee: parseNum(
              r.total_selling_fee
              ?? r.totalSellingFee
              ?? r.sellingFee
              ?? r.sellingFeeTotal
            ),
          };
        });
        return {
          skus,
          orderCount: breakdown?.totalOrders ?? 0,
        };
      },
      { skus: [], orderCount: 0 }
    );
  },

  // ─── Manifests ─────────────────────────────────────────────────────────────
  async downloadManifest(data: {
    startDate?: string;
    endDate?: string;
    [k: string]: unknown;
  }): Promise<{ blob: Blob; filename: string }> {
    // GET /manifests/generate returns JSON ({ data: [...] }). Previously this
    // saved that JSON straight into a .csv file, so Excel dumped the whole blob
    // into one cell. Fetch the JSON and build a real column-laid-out CSV here.
    // api.get throws on a non-2xx so ManifestsView's try/catch surfaces the
    // server error in a toast instead of downloading a broken file.
    const path = `/manifests/generate${qs(data as any)}`;
    const res = await api.get<any>(path);
    const csv = buildManifestCsv(manifestRowsFromResponse(res));
    // Prepend a UTF-8 BOM so Excel opens the CSV with the correct encoding and
    // splits it into columns instead of one cell.
    const blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' });
    const start = data.startDate ?? 'unknown';
    const end = data.endDate ?? 'unknown';
    return { blob, filename: `manifest_${start}_${end}.csv` };
  },
};

export type V2ApiClient = typeof apiClient;
export default apiClient;

