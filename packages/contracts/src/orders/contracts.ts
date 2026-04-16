import { type PageMeta } from "../common/pagination.js";
import { parseOptionalIntegerParam } from "../common/input-validation.js";
import type { RateDto } from "../rates/contracts.js";

export interface ListOrdersQuery {
  page: number;
  pageSize: number;
  orderStatus?: string;
  storeId?: number;
  clientId?: number;
  dateStart?: string;
  dateEnd?: string;
  search?: string;
}

export interface OrderSummaryDto {
  orderId: number;
  clientId: number | null;
  clientName: string | null;
  orderNumber: string | null;
  orderStatus: string;
  orderDate: string | null;
  storeId: number | null;
  customerEmail: string | null;
  shipTo: {
    name: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
  carrierCode: string | null;
  serviceCode: string | null;
  weight: {
    value: number;
    units: string;
  } | null;
  orderTotal: number | null;
  shippingAmount: number | null;
  residential: boolean | null;
  sourceResidential: boolean | null;
  externalShipped: boolean;
  bestRate: OrderBestRateDto | null;
  selectedRate: OrderSelectedRateDto | null;
  label: {
    shipmentId: number | null;
    trackingNumber: string | null;
    carrierCode: string | null;
    serviceCode: string | null;
    shippingProviderId: number | null;
    cost: number | null;
    rawCost: number | null;
    shipDate: string | null;
  };
  items: unknown[];
  raw: unknown;
  rateDims: { length: number; width: number; height: number } | null;
}

export type OrderBestRateDto = Omit<RateDto,
  "serviceCode" | "serviceName" | "carrierCode"
> & {
  serviceCode: string | null;
  serviceName: string | null;
  carrierCode: string | null;
};

export interface OrderSelectedRateDto {
  providerAccountId: number | null;
  providerAccountNickname: string | null;
  shippingProviderId: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  cost: number | null;
  shipmentCost: number | null;
  otherCost: number | null;
}

export interface ListOrdersResponse {
  orders: OrderSummaryDto[];
  page: number;
  pages: number;
  total: number;
}

export interface GetOrderIdsQuery {
  sku: string;
  qty?: number;
  orderStatus?: string;
  storeId?: number;
}

export interface GetOrderIdsResponse {
  ids: number[];
}

export interface OrderPicklistItemDto {
  storeId: number | null;
  clientName: string;
  sku: string;
  name: string | null;
  imageUrl: string | null;
  totalQty: number;
  orderCount: number;
}

export interface GetOrderPicklistQuery {
  orderStatus?: string;
  storeId?: number;
  dateStart?: string;
  dateEnd?: string;
}

export interface GetOrderPicklistResponse {
  skus: OrderPicklistItemDto[];
  orderStatus?: string;
}

export interface OrderOverrideInput {
  orderId: number;
  externalShipped?: boolean;
  residential?: boolean | null;
  selectedPid?: number | null;
  bestRate?: OrderBestRateDto | null;
  bestRateDims?: string | null;
}

export interface OrderFullDto {
  raw: unknown;
  shipments: unknown[];
  local: Record<string, unknown> | null;
}

export interface OrdersDailyStatsDto {
  window: {
    from: string;
    to: string;
    fromLabel: string;
    toLabel: string;
  };
  totalOrders: number;
  needToShip: number;
  upcomingOrders: number;
}

// ---------- Order CSV export ----------

export interface OrderExportQuery {
  orderStatus: string;
  pageSize: number;
}

export interface OrderExportRow {
  orderId: number;
  clientId: number | null;
  storeId: number | null;
  raw: string | null;
  external_shipped: number;
  best_rate_json: string | null;
  label_shipmentId: number | null;
  label_cost: number | null;
  label_raw_cost: number | null;
  label_carrier: string | null;
  label_service: string | null;
  label_tracking: string | null;
  label_shipDate: string | null;
  label_created_at: string | null;
  selected_rate_json: string | null;
}

export function parseOrderExportQuery(url: URL): OrderExportQuery {
  const orderStatus = url.searchParams.get("orderStatus") ?? "shipped";
  const pageSizeRaw = url.searchParams.get("pageSize");
  const pageSize = pageSizeRaw ? Math.min(5000, Math.max(1, Number.parseInt(pageSizeRaw, 10))) : 5000;
  return { orderStatus, pageSize };
}

export function parseListOrdersQuery(url: URL): ListOrdersQuery {
  const page = Math.max(1, parseOptionalIntegerParam(url.searchParams.get("page"), "page") ?? 1);
  const pageSize = Math.min(500, Math.max(1, parseOptionalIntegerParam(url.searchParams.get("pageSize"), "pageSize") ?? 50));

  return {
    page,
    pageSize,
    orderStatus: url.searchParams.get("orderStatus") ?? undefined,
    storeId: parseOptionalIntegerParam(url.searchParams.get("storeId"), "storeId"),
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
    dateStart: url.searchParams.get("dateStart") ?? undefined,
    dateEnd: url.searchParams.get("dateEnd") ?? undefined,
  };
}

export function parseGetOrderIdsQuery(url: URL): GetOrderIdsQuery {
  const sku = url.searchParams.get("sku");

  if (!sku) {
    throw new Error("sku required");
  }

  return {
    sku,
    qty: parseOptionalIntegerParam(url.searchParams.get("qty"), "qty"),
    orderStatus: url.searchParams.get("orderStatus") ?? undefined,
    storeId: parseOptionalIntegerParam(url.searchParams.get("storeId"), "storeId"),
  };
}

export function parseOrderPicklistQuery(url: URL): GetOrderPicklistQuery {
  return {
    orderStatus: url.searchParams.get("orderStatus") ?? undefined,
    storeId: parseOptionalIntegerParam(url.searchParams.get("storeId"), "storeId"),
    dateStart: url.searchParams.get("dateStart") ?? undefined,
    dateEnd: url.searchParams.get("dateEnd") ?? undefined,
  };
}
