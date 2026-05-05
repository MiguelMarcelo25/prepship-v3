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
import { API_BASE } from './api-base';
import { supabase } from './supabase';

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
// Primary signal is `isTest` (server-side flag on clients.is_test) — any
// client flagged as a sandbox never appears in stats or the main orders
// table. The name list below is a legacy fallback kept for clients that
// predate the flag and haven't been migrated yet.
const HIDDEN_CLIENT_NAMES = new Set(['api shipments']);

// Populated by fetchStores / fetchCounts when clients are loaded — lets
// downstream filtering (e.g. byStatusStore emission) drop rows for hidden
// clients even when we only have the id.
export const HIDDEN_CLIENT_IDS = new Set<number>();

// Separate set of just the isTest client IDs — used by the UI to render the
// TEST badge on order rows / drawer.
export const TEST_CLIENT_IDS = new Set<number>();

function isHiddenClient(
  c:
    | { name?: string | null; id?: number | null; isTest?: boolean | null }
    | null
    | undefined
): boolean {
  if (!c) return false;
  if (c.isTest === true) {
    if (typeof c.id === 'number') {
      TEST_CLIENT_IDS.add(c.id);
    }
    return false;
  }
  const name = (c.name ?? '').trim().toLowerCase();
  if (HIDDEN_CLIENT_NAMES.has(name)) {
    if (typeof c.id === 'number') HIDDEN_CLIENT_IDS.add(c.id);
    return true;
  }
  return false;
}

function normalizeSyntheticTestStoreQuery(q: Record<string, unknown>): void {
  if (q.storeId == null) return;
  const storeId = Number(q.storeId);
  if (!Number.isFinite(storeId) || storeId >= 0) return;
  q.clientId = Math.abs(storeId);
  delete q.storeId;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePackageDto(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const packageId = parseFiniteNumber(row.packageId ?? row.id);
  const unitCost = parseFiniteNumber(row.unitCost);
  return {
    ...row,
    packageId: packageId ?? row.packageId,
    unitCost,
  };
}

function normalizePackageResponse(res: any): any {
  if (Array.isArray(res)) return res.map(normalizePackageDto);
  if (!res || typeof res !== 'object') return res;

  const data = Array.isArray(res.data)
    ? res.data.map(normalizePackageDto)
    : normalizePackageDto(res.data);
  const pkg = normalizePackageDto(res.package);
  const self = normalizePackageDto(res);

  return {
    ...self,
    ...(res.data !== undefined ? { data } : {}),
    ...(res.package !== undefined ? { package: pkg } : {}),
  };
}

function normalizePackageMutationPayload(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data };
  if (next.unitCost == null || next.unitCost === '') {
    delete next.unitCost;
  } else {
    next.unitCost = String(next.unitCost);
  }
  return next;
}

function normalizePackageReceivePayload(data: Record<string, unknown>): Record<string, unknown> {
  const unitCost = data.unitCost ?? data.costPerUnit;
  const payload: Record<string, unknown> = {
    qty: Number(data.qty ?? 0),
  };
  if (unitCost != null && unitCost !== '') payload.unitCost = Number(unitCost);
  if (data.note != null && String(data.note).trim()) payload.note = String(data.note).trim();
  return payload;
}

function normalizePackageAdjustPayload(data: Record<string, unknown>): Record<string, unknown> {
  const qtyDelta = data.qtyDelta ?? data.qty;
  const payload: Record<string, unknown> = {
    qtyDelta: Number(qtyDelta ?? 0),
  };
  if (data.note != null && String(data.note).trim()) payload.note = String(data.note).trim();
  return payload;
}

function normalizePackageLedgerEntry(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const delta = parseFiniteNumber(row.delta ?? row.qtyDelta) ?? 0;
  return {
    ...row,
    delta,
    reason: row.reason ?? row.note ?? row.changeType ?? '',
    unitCost: parseFiniteNumber(row.unitCost),
  };
}

function normalizePackageMovementResponse(res: any): any {
  if (!res || typeof res !== 'object') return res;
  const data = res.data && typeof res.data === 'object' ? res.data : res;
  return {
    ...res,
    ...data,
    package: normalizePackageDto(data.package ?? res.package),
    ledgerEntry: normalizePackageLedgerEntry(data.ledgerEntry ?? res.ledgerEntry),
    ok: true,
  };
}

function normalizeProductDefaultsPayload(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data };
  if (next.defaultPackageCode === undefined && 'packageId' in next) {
    next.defaultPackageCode = next.packageId == null || next.packageId === ''
      ? null
      : String(next.packageId);
  }
  delete next.packageId;
  return next;
}

