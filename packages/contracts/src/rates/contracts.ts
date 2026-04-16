import type { CarrierAccountDto } from "../init/contracts.js";

export interface RateDimsDto {
  length: number;
  width: number;
  height: number;
}

export interface RateDto {
  serviceCode: string;
  serviceName: string;
  packageType: string | null;
  shipmentCost: number;
  otherCost: number;
  rateDetails: unknown[];
  carrierCode: string;
  shippingProviderId: number | null;
  carrierNickname: string | null;
  guaranteed: boolean;
  zone: string | null;
  sourceClientId: number | null;
  deliveryDays: number | null;
  estimatedDelivery: string | null;
}

export interface GetCachedRatesQuery {
  wt: number;
  zip: string;
  dims: RateDimsDto | null;
  residential: boolean;
  storeId: number | null;
  signature?: string | null;
}

export interface CachedRatesResponseDto {
  cached: boolean;
  rates: RateDto[];
  best: RateDto | null;
  fetchedAt?: number;
}

export interface BulkCachedRatesRequestItem {
  key: string;
  orderId?: number;
  ids?: number[];
  wt: number;
  zip: string;
  dims?: RateDimsDto | null;
  residential?: boolean;
  storeId?: number | null;
  signature?: string | null;
}

export interface BulkCachedRatesItemResult {
  cached: boolean;
  rates?: RateDto[];
  best?: RateDto | null;
  fetchedAt?: number;
}

export interface BulkCachedRatesResponseDto {
  results: Record<string, BulkCachedRatesItemResult>;
  missing: string[];
}

export interface CarrierLookupResponseDto {
  carriers: CarrierAccountDto[];
}

export interface LiveRatesRequestDto {
  fromPostalCode?: string;
  toPostalCode: string;
  toCountry?: string;
  weight?: {
    value?: number;
    units?: string;
  };
  dimensions?: ({
    units?: string;
  } & Partial<RateDimsDto>) | null;
  residential?: boolean;
  orderId?: number;
  orderIds?: number[];
  storeId?: number | null;
}

export interface BrowseRatesRequestDto {
  carrierCode?: string | null;
  shippingProviderId: number;
  toPostalCode: string;
  weightOz?: number;
  dimensions?: RateDimsDto | null;
  residential?: boolean;
  storeId?: number | null;
  signatureOption?: string | null;
}
