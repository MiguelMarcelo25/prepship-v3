/**
 * React-side order domain types used by the incremental parity migration.
 */

export interface OrderItem {
  sku: string;
  quantity: number;
  name?: string;
  price?: number;
  imageUrl?: string;
  adjustment?: boolean;
}

export interface OrderDimensions {
  length: number;
  width: number;
  height: number;
}

export interface OrderWeight {
  value: number;
  units: 'ounces' | 'grams';
}

export interface OrderAddress {
  name?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface Rate {
  shipmentId?: string;
  shippingProviderId: number;
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  packageType?: string | null;
  amount: number;
  shipmentCost?: number;
  otherCost?: number;
  carrierNickname?: string | null;
  deliveryDays?: number | null;
  estimatedDelivery?: string | null;
  estimatedDeliveryDays?: number;
  surcharges?: Array<{ name: string; amount: number }>;
}

export interface OrderDTO {
  orderId: number;
  orderNumber: string;
  createdAt: string;
  updatedAt: string;
  clientId: number;
  storeId: number;

  // Recipient
  shipTo?: OrderAddress;
  residential?: boolean;
  sourceResidential?: boolean;
  // PS-276 (slice 4): the BACKEND's resolved residential verdict (what the rate uses) +
  // provenance. The FE reads these instead of re-classifying (slice 3 points the rate
  // draft key + resi/comm tag at them); equals the rate fingerprint r= bit by construction.
  residentialClassification?: 'residential' | 'commercial';
  residentialSource?: string;
  residentialConfidence?: string;

  // Items
  items?: OrderItem[];

  // Shipping dimensions
  weight?: OrderWeight;
  dimensions?: OrderDimensions;

  // Rate selection
  selectedServiceCode?: string;
  selectedCarrierCode?: string;
  selectedShippingProviderId?: number;
  selectedRate?: Rate;

  // Billing
  billingProviderId?: number;
  orderTotal?: number;

  // Status
  status: 'pending' | 'awaiting_shipment' | 'shipped' | 'cancelled';

  // Print/Label
  labelCreated?: string;
  trackingNumber?: string;
  printCount?: number;

  // V2 compatibility flags
  _enrichedWeight?: OrderWeight;
  _enrichedDims?: OrderDimensions;
  bestRate?: Rate;
}

export interface RateGroup {
  key: string;
  wt: number;
  zip: string;
  dims: OrderDimensions;
  residential: boolean;
  storeId: number;
  ids: number[];
}

export interface RateCacheEntry {
  key: string;
  rates: Rate[];
  fetchedAt: number;
}

export interface RatesMap {
  [cacheKey: string]: Rate[];
}

export interface OrdersFilterOptions {
  search?: string;
  sku?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface OrdersQueryParams extends OrdersFilterOptions {
  page?: number;
  pageSize?: number;
  sort?: string;
  sortDir?: 'asc' | 'desc';
}

export interface ListOrdersResponse {
  orders: OrderDTO[];
  totalCount: number;
  pageCount: number;
  currentPage: number;
  pageSize: number;
}

export interface ColumnConfig {
  key: string;
  label: string;
  width: number;
  toggleable: boolean;
  sortable?: boolean;
}

export interface SkuGroup {
  sku: string;
  qty: number;
  orderIds: number[];
}

// API Request/Response shapes
export interface BulkCachedRatesRequest {
  groups: Array<{
    key: string;
    wt: number;
    zip: string;
    dims: OrderDimensions;
    residential: boolean;
    storeId: number;
    ids: number[];
  }>;
}

export interface LiveRateRequest {
  fromPostalCode: string;
  toPostalCode: string;
  toCountry: string;
  weight: OrderWeight;
  dimensions?: OrderDimensions;
  residential: boolean;
  orderIds: number[];
  storeId: number;
}

export interface BulkCachedRatesResponse {
  results: {
    [key: string]: {
      cached: boolean;
      rates: Rate[];
    };
  };
}
