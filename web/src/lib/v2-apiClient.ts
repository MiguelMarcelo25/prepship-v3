/**
 * v2 apiClient adapter → v4 api.
 *
 * Mirrors the method surface of v2's `apps/react/src/api/client.ts` so
 * the wholesale OrdersView.tsx (and other v2 views) port without touching
 * call sites. Every method is wrapped in try/catch and returns a safe
 * default on error — v2 components don't expect throws.
 *
 * Paths and body shapes follow what the v4 Hono routes actually accept,
 * not the verbatim v2 paths. Methods that have no v4 equivalent warn once
 * and return a harmless default.
 */

import { api, qs } from './api';
import { supabase } from './supabase';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const h: Record<string, string> = {};
  if (session?.access_token) h['Authorization'] = `Bearer ${session.access_token}`;
  return h;
}

function parseDownloadFilename(
  contentDisposition: string | null,
  fallback: string
): string {
  if (!contentDisposition) return fallback;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
  }
  const simpleMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (simpleMatch?.[1]) return simpleMatch[1].trim();
  return fallback;
}

// Clients that should be hidden from the sidebar + per-client stats views.
// Matched case-insensitively by name. Add more names here to hide them.
// Orders with these clientIds are also excluded from the main orders table
// via excludeClientId in useOrders (HIDDEN_CLIENT_IDS is populated by
// isHiddenClient as a side-effect of fetchStores/fetchCounts).
const HIDDEN_CLIENT_NAMES = new Set(['api shipments']);

// Populated by fetchStores / fetchCounts when clients are loaded — lets
// downstream filtering (e.g. byStatusStore emission) drop rows for hidden
// clients even when we only have the id.
export const HIDDEN_CLIENT_IDS = new Set<number>();

function isHiddenClient(c: { name?: string | null; id?: number | null } | null | undefined): boolean {
  if (!c) return false;
  const name = (c.name ?? '').trim().toLowerCase();
  if (HIDDEN_CLIENT_NAMES.has(name)) {
    if (typeof c.id === 'number') HIDDEN_CLIENT_IDS.add(c.id);
    return true;
  }
  return false;
}

// Coerce a date-ish input ('YYYY-MM-DD' or any ISO string) to an ISO datetime
// anchored at start-of-day / end-of-day. Used for endpoints that validate
// `z.string().datetime()` where a plain `YYYY-MM-DD` would be rejected.
function toIsoDayStart(d: string | undefined | null): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T00:00:00.000Z`).toISOString();
}
function toIsoDayEnd(d: string | undefined | null): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T23:59:59.999Z`).toISOString();
}

