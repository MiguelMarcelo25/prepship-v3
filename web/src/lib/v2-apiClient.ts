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
import { callVercelFunction } from './vercelFunction';

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
const STALE_MOCK_LABEL_HOSTS = new Set(['prepshipv4-api.onrender.com']);
const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;
const STORE_PROVIDER_KEYS = new Set([
  'walmart',
  'amazon',
  'ebay',
  'shopify',
  'etsy',
  'tiktok_shop',
  'woocommerce',
  'bigcommerce',
]);
const STORE_SCOPED_SHIPPING_PROVIDERS = new Set([
  'walmart_shipping',
  'ebay_shipping',
]);
const SYNTHETIC_STORE_ID_OFFSETS: Record<string, number> = {
  walmart_shipping: 9_000_000,
  amazon_shipping: 9_100_000,
  ebay_shipping: 9_500_000,
};

const DIRECT_ACCOUNT_PROVIDER_LABELS: Record<string, string> = {
  amazon_shipping: 'Amazon Shipping',
  ebay_shipping: 'eBay Shipping',
  ehub: 'eHub',
  easypost: 'EasyPost',
  shipp: 'Shipp',
  fedex: 'FedEx Direct',
  simulator: 'Simulator',
  stamps_com: 'Stamps.com Direct',
  ups: 'UPS Direct',
  usps: 'USPS Direct',
  walmart: 'Walmart',
  walmart_shipping: 'Walmart Shipping',
};

// Populated by fetchStores / fetchCounts when clients are loaded — lets
// downstream filtering (e.g. byStatusStore emission) drop rows for hidden
// clients even when we only have the id.
export const HIDDEN_CLIENT_IDS = new Set<number>();

// Separate set of just the isTest client IDs — used by the UI to render the
// TEST badge on order rows / drawer.
export const TEST_CLIENT_IDS = new Set<number>();

function isHiddenClient(
  c:
    | { name?: string | null; id?: number | null; isTest?: boolean | null; active?: boolean | null }
    | null
    | undefined
): boolean {
  if (!c) return false;
  if (typeof c.id === 'number') {
    HIDDEN_CLIENT_IDS.delete(c.id);
    TEST_CLIENT_IDS.delete(c.id);
  }
  if (c.active === false) {
    if (typeof c.id === 'number') HIDDEN_CLIENT_IDS.add(c.id);
    return true;
  }
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

function isMockLabelPath(pathname: string): boolean {
  return /^\/(?:api\/)?labels\/mock\/-?\d+\/?$/i.test(pathname);
}

function normalizeMockLabelUrl(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;

  try {
    const parsed = new URL(value, API_BASE);
    if (!isMockLabelPath(parsed.pathname)) return value;

    const apiOrigin = new URL(API_BASE).origin;
    const shouldRewrite =
      value.startsWith('/') ||
      STALE_MOCK_LABEL_HOSTS.has(parsed.hostname) ||
      parsed.origin !== apiOrigin;

    if (!shouldRewrite) return value;
    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, apiOrigin).toString();
  } catch {
    return value;
  }
}

function normalizeLabelResponse<T>(response: T): T {
  if (!response || typeof response !== 'object') return response;
  const record = response as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'labelUrl')) return response;
  return {
    ...record,
    labelUrl: normalizeMockLabelUrl(record.labelUrl),
  } as T;
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

function normalizeInventoryDto(row: any, clientNamesById?: Map<number, string>): any {
  if (!row || typeof row !== 'object') return row;
  const currentStock = parseFiniteNumber(row.currentStock ?? row.stockQty) ?? 0;
  const minStock = parseFiniteNumber(row.minStock ?? row.reorderLevel) ?? 0;
  const unitsPerPack = parseFiniteNumber(row.units_per_pack ?? row.unitsPerPack) ?? 1;
  const length = parseFiniteNumber(row.packageLength ?? row.length) ?? 0;
  const width = parseFiniteNumber(row.packageWidth ?? row.width) ?? 0;
  const height = parseFiniteNumber(row.packageHeight ?? row.height) ?? 0;
  const soldLast30Days = parseFiniteNumber(row.soldLast30Days ?? row.last30DaysSold) ?? 0;
  // 2026-05-13: effective-stock fields from the new /inventory route
  // computation. Parsed defensively — undefined when the endpoint
  // (e.g. older deploy) doesn't return them.
  const totalReceived = parseFiniteNumber(row.totalReceived)
  const totalSoldAllTime = parseFiniteNumber(row.totalSoldAllTime)
  const effectiveStock = parseFiniteNumber(row.effectiveStock)
  const displayStock = effectiveStock ?? currentStock
  const clientId = parseFiniteNumber(row.clientId ?? row.client_id) ?? 0;
  const clientName =
    row.clientName ??
    row.client_name ??
    (clientId ? clientNamesById?.get(clientId) : undefined) ??
    (clientId ? `Client #${clientId}` : 'Shared Catalog');

  return {
    ...row,
    clientId,
    clientName,
    minStock,
    currentStock: displayStock,
    stockQty: displayStock,
    cachedStockQty: currentStock,
    reorderLevel: minStock,
    status: row.status ?? inventoryStatus(displayStock, minStock),
    units_per_pack: unitsPerPack,
    unitsPerPack,
    packageLength: length,
    packageWidth: width,
    packageHeight: height,
    productLength: parseFiniteNumber(row.productLength ?? row.length) ?? length,
    productWidth: parseFiniteNumber(row.productWidth ?? row.width) ?? width,
    productHeight: parseFiniteNumber(row.productHeight ?? row.height) ?? height,
    baseUnitQty: parseFiniteNumber(row.baseUnitQty) ?? 1,
    baseUnits: displayStock * (parseFiniteNumber(row.baseUnitQty) ?? 1),
    cuFtOverride: parseFiniteNumber(row.cuFtOverride),
    packageId: parseFiniteNumber(row.packageId),
    packageName: row.packageName ?? null,
    parentName: row.parentName ?? null,
    lastMovement: row.lastMovement ?? null,
    soldLast30Days,
    totalReceived,
    totalSoldAllTime,
    effectiveStock,
  };
}