function inventoryStatus(stockQty: number, reorderLevel: number): 'ok' | 'low' | 'out' {
  if (stockQty <= 0) return 'out';
  if (stockQty <= reorderLevel) return 'low';
  return 'ok';
}

function normalizeInventoryDto(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const currentStock = parseFiniteNumber(row.currentStock ?? row.stockQty) ?? 0;
  const minStock = parseFiniteNumber(row.minStock ?? row.reorderLevel) ?? 0;
  const unitsPerPack = parseFiniteNumber(row.units_per_pack ?? row.unitsPerPack) ?? 1;
  const length = parseFiniteNumber(row.packageLength ?? row.length) ?? 0;
  const width = parseFiniteNumber(row.packageWidth ?? row.width) ?? 0;
  const height = parseFiniteNumber(row.packageHeight ?? row.height) ?? 0;
  const soldLast30Days = parseFiniteNumber(row.soldLast30Days ?? row.last30DaysSold) ?? 0;

  return {
    ...row,
    clientId: parseFiniteNumber(row.clientId) ?? 0,
    minStock,
    currentStock,
    stockQty: currentStock,
    reorderLevel: minStock,
    status: row.status ?? inventoryStatus(currentStock, minStock),
    units_per_pack: unitsPerPack,
    unitsPerPack,
    packageLength: length,
    packageWidth: width,
    packageHeight: height,
    productLength: parseFiniteNumber(row.productLength ?? row.length) ?? length,
    productWidth: parseFiniteNumber(row.productWidth ?? row.width) ?? width,
    productHeight: parseFiniteNumber(row.productHeight ?? row.height) ?? height,
    baseUnitQty: parseFiniteNumber(row.baseUnitQty) ?? 1,
    baseUnits: currentStock * (parseFiniteNumber(row.baseUnitQty) ?? 1),
    cuFtOverride: parseFiniteNumber(row.cuFtOverride),
    packageId: parseFiniteNumber(row.packageId),
    packageName: row.packageName ?? null,
    parentName: row.parentName ?? null,
    lastMovement: row.lastMovement ?? null,
    soldLast30Days,
  };
}

function normalizeClientDtoRows(rows: any[]): any[] {
  const namesById = new Map<number, string>();
  for (const row of rows) {
    const id = parseFiniteNumber(row?.clientId ?? row?.id);
    if (id != null) namesById.set(id, row?.name ?? '');
  }

  return rows.map((row) => {
    const clientId = parseFiniteNumber(row?.clientId ?? row?.id) ?? 0;
    const rateSourceClientId = parseFiniteNumber(
      row?.rateSourceClientId ?? row?.rate_source_client_id
    );
    const storeIds = Array.isArray(row?.storeIds)
      ? row.storeIds.map((value: unknown) => Number(value)).filter(Number.isFinite)
      : [];
    return {
      ...row,
      id: parseFiniteNumber(row?.id) ?? clientId,
      clientId,
      storeIds,
      contactName: row?.contactName ?? '',
      email: row?.email ?? '',
      phone: row?.phone ?? '',
      active: row?.active ?? true,
      hasOwnAccount: Boolean((row?.ssApiKey && row?.ssApiSecret) || row?.ssApiKeyV2),
      rateSourceClientId,
      rateSourceName: rateSourceClientId != null ? namesById.get(rateSourceClientId) ?? '' : '',
    };
  });
}

function normalizeClientMutationPayload(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    if (key === 'rate_source_client_id') {
      next.rateSourceClientId = value;
      continue;
    }
    next[key] = value;
  }

  for (const key of ['contactName', 'email', 'phone', 'ssApiKey', 'ssApiSecret', 'ssApiKeyV2']) {
    if (next[key] === '') next[key] = null;
  }

  if (next.rateSourceClientId === '' || Number.isNaN(next.rateSourceClientId)) {
    next.rateSourceClientId = null;
  }

  return next;
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
  if (typeof input.storeId === 'number') out.storeId = input.storeId;
  if (typeof input.clientId === 'number') out.clientId = input.clientId;

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