function normalizeAnalysisRange(query: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    out[k] = v as string | number | boolean;
  }
  const toIso = (d: unknown, endOfDay: boolean): string | undefined => {
    if (typeof d !== 'string' || !d) return undefined;
    if (d.includes('T')) return d;
    return new Date(`${d}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
  };
  if (out.from != null && out.dateFrom == null) {
    const iso = toIso(out.from, false);
    if (iso) out.dateFrom = iso;
    delete out.from;
  }
  if (out.to != null && out.dateTo == null) {
    const iso = toIso(out.to, true);
    if (iso) out.dateTo = iso;
    delete out.to;
  }
  if (typeof out.dateFrom === 'string') {
    const iso = toIso(out.dateFrom, false);
    if (iso) out.dateFrom = iso;
  }
  if (typeof out.dateTo === 'string') {
    const iso = toIso(out.dateTo, true);
    if (iso) out.dateTo = iso;
  }
  return out;
}

async function safe<T>(
  methodName: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(
      `[v2-apiClient] ${methodName} failed:`,
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

function notImpl<T>(methodName: string, fallback: T): Promise<T> {
  console.warn(`[v2-apiClient] ${methodName}: no v4 equivalent; returning default`);
  return Promise.resolve(fallback);
}

// ── Rate payload / response translation ──────────────────────────────────────
// Accepts either v4 shape or legacy v2 shape and normalizes to what v4's
// POST /rates Zod schema expects. Used by fetchRates — do NOT call directly
// from components; go through apiClient.fetchRates so callers can keep using
// the v2 input convention if they prefer.
function translateRatePayloadToV4(
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // weight: v4 expects a flat `weightOz` (number); v2 sends `weight.{value,units}`.
  if (typeof input.weightOz === 'number') {
    out.weightOz = input.weightOz;
  } else {
    const weight = input.weight as
      | { value?: unknown; units?: unknown }
      | undefined;
    if (weight && typeof weight.value === 'number') {
      const units =
        typeof weight.units === 'string' ? weight.units.toLowerCase() : 'ounces';
      out.weightOz = units === 'pounds' ? weight.value * 16 : weight.value;
    }
  }

  // destination zip: v2 uses `toPostalCode`, v4 uses `toZip`.
  if (typeof input.toZip === 'string' && input.toZip.length >= 3) {
    out.toZip = input.toZip;
  } else if (typeof input.toPostalCode === 'string') {
    out.toZip = input.toPostalCode;
  }

  // string passthroughs (names match across v2/v4).
  for (const k of ['toCountry', 'toState', 'toCity', 'toAddress', 'toName'] as const) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }

  if (typeof input.residential === 'boolean') out.residential = input.residential;
  if (typeof input.forceRefresh === 'boolean') out.forceRefresh = input.forceRefresh;
  if (Array.isArray(input.carrierIds)) out.carrierIds = input.carrierIds;

  // dims: v4 uses flat dimsL/W/H; v2 wraps them under `dimensions`.
  const dims = input.dimensions as
    | { length?: unknown; width?: unknown; height?: unknown }
    | undefined;
  const flatL = typeof input.dimsL === 'number' ? input.dimsL : undefined;
  const flatW = typeof input.dimsW === 'number' ? input.dimsW : undefined;
  const flatH = typeof input.dimsH === 'number' ? input.dimsH : undefined;
  const wrappedL =
    dims && typeof dims.length === 'number' ? dims.length : undefined;
  const wrappedW =
    dims && typeof dims.width === 'number' ? dims.width : undefined;
  const wrappedH =
    dims && typeof dims.height === 'number' ? dims.height : undefined;
  const L = flatL ?? wrappedL;
  const W = flatW ?? wrappedW;
  const H = flatH ?? wrappedH;
  // v4 Zod requires dims to be strictly positive — omit zero/negative.
  if (typeof L === 'number' && L > 0) out.dimsL = L;
  if (typeof W === 'number' && W > 0) out.dimsW = W;
  if (typeof H === 'number' && H > 0) out.dimsH = H;

  return out;
}

// Maps v4's ShipStation-v2-passthrough rate object to the v2-legacy shape
// the bulk-ported components read. Defensive: if a caller already hands us
// v2-shape data (has `amount` + `carrierCode`), return it unchanged.
function translateRateToV2Shape(r: unknown): Record<string, unknown> {
  if (r && typeof r === 'object') {
    const obj = r as Record<string, unknown>;
    if ('amount' in obj && 'carrierCode' in obj) return obj;
    const shipping = obj.shipping_amount as { amount?: unknown } | undefined;
    const other = obj.other_amount as { amount?: unknown } | undefined;
    const shipmentCost =
      typeof shipping?.amount === 'number' ? shipping.amount : 0;
    const otherCost = typeof other?.amount === 'number' ? other.amount : 0;
    return {
      carrierCode: obj.carrier_code ?? null,
      serviceCode: obj.service_code ?? null,
      serviceName: obj.service_type ?? null,
      carrierNickname: obj.carrier_nickname ?? null,
      shippingProviderId: obj.carrier_id ?? null,
      amount: shipmentCost + otherCost,
      shipmentCost,
      otherCost,
      raw: obj,
    };
  }
  return { raw: r };
}

async function fetchBlob(
  methodName: string,
  path: string,
  fallbackFilename: string,
  options: { throwOnError?: boolean } = {}
): Promise<{ blob: Blob; filename: string }> {
  // When `throwOnError` is false (default, back-compat), a failed fetch
  // returns an empty Blob + fallback filename so callers don't need to
  // handle exceptions — used by downloadOrdersExport / downloadQueuePrintJob
  // which pre-date the strict behavior.
  //
  // When `throwOnError` is true, the caller gets a real exception so their
  // try/catch can surface an error toast instead of quietly downloading a
  // 0-byte file (ManifestsView pattern — see MAN1).
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: await authHeaders(),
    });
    if (!res.ok) {
      // Try to pull a human message from the error body before falling
      // back to the status line.
      let message = `${res.status} ${res.statusText}`;
      try {
        const err = await res.json();
        if (err?.error) message = err.error;
      } catch {
        // body wasn't JSON — keep the status-line message
      }
      throw new Error(message);
    }
    return {
      blob: await res.blob(),
      filename: parseDownloadFilename(
        res.headers.get('content-disposition'),
        fallbackFilename
      ),
    };
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn(
      `[v2-apiClient] ${methodName} failed:`,
      err instanceof Error ? err.message : err
    );
    return { blob: new Blob([''], { type: 'text/plain' }), filename: fallbackFilename };
  }
}

type DailyStatsSummary = {
  totalOrders: number;
  needToShip: number;
  upcomingOrders: number;
  window: { from: string; to: string };
};

type V4DailyStatsResponse = {
  data: unknown;
  summary: {
    totalOrders: number;
    needToShip: number;
    shippedTotal: number;
    upcomingOrders: number;
    window: { from: string; to: string };
  };
};

type SettingsRow = { key: string; value: string };
type OrderDimsRow = { l: number; w: number; h: number; weightOz: number | null } | null;

export const apiClient = {
  // ─── Auth / token (no-op — v4 uses Supabase) ────────────────────────────────
  setToken(_token: string): void {
    // No-op: v4 reads the session from supabase.auth; token is managed there.
  },

  // ─── Init / bootstrap ───────────────────────────────────────────────────────
  fetchCounts(filter?: { dateStart?: string; dateEnd?: string }): Promise<any> {
    // v4's /init/counts → { awaiting, shipped, cancelled, on_hold, queue, inventory }
    // v2's sidebar expects { byStatus, byStatusStore }.
    // Since v4 uses `clientId` as the business grouping (not ShipStation's `storeId`)
    // and clients have names ("Tran Agency" etc.) while store IDs don't, we map
    // CLIENTS onto the sidebar's "store" slot. storeId = client.id in this wiring;
    // see fetchStores below for the matching name resolution.
    //
    // Date filter handling: /init/counts ignores query params (no validator)
    // and /clients/order-stats has no date filter on the backend. When the
    // caller wants a bounded count, fall back to three parallel /orders
    // probes (one per status) using the list endpoint's pagination.total.
    // byStatusStore stays all-time since we can't break it down per-client
    // within a date range without N backend calls.
    const hasDate = Boolean(filter?.dateStart || filter?.dateEnd);
    const dateFrom = toIsoDayStart(filter?.dateStart);
    const dateTo = toIsoDayEnd(filter?.dateEnd);
    return safe(
      'fetchCounts',
      async () => {
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
          api.get<any>('/clients/order-stats').catch(() => ({ data: [] })),
          api.get<any>('/clients').catch(() => []),
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
          if (HIDDEN_CLIENT_IDS.has(cid)) continue;
          const a = row?.awaiting ?? 0;
          const s = row?.shipped ?? 0;
          const x = row?.cancelled ?? 0;
          if (a > 0) byStatusStore.push({ orderStatus: 'awaiting_shipment', storeId: cid, cnt: a });
          if (s > 0) byStatusStore.push({ orderStatus: 'shipped', storeId: cid, cnt: s });
          if (x > 0) byStatusStore.push({ orderStatus: 'cancelled', storeId: cid, cnt: x });
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
      { byStatus: [], byStatusStore: [] }
    );
  },

  fetchStores(): Promise<any[]> {
    // v4 has no Store entity with names — each ShipStation store is just a numeric id.
    // We map CLIENTS into the store slot so the sidebar shows "Tran Agency", "KF Goods",
    // etc. instead of raw store IDs. Must stay in sync with fetchCounts above, which
    // emits byStatusStore entries keyed by client.id.
    return safe(
      'fetchStores',
      async () => {
        const clients = await api.get<any>('/clients');
        const arr = Array.isArray(clients) ? clients : [];
        return arr
          .filter((c) => !isHiddenClient(c))
          .map((c) => ({
            storeId: c?.id,
            storeName: c?.name ?? `Client ${c?.id}`,
            active: true,
          }));
      },
      []
    );
  },

  fetchInitData(): Promise<any> {
    return safe('fetchInitData', () => api.get<any>('/init/init-data'), {
      stores: [],
      carriers: [],
    });
  },

  // ─── Clients ────────────────────────────────────────────────────────────────
  fetchClients(): Promise<any[]> {
    return safe(
      'fetchClients',
      async () => {
        const res = await api.get<any>('/clients');
        return Array.isArray(res) ? res : [];
      },
      []
    );
  },

  listClients(): Promise<any[]> {
    return apiClient.fetchClients();
  },

  fetchClientDetail(clientId: number): Promise<any> {
    return safe(
      'fetchClientDetail',
      () => api.get<any>(`/clients/${clientId}`),
      null
    );
  },

  createClient(data: Record<string, unknown>): Promise<any> {
    return safe('createClient', () => api.post<any>('/clients', data), {});
  },

  createClientRecord(data: Record<string, unknown>): Promise<any> {
    return safe('createClientRecord', () => api.post<any>('/clients', data), {});
  },

  updateClient(clientId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'updateClient',
      () => api.patch<any>(`/clients/${clientId}`, data),
      {}
    );
  },

  updateClientRecord(clientId: number, data: Record<string, unknown>): Promise<any> {
    return apiClient.updateClient(clientId, data);
  },

  deleteClientRecord(clientId: number): Promise<any> {
    return safe(
      'deleteClientRecord',
      () => api.delete<any>(`/clients/${clientId}`),
      { ok: true }
    );
  },

  syncClientsFromStores(): Promise<any> {
    return safe(
      'syncClientsFromStores',
      () => api.post<any>('/clients/sync-stores', {}),
      {}
    );
  },

  // ─── Carrier accounts ───────────────────────────────────────────────────────
  fetchCarrierAccounts(): Promise<any[]> {
    return safe(
      'fetchCarrierAccounts',
      async () => {
        const res = await api.get<any>('/init/carrier-accounts');
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.carriers)) return res.carriers;
        return [];
      },
      []
    );
  },

  // ─── Column preferences (settings kv store) ─────────────────────────────────
  fetchColumnPrefs(): Promise<any> {
    return safe(
      'fetchColumnPrefs',
      async () => {
        const row = await api.get<SettingsRow>('/settings/orders.columnPrefs');
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      },
      null
    );
  },

  saveColumnPrefs(prefs: unknown): Promise<any> {
    return safe(
      'saveColumnPrefs',
      () =>
        api.put<any>('/settings/orders.columnPrefs', {
          value: JSON.stringify(prefs ?? null),
        }),
      {}
    );
  },

  // ─── Sync status ────────────────────────────────────────────────────────────
  fetchLegacySyncStatus(): Promise<any> {
    // v4 mounts the order-sync watermark under /orders, not at the root.
    return safe('fetchLegacySyncStatus', () => api.get<any>('/orders/sync/status'), {});
  },

  triggerLegacySync(mode?: 'incremental' | 'full'): Promise<any> {
    return safe(
      'triggerLegacySync',
      () =>
        api.post<any>('/sync/orders', mode === 'full' ? { full: true } : {}),
      { queued: false }
    );
  },

  fetchShipmentSyncStatus(): Promise<any> {
    // Expected v4 backend: GET /shipments/status (T2 punch-list item).
    // Until it lands the call 404s and safe() returns the idle fallback so
    // the topbar pill still renders.
    return safe(
      'fetchShipmentSyncStatus',
      () => api.get<any>('/shipments/status'),
      { status: 'idle' }
    );
  },

  triggerShipmentSync(): Promise<any> {
    // Expected v4 backend: POST /shipments/sync (T2 punch-list item).
    return safe(
      'triggerShipmentSync',
      () => api.post<any>('/shipments/sync', {}),
      { queued: false }
    );
  },

  clearAndRefetchAllRates(): Promise<any> {
    // v2 "clear & refetch" flow = purge the rates cache then kick a fresh
    // order sync so best-rate backfill repopulates. v4 exposes both:
    //   DELETE /rates/cache — empty the cache
    //   POST   /orders/sync — user-initiated sync (JWT-authed mirror of
    //                         /cron/sync-orders; cron path is secret-gated)
    // Response shape matches v2's settings-parity toast, which reads
    // `.message` and `.ordersQueued`.
    return safe(
      'clearAndRefetchAllRates',
      async () => {
        const [cleared, queued] = await Promise.all([
          api.delete<any>('/rates/cache'),
          api.post<any>('/orders/sync', {}),
        ]);
        const deleted = Number(cleared?.deleted ?? 0);
        const synced = Number(queued?.synced ?? 0);
        return {
          ok: true,
          ordersQueued: synced,
          message: `Cleared ${deleted} cached rates — ${synced} orders re-synced`,
          cleared,
          queued,
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
  fetchOrders(query: Record<string, unknown>): Promise<any> {
    return safe(
      'fetchOrders',
      () => api.get<any>(`/orders${qs(query as any)}`),
      { data: [], pagination: { page: 1, pageSize: 0, total: 0, totalPages: 0 } }
    );
  },

  listOrders(query: Record<string, unknown>): Promise<any> {
    return apiClient.fetchOrders(query);
  },

  fetchOrderFull(orderId: number): Promise<any> {
    return safe(
      'fetchOrderFull',
      () => api.get<any>(`/orders/${orderId}/full`),
      null
    );
  },

  updateOrder(orderId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'updateOrder',
      () => api.patch<any>(`/orders/${orderId}`, data),
      {}
    );
  },

  setOrderResidential(orderId: number, residential: boolean | null): Promise<any> {
    return safe(
      'setOrderResidential',
      () => api.patch<any>(`/orders/${orderId}`, { residential }),
      {}
    );
  },

  markOrderShippedExternal(orderId: number, source: string): Promise<any> {
    // v2 "Mark as shipped externally" flow. T2 is extending v4's PATCH
    // /orders/:id schema to accept `externallyShipped` + optional
    // `externallyShippedSource`; both columns already exist on orderOverrides.
    // Until the schema lands the call 400s and safe() returns {ok:false} so
    // the button stays responsive instead of throwing.
    return safe(
      'markOrderShippedExternal',
      () =>
        api.patch<any>(`/orders/${orderId}`, {
          externallyShipped: true,
          externallyShippedSource: source,
        }),
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

  // ─── Orders: stats / picklist / export / dims ───────────────────────────────
  fetchDailyStats(query?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<DailyStatsSummary> {
    // v2 parity — server computes the shift-based PT window (noon→noon on
    // weekdays, expanded Fri-pm through Mon-am to cover weekend orders).
    // Don't default dateFrom/dateTo here: if the caller doesn't pass them,
    // the server applies the shift window and returns labels in PT.
    const fallback: DailyStatsSummary = {
      totalOrders: 0,
      needToShip: 0,
      upcomingOrders: 0,
      window: { from: '', to: '', fromLabel: '', toLabel: '' } as any,
    };
    return safe(
      'fetchDailyStats',
      async () => {
        // HIDDEN_CLIENT_IDS is populated lazily as a side-effect of
        // fetchStores/fetchCounts. If the stats strip fires before those, the
        // set is empty and hidden-client orders inflate the counts. Always
        // fetch /clients inline here, compute hidden IDs by name, and pass
        // them — guaranteed correct regardless of call order.
        const [clientsRes, countsCached] = await Promise.all([
          api.get<any>('/clients').catch(() => []),
          Promise.resolve(HIDDEN_CLIENT_IDS), // preserve any already-discovered IDs
        ]);
        const clientsArr = Array.isArray(clientsRes) ? clientsRes : [];
        const hiddenIds = new Set<number>([...countsCached]);
        for (const c of clientsArr) {
          if (isHiddenClient(c) && typeof c?.id === 'number') hiddenIds.add(c.id);
        }
        const excludeClientId =
          hiddenIds.size > 0 ? [...hiddenIds].join(',') : undefined;
        const res = await api.get<V4DailyStatsResponse>(
          `/orders/daily-stats${qs({
            dateFrom: query?.dateFrom,
            dateTo: query?.dateTo,
            excludeClientId,
          })}`
        );
        return {
          totalOrders: res.summary.totalOrders,
          needToShip: res.summary.needToShip,
          upcomingOrders: res.summary.upcomingOrders,
          window: res.summary.window as any,
        };
      },
      fallback
    );
  },

  fetchPicklist(query: {
    status?: string;
    clientId?: number;
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
        const res = await api.get<any>(
          `/orders/picklist${qs({
            status: query.status,
            clientId: query.clientId,
            dateFrom: query.dateFrom,
            dateTo: query.dateTo,
          })}`
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

  fetchOrderDims(orderId: number): Promise<any> {
    // v4 returns { data: { l, w, h, weightOz } }. v2 callers expect
    // { orderId, sku, qty, dims: { length, width, height }, weightOz }.
    // Reshape so v2-copied UI gets the shape it expects.
    return safe(
      'fetchOrderDims',
      async () => {
        const res = await api.get<{ data: OrderDimsRow }>(
          `/orders/${orderId}/dims`
        );
        const d = res?.data;
        if (!d) return null;
        return {
          orderId,
          sku: null,
          qty: null,
          dims:
            typeof d.l === 'number' ||
            typeof d.w === 'number' ||
            typeof d.h === 'number'
              ? {
                  length: Number(d.l ?? 0),
                  width: Number(d.w ?? 0),
                  height: Number(d.h ?? 0),
                }
              : null,
          weightOz: d.weightOz ?? null,
        };
      },
      null
    );
  },

  saveOrderDims(
    orderId: number,
    dims:
      | { l: number; w: number; h: number; weightOz?: number }
      | { length: number; width: number; height: number; weightOz?: number }
      | Record<string, unknown>
  ): Promise<any> {
    // v2-copied UI call sites send { length, width, height }; v4 accepts
    // { l, w, h }. Translate either shape to v4 so both work.
    const anyDims = dims as Record<string, unknown>;
    const l = Number(anyDims.l ?? anyDims.length ?? 0);
    const w = Number(anyDims.w ?? anyDims.width ?? 0);
    const h = Number(anyDims.h ?? anyDims.height ?? 0);
    const weightOz =
      anyDims.weightOz === undefined ? undefined : Number(anyDims.weightOz);
    return safe(
      'saveOrderDims',
      () =>
        api
          .post<{ data: any }>(`/orders/${orderId}/save-dims`, {
            l,
            w,
            h,
            ...(weightOz !== undefined ? { weightOz } : {}),
          })
          .then((r) => r.data),
      {}
    );
  },

  // ─── Labels ────────────────────────────────────────────────────────────────
  // Throws on failure — callers (OrdersView) use try/catch to surface toasts
  // and keep flow-control semantics intact. Other methods in this file return
  // safe fallbacks, but labels MUST surface errors to the UI.
  createLabel(payload: unknown): Promise<any> {
    return api.post<any>('/labels', payload);
  },

  createLabelBatch(payload: {
    orderIds: number[];
    serviceCode: string;
    shippingProviderId: number;
    carrierCode?: string;
    packageCode?: string;
    confirmation?: string;
    testLabel?: boolean;
  }): Promise<any> {
    return api.post<any>('/labels/create-batch', payload);
  },

  voidLabel(shipmentId: number): Promise<any> {
    return api.post<any>(`/labels/${shipmentId}/void`, {});
  },

  returnLabel(shipmentId: number, reason?: string): Promise<any> {
    return api.post<any>(`/labels/${shipmentId}/return`, reason ? { reason } : {});
  },

  retrieveLabel(orderLookup: number | string, fresh = false): Promise<any> {
    const path = `/labels/${encodeURIComponent(String(orderLookup))}/retrieve${fresh ? '?fresh=true' : ''}`;
    return api.get<any>(path);
  },

  async openLabel(url: string): Promise<void> {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  // ─── Print queue ───────────────────────────────────────────────────────────
  fetchQueue(clientId: number, historyVisible = false): Promise<any> {
    return safe(
      'fetchQueue',
      () =>
        api.get<any>(
          `/print-queue${qs({
            clientId,
            includePrinted: historyVisible ? '1' : undefined,
          })}`
        ),
      { entries: [], count: 0 }
    );
  },

  addToQueue(payload: Record<string, unknown>): Promise<any> {
    return safe('addToQueue', () => api.post<any>('/print-queue/add', payload), {});
  },

  clearQueue(clientId: number): Promise<any> {
    return safe(
      'clearQueue',
      () => api.post<any>('/print-queue/clear', { client_id: clientId }),
      { cleared_count: 0 }
    );
  },

  removeFromQueue(entryId: string, _clientId: number): Promise<any> {
    // v4's api.delete helper doesn't accept a body; v4 endpoint treats
    // client_id in the body as optional so omitting it is safe.
    return safe(
      'removeFromQueue',
      () => api.delete<any>(`/print-queue/${encodeURIComponent(entryId)}`),
      { removed_entry: entryId }
    );
  },

  startQueuePrintJob(
    clientId: number,
    entryIds: string[],
    combine = true
  ): Promise<any> {
    return safe(
      'startQueuePrintJob',
      () =>
        api.post<any>('/print-queue/print', {
          client_id: clientId,
          queue_entry_ids: entryIds,
          merge_headers: combine,
        }),
      {}
    );
  },

  fetchQueuePrintJobStatus(jobId: string): Promise<any> {
    return safe(
      'fetchQueuePrintJobStatus',
      () =>
        api.get<any>(`/print-queue/print/status/${encodeURIComponent(jobId)}`),
      { status: 'unknown' }
    );
  },

  downloadQueuePrintJob(
    jobId: string
  ): Promise<{ blob: Blob; filename: string }> {
    return fetchBlob(
      'downloadQueuePrintJob',
      `/print-queue/print/download/${encodeURIComponent(jobId)}`,
      `batch_print_${jobId}.pdf`
    );
  },

  // ─── Products ──────────────────────────────────────────────────────────────
  fetchProducts(query?: Record<string, unknown>): Promise<any[]> {
    return safe(
      'fetchProducts',
      async () => {
        const res = await api.get<any>(`/products${qs((query ?? {}) as any)}`);
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

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

  saveProductDefaults(data: Record<string, unknown>): Promise<any> {
    return safe('saveProductDefaults', () => api.post<any>('/products', data), {});
  },

  saveProductDefaultsV2(data: Record<string, unknown>): Promise<any> {
    return safe(
      'saveProductDefaultsV2',
      () => api.post<any>('/products/save-defaults', data),
      {}
    );
  },

  // ─── Inventory ─────────────────────────────────────────────────────────────
  fetchInventory(query?: Record<string, unknown>): Promise<any[]> {
    return safe(
      'fetchInventory',
      async () => {
        const res = await api.get<any>(`/inventory${qs((query ?? {}) as any)}`);
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

  fetchInventoryDetail(invSkuId: number): Promise<any> {
    return safe(
      'fetchInventoryDetail',
      () => api.get<any>(`/inventory/${invSkuId}`),
      null
    );
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
    return safe(
      'updateInventoryItem',
      () => api.patch<any>(`/inventory/${invSkuId}`, payload),
      {}
    );
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
          api.get<any>('/clients').catch(() => []),
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
        return rows.map((row: any) => ({
          ...row,
          clientName:
            row?.clientId != null ? nameById.get(row.clientId) ?? null : null,
          currentStock: row?.stockQty ?? 0,
        }));
      },
      []
    );
  },

  fetchInventoryItemLedger(invSkuId: number): Promise<any[]> {
    return safe(
      'fetchInventoryItemLedger',
      async () => {
        const res = await api.get<any>(`/inventory/${invSkuId}/ledger`);
        if (Array.isArray(res?.data)) return res.data;
        if (Array.isArray(res)) return res;
        return [];
      },
      []
    );
  },

  fetchInventoryLedger(query: Record<string, unknown>): Promise<any[]> {
    // Expected v4 backend: GET /inventory/ledger (global, T2 punch-list item).
    // InventoryView History tab passes `{clientId?, type?, from?, to?}`; pass
    // them through as query params so the endpoint has everything it needs.
    // Until it lands the 404 is swallowed and the history tab shows an empty
    // ledger instead of crashing.
    return safe(
      'fetchInventoryLedger',
      async () => {
        const res = await api.get<any>(`/inventory/ledger${qs(query as any)}`);
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

  fetchInventorySkuOrders(invSkuId: number, days?: number): Promise<any> {
    // v4 returns {sku, name, orders: [{order_id, order_number, order_date,
    // order_status, qty}]} (snake_case, no dailySales).
    // v2 UI reads camelCase rows + {day, units}[] for the 30-day chart.
    // Reshape rows and synthesize dailySales by bucketing qty per day.
    const windowDays = days ?? 30;
    return safe(
      'fetchInventorySkuOrders',
      async () => {
        const res = await api.get<any>(
          `/inventory/${invSkuId}/sku-orders${qs({ days: windowDays } as any)}`
        );
        const rawOrders = Array.isArray(res?.orders) ? res.orders : [];
        const orders = rawOrders.map((r: any) => ({
          orderId: r?.order_id ?? r?.orderId ?? null,
          orderNumber: r?.order_number ?? r?.orderNumber ?? '',
          orderDate: r?.order_date ?? r?.orderDate ?? null,
          orderStatus: r?.order_status ?? r?.orderStatus ?? '',
          qty: Number(r?.qty ?? 0),
        }));

        // Bucket qty per YYYY-MM-DD, then pad missing days with 0 so the
        // chart has exactly `windowDays` contiguous data points.
        const bucket = new Map<string, number>();
        for (const o of orders) {
          if (!o.orderDate) continue;
          const day = String(o.orderDate).slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
          bucket.set(day, (bucket.get(day) ?? 0) + o.qty);
        }
        const dailySales: { day: string; units: number }[] = [];
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        for (let i = windowDays - 1; i >= 0; i -= 1) {
          const d = new Date(today);
          d.setUTCDate(d.getUTCDate() - i);
          const day = d.toISOString().slice(0, 10);
          dailySales.push({ day, units: bucket.get(day) ?? 0 });
        }

        return {
          sku: res?.sku ?? '',
          name: res?.name ?? '',
          orders,
          dailySales,
        };
      },
      { orders: [], name: '', sku: '', dailySales: [] }
    );
  },

  receiveInventory(data: Record<string, unknown>): Promise<any[]> {
    // v2 receiveInventory payload shape differs from v4's per-item endpoint.
    // v4 requires POST /inventory/:id/receive with {qty, note, orderId?}.
    // Best-effort: if payload has an inventoryId+qty, call the endpoint.
    return safe(
      'receiveInventory',
      async () => {
        const invId = (data as any)?.invSkuId ?? (data as any)?.inventoryId;
        if (!invId) {
          console.warn(
            '[v2-apiClient] receiveInventory: payload missing inventoryId; returning []'
          );
          return [];
        }
        const res = await api.post<any>(`/inventory/${invId}/receive`, {
          qty: (data as any).qty,
          note: (data as any).note,
          orderId: (data as any).orderId,
        });
        return Array.isArray(res) ? res : [res];
      },
      []
    );
  },

  submitInventoryReceive(data: Record<string, unknown>): Promise<any> {
    // v4's POST /inventory/:id/receive returns {inventory, ledger} (not a flat
    // item row). v2 InventoryView reads result.received as an array of
    // {sku, qty, newStock} for its toast string. Reshape each entry so the
    // UI's "Received X SKU(s): ABC (5 units → 100 total)" renders correctly.
    return safe(
      'submitInventoryReceive',
      async () => {
        const raw = await apiClient.receiveInventory(data);
        const entries = Array.isArray(raw) ? raw : [raw];
        const received = entries.map((e: any) => ({
          sku: e?.inventory?.sku ?? e?.sku ?? '',
          qty: e?.ledger?.qty ?? e?.qty ?? (data as any)?.qty ?? 0,
          newStock: e?.inventory?.stockQty ?? e?.stockQty ?? 0,
        }));
        return { ok: true, received } as { ok: boolean; received: any[] };
      },
      { ok: false, received: [] as any[] }
    );
  },

  adjustInventory(data: Record<string, unknown>): Promise<any> {
    return safe(
      'adjustInventory',
      async () => {
        const invId = (data as any)?.invSkuId ?? (data as any)?.inventoryId;
        if (!invId) return {};
        return api.post<any>(`/inventory/${invId}/adjust`, {
          qty: (data as any).qty,
          note: (data as any).note,
          orderId: (data as any).orderId,
        });
      },
      {}
    );
  },

  submitInventoryAdjustment(data: Record<string, unknown>): Promise<any> {
    // v4's POST /inventory/:id/adjust returns {inventory, ledger}. Toast was
    // reading result.stockQty (undefined on current backend, would be defined
    // if backend flattened). Check the nested path first, fall back to flat
    // in case the server contract changes.
    return safe(
      'submitInventoryAdjustment',
      async () => {
        const result = await apiClient.adjustInventory(data);
        return {
          ok: true,
          newStock:
            (result as any)?.inventory?.stockQty ??
            (result as any)?.stockQty ??
            0,
        } as { ok: boolean; newStock: number };
      },
      { ok: false, newStock: 0 }
    );
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

  fetchParentSkuDetail(parentSkuId: number): Promise<any> {
    return safe(
      'fetchParentSkuDetail',
      () => api.get<any>(`/inventory/parent/${parentSkuId}`),
      null
    );
  },

  // ─── Locations ─────────────────────────────────────────────────────────────
  fetchLocations(): Promise<any[]> {
    // v4 returns rows with `id`; v2 consumers (LocationsView, useLocations)
    // read `locationId`. Normalize here so every caller gets the v2 shape.
    return safe(
      'fetchLocations',
      async () => {
        const res = await api.get<any>('/locations');
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

  fetchLocationDetail(locationId: number): Promise<any> {
    return safe(
      'fetchLocationDetail',
      () => api.get<any>(`/locations/${locationId}`),
      null
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
    return safe(
      'fetchPackages',
      async () => {
        const res = await api.get<any>(`/packages${qs({ source })}`);
        return Array.isArray(res) ? res : [];
      },
      []
    );
  },

  fetchLowStockPackages(): Promise<any[]> {
    // v4 has no /packages/low-stock — derive client-side.
    return safe(
      'fetchLowStockPackages',
      async () => {
        const res = await api.get<any[]>('/packages');
        if (!Array.isArray(res)) return [];
        return res.filter(
          (p: any) =>
            typeof p?.stockQty === 'number' &&
            typeof p?.reorderLevel === 'number' &&
            p.stockQty <= p.reorderLevel
        );
      },
      []
    );
  },

  createPackageMutation(data: Record<string, unknown>): Promise<any> {
    return safe(
      'createPackageMutation',
      () => api.post<any>('/packages', data),
      {}
    );
  },

  updatePackageMutation(
    packageId: number,
    data: Record<string, unknown>
  ): Promise<any> {
    return safe(
      'updatePackageMutation',
      () => api.patch<any>(`/packages/${packageId}`, data),
      {}
    );
  },

  deletePackageMutation(packageId: number): Promise<any> {
    return safe(
      'deletePackageMutation',
      () => api.delete<any>(`/packages/${packageId}`),
      { ok: true }
    );
  },

  setPackageReorderLevel(packageId: number, reorderLevel: number): Promise<any> {
    // v4 doesn't expose a dedicated /reorder-level route; use the general
    // PATCH body, which already accepts reorderLevel.
    return safe(
      'setPackageReorderLevel',
      () => api.patch<any>(`/packages/${packageId}`, { reorderLevel }),
      { ok: false }
    );
  },

  receivePackage(packageId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'receivePackage',
      () => api.post<any>(`/packages/${packageId}/receive`, data),
      {}
    );
  },

  adjustPackage(packageId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'adjustPackage',
      () => api.post<any>(`/packages/${packageId}/adjust`, data),
      {}
    );
  },

  fetchPackageLedger(packageId: number): Promise<any[]> {
    return safe(
      'fetchPackageLedger',
      async () => {
        const res = await api.get<any>(`/packages/${packageId}/ledger`);
        if (Array.isArray(res?.data)) return res.data;
        if (Array.isArray(res)) return res;
        return [];
      },
      []
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
  fetchBillingConfigs(): Promise<any[]> {
    return safe(
      'fetchBillingConfigs',
      async () => {
        const res = await api.get<any>('/billing/config');
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
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
    };
    const ACCEPTED = new Set([
      'pickPackFee',
      'pickPackMaxUnits',
      'additionalUnitFee',
      'packageCostMarkup',
      'shippingMarkupPct',
      'shippingMarkupFlat',
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
      () => api.put<any>(`/billing/config/${clientId}`, payload),
      {}
    );
  },

  generateBilling(from: string, to: string, clientId?: number): Promise<any> {
    return safe(
      'generateBilling',
      () =>
        api.post<any>('/billing/generate', {
          from,
          to,
          ...(clientId != null ? { clientId } : {}),
        }),
      {}
    );
  },

  fetchBillingSummary(from: string, to: string, clientId?: number): Promise<any[]> {
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
    return safe(
      'fetchBillingSummary',
      async () => {
        const [res, clientsRes] = await Promise.all([
          api.get<any>(`/billing/summary${qs({ dateFrom, dateTo, clientId })}`),
          api.get<any>('/clients').catch(() => []),
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
      []
    );
  },

  fetchBillingDetails(from: string, to: string, clientId: number): Promise<any[]> {
    const dateFrom = toIsoDayStart(from);
    const dateTo = toIsoDayEnd(to);
    return safe(
      'fetchBillingDetails',
      async () => {
        const res = await api.get<any>(
          `/billing/details${qs({ dateFrom, dateTo, clientId })}`
        );
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

  fetchBillingPackagePrices(clientId: number): Promise<any[]> {
    return safe(
      'fetchBillingPackagePrices',
      async () => {
        const res = await api.get<any>(
          `/billing/package-prices${qs({ clientId })}`
        );
        if (Array.isArray(res)) return res;
        if (Array.isArray(res?.data)) return res.data;
        return [];
      },
      []
    );
  },

  saveBillingPackagePrices(data: Record<string, unknown>): Promise<any> {
    return safe(
      'saveBillingPackagePrices',
      () => api.put<any>('/billing/package-prices', data),
      {}
    );
  },

  setDefaultPackagePrice(packageId: number, price: number): Promise<any> {
    return safe(
      'setDefaultPackagePrice',
      () =>
        api.post<any>('/billing/package-prices/set-default', { packageId, price }),
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
  // fetchRates is the ONE place in the app that translates between v2's rate
  // shape (shared by the bulk-ported RatesView / OrdersView side-panel / any
  // future caller) and v4's ShipStation-v2-passthrough shape. Callers may
  // pass either v4 shape (weightOz / toZip / dimsL/W/H) or legacy v2 shape
  // (toPostalCode / weight.value / dimensions.length / …); we normalize to v4
  // on input and remap to v2-legacy on output so every reader of the result
  // can use the same field names the bulk-ported v2 code expects.
  fetchRates(data: Record<string, unknown>): Promise<any[]> {
    return safe(
      'fetchRates',
      async () => {
        const body = translateRatePayloadToV4(data);
        const res = await api.post<any>('/rates', body);
        const rawRates = Array.isArray(res)
          ? res
          : Array.isArray(res?.rates)
            ? res.rates
            : [];
        return rawRates.map(translateRateToV2Shape);
      },
      []
    );
  },

  // ─── Analysis ──────────────────────────────────────────────────────────────
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
        const topSkus = topSkusRaw.map((t: any) => ({
          sku: t.sku,
          name: t.name ?? '',
          totalQty: t.total_qty ?? t.totalQty ?? 0,
        }));
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
          api.get<any>('/clients').catch(() => []),
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
        const skus = rows.map((r: any) => ({
          sku: r.sku,
          name: r.name ?? '',
          imageUrl: r.image_url ?? r.imageUrl ?? null,
          clientId: r.client_id ?? r.clientId ?? null,
          clientName:
            r.client_id != null ? nameById.get(r.client_id) ?? '' : '',
          orders: r.orders ?? 0,
          pendingOrders: r.pending ?? 0,
          externalOrders: r.ext_shipped ?? 0,
          qty: r.total_qty ?? 0,
          standardShipCount: r.std_orders ?? 0,
          standardShipTotal: parseNum(r.std_total),
          expeditedShipCount: r.exp_orders ?? 0,
          expeditedShipTotal: parseNum(r.exp_total),
          totalShipping: parseNum(r.total_shipping),
        }));
        return {
          skus,
          orderCount: breakdown?.totalOrders ?? 0,
        };
      },
      { skus: [], orderCount: 0 }
    );
  },

  // ─── Manifests ─────────────────────────────────────────────────────────────
  downloadManifest(data: {
    startDate?: string;
    endDate?: string;
    [k: string]: unknown;
  }): Promise<{ blob: Blob; filename: string }> {
    // v4 exposes GET /manifests/generate with query params. Flatten v2's body
    // to query string. Throws on failure so ManifestsView's try/catch surfaces
    // the server error in a toast instead of silently downloading a 0-byte
    // file.
    const path = `/manifests/generate${qs(data as any)}`;
    const start = data.startDate ?? 'unknown';
    const end = data.endDate ?? 'unknown';
    return fetchBlob(
      'downloadManifest',
      path,
      `manifest_${start}_${end}.csv`,
      { throwOnError: true }
    );
  },
};

export type V2ApiClient = typeof apiClient;
export default apiClient;