function filterRowsToActiveClients(rows: any[], activeClientIds: Set<number>): any[] {
  return rows.filter((row) => {
    const clientId = parseFiniteNumber(row?.clientId ?? row?.client_id);
    return clientId == null || clientId === 0 || activeClientIds.has(clientId);
  });
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
    const hasOwnAccount = Boolean(
      row?.hasShipStationV1Credentials ||
        row?.hasShipStationV2Credentials
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
      hasOwnAccount,
      rateSourceClientId,
      rateSourceName:
        rateSourceClientId != null
          ? namesById.get(rateSourceClientId) ?? ''
          : hasOwnAccount
            ? row?.name ?? ''
            : '',
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
    warnThrottled(
      `safe:${methodName}`,
      `[v2-apiClient] ${methodName} failed:`,
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

const WARN_THROTTLE_MS = 60_000;
const warnLastSeen = new Map<string, number>();

function warnThrottled(key: string, ...args: unknown[]): void {
  const now = Date.now();
  const lastSeen = warnLastSeen.get(key) ?? 0;
  if (now - lastSeen < WARN_THROTTLE_MS) return;
  warnLastSeen.set(key, now);
  console.warn(...args);
}

type CachedRead<T> = {
  hasValue: boolean;
  value?: T;
  expiresAt: number;
  staleUntil: number;
  inFlight?: Promise<T>;
};

const cachedReads = new Map<string, CachedRead<unknown>>();

type CachedSafeOptions = {
  warn?: boolean;
  fallbackTtlMs?: number;
  fallbackStaleMs?: number;
  throwOnError?: boolean;
};

function clearCachedReads(...keysOrPrefixes: string[]): void {
  if (keysOrPrefixes.length === 0) return;
  for (const key of Array.from(cachedReads.keys())) {
    if (
      keysOrPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
    ) {
      cachedReads.delete(key);
    }
  }
}

async function cachedSafe<T>(
  methodName: string,
  cacheKey: string,
  ttlMs: number,
  staleMs: number,
  fn: () => Promise<T>,
  fallback: T,
  options: CachedSafeOptions = {}
): Promise<T> {
  const now = Date.now();
  const existing = cachedReads.get(cacheKey) as CachedRead<T> | undefined;
  if (existing?.hasValue && existing.expiresAt > now) return existing.value as T;
  if (existing?.inFlight) return existing.inFlight;

  const entry: CachedRead<T> = existing ?? {
    hasValue: false,
    expiresAt: 0,
    staleUntil: 0,
  };

  const inFlight = fn()
    .then((value) => {
      const settledAt = Date.now();
      cachedReads.set(cacheKey, {
        hasValue: true,
        value,
        expiresAt: settledAt + ttlMs,
        staleUntil: settledAt + staleMs,
      });
      return value;
    })
    .catch((err) => {
      const current = cachedReads.get(cacheKey) as CachedRead<T> | undefined;
      if (current?.hasValue && current.staleUntil > Date.now()) {
        if (options.warn !== false) {
          warnThrottled(
            `cached-stale:${methodName}`,
            `[v2-apiClient] ${methodName} failed; using cached value:`,
            err instanceof Error ? err.message : err
          );
        }
        return current.value as T;
      }
      if (options.warn !== false) {
        warnThrottled(
          `cached:${methodName}`,
          `[v2-apiClient] ${methodName} failed:`,
          err instanceof Error ? err.message : err
        );
      }
      if (options.throwOnError) throw err;
      const failedAt = Date.now();
      cachedReads.set(cacheKey, {
        hasValue: true,
        value: fallback,
        expiresAt: failedAt + (options.fallbackTtlMs ?? 60_000),
        staleUntil: failedAt + (options.fallbackStaleMs ?? 5 * 60_000),
      });
      return fallback;
    })
    .finally(() => {
      const current = cachedReads.get(cacheKey) as CachedRead<T> | undefined;
      if (current?.inFlight) {
        delete current.inFlight;
      }
    });

  cachedReads.set(cacheKey, {
    ...entry,
    inFlight,
  });
  return inFlight;
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

  // string passthroughs (names match across v2/v4, plus a few direct-carrier
  // hints that the Vercel carrier quoter can use).
  for (const k of ['toCountry', 'toState', 'toCity', 'toAddress', 'toName', 'externalOrderId', 'purchaseOrderId', 'orderNumber', 'confirmation', 'signature'] as const) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) {
      if (k === 'signature') out.confirmation ??= v;
      else out[k] = v;
    }
  }
  const fromPostalCode = input.fromPostalCode ?? input.fromZip;
  if (typeof fromPostalCode === 'string' && fromPostalCode.trim()) {
    out.fromZip = fromPostalCode.trim();
  }

  if (typeof input.residential === 'boolean') out.residential = input.residential;
  if (typeof input.forceRefresh === 'boolean') out.forceRefresh = input.forceRefresh;
  if (typeof input.forceLive === 'boolean') out.forceLive = input.forceLive;
  if (typeof input.cachedOnly === 'boolean') out.cachedOnly = input.cachedOnly;
  if (typeof input.preferredCarrierId === 'string' && input.preferredCarrierId) {
    out.preferredCarrierId = input.preferredCarrierId;
  }
  if (typeof input.includeAllDirectCarriers === 'boolean') out.includeAllDirectCarriers = input.includeAllDirectCarriers;
  if (Array.isArray(input.carrierIds)) out.carrierIds = input.carrierIds;
  const numericOrderId = typeof input.orderId === 'number'
    ? input.orderId
    : typeof input.orderId === 'string'
      ? Number.parseInt(input.orderId, 10)
      : NaN;
  const numericStoreId = typeof input.storeId === 'number'
    ? input.storeId
    : typeof input.storeId === 'string'
      ? Number.parseInt(input.storeId, 10)
      : NaN;
  const numericClientId = typeof input.clientId === 'number'
    ? input.clientId
    : typeof input.clientId === 'string'
      ? Number.parseInt(input.clientId, 10)
      : NaN;
  if (Number.isFinite(numericOrderId)) out.orderId = numericOrderId;
  if (Number.isFinite(numericStoreId)) out.storeId = numericStoreId;
  if (Number.isFinite(numericClientId)) out.clientId = numericClientId;
  if (input.shipFrom && typeof input.shipFrom === 'object') out.shipFrom = input.shipFrom;

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

type DirectCarrierAccountRow = {
  id: number;
  clientId?: number | null;
  provider: string;
  label?: string | null;
  accountIdentifier?: string | null;
  active?: boolean;
  sourceTable?: 'carrier_accounts' | 'store_accounts';
  assignedClientIds?: number[];
};

type DirectCarrierRatesResult = {
  ok: boolean;
  provider?: string;
  simulated?: boolean;
  rates?: DirectCarrierRateResult[];
  error?: string;
  meta?: Record<string, unknown>;
};

type DirectCarrierRateResult = {
  service: string;
  cost: number;
  days?: number;
  currency?: string;
  carrierCode?: string | null;
  carrierName?: string | null;
  carrierType?: string | null;
};

export type DirectCarrierRateError = {
  accountId: number;
  shippingProviderId?: number;
  sourceTable?: DirectAccountRef['sourceTable'];
  provider: string;
  label: string;
  message: string;
  // Resolution hint from the backend (e.g. 'store_orders lookup',
  // 'walmart_marketplace_api', 'store_orders fallback (settings demo)').
  // Surfaces under the rate browser cell so operators can tell whether
  // the rates came from their actual order vs. a fallback path.
  meta?: Record<string, unknown> | null;
};

// Per-carrier metadata returned alongside successful (or empty) rate
// fetches. Right now this is purely informational — the FE shows
// `purchaseOrderSource` as a subtle hint under the rate list.
export type DirectCarrierRateMeta = {
  accountId: number;
  shippingProviderId?: number;
  sourceTable?: DirectAccountRef['sourceTable'];
  provider: string;
  meta: Record<string, unknown>;
};

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isStoreProvider(provider: unknown): boolean {
  return STORE_PROVIDER_KEYS.has(normalizeProviderKey(provider));
}

function normalizeClientIdList(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map((item) => parseFiniteNumber(item))
        .filter((item): item is number => item != null)
    : [];
}

type DirectAccountRef = {
  accountId: number;
  sourceTable: 'carrier_accounts' | 'store_accounts';
};

function directProviderIdFromAccount(account: Pick<DirectCarrierAccountRow, 'id' | 'sourceTable'>): number {
  const offset = account.sourceTable === 'store_accounts'
    ? DIRECT_STORE_PROVIDER_ID_OFFSET
    : DIRECT_CARRIER_PROVIDER_ID_OFFSET;
  return offset + account.id;
}

function directAccountRefFromProviderId(providerId: number | null): DirectAccountRef | null {
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

function isDirectCarrierId(value: unknown): boolean {
  return directAccountRefFromProviderId(toProviderAccountId(value)) != null;
}

function directAccountKey(account: Pick<DirectCarrierAccountRow, 'id' | 'sourceTable'>): string {
  return `${account.sourceTable ?? 'carrier_accounts'}:${account.id}`;
}

function looksLikeOpaqueAccountIdentifier(value: unknown): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return false;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) return true;
  return /^(?:cid:)?[a-z0-9_-]{12,}$/i.test(trimmed);
}

function storeAccountMatchesOrder(
  row: DirectCarrierAccountRow,
  context: { storeId?: unknown; clientId?: unknown }
): boolean {
  const provider = normalizeProviderKey(row.provider);
  const storeId = parseFiniteNumber(context.storeId);
  const offset = SYNTHETIC_STORE_ID_OFFSETS[provider];
  if (storeId != null && offset != null && storeId === offset + row.id) return true;

  const rowClientId = parseFiniteNumber(row.clientId);
  const contextClientId = parseFiniteNumber(context.clientId);
  return rowClientId != null && contextClientId != null && rowClientId === contextClientId;
}

function directCarrierAccountVisibleForOrder(
  row: DirectCarrierAccountRow,
  context: { storeId?: unknown; clientId?: unknown; includeAllDirectCarriers?: unknown }
): boolean {
  const provider = normalizeProviderKey(row.provider);
  if ((row.sourceTable ?? 'carrier_accounts') === 'store_accounts') {
    return storeAccountMatchesOrder(row, context);
  }

  const contextClientId = parseFiniteNumber(context.clientId);
  if (context.includeAllDirectCarriers === true && contextClientId == null && context.storeId == null) {
    return !STORE_SCOPED_SHIPPING_PROVIDERS.has(provider);
  }

  const assignedClientIds = normalizeClientIdList(row.assignedClientIds);
  if (assignedClientIds.length > 0) {
    return contextClientId != null && assignedClientIds.includes(contextClientId);
  }

  const rowClientId = parseFiniteNumber(row.clientId);
  if (rowClientId != null) {
    return contextClientId != null && rowClientId === contextClientId;
  }

  // Marketplace-owned shipping APIs are not globally shared carriers. Without
  // a client/store match they would leak into unrelated clients like KFG.
  if (STORE_SCOPED_SHIPPING_PROVIDERS.has(provider)) return false;

  return true;
}

function normalizeDirectCarrierAccountDto(row: DirectCarrierAccountRow): any {
  const provider = normalizeProviderKey(row.provider);
  const shippingProviderId = directProviderIdFromAccount(row);
  const rowLabel = typeof row.label === 'string' ? row.label.trim() : '';
  const accountIdentifier = typeof row.accountIdentifier === 'string' ? row.accountIdentifier.trim() : '';
  const label =
    rowLabel && rowLabel !== accountIdentifier && !looksLikeOpaqueAccountIdentifier(rowLabel)
      ? rowLabel
      : DIRECT_ACCOUNT_PROVIDER_LABELS[provider] || rowLabel || accountIdentifier || provider;
  return {
    id: row.id,
    directCarrierAccountId: row.id,
    carrierId: `se-${shippingProviderId}`,
    carrierCode: provider,
    shippingProviderId,
    nickname: label,
    accountNumber: row.accountIdentifier ?? null,
    clientId: row.clientId ?? null,
    code: provider,
    _label: label,
    source: 'carrier_accounts',
    sourceTable: row.sourceTable ?? 'carrier_accounts',
    assignedClientIds: normalizeClientIdList(row.assignedClientIds),
    sourceClientName: 'Direct carrier accounts',
  };
}

async function fetchDirectCarrierAccountRows(): Promise<DirectCarrierAccountRow[]> {
  const [carrierRes, storeRes] = await Promise.all([
    callVercelFunction<{ data?: DirectCarrierAccountRow[] }>('/carrier-accounts?source=admin'),
    callVercelFunction<{ data?: DirectCarrierAccountRow[] }>('/store-accounts?source=admin').catch((err) => {
      console.warn(
        '[v2-apiClient] store account lookup for carrier rates failed:',
        err instanceof Error ? err.message : err
      );
      return { data: [] as DirectCarrierAccountRow[] };
    }),
  ]);
  const carriers = (carrierRes.data ?? [])
    .filter((row) => row && row.active !== false && row.provider)
    .filter((row) => !isStoreProvider(row.provider))
    .map((row) => ({
      ...row,
      provider: normalizeProviderKey(row.provider),
      sourceTable: 'carrier_accounts' as const,
      assignedClientIds: normalizeClientIdList(row.assignedClientIds),
    }));
  const derivedFromStores = (storeRes.data ?? [])
    .filter((row) => row && row.active !== false && row.provider)
    .filter((row) => normalizeProviderKey(row.provider) === 'ebay')
    .map((row) => ({
      ...row,
      provider: 'ebay_shipping',
      label: row.label ? `eBay Shipping - ${row.label}` : 'eBay Shipping',
      sourceTable: 'store_accounts' as const,
      assignedClientIds: normalizeClientIdList(row.assignedClientIds),
    }));
  return [...carriers, ...derivedFromStores];
}

function inferCarrierCodeForDirectRate(provider: string, service: string): string {
  const p = normalizeProviderKey(provider);
  const s = service.toLowerCase();
  if (s.includes('usps') || s.includes('postal')) return 'stamps_com';
  if (s.includes('fedex')) return 'fedex';
  if (s.includes('ups')) return 'ups';
  if (s.includes('dhl')) return 'dhl_express';
  if (p === 'usps') return 'stamps_com';
  if (p === 'fedex') return 'fedex';
  if (p === 'ups') return 'ups';
  return p || 'direct_carrier';
}

function normalizeCarrierCodeForDirectRate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = normalizeProviderKey(raw);
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  if (compact.includes('walmart')) return 'walmart_shipping';
  if (compact.includes('amazon')) return 'amazon_shipping';
  if (compact.includes('ebay')) return 'ebay_shipping';
  return normalized || null;
}

function slugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function translateDirectRateToV2Shape(
  rate: DirectCarrierRateResult,
  account: DirectCarrierAccountRow
): Record<string, unknown> {
  const provider = normalizeProviderKey(account.provider);
  const shippingProviderId = directProviderIdFromAccount(account);
  const serviceName = String(rate.service || provider || 'Direct carrier');
  const explicitCarrierCode = normalizeCarrierCodeForDirectRate(
    rate.carrierCode ?? rate.carrierType ?? rate.carrierName
  );
  const carrierCode = explicitCarrierCode ?? inferCarrierCodeForDirectRate(provider, serviceName);
  const carrierServicePrefix = carrierCode && carrierCode !== provider ? `${carrierCode}_` : '';
  const serviceCode = `${provider}_${carrierServicePrefix}${slugRateService(serviceName)}`;
  const amount = Number(rate.cost ?? 0);
  const currency = String(rate.currency ?? 'USD').toLowerCase();
  const accountLabel = account.label || account.accountIdentifier || provider;
  const raw = {
    provider,
    source: 'carrier_accounts',
    carrier_id: `se-${shippingProviderId}`,
    carrier_code: carrierCode,
    carrier_name: rate.carrierName ?? null,
    carrier_type: rate.carrierType ?? null,
    carrier_nickname: accountLabel,
    service_code: serviceCode,
    service_type: serviceName,
    shipping_amount: { amount, currency },
    other_amount: { amount: 0, currency },
    delivery_days: Number(rate.days ?? 0) || null,
  };
  return {
    carrierCode,
    serviceCode,
    serviceName,
    carrierNickname: accountLabel,
    shippingProviderId,
    sourceClientId: account.clientId ?? null,
    sourceClientName: 'Direct carrier accounts',
    provider,
    source: 'carrier_accounts',
    amount,
    shipmentCost: amount,
    otherCost: 0,
    deliveryDays: raw.delivery_days,
    raw,
  };
}

