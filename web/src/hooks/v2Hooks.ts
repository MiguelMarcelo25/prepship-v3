import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type Paginated } from '../lib/api';
import { HIDDEN_CLIENT_IDS } from '../lib/v2-apiClient';

/**
 * v2 hook shims — React Query-backed.
 *
 * Mirror the runtime shape of v2's hooks at
 * `apps/react/src/hooks/{useOrders,useOrderDetail,useLocations,useShippingAccounts}.ts`
 * so the wholesale OrdersView.tsx port compiles and runs against v4's API
 * without edits at the call sites. DTOs are kept loose (`any`) because
 * v2's types aren't available in this project; structural access from
 * the ported view is preserved.
 */

// Loose DTOs — property access flows as `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrderSummaryDto = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrderFullDto = any;

const ORDERS_STALE_MS = 30_000;
const ORDERS_CACHE_MS = 10 * 60_000;

// ──────────────────────────────────────────────────────────────────
// useOrders
// ──────────────────────────────────────────────────────────────────

export interface UseOrdersOptions {
  page?: number;
  pageSize?: number;
  storeId?: number;
  clientId?: number;
  dateStart?: string;
  dateEnd?: string;
  hideTestOrders?: boolean;
}

export interface UseOrdersResult {
  orders: OrderSummaryDto[];
  total: number;
  pages: number;
  currentPage: number;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  goToPage: (page: number) => Promise<void>;
}

type V4ClientRow = { id: number; name: string; isTest?: boolean };

const LEGACY_CLIENT_ID_BY_NAME = new Map<string, number>([
  ['techtok', 7],
  ['tran agency', 8],
  ['walmart - djc', 9],
  ['kf goods', 10],
  ['test orders', 11],
]);

const LEGACY_CLIENT_ID_BY_STORE_ID = new Map<number, number>([
  [367706, 7],
  [363392, 8],
  [376661, 9],
  [277422, 10],
  [376827, 10],
]);

const LEGACY_CLIENT_ID_BY_CURRENT_ID = new Map<number, number>([
  [8, 7],
  [9, 8],
  [10, 9],
  [11, 10],
  [12, 11],
]);

function toNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRateForV2(value: unknown): Record<string, unknown> | null {
  const rate = toRecordValue(value);
  if (!rate) return null;
  const shipping = rate.shipping_amount as Record<string, unknown> | undefined;
  const other = rate.other_amount as Record<string, unknown> | undefined;
  const shipmentCost =
    toFiniteNumber(rate.shipmentCost) ??
    toFiniteNumber(shipping?.amount) ??
    toFiniteNumber(rate.cost) ??
    null;
  const otherCost = toFiniteNumber(rate.otherCost) ?? toFiniteNumber(other?.amount) ?? 0;
  const cost = toFiniteNumber(rate.cost) ?? (shipmentCost != null ? shipmentCost + otherCost : null);

  return {
    ...rate,
    carrierCode: rate.carrierCode ?? rate.carrier_code ?? null,
    serviceCode: rate.serviceCode ?? rate.service_code ?? null,
    serviceName: rate.serviceName ?? rate.service_type ?? rate.serviceCode ?? rate.service_code ?? null,
    carrierNickname: rate.carrierNickname ?? rate.carrier_nickname ?? null,
    providerAccountNickname: rate.providerAccountNickname ?? rate.carrierNickname ?? rate.carrier_nickname ?? null,
    shippingProviderId: toProviderAccountId(rate.shippingProviderId ?? rate.carrier_id ?? null),
    providerAccountId: toProviderAccountId(rate.providerAccountId ?? rate.shippingProviderId ?? rate.carrier_id ?? null),
    shipmentCost,
    otherCost,
    cost,
    amount: toFiniteNumber(rate.amount) ?? cost,
    raw: rate.raw ?? rate,
  };
}

function normalizeLabelForV2(value: unknown): Record<string, unknown> | null {
  const label = toRecordValue(value);
  if (!label) return null;
  return {
    ...label,
    trackingNumber: label.trackingNumber ?? label.tracking_number ?? null,
    carrierCode: label.carrierCode ?? label.carrier_code ?? null,
    serviceCode: label.serviceCode ?? label.service_code ?? null,
    shippingProviderId: toProviderAccountId(label.shippingProviderId ?? label.providerAccountId ?? label.carrier_id ?? null),
    cost: toFiniteNumber(label.cost ?? label.labelCost ?? label.label_cost),
  };
}

