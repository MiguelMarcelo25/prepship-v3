import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type Paginated } from '../lib/api';
import { californiaDayEndIso, californiaDayStartIso } from '../lib/ca-time';
import { HIDDEN_CLIENT_IDS } from '../lib/v2-apiClient';
import { createOrdersRefetchCoordinator } from './orders-refetch-coordinator';
import {
  ORDERS_STALE_MS,
  ORDERS_CACHE_MS,
  type OrderSummaryDto,
  toProviderAccountId,
} from './v2Hooks-shared';

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
  includeInactiveClients?: boolean;
  search?: string;
  /** PS-210: 'global' widens a NON-EMPTY search across awaiting/shipped/
   *  cancelled server-side. Backend ignores it when search is empty, so the
   *  no-search tab behavior is unchanged by construction. */
  searchScope?: 'global';
  sku?: string;
  sortBy?: 'sku';
}

export interface UseOrdersResult {
  orders: OrderSummaryDto[];
  total: number;
  totalApproximate: boolean;
  pages: number;
  currentPage: number;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  goToPage: (page: number) => Promise<void>;
}

type V4ClientRow = { id: number; name: string; isTest?: boolean };

// PS-184: the legacy client-id parity map is BACKEND-owned — every order row
// carries `legacyClientId` from resolveLegacyClientId (src/routes/orders.ts).
// The local remap tables (by name / store id / current id) that shadowed it
// are deleted; the transform reads the backend value with a plain clientId
// fallback for pre-stamp rows.

function toNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
  const confirmation = rate.confirmation_amount as Record<string, unknown> | undefined;
  const insuranceAmount = rate.insurance_amount as Record<string, unknown> | undefined;
  const shipmentCost =
    toFiniteNumber(rate.shipmentCost) ??
    toFiniteNumber(shipping?.amount) ??
    toFiniteNumber(rate.cost) ??
    null;
  const otherAmountCost = toFiniteNumber(other?.amount) ?? 0;
  const confirmationAmountCost = toFiniteNumber(confirmation?.amount) ?? 0;
  const insuranceAmountCost = toFiniteNumber(insuranceAmount?.amount) ?? 0;
  const componentOtherCost = otherAmountCost + confirmationAmountCost + insuranceAmountCost;
  const storedOtherCost = toFiniteNumber(rate.otherCost);
  const otherCost =
    storedOtherCost != null
      ? Math.max(storedOtherCost, componentOtherCost)
      : componentOtherCost;
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
    toNumericValue(row.legacyClientId) ??
    toNumericValue(canonicalOrder?.legacyClientId) ??
    toNumericValue(canonicalClient?.legacyId) ??
    clientId;
  const overrides = (row.overrides ?? null) as Record<string, unknown> | null;
  const shippingModel = toRecordValue(canonicalOrder?.shipping) ?? toRecordValue(row.shipping);
  const orderStatus = (canonicalOrder?.orderStatus as string | undefined) ?? (row.orderStatus as string | undefined) ?? null;
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
  const bestRate = toRecordValue(shippingModel?.bestRate ?? row.bestRate);
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
  const shipping = shippingModel
    ? {
        ...shippingModel,
        carrierCode: shippingModel.carrierCode ?? selectedRate?.carrierCode ?? null,
        serviceCode: shippingModel.serviceCode ?? selectedRate?.serviceCode ?? null,
        trackingNumber: shippingModel.trackingNumber ?? label?.trackingNumber ?? null,
        providerAccountId:
          toProviderAccountId(shippingModel.providerAccountId) ??
          toProviderAccountId(selectedRate?.shippingProviderId) ??
          toProviderAccountId(label?.shippingProviderId),
        accountNickname: shippingModel.accountNickname ?? selectedRate?.providerAccountNickname ?? null,
        selectedRateAmount: toFiniteNumber(shippingModel.selectedRateAmount) ?? toFiniteNumber(selectedRate?.cost),
        selectedRate,
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
    bestRate,
    selectedRate,
    label,
    shipping,
    // PS-036: lift the explicit external-fulfillment flags to the top level so
    // OrdersView reads `order.flags` consistently. The list API nests these
    // under canonicalOrder.flags and also exposes the raw row columns
    // (externallyShipped, raw.externallyFulfilled); the /full detail DTO emits
    // a top-level `flags`. Reconcile all three here so a shipped row with no
    // local shipment data is correctly classed as "external" vs "missing sync".
    flags: (() => {
      const canonicalFlags = toRecordValue(canonicalOrder?.flags)
      const rowFlags = toRecordValue(row.flags)
      return {
        externallyShipped:
          canonicalFlags?.externallyShipped === true ||
          rowFlags?.externallyShipped === true ||
          row.externallyShipped === true,
        externallyFulfilled:
          canonicalFlags?.externallyFulfilled === true ||
          rowFlags?.externallyFulfilled === true ||
          rawAny.externallyFulfilled === true,
        externallyFulfilledVerified:
          canonicalFlags?.externallyFulfilledVerified === true ||
          rowFlags?.externallyFulfilledVerified === true ||
          row.externallyFulfilledVerified === true,
      }
    })(),
  };
}