function directCarrierErrorMessage(provider: string, message: string): string {
  const providerKey = normalizeProviderKey(provider);
  if (providerKey === 'walmart_shipping' && /Walmart Shipping Estimates|unable to retrieve data|technical issue|required fields/i.test(message)) {
    return 'Walmart Shipping reached Walmart, but Walmart did not return rates. Confirm Ship With Walmart is enabled and the carrier ship-from address matches the Seller Center origin.';
  }
  if (providerKey === 'walmart_shipping' && /requires a Walmart purchaseOrderId|could not resolve.*purchaseOrderId|purchaseOrderId.*required/i.test(message)) {
    return 'Walmart Shipping could not resolve the Walmart purchaseOrderId for this request. Refresh the order after Pull Orders, then reopen Browse Rates from that Walmart order.';
  }
  if (providerKey === 'ebay_shipping') {
    if (/order/i.test(message) || /externalOrderId/i.test(message)) {
      return 'eBay Shipping rates require opening Browse Rates from an eBay order. The generic Rate Calculator does not have an eBay order id.';
    }
    if (/sell\.logistics|scope|OAuth/i.test(message)) {
      return 'eBay Shipping needs an eBay OAuth refresh token that includes the sell.logistics scope.';
    }
  }
  if (providerKey === 'ehub') {
    return 'eHub is in Settings now, but live rates need the eHub API base URL and rate endpoint docs before quotes can be returned.';
  }
  if (providerKey === 'shipp') {
    if (/apiKey|email|password|login|session cookie|Invalid API Key|Forbidden/i.test(message)) {
      return 'Shipp needs the saved x-api-key, email, and password to log in before PrepShip can request quote rates.';
    }
    if (/box dimensions|0 rates|quote/i.test(message)) {
      return 'Shipp reached the quote API but did not return rates. Confirm the package dimensions, ship-from address, and destination address are valid for your Shipp account.';
    }
  }
  return message;
}