function hasPositiveRateAmount(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  const total =
    toFiniteNumber(rate.amount) ??
    toFiniteNumber(rate.cost) ??
    ((toFiniteNumber(rate.shipmentCost) ?? 0) + (toFiniteNumber(rate.otherCost) ?? 0));
  return total > 0;
}

function getItemsTotalForDisplay(source: unknown): number | null {
  if (!Array.isArray(source)) return null;
  let total = 0;
  let hasPricedItem = false;

  for (const item of source) {
    const record = toRecordValue(item);
    if (!record || record.adjustment === true) continue;
    const unitPrice = toFiniteNumber(record.unitPrice) ?? toFiniteNumber(record.price);
    if (unitPrice == null) continue;
    const quantity = toFiniteNumber(record.quantity) ?? 1;
    total += unitPrice * quantity;
    hasPricedItem = true;
  }

  return hasPricedItem && total > 0 ? total : null;
}

function legacyClientId(
  clientId: number | null,
  storeId: unknown,
  clientsById: Map<number, string>,
): number | null {
  const numericStoreId = toNumericValue(storeId);
  if (numericStoreId != null) {
    const byStore = LEGACY_CLIENT_ID_BY_STORE_ID.get(numericStoreId);
    if (byStore != null) return byStore;
  }
  if (clientId != null) {
    const byName = LEGACY_CLIENT_ID_BY_NAME.get((clientsById.get(clientId) ?? '').trim().toLowerCase());
    if (byName != null) return byName;
    const byCurrentId = LEGACY_CLIENT_ID_BY_CURRENT_ID.get(clientId);
    if (byCurrentId != null) return byCurrentId;
  }
  return clientId;
}

