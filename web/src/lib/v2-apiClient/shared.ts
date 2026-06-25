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

import { api, qs } from '../api';
import { API_BASE } from '../api-base';
import { getCachedAuthToken } from '../auth-session-cache';
import { buildManifestCsv, manifestRowsFromResponse } from '../../components/Views/manifests-parity';
// PS-292: the SHIPP house-account tuple (backend-owned, src/routes/rates.ts) must SURVIVE this v2
// translation. The allowlist below historically dropped nextBestNonHouseRate/houseMargin (they
// remained only under `raw`), so every FE save persisted best_rate_json without the tuple and the
// Awaiting/Rate-Browser UI had nothing to render. Pass them through via the single FE owner.
import { houseTuplePassThrough } from '../rate-browser-house-tuple';
// PS-083: shared "is this direct carrier usable for this scope?" decision —
// the SAME module the backend `/carriers/rates` + `/carriers/labels` gates use,
// so Rate Browser hiding and server-side rejection can never drift apart.
import { directCarrierVisibleForScope } from '../../../../src/lib/direct-carrier-scope';

export async function authHeaders(): Promise<Record<string, string>> {
  const accessToken = await getCachedAuthToken();
  const h: Record<string, string> = {};
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
  return h;
}

export function parseDownloadFilename(
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
export const HIDDEN_CLIENT_NAMES = new Set(['api shipments']);
export const STALE_MOCK_LABEL_HOSTS = new Set(['prepshipv4-api.onrender.com']);
// PS-286 (slice): the offsets + the synthetic-id predicate now live in the PURE
// web/src/lib/direct-carrier-id module (importable without the network-client
// barrel). Imported here and re-exported so every existing import site of
// `../v2-apiClient/...` keeps working and there is still ONE source of truth.
import {
  DIRECT_CARRIER_PROVIDER_ID_OFFSET,
  DIRECT_STORE_PROVIDER_ID_OFFSET,
  directAccountRefFromProviderId,
  isDirectCarrierId,
  type DirectAccountRef,
} from '../direct-carrier-id';
export {
  DIRECT_CARRIER_PROVIDER_ID_OFFSET,
  DIRECT_STORE_PROVIDER_ID_OFFSET,
  directAccountRefFromProviderId,
  isDirectCarrierId,
  type DirectAccountRef,
};
export const STORE_PROVIDER_KEYS = new Set([
  'walmart',
  'amazon',
  'ebay',
  'shopify',
  'etsy',
  'tiktok_shop',
  'woocommerce',
  'bigcommerce',
]);
// PS-083: store-scoped provider handling now lives in the shared
// src/lib/direct-carrier-scope module (isStoreScopedShippingProvider).
export const SYNTHETIC_STORE_ID_OFFSETS: Record<string, number> = {
  walmart_shipping: 9_000_000,
  amazon_shipping: 9_100_000,
  ebay_shipping: 9_500_000,
};

export const DIRECT_ACCOUNT_PROVIDER_LABELS: Record<string, string> = {
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

export function isHiddenClient(
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

export function normalizeSyntheticTestStoreQuery(q: Record<string, unknown>): void {
  if (q.storeId == null) return;
  const storeId = Number(q.storeId);
  if (!Number.isFinite(storeId) || storeId >= 0) return;
  q.clientId = Math.abs(storeId);
  delete q.storeId;
}

export function isMockLabelPath(pathname: string): boolean {
  return /^\/(?:api\/)?labels\/mock\/-?\d+\/?$/i.test(pathname);
}

export function normalizeMockLabelUrl(value: unknown): unknown {
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

export function normalizeLabelResponse<T>(response: T): T {
  if (!response || typeof response !== 'object') return response;
  const record = response as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'labelUrl')) return response;
  return {
    ...record,
    labelUrl: normalizeMockLabelUrl(record.labelUrl),
  } as T;
}

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizePackageDto(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const packageId = parseFiniteNumber(row.packageId ?? row.id);
  const unitCost = parseFiniteNumber(row.unitCost);
  return {
    ...row,
    packageId: packageId ?? row.packageId,
    unitCost,
  };
}

export function normalizePackageResponse(res: any): any {
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

export function normalizePackageMutationPayload(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data };
  if (next.unitCost == null || next.unitCost === '') {
    delete next.unitCost;
  } else {
    next.unitCost = String(next.unitCost);
  }
  return next;
}

export function normalizePackageReceivePayload(data: Record<string, unknown>): Record<string, unknown> {
  const unitCost = data.unitCost ?? data.costPerUnit;
  const payload: Record<string, unknown> = {
    qty: Number(data.qty ?? 0),
  };
  if (unitCost != null && unitCost !== '') payload.unitCost = Number(unitCost);
  if (data.note != null && String(data.note).trim()) payload.note = String(data.note).trim();
  return payload;
}

export function normalizePackageAdjustPayload(data: Record<string, unknown>): Record<string, unknown> {
  const qtyDelta = data.qtyDelta ?? data.qty;
  const payload: Record<string, unknown> = {
    qtyDelta: Number(qtyDelta ?? 0),
  };
  if (data.note != null && String(data.note).trim()) payload.note = String(data.note).trim();
  return payload;
}

export function normalizePackageLedgerEntry(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const delta = parseFiniteNumber(row.delta ?? row.qtyDelta) ?? 0;
  return {
    ...row,
    delta,
    reason: row.reason ?? row.note ?? row.changeType ?? '',
    unitCost: parseFiniteNumber(row.unitCost),
  };
}

export function normalizePackageMovementResponse(res: any): any {
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

export function normalizeProductDefaultsPayload(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data };
  if (next.defaultPackageCode === undefined && 'packageId' in next) {
    next.defaultPackageCode = next.packageId == null || next.packageId === ''
      ? null
      : String(next.packageId);
  }
  delete next.packageId;
  return next;
}

export function inventoryStatus(stockQty: number, reorderLevel: number): 'ok' | 'low' | 'out' {
  if (stockQty <= 0) return 'out';
  if (stockQty <= reorderLevel) return 'low';
  return 'ok';
}

export function normalizeInventoryDto(row: any, clientNamesById?: Map<number, string>): any {
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
    // PS-324: backend-owned per-unit cubic feet (storage-fee input). undefined when an older
    // deploy's /inventory route doesn't stamp it yet — the FE getInventoryCuFt then falls back
    // to the legacy override/dims math.
    cuFt: parseFiniteNumber(row.cuFt),
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

export function filterRowsToActiveClients(rows: any[], activeClientIds: Set<number>): any[] {
  return rows.filter((row) => {
    const clientId = parseFiniteNumber(row?.clientId ?? row?.client_id);
    return clientId == null || clientId === 0 || activeClientIds.has(clientId);
  });
}

export function normalizeClientDtoRows(rows: any[]): any[] {
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

export function normalizeClientMutationPayload(data: Record<string, unknown>): Record<string, unknown> {
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
export function toIsoDayStart(d: string | undefined | null): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T00:00:00.000Z`).toISOString();
}
export function toIsoDayEnd(d: string | undefined | null): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T23:59:59.999Z`).toISOString();
}

export function normalizeAnalysisRange(query: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
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

export async function safe<T>(
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

export const WARN_THROTTLE_MS = 60_000;
export const warnLastSeen = new Map<string, number>();
export const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response';

export function warnThrottled(key: string, ...args: unknown[]): void {
  const now = Date.now();
  const lastSeen = warnLastSeen.get(key) ?? 0;
  if (now - lastSeen < WARN_THROTTLE_MS) return;
  warnLastSeen.set(key, now);
  console.warn(...args);
}

export type CachedRead<T> = {
  hasValue: boolean;
  value?: T;
  expiresAt: number;
  staleUntil: number;
  inFlight?: Promise<T>;
};

export const cachedReads = new Map<string, CachedRead<unknown>>();

export type CachedSafeOptions = {
  warn?: boolean;
  fallbackTtlMs?: number;
  fallbackStaleMs?: number;
  throwOnError?: boolean;
};

export function clearCachedReads(...keysOrPrefixes: string[]): void {
  if (keysOrPrefixes.length === 0) return;
  for (const key of Array.from(cachedReads.keys())) {
    if (
      keysOrPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
    ) {
      cachedReads.delete(key);
    }
  }
}

export async function cachedSafe<T>(
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

export function notImpl<T>(methodName: string, fallback: T): Promise<T> {
  console.warn(`[v2-apiClient] ${methodName}: no v4 equivalent; returning default`);
  return Promise.resolve(fallback);
}

// ── Rate payload / response translation ──────────────────────────────────────
// Accepts either v4 shape or legacy v2 shape and normalizes to what v4's
// POST /rates Zod schema expects. Used by fetchRates — do NOT call directly
// from components; go through apiClient.fetchRates so callers can keep using
// the v2 input convention if they prefer.
export function translateRatePayloadToV4(
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
  for (const k of ['toCountry', 'toState', 'toCity', 'toAddress', 'toName', 'externalOrderId', 'purchaseOrderId', 'orderNumber', 'clientName', 'confirmation', 'signature', 'insuranceProvider', 'insurance'] as const) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) {
      if (k === 'signature') out.confirmation ??= v;
      else out[k] = v;
    }
  }
  const insuredValue = input.insuredValue ?? input.insuranceValue;
  if (typeof insuredValue === 'number' && insuredValue > 0) out.insuredValue = insuredValue;
  else if (typeof insuredValue === 'string' && Number(insuredValue) > 0) out.insuredValue = Number(insuredValue);
  const fromPostalCode = input.fromPostalCode ?? input.fromZip;
  if (typeof fromPostalCode === 'string' && fromPostalCode.trim()) {
    out.fromZip = fromPostalCode.trim();
  }

  if (typeof input.residential === 'boolean') out.residential = input.residential;
  if (typeof input.forceRefresh === 'boolean') out.forceRefresh = input.forceRefresh;
  if (typeof input.forceLive === 'boolean') out.forceLive = input.forceLive;
  if (typeof input.cachedOnly === 'boolean') out.cachedOnly = input.cachedOnly;
  // PS-197b: on-demand uninsured manual-baseline comparison (reference only, never purchasable).
  if (typeof input.manualEstimate === 'boolean') out.manualEstimate = input.manualEstimate;
  if (typeof input.preferredCarrierId === 'string' && input.preferredCarrierId) {
    out.preferredCarrierId = input.preferredCarrierId;
  }
  if (typeof input.includeAllDirectCarriers === 'boolean') out.includeAllDirectCarriers = input.includeAllDirectCarriers;
  // PS-083 follow-up: opt-in for best-rate paths (Recalculate + passive auto-rate)
  // to include the order's VISIBLE/assigned direct carriers (Walmart Shipping,
  // SHIPP, …) even when an explicit ShipStation-only carrierIds list is passed —
  // so the best rate matches what the Rate Browser drawer shows.
  if (typeof input.includeVisibleDirectCarriers === 'boolean') out.includeVisibleDirectCarriers = input.includeVisibleDirectCarriers;
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

export function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const n = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCarrierAccountDto(c: any, index = 0): any {
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
    // PS-216: backend-owned human disambiguator for duplicate nicknames
    // ("USPS"/"UPS"/...). Display code must use this — never provider ids.
    displayDisambiguator: c?.display_disambiguator ?? c?.displayDisambiguator ?? null,
  };
}

export type DirectCarrierAccountRow = {
  id: number;
  clientId?: number | null;
  provider: string;
  label?: string | null;
  accountIdentifier?: string | null;
  active?: boolean;
  sourceTable?: 'carrier_accounts' | 'store_accounts';
  assignedClientIds?: number[];
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


export function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isStoreProvider(provider: unknown): boolean {
  return STORE_PROVIDER_KEYS.has(normalizeProviderKey(provider));
}

export function normalizeClientIdList(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map((item) => parseFiniteNumber(item))
        .filter((item): item is number => item != null)
    : [];
}

// PS-286 (slice): DirectAccountRef, directAccountRefFromProviderId, and isDirectCarrierId
// moved to the PURE ../direct-carrier-id module and are re-exported near the offset block
// above. directProviderIdFromAccount stays here (it depends on the local DirectCarrierAccountRow).
export function directProviderIdFromAccount(account: Pick<DirectCarrierAccountRow, 'id' | 'sourceTable'>): number {
  const offset = account.sourceTable === 'store_accounts'
    ? DIRECT_STORE_PROVIDER_ID_OFFSET
    : DIRECT_CARRIER_PROVIDER_ID_OFFSET;
  return offset + account.id;
}

// PS-078 req 7 (routing CLASS, not endpoint — PS-202/PS-209 update): every
// purchase posts to v4 /labels (createLabelV2 owns both the ShipStation and
// direct-carrier branches; the legacy Vercel function is a retired 410).
// This classifier still matters for the WORKFLOW split: a direct
// carrier_accounts rate (10M offset) takes the direct-create queue route; a
// ShipStation provider id takes the backend queue job; a direct
// store_accounts rate (20M offset) is a MARKETPLACE store account that cannot
// create a label at all — it must be BLOCKED before postage rather than
// silently posting a bogus `se-20000xxx` id to ShipStation.
export type LabelEndpointRoute = 'carrier-direct' | 'store-account-blocked' | 'shipstation';

export function classifyLabelEndpoint(shippingProviderId: number | null): LabelEndpointRoute {
  const ref = directAccountRefFromProviderId(shippingProviderId);
  if (ref?.sourceTable === 'carrier_accounts') return 'carrier-direct';
  if (ref?.sourceTable === 'store_accounts') return 'store-account-blocked';
  return 'shipstation';
}

export function directAccountKey(account: Pick<DirectCarrierAccountRow, 'id' | 'sourceTable'>): string {
  return `${account.sourceTable ?? 'carrier_accounts'}:${account.id}`;
}

export function looksLikeOpaqueAccountIdentifier(value: unknown): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return false;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) return true;
  return /^(?:cid:)?[a-z0-9_-]{12,}$/i.test(trimmed);
}

export function storeAccountMatchesOrder(
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

export function directCarrierAccountVisibleForOrder(
  row: DirectCarrierAccountRow,
  context: { storeId?: unknown; clientId?: unknown; includeAllDirectCarriers?: unknown }
): boolean {
  // Marketplace store accounts (eBay/Walmart Shipping) match by store/client
  // identity, not by carrier assignment — handled separately.
  if ((row.sourceTable ?? 'carrier_accounts') === 'store_accounts') {
    return storeAccountMatchesOrder(row, context);
  }

  // PS-083: direct carrier_accounts rows are governed by the shared assignment
  // rule. An active carrier with NO client assignment (no junction rows AND no
  // legacy client_id) is HIDDEN — not treated as globally visible. Previously
  // this function fell through to `return true`, which leaked unassigned SHIPP
  // into every Rate Browser scope. "Available to all clients" must now come
  // from an explicit assignment, never from a blank assignment list.
  return directCarrierVisibleForScope(
    {
      provider: row.provider,
      clientId: row.clientId,
      assignedClientIds: row.assignedClientIds,
    },
    context,
  );
}

export function normalizeDirectCarrierAccountDto(row: DirectCarrierAccountRow): any {
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
    // PS-216: human provider label for duplicate-nickname disambiguation —
    // synthetic direct ids must never surface as display suffixes.
    displayDisambiguator: DIRECT_ACCOUNT_PROVIDER_LABELS[provider] ?? null,
  };
}

export async function fetchDirectCarrierAccountRows(): Promise<DirectCarrierAccountRow[]> {
  // PS-200 S1: account lists come from the v4 backend (same handler code the
  // legacy Vercel functions delegated to — single service layer either way).
  const [carrierRes, storeRes] = await Promise.all([
    api.get<{ data?: DirectCarrierAccountRow[] }>('/carrier-accounts?source=admin'),
    api.get<{ data?: DirectCarrierAccountRow[] }>('/store-accounts?source=admin').catch((err) => {
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

// PS-200 S2: removed the dead FE direct-rate fan-out cluster (fetchDirectCarrierRates +
// translateDirectRateToV2Shape / slugRateService / inferCarrierCodeForDirectRate /
// normalizeCarrierCodeForDirectRate / directCarrierErrorMessage) — 0 callers since PS-203
// moved the combined rate universe (ShipStation + direct, one money pick) to the backend.
// The FE no longer quotes direct carriers itself, so its last POST to the legacy Vercel
// /carriers/rates endpoint is gone with it.

// PS-139: removed the dead FE rate-dedupe cluster (dedupeRateResults + rateResultDedupeKey /
// rateResultMoneyKey / rateResultTextKey) — 0 callers; the backend owns best-rate selection +
// de-duplication (PS-135), so the parallel client-side de-dupe was orphaned.

export const rateBrowseInflight = new Map<string, Promise<any>>();


// Maps v4's ShipStation-v2-passthrough rate object to the v2-legacy shape
// the bulk-ported components read. Defensive: if a caller already hands us
// v2-shape data (has `amount` + `carrierCode`), return it unchanged.
export function translateRateToV2Shape(r: unknown): Record<string, unknown> {
  if (r && typeof r === 'object') {
    const obj = r as Record<string, unknown>;
    if ('amount' in obj && 'carrierCode' in obj) {
      // PS-292: already-v2-shaped input (a re-translation or a pre-translated cached hit). Keep it
      // unchanged, but surface the SHIPP house tuple at the top level if it only survived under
      // `raw`, so this function's output shape is house-consistent no matter which path produced the
      // input. Idempotent — once the key is present we return verbatim.
      return 'nextBestNonHouseRate' in obj
        ? obj
        : { ...obj, ...houseTuplePassThrough((obj as { raw?: unknown }).raw ?? obj) };
    }
    const shipping = obj.shipping_amount as { amount?: unknown } | undefined;
    const originalShipping = obj.original_amount as { amount?: unknown } | undefined;
    const other = obj.other_amount as { amount?: unknown } | undefined;
    const confirmation = obj.confirmation_amount as { amount?: unknown } | undefined;
    const insurance = obj.insurance_amount as { amount?: unknown } | undefined;
    const shipmentCost =
      typeof originalShipping?.amount === 'number' ? originalShipping.amount :
      typeof shipping?.amount === 'number' ? shipping.amount : 0;
    // PS-108: include the ParcelGuard/insurance premium in the displayed total so the
    // Rate Browser/selected total matches the backend's insured rateTotal used to pick
    // best rate. Backend populates insurance_amount before selection.
    const otherCost =
      (typeof other?.amount === 'number' ? other.amount : 0) +
      (typeof confirmation?.amount === 'number' ? confirmation.amount : 0) +
      (typeof insurance?.amount === 'number' ? insurance.amount : 0);
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
      requestFingerprint: obj.requestFingerprint ?? null,
      cacheKey: obj.cacheKey ?? obj.requestFingerprint ?? null,
      cacheCreatedAt: obj.cacheCreatedAt ?? null,
      cacheExpiresAt: obj.cacheExpiresAt ?? null,
      proofSource: obj.proofSource ?? null,
      // PS-198: backend-owned quote snapshot ref, stamped per-rate by /rates/browse.
      // Pass-through ONLY — null when the backend issued none (manual estimate,
      // legacy cache), which keeps those rates structurally non-purchasable.
      rateQuoteId: obj.rateQuoteId ?? null,
      selectedRateKey: obj.selectedRateKey ?? null,
      secondBestRate: obj.secondBestRate ? translateRateToV2Shape(obj.secondBestRate) : null,
      isComplete: obj.isComplete ?? null,
      rateCount: obj.rateCount ?? null,
      matchType: obj.matchType ?? null,
      // PS-108: carry insurance provenance/unresolved state for display + audit.
      insuranceCost: obj.insuranceCost ?? null,
      insuranceCostUnresolved: obj.insuranceCostUnresolved ?? false,
      insuranceCostError: obj.insuranceCostError ?? null,
      insuranceCoverageStatus: obj.insuranceCoverageStatus ?? null,
      insuranceBadgeLabel: obj.insuranceBadgeLabel ?? null,
      insuranceBadgeTone: obj.insuranceBadgeTone ?? null,
      insuranceCoverageProofSource: obj.insuranceCoverageProofSource ?? null,
      hugrabPurchaseAllowed: obj.hugrabPurchaseAllowed ?? null,
      hugrabPurchaseBlockReason: obj.hugrabPurchaseBlockReason ?? null,
      // PS-292: lift the backend-owned SHIPP house tuple (customer_rate basis + margin) to the TOP
      // level so the FE save path persists it and the row/Rate-Browser can render the two-tier
      // display. Pass-through ONLY (backend nulls it for non-financial viewers before it gets here).
      ...houseTuplePassThrough(obj),
      raw: obj,
    };
  }
  return { raw: r };
}

export async function fetchBlob(
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

export type DailyStatsSummary = {
  totalOrders: number;
  needToShip: number;
  upcomingOrders: number;
  window: { from: string; to: string; fromLabel: string; toLabel: string };
};


export type SettingsRow = { key: string; value: string };
export type OrderDimsRow = { l: number; w: number; h: number; weightOz: number | null } | null;