function toIsoStart(d: string | undefined): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return californiaDayStartIso(d);
}

function toIsoEnd(d: string | undefined): string | undefined {
  if (!d) return undefined;
  if (d.includes('T')) return d;
  return californiaDayEndIso(d);
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
    includeInactiveClients = false,
    search,
    searchScope,
    sku,
    sortBy,
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
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });

  const isoFrom = toIsoStart(dateStart);
  const isoTo = toIsoEnd(dateEnd);
  const trimmedSearch = search?.trim() ?? '';
  const trimmedSku = sku?.trim() ?? '';
  // PS-210: scope intent only rides a real search — an empty box never
  // changes the tab query (and the backend ignores it anyway).
  const effectiveSearchScope = trimmedSearch ? searchScope : undefined;

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

  const [exactTotalReady, setExactTotalReady] = useState(false);
  useEffect(() => {
    setExactTotalReady(false);
    const timerId = window.setTimeout(() => setExactTotalReady(true), 2500);
    return () => window.clearTimeout(timerId);
  }, [
    status,
    currentPage,
    pageSize,
    effectiveClientId,
    effectiveStoreId,
    excludeClientId,
    hideTestOrders,
    includeInactiveClients,
    isoFrom,
    isoTo,
    trimmedSearch,
    trimmedSku,
    sortBy,
  ]);

  const delayExactTotal =
    currentPage === 1 &&
    !exactTotalReady &&
    trimmedSearch.length === 0 &&
    trimmedSku.length === 0;

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
      includeInactiveClients,
      isoFrom,
      isoTo,
      trimmedSearch,
      effectiveSearchScope,
      trimmedSku,
      sortBy,
      delayExactTotal,
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
          includeInactiveClients,
          dateFrom: isoFrom,
          dateTo: isoTo,
          search: trimmedSearch || undefined,
          searchScope: effectiveSearchScope,
          sku: trimmedSku || undefined,
          sort: sortBy,
          includeTotal: delayExactTotal ? false : undefined,
        })}`
      ),
    staleTime: ORDERS_STALE_MS,
    gcTime: ORDERS_CACHE_MS,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: 1_500,
    refetchInterval: (activeQuery) =>
      activeQuery.state.error != null && activeQuery.state.data == null ? 15_000 : false,
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

  const queryRefetch = query.refetch;
  const queryRefetchRef = useRef(queryRefetch);
  useEffect(() => {
    queryRefetchRef.current = queryRefetch;
  }, [queryRefetch]);

  const refetchCoordinatorRef = useRef<ReturnType<typeof createOrdersRefetchCoordinator> | null>(null);
  if (refetchCoordinatorRef.current == null) {
    refetchCoordinatorRef.current = createOrdersRefetchCoordinator(async () => {
      await queryRefetchRef.current();
    });
  }

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetchCoordinatorRef.current?.request('orders-refetch');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const goToPage = useCallback(async (pageNum: number) => {
    setCurrentPage(pageNum);
  }, []);

  const hasOrdersPayload = query.data != null;
  const backgroundFetching = query.isFetching && hasOrdersPayload;

  return {
    orders: transformedOrders,
    total: query.data?.pagination.total ?? 0,
    totalApproximate: Boolean(query.data?.pagination.totalApproximate),
    pages: query.data?.pagination.totalPages ?? 0,
    currentPage,
    loading: query.isLoading && !hasOrdersPayload,
    refreshing: refreshing || backgroundFetching,
    error: (query.error as Error | null) ?? null,
    refetch,
    goToPage,
  };
}