async function fetchDirectCarrierRates(
  body: Record<string, unknown>,
  carrierIds: string[]
): Promise<{ rates: Record<string, unknown>[]; errors: DirectCarrierRateError[]; metas: DirectCarrierRateMeta[] }> {
  const refs = [...new Map(
    carrierIds
      .map((carrierId) => directAccountRefFromProviderId(toProviderAccountId(carrierId)))
      .filter((ref): ref is DirectAccountRef => ref != null)
      .map((ref) => [`${ref.sourceTable}:${ref.accountId}`, ref])
  ).values()];
  if (!refs.length) return { rates: [], errors: [], metas: [] };

  let rows: DirectCarrierAccountRow[] = [];
  let rowLookupSucceeded = false;
  try {
    const allRows = await fetchDirectCarrierAccountRows();
    rowLookupSucceeded = true;
    rows = refs
      .map((ref) =>
        allRows.find((row) =>
          row.id === ref.accountId &&
          (row.sourceTable ?? 'carrier_accounts') === ref.sourceTable
        ) ?? null
      )
      .filter((row): row is DirectCarrierAccountRow => row != null);
  } catch (err) {
    console.warn(
      '[v2-apiClient] direct carrier account lookup failed:',
      err instanceof Error ? err.message : err
    );
  }

  const rowByKey = new Map(rows.map((row) => [directAccountKey(row), row]));
  const visibleRefs = rowLookupSucceeded
    ? refs.filter((ref) => {
        const row = rowByKey.get(`${ref.sourceTable}:${ref.accountId}`);
        return row ? directCarrierAccountVisibleForOrder(row, body) : false;
      })
    : refs;
  const calls = visibleRefs.map(async (ref) => {
    const accountKey = `${ref.sourceTable}:${ref.accountId}`;
    const account = rowByKey.get(accountKey) ?? {
      id: ref.accountId,
      provider: 'direct_carrier',
      label: `Direct Carrier #${ref.accountId}`,
      active: true,
      sourceTable: ref.sourceTable,
    };
    const label = account.label || account.accountIdentifier || account.provider;
    try {
      const res = await callVercelFunction<DirectCarrierRatesResult>('/carriers/rates', {
        method: 'POST',
        body: {
          ...(ref.sourceTable === 'store_accounts'
            ? { storeAccountId: ref.accountId }
            : { carrierAccountId: ref.accountId }),
          provider: account.provider,
          weightOz: body.weightOz,
          fromZip: body.fromZip,
          toZip: body.toZip,
          dimsL: body.dimsL,
          dimsW: body.dimsW,
          dimsH: body.dimsH,
          orderId: body.orderId,
          externalOrderId: body.externalOrderId ?? body.orderNumber,
          orderNumber: body.orderNumber,
          purchaseOrderId: body.purchaseOrderId,
          confirmation: body.confirmation,
          shipFrom: body.shipFrom,
        },
      });
      // Fix 3 (2026-05-12): thread the backend's meta object back into
      // the FE result. The Rate Browser renders `meta.purchaseOrderSource`
      // as a small hint under the rate list so operators can tell whether
      // rates came from their actual order, a marketplace lookup, or a
      // settings-demo fallback.
      const backendMeta = res.meta && typeof res.meta === 'object' ? (res.meta as Record<string, unknown>) : null;
      const metaEntry: DirectCarrierRateMeta | null = backendMeta
        ? {
            accountId: ref.accountId,
            shippingProviderId: directProviderIdFromAccount(account),
            sourceTable: ref.sourceTable,
            provider: normalizeProviderKey(res.provider ?? account.provider),
            meta: backendMeta,
          }
        : null;

      if (!res.ok) {
        const message = directCarrierErrorMessage(
          res.provider ?? account.provider,
          res.error ?? 'No rates returned'
        );
        console.warn(
          `[v2-apiClient] direct carrier ${account.provider} returned no rates:`,
          message
        );
        return {
          rates: [],
          errors: [{
            accountId: ref.accountId,
            shippingProviderId: directProviderIdFromAccount(account),
            sourceTable: ref.sourceTable,
            provider: normalizeProviderKey(res.provider ?? account.provider),
            label,
            message,
            meta: backendMeta,
          }],
          metas: metaEntry ? [metaEntry] : [],
        };
      }
      const accountForRates = {
        ...account,
        provider: normalizeProviderKey(res.provider ?? account.provider),
      };
      const rates = (res.rates ?? [])
        .filter((rate) => Number(rate.cost ?? 0) > 0)
        .map((rate) => translateDirectRateToV2Shape(rate, accountForRates));
      return { rates, errors: [], metas: metaEntry ? [metaEntry] : [] };
    } catch (err) {
      const message = directCarrierErrorMessage(
        account.provider,
        err instanceof Error ? err.message : String(err)
      );
      console.warn(
        `[v2-apiClient] direct carrier #${ref.accountId} rates failed:`,
        message
      );
      return {
        rates: [],
        errors: [{
          accountId: ref.accountId,
          shippingProviderId: directProviderIdFromAccount(account),
          sourceTable: ref.sourceTable,
          provider: normalizeProviderKey(account.provider),
          label,
          message,
          meta: null,
        }],
        metas: [] as DirectCarrierRateMeta[],
      };
    }
  });

  const settled = await Promise.all(calls);
  return {
    rates: settled.flatMap((item) => item.rates),
    errors: settled.flatMap((item) => item.errors),
    metas: settled.flatMap((item) => item.metas ?? []),
  };
}

function rateResultTextKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function rateResultMoneyKey(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

function rateResultDedupeKey(rate: Record<string, unknown>): string {
  const raw = rate.raw && typeof rate.raw === 'object'
    ? rate.raw as Record<string, unknown>
    : {};
  const rawShipping = raw.shipping_amount && typeof raw.shipping_amount === 'object'
    ? raw.shipping_amount as Record<string, unknown>
    : {};
  const rawOriginal = raw.original_amount && typeof raw.original_amount === 'object'
    ? raw.original_amount as Record<string, unknown>
    : {};
  const rawOther = raw.other_amount && typeof raw.other_amount === 'object'
    ? raw.other_amount as Record<string, unknown>
    : {};
  const rawConfirmation = raw.confirmation_amount && typeof raw.confirmation_amount === 'object'
    ? raw.confirmation_amount as Record<string, unknown>
    : {};
  const rawInsurance = raw.insurance_amount && typeof raw.insurance_amount === 'object'
    ? raw.insurance_amount as Record<string, unknown>
    : {};
  const shipmentCost = rawOriginal.amount ?? rate.shipmentCost ?? rawShipping.amount ?? rate.amount ?? 0;
  const otherCost =
    Number(rate.otherCost ?? 0) ||
    (Number(rawOther.amount ?? 0) + Number(rawConfirmation.amount ?? 0));

  return [
    rateResultTextKey(rate.shippingProviderId ?? raw.carrier_id),
    rateResultTextKey(rate.carrierCode ?? raw.carrier_code),
    rateResultTextKey(rate.serviceCode ?? raw.service_code ?? rate.serviceName ?? raw.service_type),
    rateResultMoneyKey(shipmentCost),
    rateResultMoneyKey(otherCost),
    rateResultMoneyKey(rawConfirmation.amount),
    rateResultMoneyKey(rawInsurance.amount),
    rateResultTextKey(raw.estimated_delivery_date ?? raw.delivery_days ?? rate.deliveryDays),
  ].join('|');
}

function dedupeRateResults<T extends Record<string, unknown>>(rates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const rate of rates) {
    const key = rateResultDedupeKey(rate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rate);
      continue;
    }
    const existingRaw = existing.raw && typeof existing.raw === 'object'
      ? existing.raw as Record<string, unknown>
      : {};
    const rateRaw = rate.raw && typeof rate.raw === 'object'
      ? rate.raw as Record<string, unknown>
      : {};
    if (!existingRaw.rate_id && rateRaw.rate_id) {
      byKey.set(key, rate);
    }
  }
  return [...byKey.values()];
}