function transformOrderRowV4toV2(
  row: Record<string, unknown>,
  clientsById: Map<number, string>
): OrderSummaryDto {
  const canonicalOrder = toRecordValue(row.canonicalOrder);
  const canonicalRecipient = toRecordValue(canonicalOrder?.recipient);
  const canonicalWeight = toRecordValue(canonicalOrder?.weight);
  const canonicalDimensions = toRecordValue(canonicalOrder?.dimensions);
  const canonicalTotals = toRecordValue(canonicalOrder?.totals);
  const canonicalClient = toRecordValue(canonicalOrder?.client);
  const canonicalCustomer = toRecordValue(canonicalOrder?.customer);
  const rawAny = (row.raw ?? {}) as Record<string, unknown>;
  const rawShipTo = (rawAny.shipTo ?? {}) as Record<string, unknown>;
  const rawDims = (rawAny.dimensions ?? {}) as Record<string, unknown>;
  const clientId =
    toNumericValue(canonicalOrder?.clientId) ??
    toNumericValue(canonicalClient?.id) ??
    (typeof row.clientId === 'number' ? row.clientId : null);
  const storeId = toNumericValue(canonicalOrder?.storeId) ?? toNumericValue(canonicalClient?.storeId) ?? toNumericValue(row.storeId);
  const resolvedLegacyClientId =
    toNumericValue(canonicalOrder?.legacyClientId) ??
    toNumericValue(canonicalClient?.legacyId) ??
    legacyClientId(clientId, storeId, clientsById);
  const overrides = (row.overrides ?? null) as Record<string, unknown> | null;
  const shippingModel = toRecordValue(canonicalOrder?.shipping) ?? toRecordValue(row.shipping);
  const orderStatus = (canonicalOrder?.orderStatus as string | undefined) ?? (row.orderStatus as string | undefined) ?? null;
  const bestRateJson = overrides?.bestRateJson as
    | Record<string, unknown>
    | null
    | undefined;

  // Remap ShipStation v2 rate shape → v2-legacy bestRate shape that OrdersView expects.
  // v2 shape: { amount, shipmentCost, otherCost, carrierCode, serviceCode, serviceName, carrierNickname, shippingProviderId }
  // SS v2 shape: { shipping_amount: {amount}, other_amount: {amount}, carrier_code, service_code, service_type, carrier_nickname, carrier_id }
  const bestRateLegacy = (() => {
    if (!bestRateJson) return null;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const ship = bestRateJson.shipping_amount as Record<string, unknown> | undefined;
    const other = bestRateJson.other_amount as Record<string, unknown> | undefined;
    const shipmentCost =
      num(ship?.amount) ?? num(bestRateJson.shipmentCost) ?? num(bestRateJson.cost) ?? 0;
    const otherCost = num(other?.amount) ?? num(bestRateJson.otherCost) ?? 0;
    return {
      carrierCode: (bestRateJson.carrier_code as string) ?? (bestRateJson.carrierCode as string) ?? null,
      serviceCode: (bestRateJson.service_code as string) ?? (bestRateJson.serviceCode as string) ?? null,
      serviceName:
        (bestRateJson.service_type as string) ??
        (bestRateJson.serviceName as string) ??
        (bestRateJson.serviceCode as string) ??
        null,
      carrierNickname:
        (bestRateJson.carrier_nickname as string) ??
        (bestRateJson.carrierNickname as string) ??
        null,
      shippingProviderId: toProviderAccountId(
        bestRateJson.shippingProviderId ?? bestRateJson.carrier_id ?? null,
      ),
      amount: shipmentCost + otherCost,
      shipmentCost,
      otherCost,
      // Keep the raw object under `raw` so anything that peeks at SS v2 fields still works.
      raw: bestRateJson,
    };
  })();

  const weightOz =
    toFiniteNumber(overrides?.rateWeightOz) ??
    toFiniteNumber(canonicalOrder?.weightOz) ??
    toFiniteNumber(canonicalWeight?.value) ??
    (typeof row.weightOz === 'number' ? row.weightOz : null);
  const ovL = toFiniteNumber(overrides?.rateDimsL);
  const ovW = toFiniteNumber(overrides?.rateDimsW);
  const ovH = toFiniteNumber(overrides?.rateDimsH);
  const dimsL =
    ovL ??
    toFiniteNumber(canonicalDimensions?.length) ??
    (typeof rawDims.length === 'number' ? (rawDims.length as number) : null) ??
    null;
  const dimsW =
    ovW ??
    toFiniteNumber(canonicalDimensions?.width) ??
    (typeof rawDims.width === 'number' ? (rawDims.width as number) : null) ??
    null;
  const dimsH =
    ovH ??
    toFiniteNumber(canonicalDimensions?.height) ??
    (typeof rawDims.height === 'number' ? (rawDims.height as number) : null) ??
    null;

  const orderTotalNum = (() => {
    const canonicalTotal = toFiniteNumber(canonicalTotals?.orderTotal);
    if (canonicalTotal != null && canonicalTotal > 0) return canonicalTotal;
    const v = row.orderTotal;
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const rawTotal = toFiniteNumber(rawAny.orderTotal ?? rawAny.order_total);
    if (rawTotal != null && rawTotal > 0) return rawTotal;
    if (orderStatus === 'cancelled') {
      const itemsTotal =
        getItemsTotalForDisplay(canonicalOrder?.items) ??
        getItemsTotalForDisplay(row.items) ??
        getItemsTotalForDisplay(rawAny.items);
      if (itemsTotal != null) return itemsTotal;
    }
    return canonicalTotal ?? (typeof v === 'number' ? v : null) ?? rawTotal ?? null;
  })();
  const shippingAmountNum = (() => {
    const canonicalShipping = toFiniteNumber(canonicalTotals?.shippingAmount);
    if (canonicalShipping != null) return canonicalShipping;
    const v = row.shippingAmount;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  })();
  const apiBestRate = normalizeRateForV2(shippingModel?.bestRate ?? row.bestRate);
  const selectedRate = normalizeRateForV2(shippingModel?.selectedRate ?? row.selectedRate);
  const rowLabel = toRecordValue(row.label);
  const label = normalizeLabelForV2({
    ...(rowLabel ?? {}),
    trackingNumber: shippingModel?.trackingNumber ?? rowLabel?.trackingNumber,
    carrierCode: shippingModel?.carrierCode ?? rowLabel?.carrierCode,
    serviceCode: shippingModel?.serviceCode ?? rowLabel?.serviceCode,
    shippingProviderId: shippingModel?.providerAccountId ?? rowLabel?.shippingProviderId,
    cost: shippingModel?.labelCost ?? rowLabel?.cost,
  });
  const selectedRateBestFallback = hasPositiveRateAmount(selectedRate) ? selectedRate : null;
  const displayBestRate =
    (hasPositiveRateAmount(apiBestRate) ? apiBestRate : null) ??
    (hasPositiveRateAmount(bestRateLegacy) ? bestRateLegacy : null) ??
    (orderStatus === 'cancelled' ? null : selectedRateBestFallback);
  const shipping = shippingModel
    ? {
        ...shippingModel,
        carrierCode: shippingModel.carrierCode ?? selectedRate?.carrierCode ?? displayBestRate?.carrierCode ?? null,
        serviceCode: shippingModel.serviceCode ?? selectedRate?.serviceCode ?? displayBestRate?.serviceCode ?? null,
        trackingNumber: shippingModel.trackingNumber ?? label?.trackingNumber ?? null,
        providerAccountId:
          toProviderAccountId(shippingModel.providerAccountId) ??
          toProviderAccountId(selectedRate?.shippingProviderId) ??
          toProviderAccountId(label?.shippingProviderId),
        accountNickname:
          shippingModel.accountNickname ??
          selectedRate?.providerAccountNickname ??
          displayBestRate?.carrierNickname ??
          null,
        selectedRateAmount: toFiniteNumber(shippingModel.selectedRateAmount) ?? toFiniteNumber(selectedRate?.cost),
        bestRateAmount: toFiniteNumber(shippingModel.bestRateAmount) ?? toFiniteNumber(displayBestRate?.amount),
        selectedRate,
        bestRate: displayBestRate,
      }
    : null;

  return {
    ...row,
    orderId: toNumericValue(canonicalOrder?.orderId) ?? toNumericValue(canonicalOrder?.id) ?? row.id,
    orderNumber: canonicalOrder?.orderNumber ?? row.orderNumber,
    orderStatus,
    orderDate: canonicalOrder?.orderDate ?? row.orderDate,
    externalOrderId: canonicalOrder?.externalOrderId ?? row.externalOrderId,
    orderTotal: orderTotalNum,
    shippingAmount: shippingAmountNum,
    customerEmail: canonicalCustomer?.email ?? row.customerEmail,
    storeId,
    items: Array.isArray(canonicalOrder?.items) ? canonicalOrder.items : row.items,
    clientId,
    legacyClientId: resolvedLegacyClientId,
    clientName: clientId != null ? clientsById.get(clientId) ?? null : null,
    shipTo: {
      name:
        (canonicalRecipient?.name as string | undefined) ??
        (rawShipTo.name as string | undefined) ??
        (row.shipToName as string | null) ??
        null,
      company: (canonicalRecipient?.company as string | undefined) ?? (rawShipTo.company as string | undefined) ?? null,
      street1: (canonicalRecipient?.street1 as string | undefined) ?? (rawShipTo.street1 as string | undefined) ?? null,
      street2: (canonicalRecipient?.street2 as string | undefined) ?? (rawShipTo.street2 as string | undefined) ?? null,
      city:
        (canonicalRecipient?.city as string | undefined) ??
        (rawShipTo.city as string | undefined) ??
        (row.shipToCity as string | null) ??
        null,
      state:
        (canonicalRecipient?.state as string | undefined) ??
        (rawShipTo.state as string | undefined) ??
        (row.shipToState as string | null) ??
        null,
      postalCode:
        (canonicalRecipient?.postalCode as string | undefined) ??
        (rawShipTo.postalCode as string | undefined) ??
        (row.shipToPostalCode as string | null) ??
        null,
      country: (canonicalRecipient?.country as string | undefined) ?? (rawShipTo.country as string | undefined) ?? 'US',
      phone: (canonicalRecipient?.phone as string | undefined) ?? (rawShipTo.phone as string | undefined) ?? null,
      addressVerified:
        (canonicalRecipient?.addressVerified as string | undefined) ??
        (rawShipTo.addressVerified as string | undefined) ??
        null,
    },
    weight: weightOz != null ? { value: weightOz, units: 'ounces' } : null,
    rateDims:
      dimsL != null && dimsW != null && dimsH != null
        ? { length: dimsL, width: dimsW, height: dimsH, units: 'inches' }
        : null,
    bestRate: displayBestRate,
    selectedRate,
    label,
    shipping,
  };
}

