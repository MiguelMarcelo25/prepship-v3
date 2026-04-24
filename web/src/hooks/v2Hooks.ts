import { useCallback, useMemo, useState } from 'react';
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

type V4ClientRow = { id: number; name: string };

function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function transformOrderRowV4toV2(
  row: Record<string, unknown>,
  clientsById: Map<number, string>
): OrderSummaryDto {
  const rawAny = (row.raw ?? {}) as Record<string, unknown>;
  const rawShipTo = (rawAny.shipTo ?? {}) as Record<string, unknown>;
  const rawDims = (rawAny.dimensions ?? {}) as Record<string, unknown>;
  const clientId = typeof row.clientId === 'number' ? row.clientId : null;
  const overrides = (row.overrides ?? null) as Record<string, unknown> | null;
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
    const shipmentCost = num(ship?.amount) ?? 0;
    const otherCost = num(other?.amount) ?? 0;
    return {
      carrierCode: (bestRateJson.carrier_code as string) ?? null,
      serviceCode: (bestRateJson.service_code as string) ?? null,
      serviceName: (bestRateJson.service_type as string) ?? null,
      carrierNickname: (bestRateJson.carrier_nickname as string) ?? null,
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

  const weightOz = typeof row.weightOz === 'number' ? row.weightOz : null;
  const ovL = typeof overrides?.rateDimsL === 'number' ? (overrides.rateDimsL as number) : null;
  const ovW = typeof overrides?.rateDimsW === 'number' ? (overrides.rateDimsW as number) : null;
  const ovH = typeof overrides?.rateDimsH === 'number' ? (overrides.rateDimsH as number) : null;
  const dimsL = (typeof rawDims.length === 'number' ? (rawDims.length as number) : null) ?? ovL;
  const dimsW = (typeof rawDims.width === 'number' ? (rawDims.width as number) : null) ?? ovW;
  const dimsH = (typeof rawDims.height === 'number' ? (rawDims.height as number) : null) ?? ovH;

  const orderTotalNum = (() => {
    const v = row.orderTotal;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  })();
  const shippingAmountNum = (() => {
    const v = row.shippingAmount;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  })();

  return {
    ...row,
    orderId: row.id,
    orderTotal: orderTotalNum,
    shippingAmount: shippingAmountNum,
    clientId,
    clientName: clientId != null ? clientsById.get(clientId) ?? null : null,
    shipTo: {
      name: (rawShipTo.name as string | undefined) ?? (row.shipToName as string | null) ?? null,
      company: (rawShipTo.company as string | undefined) ?? null,
      street1: (rawShipTo.street1 as string | undefined) ?? null,
      street2: (rawShipTo.street2 as string | undefined) ?? null,
      city: (rawShipTo.city as string | undefined) ?? (row.shipToCity as string | null) ?? null,
      state: (rawShipTo.state as string | undefined) ?? (row.shipToState as string | null) ?? null,
      postalCode:
        (rawShipTo.postalCode as string | undefined) ??
        (row.shipToPostalCode as string | null) ??
        null,
      country: (rawShipTo.country as string | undefined) ?? 'US',
      phone: (rawShipTo.phone as string | undefined) ?? null,
    },
    weight: weightOz != null ? { value: weightOz, units: 'ounces' } : null,
    rateDims:
      dimsL != null && dimsW != null && dimsH != null
        ? { length: dimsL, width: dimsW, height: dimsH, units: 'inches' }
        : null,
    bestRate: bestRateLegacy,
    selectedRate: null,
    label: null,
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
  } = options;

  const [currentPage, setCurrentPage] = useState<number>(page);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const clientsQuery = useQuery<V4ClientRow[]>({
    queryKey: ['v2-hooks:clients'],
    queryFn: () => api.get<V4ClientRow[]>('/clients'),
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
          dateFrom: isoFrom,
          dateTo: isoTo,
        })}`
      ),
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

  return {
    orders: transformedOrders,
    total: query.data?.pagination.total ?? 0,
    pages: query.data?.pagination.totalPages ?? 0,
    currentPage,
    loading: query.isLoading,
    refreshing,
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
};

type V4CarriersResponse = { carriers: V4Carrier[] };

export function useShippingAccounts(): UseShippingAccountsResult {
  const query = useQuery<V4CarriersResponse>({
    queryKey: ['v2-hooks:carriers'],
    queryFn: () => api.get<V4CarriersResponse>('/rates/carriers'),
    staleTime: 60_000,
  });

  // SettingsView keys rows by `shippingProviderId` — must be unique per account.
  // ShipStation carrier ids are `se-433542`; v2 uses the numeric provider id.
  const accounts = useMemo<CarrierAccountDto[]>(
    () =>
      (query.data?.carriers ?? []).map((c, i) => ({
        carrierId: c.carrier_id,
        carrierCode: c.carrier_code,
        shippingProviderId: toProviderAccountId(c.carrier_id) ?? i + 1,
        nickname: c.nickname ?? c.friendly_name ?? c.carrier_code,
        clientId: null,
        code: c.carrier_code,
        _label: c.friendly_name ?? c.nickname ?? c.carrier_code,
      })),
    [query.data]
  );

  return {
    accounts,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
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

export function useClients(): UseClientsResult {
  const query = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients'),
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

  const clientsQuery = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients'),
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