const rateBrowseInflight = new Map<string, Promise<any>>();

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

// Maps v4's ShipStation-v2-passthrough rate object to the v2-legacy shape
// the bulk-ported components read. Defensive: if a caller already hands us
// v2-shape data (has `amount` + `carrierCode`), return it unchanged.
function translateRateToV2Shape(r: unknown): Record<string, unknown> {
  if (r && typeof r === 'object') {
    const obj = r as Record<string, unknown>;
    if ('amount' in obj && 'carrierCode' in obj) return obj;
    const shipping = obj.shipping_amount as { amount?: unknown } | undefined;
    const originalShipping = obj.original_amount as { amount?: unknown } | undefined;
    const other = obj.other_amount as { amount?: unknown } | undefined;
    const confirmation = obj.confirmation_amount as { amount?: unknown } | undefined;
    const shipmentCost =
      typeof originalShipping?.amount === 'number' ? originalShipping.amount :
      typeof shipping?.amount === 'number' ? shipping.amount : 0;
    const otherCost =
      (typeof other?.amount === 'number' ? other.amount : 0) +
      (typeof confirmation?.amount === 'number' ? confirmation.amount : 0);
    return {
      carrierCode: obj.carrier_code ?? null,
      serviceCode: obj.service_code ?? null,
      serviceName: obj.service_type ?? null,
      carrierNickname: obj.carrier_nickname ?? null,
      shippingProviderId: toProviderAccountId(obj.carrier_id),
      sourceClientId: obj.source_client_id ?? obj.sourceClientId ?? null,
      sourceClientName: obj.source_client_name ?? obj.sourceClientName ?? null,
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
    return cachedSafe(
      'fetchCounts',
      `fetchCounts:${dateFrom ?? ''}:${dateTo ?? ''}`,
      120_000,
      15 * 60_000,
      async () => {
        if (hasDate) {
          const legacyCounts = await api.get<any>(`/init/counts${qs({ dateFrom, dateTo })}`, {
            timeoutMs: 8_000,
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

        const legacyCounts = await api.get<any>('/init/counts', { timeoutMs: 8_000 });
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
          api.get<any>('/init/stores', { timeoutMs: 8_000 }).catch(() => ({ data: [] })),
          api.get<any>('/clients?includeInactive=true', { timeoutMs: 8_000 }).catch(() => []),
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

  fetchInitData(): Promise<any> {
    return api.get<any>('/init/init-data');
  },

  // ─── Clients ────────────────────────────────────────────────────────────────
  fetchClients(): Promise<any[]> {
    return cachedSafe(
      'fetchClients',
      'fetchClients',
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(`/clients${qs({ activeOnly: true })}`, { timeoutMs: 8_000 });
        return normalizeClientDtoRows(Array.isArray(res) ? res : []);
      },
      [],
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
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
        const res = await api.get<any>('/init/carrier-accounts', { timeoutMs: 8_000 });
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
        const row = await api.get<SettingsRow>('/settings/orders.columnPrefs', { timeoutMs: 8_000 });
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

  // ─── Sync status ────────────────────────────────────────────────────────────
  fetchLegacySyncStatus(): Promise<any> {
    return cachedSafe(
      'fetchLegacySyncStatus',
      'fetchLegacySyncStatus',
      90_000,
      10 * 60_000,
      () => api.get<any>('/sync/status', { timeoutMs: 6_000 }),
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
      () => api.get<any>('/worker/status', { timeoutMs: 6_000 }),
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

  fetchOrderFull(orderId: number): Promise<any> {
    return api.get<any>(`/orders/${orderId}/full`);
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
          timeoutMs: 8_000,
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

  createManualOrder(payload: Record<string, unknown>): Promise<any> {
    return api.post<any>('/orders/manual', payload);
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
    const queryString = qs({
      dateFrom: toIsoDayStart(query?.dateFrom),
      dateTo: toIsoDayEnd(query?.dateTo),
    });
    return cachedSafe(
      'fetchDailyStats',
      `fetchDailyStats:${queryString}`,
      5 * 60_000,
      30 * 60_000,
      async () => {
        // V2 parity: the daily stats endpoint applies only the configured
        // excluded store IDs server-side.
        const res = await api.get<unknown>(`/orders/daily-stats${queryString}`, { timeoutMs: 8_000 });
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
    const body = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
    const shippingProviderId = parseFiniteNumber(body.shippingProviderId);
    const directRef = directAccountRefFromProviderId(shippingProviderId);

    // Direct carrier accounts use synthetic provider ids (10,000,000 + row id),
    // not ShipStation carrier ids. Always route those labels through the
    // Vercel direct-carrier label endpoint so ShipStation never receives
    // non-existent ids like `se-10000025` or service codes like `shipp_*`.
    if (directRef?.sourceTable === 'carrier_accounts') {
      return callVercelFunction<any>('/carriers/labels', {
        method: 'POST',
        body: {
          ...body,
          carrierAccountId: directRef.accountId,
          dimsL: body.length ?? body.dimsL,
          dimsW: body.width ?? body.dimsW,
          dimsH: body.height ?? body.dimsH,
        },
      }).then(normalizeLabelResponse);
    }

    return api.post<any>('/labels', payload).then(normalizeLabelResponse);
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
    return api.get<any>(path).then(normalizeLabelResponse);
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
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        Accept: 'application/pdf,application/octet-stream,*/*',
      };
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
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
    return cachedSafe(
      'fetchLocations',
      'fetchLocations',
      60_000,
      10 * 60_000,
      async () => {
        const res = await api.get<any>('/locations', { timeoutMs: 8_000 });
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
    return cachedSafe(
      'fetchPackages',
      `fetchPackages:${source ?? ''}`,
      5 * 60_000,
      30 * 60_000,
      async () => {
        const res = await api.get<any>(`/packages${qs({ source })}`, { timeoutMs: 8_000 });
        if (Array.isArray(res)) return res.map(normalizePackageDto);
        if (Array.isArray(res?.data)) return res.data.map(normalizePackageDto);
        return [];
      },
      [],
      { warn: false, fallbackTtlMs: 2 * 60_000, fallbackStaleMs: 30 * 60_000 }
    );
  },

  fetchLowStockPackages(): Promise<any[]> {
    // v4 has no /packages/low-stock — derive client-side.
    return apiClient.fetchPackages().then((rows) =>
      rows.filter(
        (p: any) =>
          typeof p?.stockQty === 'number' &&
          typeof p?.reorderLevel === 'number' &&
          p.stockQty <= p.reorderLevel
      )
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
      async () => {
        const res = await api.put<any>(`/billing/config/${clientId}`, payload);
        clearCachedReads('fetchBillingConfigs', 'fetchBillingSummary');
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
        clearCachedReads('fetchBillingSummary');
        return res;
      },
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
    return cachedSafe(
      'fetchBillingSummary',
      `fetchBillingSummary:${dateFrom ?? ''}:${dateTo ?? ''}:${clientId ?? ''}`,
      60_000,
      10 * 60_000,
      async () => {
        const [res, clientsRes] = await Promise.all([
          api.get<any>(`/billing/summary${qs({ dateFrom, dateTo, clientId })}`),
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
  // fetchRates is the ONE place in the app that translates between v2's rate
  // shape (shared by the bulk-ported RatesView / OrdersView side-panel / any
  // future caller) and v4's ShipStation-v2-passthrough shape. Callers may
  // pass either v4 shape (weightOz / toZip / dimsL/W/H) or legacy v2 shape
  // (toPostalCode / weight.value / dimensions.length / …); we normalize to v4
  // on input and remap to v2-legacy on output so every reader of the result
  // can use the same field names the bulk-ported v2 code expects.
  fetchRates(data: Record<string, unknown>): Promise<any[]> {
    return (async () => {
        const body = translateRatePayloadToV4(data);
        const requestedCarrierIds = Array.isArray(body.carrierIds)
          ? body.carrierIds.map((value) => String(value)).filter(Boolean)
          : null;
        const shipStationCarrierIds = requestedCarrierIds
          ? requestedCarrierIds.filter((carrierId) => !isDirectCarrierId(carrierId))
          : null;
        let directCarrierIds = requestedCarrierIds?.filter(isDirectCarrierId) ?? [];
        if (requestedCarrierIds == null) {
          const directRows = await fetchDirectCarrierAccountRows().catch((err) => {
            console.warn(
              '[v2-apiClient] automatic direct-carrier lookup failed:',
              err instanceof Error ? err.message : err
            );
            return [] as DirectCarrierAccountRow[];
          });
          directCarrierIds = [...new Set(
            directRows
              .filter((row) => directCarrierAccountVisibleForOrder(row, body))
              .map((row) => `se-${directProviderIdFromAccount(row)}`)
          )];
        }

        const shouldFetchShipStation =
          requestedCarrierIds == null || (shipStationCarrierIds?.length ?? 0) > 0;

        const [shipStationRates, directRates] = await Promise.all([
          shouldFetchShipStation
            ? api.post<any>('/rates', {
                ...body,
                ...(shipStationCarrierIds
                  ? { carrierIds: shipStationCarrierIds }
                  : {}),
              }).then((res) => {
                const rawRates = Array.isArray(res)
                  ? res
                  : Array.isArray(res?.rates)
                    ? res.rates
                    : [];
                return rawRates.map(translateRateToV2Shape);
              })
            : Promise.resolve([]),
          directCarrierIds.length
            ? fetchDirectCarrierRates(body, directCarrierIds)
            : Promise.resolve({ rates: [], errors: [], metas: [] }),
        ]);

        const combined = dedupeRateResults([...shipStationRates, ...directRates.rates]).sort((left, right) => {
          const leftAmount = Number((left as any).shipmentCost ?? (left as any).amount ?? 0) +
            Number((left as any).otherCost ?? 0);
          const rightAmount = Number((right as any).shipmentCost ?? (right as any).amount ?? 0) +
            Number((right as any).otherCost ?? 0);
          return leftAmount - rightAmount;
        });
        Object.defineProperty(combined, 'directCarrierErrors', {
          value: directRates.errors,
          enumerable: false,
        });
        // Fix 3 (2026-05-12): direct-carrier meta (e.g. purchaseOrderSource)
        // is attached to the combined array the same way as errors. The
        // Rate Browser pulls it via (raw as any).directCarrierMetas to
        // render the "where did these rates come from" hint per carrier.
        Object.defineProperty(combined, 'directCarrierMetas', {
          value: directRates.metas,
          enumerable: false,
        });
        return combined;
      })();
  },

  // v2 parity: thin wrapper around POST /rates/browse. Backend already
  // returns `{rates, bestRate, ...}` — we passthrough verbatim (no
  // translation) since the rate-browser UI consumes the v4 shape directly.
  browseRates(data: Record<string, unknown>): Promise<any> {
    const run = async () => {
        const body = translateRatePayloadToV4(data);
        const requestedCarrierIds = Array.isArray(body.carrierIds)
          ? body.carrierIds.map((value) => String(value)).filter(Boolean)
          : [];
        const shipStationCarrierIds = requestedCarrierIds.filter((carrierId) => !isDirectCarrierId(carrierId));
        const directCarrierIds = requestedCarrierIds.filter(isDirectCarrierId);
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

        const inFlight = (async () => {
          const shouldFetchShipStation =
            requestedCarrierIds.length === 0 || shipStationCarrierIds.length > 0;
          const shouldFetchDirect = directCarrierIds.length > 0 && body.cachedOnly !== true;
          const [shipStationResult, directRates] = await Promise.all([
            shouldFetchShipStation
              ? api.post<any>('/rates/browse', {
                  ...body,
                  ...(shipStationCarrierIds.length ? { carrierIds: shipStationCarrierIds } : {}),
                  ...(preferredCarrierId ? { preferredCarrierId } : {}),
                })
              : Promise.resolve({
                  rates: [],
                  bestRate: null,
                  cached: false,
                  source: 'live',
                  carrierStatuses: [],
                  carrierDiagnostics: [],
                }),
            shouldFetchDirect
              ? fetchDirectCarrierRates(body, directCarrierIds)
              : Promise.resolve({ rates: [], errors: [], metas: [] }),
          ]);
          const shipStationRates = Array.isArray(shipStationResult?.rates)
            ? shipStationResult.rates.map(translateRateToV2Shape)
            : [];
          const combined = dedupeRateResults([...shipStationRates, ...directRates.rates]).sort((left, right) => {
            const leftAmount = Number((left as any).shipmentCost ?? (left as any).amount ?? 0) +
              Number((left as any).otherCost ?? 0);
            const rightAmount = Number((right as any).shipmentCost ?? (right as any).amount ?? 0) +
              Number((right as any).otherCost ?? 0);
            return leftAmount - rightAmount;
          });
          const bestRate = combined[0] ?? (
            shipStationResult?.bestRate
              ? translateRateToV2Shape(shipStationResult.bestRate)
              : null
          );
          const directCarrierStatuses = directCarrierIds.map((carrierId) => {
            const providerId = toProviderAccountId(carrierId);
            const hasRate = combined.some((rate) => {
              const raw = rate.raw && typeof rate.raw === 'object' ? rate.raw as Record<string, unknown> : {};
              return String(rate.shippingProviderId ?? raw.carrier_id) === String(providerId);
            });
            const error = directRates.errors.find((item) => String(item.shippingProviderId) === String(providerId));
            const rateCount = directRates.rates.filter((rate) => {
              const raw = rate.raw && typeof rate.raw === 'object' ? rate.raw as Record<string, unknown> : {};
              return String(rate.shippingProviderId ?? raw.carrier_id) === String(providerId);
            }).length;
            return {
              carrierId,
              carrierName: error?.label ?? carrierId,
              status: hasRate
                ? body.cachedOnly === true
                  ? 'cached'
                  : 'live'
                : error
                  ? 'error'
                  : body.cachedOnly === true
                  ? 'loading'
                  : 'unavailable',
              rateCount,
              error: error?.message,
            };
          });
          const shipStationDiagnostics = Array.isArray(shipStationResult?.carrierDiagnostics)
            ? shipStationResult.carrierDiagnostics.map((diagnostic: Record<string, unknown>) => ({
                ...diagnostic,
                source: 'shipstation',
              }))
            : [];
          const directCarrierDiagnostics = directCarrierStatuses.map((status) => ({
            carrierId: status.carrierId,
            nickname: status.carrierName,
            source: 'direct',
            status:
              status.status === 'live'
                ? 'ok'
                : status.status === 'unavailable'
                  ? 'empty'
                  : status.status === 'error'
                    ? 'failed'
                    : status.status,
            rateCount: status.rateCount,
            error: status.error,
          }));
          return {
            ...shipStationResult,
            requestKey: shipStationResult?.requestKey ?? requestKey,
            rates: combined,
            bestRate,
            carrierStatuses: [
              ...(Array.isArray(shipStationResult?.carrierStatuses) ? shipStationResult.carrierStatuses : []),
              ...directCarrierStatuses,
            ],
            carrierDiagnostics: [
              ...shipStationDiagnostics,
              ...directCarrierDiagnostics,
            ],
            directCarrierErrors: directRates.errors,
            directCarrierMetas: directRates.metas,
          };
        })();

        rateBrowseInflight.set(requestKey, inFlight);
        try {
          return await inFlight;
        } finally {
          rateBrowseInflight.delete(requestKey);
        }
    };
    return run();
  },

  // ─── Analysis ──────────────────────────────────────────────────────────────

  // Server-aggregated daily order counts split by status. Replaces the
  // previous Dashboard pattern of paginating through every order in the
  // 30-day window (up to 5000 rows!) just to bucket them client-side.
  // Backend does ONE GROUP BY query and returns ~30 rows. See
  // src/routes/orders.ts /daily-counts.
  fetchOrdersDailyCounts(query: { from: string; to: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    data: Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }>;
  }> {
    return safe(
      'fetchOrdersDailyCounts',
      async () => {
        const q: Record<string, string | number | boolean> = { from: query.from, to: query.to };
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        const res: any = await api.get<any>(`/orders/daily-counts${qs(q)}`);
        const data = Array.isArray(res?.data) ? res.data : [];
        return { data };
      },
      // Fallback returned on error so the dashboard render code can keep
      // pattern-matching `payload?.data` without an extra null guard.
      { data: [] as Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }> }
    );
  },

  fetchDashboardOrderSales(query: { from: string; to: string; sevenFrom?: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    revenue: number;
    units: number;
    bySku: Array<{ sku: string; revenue: number; units30: number; units7: number }>;
    dailyRevenue: Array<{ day: string; revenue: number }>;
  }> {
    return safe(
      'fetchDashboardOrderSales',
      async () => {
        const q: Record<string, string | number | boolean> = {
          from: query.from,
          to: query.to,
        };
        if (query.sevenFrom) q.sevenFrom = query.sevenFrom;
        if (query.clientId !== undefined) q.clientId = query.clientId;
        if (query.storeId !== undefined) q.storeId = query.storeId;
        if (query.hideTestOrders) q.hideTestOrders = true;
        const res: any = await api.get<any>(`/orders/dashboard-sales${qs(q)}`);
        return {
          revenue: Number(res?.revenue) || 0,
          units: Number(res?.units) || 0,
          bySku: Array.isArray(res?.bySku) ? res.bySku : [],
          dailyRevenue: Array.isArray(res?.dailyRevenue) ? res.dailyRevenue : [],
        };
      },
      {
        revenue: 0,
        units: 0,
        bySku: [] as Array<{ sku: string; revenue: number; units30: number; units7: number }>,
        dailyRevenue: [] as Array<{ day: string; revenue: number }>,
      }
    );
  },

  fetchDashboardDailyCounts(query: { from: string; to: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    data: Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }>;
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
        return { data };
      },
      { data: [] as Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }> }
    );
  },

  fetchDashboardSummary(query: { from: string; to: string; sevenFrom?: string; clientId?: number; storeId?: number; hideTestOrders?: boolean }): Promise<{
    revenue: number;
    units: number;
    bySku: Array<{ sku: string; revenue: number; units30: number; units7: number }>;
    dailyRevenue: Array<{ day: string; revenue: number }>;
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
        };
      },
      {
        revenue: 0,
        units: 0,
        bySku: [] as Array<{ sku: string; revenue: number; units30: number; units7: number }>,
        dailyRevenue: [] as Array<{ day: string; revenue: number }>,
      }
    );
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
        return { dates, topSkus, series };
      },
      { dates: [], topSkus: [], series: {} }
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

  fetchDashboardInventoryRisk(query?: { clientId?: number; active?: boolean; pageSize?: number }): Promise<{
    items: any[];
    total: number;
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
        };
      },
      { items: [], total: 0 },
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