function toIsoStart(d: string | undefined): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T00:00:00.000Z`).toISOString();
}

function toIsoEnd(d: string | undefined): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return new Date(`${d}T23:59:59.999Z`).toISOString();
}

export function useOrders(
  status: string,
  options: UseOrdersOptions = {}
): UseOrdersResult {
  const {
    page = 1,
    pageSize = 50,
    storeId,
    clientId,
    dateStart,
    dateEnd,
    hideTestOrders = false,
  } = options;

  const [currentPage, setCurrentPage] = useState<number>(page);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  useEffect(() => {
    setCurrentPage(page);
  }, [page]);

  // 2026-05-12: explicit activeOnly=true so the orders query's client
  // lookup never includes disabled clients (mirrors useClients() above).
  const clientsQuery = useQuery<V4ClientRow[]>({
    queryKey: ['v2-hooks:clients', 'active-only'],
    queryFn: () => api.get<V4ClientRow[]>('/clients?activeOnly=true'),
    staleTime: 60_000,
  });

  const isoFrom = toIsoStart(dateStart);
  const isoTo = toIsoEnd(dateEnd);

  // Test clients can appear in the sidebar without a real ShipStation store.
  // /init/stores represents those rows with a negative synthetic store id
  // (-clientId). Translate it back before querying orders, otherwise the
  // backend receives storeId=-12 while the seeded test row has store_id=null.
  const syntheticTestClientId =
    typeof storeId === 'number' && storeId < 0 ? Math.abs(storeId) : undefined;
  const effectiveClientId = clientId ?? syntheticTestClientId;
  const effectiveStoreId = syntheticTestClientId != null ? undefined : storeId;

  // When no specific client is selected, exclude orders from hidden clients
  // (e.g. "Api Shipments") so the main table isn't buried under test data.
  const excludeClientId =
    effectiveClientId == null && effectiveStoreId == null && HIDDEN_CLIENT_IDS.size > 0
      ? [...HIDDEN_CLIENT_IDS].join(',')
      : undefined;

  const query = useQuery<Paginated<OrderSummaryDto>>({
    queryKey: [
      'v2-hooks:orders',
      status,
      currentPage,
      pageSize,
      effectiveClientId,
      effectiveStoreId,
      excludeClientId,
      hideTestOrders,
      isoFrom,
      isoTo,
    ],
    queryFn: () =>
      api.get<Paginated<OrderSummaryDto>>(
        `/orders${qs({
          status,
          page: currentPage,
          pageSize,
          clientId: effectiveClientId,
          storeId: effectiveStoreId,
          excludeClientId,
          hideTestOrders: hideTestOrders && effectiveClientId == null && effectiveStoreId == null ? true : undefined,
          dateFrom: isoFrom,
          dateTo: isoTo,
        })}`
      ),
    staleTime: ORDERS_STALE_MS,
    gcTime: ORDERS_CACHE_MS,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey as unknown[] | undefined;
      return previousKey?.[1] === status ? previousData : undefined;
    },
  });

  // Memoize so the transform only runs when the underlying fetch data changes.
  // Without this, OrdersView's panel useEffect sees a new panelOrder reference
  // every render and fires setState in a loop ("Maximum update depth exceeded").
  const transformedOrders = useMemo(() => {
    const clientsById = new Map<number, string>();
    for (const c of clientsQuery.data ?? []) clientsById.set(c.id, c.name);
    return (query.data?.data ?? []).map((row) =>
      transformOrderRowV4toV2(row as Record<string, unknown>, clientsById)
    );
  }, [query.data, clientsQuery.data]);

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [query]);

  const goToPage = useCallback(async (pageNum: number) => {
    setCurrentPage(pageNum);
  }, []);

  const hasOrdersPayload = query.data != null;
  const backgroundFetching = query.isFetching && hasOrdersPayload;

  return {
    orders: transformedOrders,
    total: query.data?.pagination.total ?? 0,
    pages: query.data?.pagination.totalPages ?? 0,
    currentPage,
    loading: query.isLoading && !hasOrdersPayload,
    refreshing: refreshing || backgroundFetching,
    error: (query.error as Error | null) ?? null,
    refetch,
    goToPage,
  };
}

// ──────────────────────────────────────────────────────────────────
// useOrderDetail — v2 signature accepts a string id.
// ──────────────────────────────────────────────────────────────────

export interface UseOrderDetailResult {
  order: OrderFullDto | null;
  isLoading: boolean;
  error: Error | null;
}

export function useOrderDetail(
  orderId: string | null | undefined
): UseOrderDetailResult {
  const raw = orderId != null ? String(orderId).trim() : '';
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const enabled = Number.isFinite(parsed) && parsed > 0;

  const query = useQuery<OrderFullDto>({
    queryKey: ['v2-hooks:order-detail', parsed],
    queryFn: () => api.get<OrderFullDto>(`/orders/${parsed}/full`),
    enabled,
  });

  return {
    order: query.data ?? null,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────
// useLocations — v4 returns rows with `id`; adapt to `locationId`.
// ──────────────────────────────────────────────────────────────────

export interface LocationDto {
  locationId: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface UseLocationsResult {
  locations: LocationDto[];
  isLoading: boolean;
  error: Error | null;
}

type V4LocationRow = {
  id: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
};

export function useLocations(): UseLocationsResult {
  const query = useQuery<V4LocationRow[]>({
    queryKey: ['v2-hooks:locations'],
    queryFn: () => api.get<V4LocationRow[]>('/locations'),
    staleTime: 60_000,
  });

  const locations = useMemo<LocationDto[]>(
    () =>
      (query.data ?? []).map((row) => ({
        locationId: row.id,
        name: row.name,
        company: row.company,
        street1: row.street1,
        street2: row.street2,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        country: row.country,
        phone: row.phone,
        isDefault: row.isDefault,
        active: row.active,
      })),
    [query.data]
  );

  return {
    locations,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

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

// Route the direct-carrier list through the Vercel function we control
// (api/carrier-accounts.ts) rather than Render's same-named endpoint,
// whose code lives in a separate repo and may not match. Using fetch
// directly here so we don't have to thread callVercelFunction through
// the React Query queryFn — same-origin /api/* path + Supabase JWT.
async function fetchDirectCarrierAccounts(): Promise<V4DirectCarriersResponse> {
  const { supabase } = await import('../lib/supabase');
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const res = await fetch('/api/carrier-accounts?source=admin', { headers });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const e = await res.json(); if (e?.error) msg = e.error; } catch { /* ignore */ }
    // Surface in console too — the merged hook (useShippingAccounts below)
    // intentionally swallows this error when ShipStation succeeds, so a
    // failure here is invisible in the UI. That makes "my direct UPS isn't
    // in the Rate Browser sidebar" near-impossible to diagnose without
    // poking at Network. Console warn is the cheapest fix.
    // eslint-disable-next-line no-console
    console.warn('[useShippingAccounts] direct carrier list failed:', msg);
    throw new Error(msg);
  }
  const json = (await res.json()) as V4DirectCarriersResponse;
  // eslint-disable-next-line no-console
  console.debug('[useShippingAccounts] direct carriers:', json?.data?.length ?? 0);
  return json;
}

export function useShippingAccounts(): UseShippingAccountsResult {
  const query = useQuery<V4CarriersResponse>({
    queryKey: ['v2-hooks:carriers'],
    queryFn: () => api.get<V4CarriersResponse>('/rates/multi'),
    staleTime: 60_000,
  });

  const directQuery = useQuery<V4DirectCarriersResponse>({
    queryKey: ['v2-hooks:carrier-accounts'],
    queryFn: fetchDirectCarrierAccounts,
    staleTime: 60_000,
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
  // (via Render /rates/multi) and direct carriers (via Vercel
  // /api/carrier-accounts) are independent — losing one shouldn't make
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
    isLoading: query.isLoading || directQuery.isLoading,
    error: mergedError,
  };
}

// ──────────────────────────────────────────────────────────────────
// useClients — v4 returns flat rows with `id`; adapt to v2 ClientDto.
// Resolves `rateSourceName` by looking up the referenced client's name
// in the same list. Derives `hasOwnAccount` from ShipStation API key
// presence. Shares the `['v2-hooks:clients']` query key with useOrders
// so React Query dedupes the /clients fetch.
// ──────────────────────────────────────────────────────────────────

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

type V4ClientFullRow = {
  id: number;
  name: string;
  storeIds: number[] | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  ssApiKey: string | null;
  ssApiSecret: string | null;
  ssApiKeyV2: string | null;
  rateSourceClientId: number | null;
  active: boolean;
};

function transformClientRowV4toV2(
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
      (row.ssApiKey && row.ssApiSecret) || row.ssApiKeyV2
    ),
    rateSourceClientId: rateSourceId,
    rateSourceName:
      rateSourceId != null ? namesById.get(rateSourceId) ?? '' : '',
  };
}

// 2026-05-12 visibility hardening: useClients() now ALWAYS requests
// active-only clients from the backend. Previously it called bare
// /clients and relied on the route's `activeOnly=true` default — which
// works today but is one default-flip away from leaking inactive
// clients into every consumer (Settings, CarrierIntegrationsCard,
// future surfaces). Explicit is better than implicit.
//
// Admin paths that NEED to see disabled clients should use
// useAllClients() (below) — that hook explicitly passes
// includeInactive=true, signaling at the call site that this is a
// management surface, not a data view.
export function useClients(): UseClientsResult {
  const query = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients', 'active-only'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?activeOnly=true'),
    staleTime: 60_000,
  });

  const clients = useMemo(() => {
    const rows = query.data ?? [];
    const namesById = new Map<number, string>();
    for (const row of rows) namesById.set(row.id, row.name);
    return rows.map((row) => transformClientRowV4toV2(row, namesById));
  }, [query.data]);

  return {
    clients,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

// Admin-only: returns ACTIVE + INACTIVE clients. Use this for the
// Clients management screen, anywhere the operator needs to re-enable
// a disabled tenant, or any audit/report that should show the full
// roster. Separate query key from useClients() so React Query keeps
// the two caches distinct — toggling a client's active flag
// invalidates both, but a routine refetch of one doesn't trigger the
// other.
export function useAllClients(): UseClientsResult {
  const query = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients', 'include-inactive'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?includeInactive=true'),
    staleTime: 60_000,
  });

  const clients = useMemo(() => {
    const rows = query.data ?? [];
    const namesById = new Map<number, string>();
    for (const row of rows) namesById.set(row.id, row.name);
    return rows.map((row) => transformClientRowV4toV2(row, namesById));
  }, [query.data]);

  return {
    clients,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────
// useInventory — v4 returns paginated thin rows; adapt to v2's rich
// InventoryItemDto. v4's schema is a subset of v2's, so fields v4 doesn't
// carry (baseUnitQty, units_per_pack, product-vs-package dim split,
// packageId, cuFtOverride, parent/package name joins, lastMovement) are
// defaulted/null. `status` is computed from stockQty vs reorderLevel.
// Also fetches /clients (deduped via shared key) to resolve `clientName`.
// ──────────────────────────────────────────────────────────────────

export interface InventoryItemDto {
  id: number;
  clientId: number;
  sku: string;
  name: string;
  minStock: number;
  active: boolean;
  weightOz: number;
  parentSkuId: number | null;
  baseUnitQty: number;
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  productLength: number;
  productWidth: number;
  productHeight: number;
  packageId: number | null;
  units_per_pack: number;
  cuFtOverride: number | null;
  clientName: string;
  packageName: string | null;
  packageDimLength: number | null;
  packageDimWidth: number | null;
  packageDimHeight: number | null;
  parentName: string | null;
  currentStock: number;
  lastMovement: number | null;
  imageUrl: string | null;
  baseUnits: number;
  status: 'ok' | 'low' | 'out';
}

export interface UseInventoryOptions {
  clientId?: number;
  search?: string;
  lowStock?: boolean;
  pageSize?: number;
  page?: number;
}

export interface UseInventoryResult {
  items: InventoryItemDto[];
  total: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

type V4InventoryRow = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  imageUrl: string | null;
  stockQty: number;
  reorderLevel: number;
  weightOz: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  parentSkuId: number | null;
  active: boolean;
};

function statusOf(
  stockQty: number,
  reorderLevel: number
): 'ok' | 'low' | 'out' {
  if (stockQty <= 0) return 'out';
  if (stockQty <= reorderLevel) return 'low';
  return 'ok';
}

function transformInventoryRowV4toV2(
  row: V4InventoryRow,
  clientNamesById: Map<number, string>
): InventoryItemDto {
  const clientId = row.clientId ?? 0;
  const l = row.length ?? 0;
  const w = row.width ?? 0;
  const h = row.height ?? 0;
  const baseUnitQty = 1;

  return {
    id: row.id,
    clientId,
    sku: row.sku,
    name: row.name ?? '',
    minStock: row.reorderLevel,
    active: row.active,
    weightOz: row.weightOz ?? 0,
    parentSkuId: row.parentSkuId,
    baseUnitQty,
    packageLength: l,
    packageWidth: w,
    packageHeight: h,
    productLength: l,
    productWidth: w,
    productHeight: h,
    packageId: null,
    units_per_pack: 1,
    cuFtOverride: null,
    clientName: clientId ? clientNamesById.get(clientId) ?? '' : '',
    packageName: null,
    packageDimLength: null,
    packageDimWidth: null,
    packageDimHeight: null,
    parentName: null,
    currentStock: row.stockQty,
    lastMovement: null,
    imageUrl: row.imageUrl,
    baseUnits: row.stockQty * baseUnitQty,
    status: statusOf(row.stockQty, row.reorderLevel),
  };
}

export function useInventory(
  options: UseInventoryOptions = {}
): UseInventoryResult {
  const { clientId, search, lowStock, pageSize = 200, page = 1 } = options;

  // 2026-05-12: explicit activeOnly=true so the inventory query's
  // clientName resolution never picks up disabled clients.
  const clientsQuery = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients', 'active-only'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?activeOnly=true'),
    staleTime: 60_000,
  });

  const query = useQuery<Paginated<V4InventoryRow>>({
    queryKey: [
      'v2-hooks:inventory',
      clientId,
      search,
      lowStock,
      page,
      pageSize,
    ],
    queryFn: () =>
      api.get<Paginated<V4InventoryRow>>(
        `/inventory${qs({ clientId, search, lowStock, page, pageSize })}`
      ),
  });

  const items = useMemo(() => {
    const clientNamesById = new Map<number, string>();
    for (const c of clientsQuery.data ?? []) clientNamesById.set(c.id, c.name);
    return (query.data?.data ?? []).map((row) =>
      transformInventoryRowV4toV2(row, clientNamesById)
    );
  }, [query.data, clientsQuery.data]);

  return {
    items,
    total: query.data?.pagination.total ?? 0,
    isLoading: query.isLoading || clientsQuery.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}

// ──────────────────────────────────────────────────────────────────
// usePackages — v4 returns `id` and numeric `unitCost` as a string
// (pg `numeric` column). v2 wants `packageId` and a parsed float.
// ──────────────────────────────────────────────────────────────────

export interface PackageDto {
  packageId: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  source: string | null;
  carrierCode: string | null;
  stockQty: number | null;
  reorderLevel: number | null;
  unitCost: number | null;
  isDefault: boolean;
}

export interface UsePackagesResult {
  packages: PackageDto[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

type V4PackageRow = {
  id: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  source: string | null;
  carrierCode: string | null;
  stockQty: number;
  reorderLevel: number;
  unitCost: string | null;
  isDefault: boolean;
};

function parseUnitCost(v: string | null): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function transformPackageRowV4toV2(row: V4PackageRow): PackageDto {
  return {
    packageId: row.id,
    name: row.name,
    type: row.type,
    length: row.length,
    width: row.width,
    height: row.height,
    tareWeightOz: row.tareWeightOz,
    source: row.source,
    carrierCode: row.carrierCode,
    stockQty: row.stockQty,
    reorderLevel: row.reorderLevel,
    unitCost: parseUnitCost(row.unitCost),
    isDefault: row.isDefault,
  };
}

export function usePackages(): UsePackagesResult {
  const query = useQuery<V4PackageRow[]>({
    queryKey: ['v2-hooks:packages'],
    queryFn: () => api.get<V4PackageRow[]>('/packages'),
    staleTime: 60_000,
  });

  const packages = useMemo(
    () => (query.data ?? []).map(transformPackageRowV4toV2),
    [query.data]
  );

  return {
    packages,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}