function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const n = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeCarrierAccountDto(c: any, index = 0): any {
  const carrierId = c?.carrier_id ?? c?.carrierId ?? '';
  const carrierCode = c?.carrier_code ?? c?.carrierCode ?? c?.code ?? '';
  const label =
    c?.nickname ??
    c?.friendly_name ??
    c?.friendlyName ??
    c?.accountNumber ??
    c?.name ??
    carrierCode;
  return {
    ...c,
    carrierId,
    carrierCode,
    shippingProviderId: toProviderAccountId(carrierId) ?? c?.shippingProviderId ?? index + 1,
    nickname: c?.nickname ?? label,
    clientId: c?.source_client_id ?? c?.sourceClientId ?? c?.clientId ?? null,
    code: carrierCode,
    _label: label,
    sourceClientName: c?.source_client_name ?? c?.sourceClientName,
  };
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
      shippingProviderId: toProviderAccountId(obj.carrier_id),
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
    const res = await fetch(`${API_BASE}${path}`, {
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
  window: { from: string; to: string; fromLabel: string; toLabel: string };
};

function parseDailyStatsSummary(value: unknown): DailyStatsSummary {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid daily stats response');
  }

  const dto = value as Record<string, unknown>;
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

type SettingsRow = { key: string; value: string };
type OrderDimsRow = { l: number; w: number; h: number; weightOz: number | null } | null;

export const apiClient = {
  // ─── Auth / token (no-op — v4 uses Supabase) ────────────────────────────────
  setToken(_token: string): void {
    // No-op: v4 reads the session from supabase.auth; token is managed there.
  },

  // ─── Init / bootstrap ───────────────────────────────────────────────────────
  fetchCounts(filter?: { dateStart?: string; dateEnd?: string }): Promise<any> {
    // v2 sidebar parity: counts are grouped by real ShipStation storeId.
    // /init/counts returns the legacy { byStatus, byStatusStore } shape.
    const hasDate = Boolean(filter?.dateStart || filter?.dateEnd);
    const dateFrom = toIsoDayStart(filter?.dateStart);
    const dateTo = toIsoDayEnd(filter?.dateEnd);
    return safe(
      'fetchCounts',
      async () => {
        if (hasDate) {
          const legacyCounts = await api.get<any>(`/init/counts${qs({ dateFrom, dateTo })}`);
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

        const legacyCounts = await api.get<any>('/init/counts');
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
      { byStatus: [], byStatusStore: [] }
    );
  },

  fetchStores(): Promise<any[]> {
    // v2 sidebar parity: return one row per ShipStation storeId, named from
    // the owning client.
    return safe(
      'fetchStores',
      async () => {
        const [storesRes, clientRowsRes] = await Promise.all([
          api.get<any>('/init/stores').catch(() => ({ data: [] })),
          api.get<any>('/clients').catch(() => []),
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

        const clients = await api.get<any>('/clients');
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

  fetchInitData(): Promise<any> {
    return safe('fetchInitData', () => api.get<any>('/init/init-data'), {
      stores: [],
      carriers: [],
    });
  },

  // ─── Clients ────────────────────────────────────────────────────────────────
  fetchClients(): Promise<any[]> {
    return api.get<any>('/clients').then((res) => normalizeClientDtoRows(Array.isArray(res) ? res : []));
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
    return api.post<any>('/clients', normalizeClientMutationPayload(data));
  },

  createClientRecord(data: Record<string, unknown>): Promise<any> {
    return api.post<any>('/clients', normalizeClientMutationPayload(data));
  },

  updateClient(clientId: number, data: Record<string, unknown>): Promise<any> {
    return api.patch<any>(`/clients/${clientId}`, normalizeClientMutationPayload(data));
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
      async () => {
        const res = await api.post<any>('/clients/sync-stores', {});
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
        const res = await api.get<any>(
          `/rates/carriers-for-store${qs({
            storeId: storeId ?? undefined,
            clientId: clientId ?? undefined,
          })}`
        );
        const raw = Array.isArray(res?.carriers)
          ? res.carriers
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res)
              ? res
              : [];
        return { carriers: raw.map(normalizeCarrierAccountDto) };
      },
      { carriers: [] }
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
        api.post<any>(
          '/sync/orders',
          mode === 'full' ? { full: true } : {}
        ),
      { queued: false }
    );
  },

  fetchShipmentSyncStatus(): Promise<any> {
    return safe(
      'fetchShipmentSyncStatus',
      () => api.get<any>('/shipments/status'),
      { status: 'idle' }
    );
  },

  triggerShipmentSync(): Promise<any> {
    return safe(
      'triggerShipmentSync',
      () => api.post<any>('/shipments/sync', {}),
      { queued: false }
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
    return safe(
      'fetchOrders',
      async () => {
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
      },
      { orders: [], total: 0, pages: 1, currentPage: 1 }
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

  // v2 parity: plain single-order read (no hydration). Use when callers only
  // need the raw order row — `fetchOrderFull` is the hydrated variant.
  fetchOrderDetail(orderId: number): Promise<any> {
    return safe(
      'fetchOrderDetail',
      () => api.get<any>(`/orders/${orderId}`),
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
    return safe(
      'markOrderShippedExternal',
      () => api.post<any>(`/orders/${orderId}/shipped-external`, { source }),
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
  }): Promise<DailyStatsSummary | null> {
    // Coerce UI date strings (YYYY-MM-DD) to the ISO datetimes expected by
    // /orders/daily-stats. With no dates, the server applies its default
    // shift window.
    return safe(
      'fetchDailyStats',
      async () => {
        // V2 parity: the daily stats endpoint applies only the configured
        // excluded store IDs server-side.
        const res = await api.get<unknown>(
          `/orders/daily-stats${qs({
            dateFrom: toIsoDayStart(query?.dateFrom),
            dateTo: toIsoDayEnd(query?.dateTo),
          })}`
        );
        return parseDailyStatsSummary(res);
      },
      null
    );
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

  startQueueSendJob(payload: {
    orders: Array<Record<string, unknown>>;
    concurrency?: number;
  }): Promise<any> {
    return api.post<any>('/print-queue/batch-send', payload);
  },

  fetchQueueSendJobStatus(jobId: string): Promise<any> {
    return api.get<any>(`/print-queue/batch-send/status/${encodeURIComponent(jobId)}`);
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
    return api.post<any>('/print-queue/print', {
      client_id: clientId,
      queue_entry_ids: entryIds,
      merge_headers: combine,
    });
  },

  fetchQueuePrintJobStatus(jobId: string): Promise<any> {
    return api.get<any>(`/print-queue/print/status/${encodeURIComponent(jobId)}`);
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

  // Convenience wrapper: download the merged PDF and return a blob: URL the
  // caller can pass to window.open(). The blob URL is auto-revoked after
  // 30s — long enough for the user to grab the print dialog.
  async fetchQueuePrintJobPdfUrl(jobId: string): Promise<string | null> {
    try {
      const { blob } = await this.downloadQueuePrintJob(jobId);
      const url = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return url;
    } catch {
      return null;
    }
  },

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
    const toIsoStart = (d: string) =>
      d.includes('T') ? d : new Date(`${d}T00:00:00.000Z`).toISOString();
    const toIsoEnd = (d: string) =>
      d.includes('T') ? d : new Date(`${d}T23:59:59.999Z`).toISOString();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');
      const qs = new URLSearchParams({
        clientId: String(clientId),
        dateFrom: toIsoStart(from),
        dateTo: toIsoEnd(to),
      }).toString();
      const res = await fetch(`${API_BASE}/billing/invoice?${qs}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
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
    return api.post<any>('/products', normalizeProductDefaultsPayload(data));
  },

  saveProductDefaultsV2(data: Record<string, unknown>): Promise<any> {
    return api.post<any>('/products/save-defaults', normalizeProductDefaultsPayload(data));
  },

  // Multi-SKU fallback for the shipping panel: when an order has more than one
  // SKU, savePanelSkuDefaults skips the per-SKU save (no clean way to allocate
  // one parcel's weight/dims across many lines), but the package selection IS
  // still meaningful for every SKU on the order. This endpoint stamps just
  // inventory.package_id for each provided SKU under the given clientId.
  bulkSetInventoryPackageDefault(payload: {
    clientId: number | null;
    packageId: number | null;
    skus: string[];
  }): Promise<{ updated: number; skipped: number; total: number }> {
    return api.post<{ updated: number; skipped: number; total: number }>(
      '/inventory/bulk-set-default-package',
      payload
    );
  },

  // ─── Inventory ─────────────────────────────────────────────────────────────
  fetchInventory(query?: Record<string, unknown>): Promise<any[]> {
    return safe(
      'fetchInventory',
      async () => {
        const res = await api.get<any>(`/inventory${qs((query ?? {}) as any)}`);
        if (Array.isArray(res)) return res.map(normalizeInventoryDto);
        if (Array.isArray(res?.data)) return res.data.map(normalizeInventoryDto);
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
    const ledgerQuery = { ...(query as Record<string, unknown>) };
    if (ledgerQuery.limit != null && ledgerQuery.pageSize == null) {
      ledgerQuery.pageSize = Math.min(200, Number(ledgerQuery.limit) || 200);
    }
    if (ledgerQuery.pageSize != null) {
      ledgerQuery.pageSize = Math.min(200, Number(ledgerQuery.pageSize) || 200);
    }
    delete ledgerQuery.limit;
    return api.get<any>(`/inventory/ledger${qs(ledgerQuery as any)}`).then((res) => {
      if (Array.isArray(res)) return res;
      if (Array.isArray(res?.data)) return res.data;
      return [];
    });
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
          standardShippingCost:
            r?.standard_shipping_cost == null && r?.standardShippingCost == null
              ? null
              : Number(r?.standard_shipping_cost ?? r?.standardShippingCost),
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
          qty: Number(item?.qty ?? 0),
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
        if (Array.isArray(res)) return res.map(normalizePackageDto);
        if (Array.isArray(res?.data)) return res.data.map(normalizePackageDto);
        return [];
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
        ).map(normalizePackageDto);
      },
      []
    );
  },

  createPackageMutation(data: Record<string, unknown>): Promise<any> {
    return safe(
      'createPackageMutation',
      async () => ({
        ...normalizePackageResponse(
          await api.post<any>('/packages', normalizePackageMutationPayload(data))
        ),
        ok: true,
      }),
      {}
    );
  },

  autoCreatePackageByDimensions(data: Record<string, unknown>): Promise<any> {
    return safe(
      'autoCreatePackageByDimensions',
      async () => normalizePackageResponse(await api.post<any>('/packages/auto-create', data)),
      {}
    );
  },

  updatePackageMutation(
    packageId: number,
    data: Record<string, unknown>
  ): Promise<any> {
    return safe(
      'updatePackageMutation',
      async () => ({
        ...normalizePackageResponse(
          await api.patch<any>(
            `/packages/${packageId}`,
            normalizePackageMutationPayload(data)
          )
        ),
        ok: true,
      }),
      {}
    );
  },

  deletePackageMutation(packageId: number): Promise<any> {
    return safe(
      'deletePackageMutation',
      async () => ({ ...(await api.delete<any>(`/packages/${packageId}`)), ok: true }),
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
      async () =>
        normalizePackageMovementResponse(
          await api.post<any>(
            `/packages/${packageId}/receive`,
            normalizePackageReceivePayload(data)
          )
        ),
      {}
    );
  },

  adjustPackage(packageId: number, data: Record<string, unknown>): Promise<any> {
    return safe(
      'adjustPackage',
      async () =>
        normalizePackageMovementResponse(
          await api.post<any>(
            `/packages/${packageId}/adjust`,
            normalizePackageAdjustPayload(data)
          )
        ),
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

  syncCarrierPackages(): Promise<any> {
    return safe(
      'syncCarrierPackages',
      () => api.post<any>('/packages/sync', {}),
      { inserted: 0, skipped: 0, message: '' }
    );
  },

  // ─── Billing ───────────────────────────────────────────────────────────────
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

  // v2 parity: thin wrapper around POST /rates/browse. Backend already
  // returns `{rates, bestRate, ...}` — we passthrough verbatim (no
  // translation) since the rate-browser UI consumes the v4 shape directly.
  browseRates(data: Record<string, unknown>): Promise<any> {
    return safe(
      'browseRates',
      () => api.post<any>('/rates/browse', data),
      { rates: [], bestRate: null }
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
          const expeditedShipCount = parseNum(
            r.exp_ship_count ?? r.expeditedShipCount ?? r.exp_orders ?? 0
          );
          const expeditedTotalShipping = parseNum(
            r.exp_total ?? r.expeditedTotalShipping ?? r.expeditedShipTotal
          );
          const shipCountWithCost = parseNum(
            r.ship_count_with_cost ?? r.shipCountWithCost ?? standardShipCount + expeditedShipCount
          );
          const totalShipping = parseNum(r.total_shipping ?? r.totalShipping);

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
            orders: parseNum(r.orders),
            pendingOrders: parseNum(r.pending ?? r.pendingOrders),
            externalOrders: parseNum(r.ext_shipped ?? r.externalOrders),
            qty: parseNum(r.total_qty ?? r.qty),
            standardOrders: parseNum(r.std_orders ?? r.standardOrders),
            standardShipCount,
            standardAvgShipping:
              standardShipCount > 0
                ? Number((standardTotalShipping / standardShipCount).toFixed(2))
                : 0,
            standardTotalShipping,
            standardShipTotal: standardTotalShipping,
            expeditedOrders: parseNum(r.exp_orders ?? r.expeditedOrders),
            expeditedShipCount,
            expeditedAvgShipping:
              expeditedShipCount > 0
                ? Number((expeditedTotalShipping / expeditedShipCount).toFixed(2))
                : 0,
            expeditedTotalShipping,
            expeditedShipTotal: expeditedTotalShipping,
            shipCountWithCost,
            blendedAvgShipping:
              shipCountWithCost > 0 ? Number((totalShipping / shipCountWithCost).toFixed(2)) : 0,
            totalShipping,
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
