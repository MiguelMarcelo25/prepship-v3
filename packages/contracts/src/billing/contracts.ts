import { parseOptionalIntegerParam } from "../common/input-validation.js";

export interface BillingConfigDto {
  clientId: number;
  clientName: string;
  pickPackFee: number;
  additionalUnitFee: number;
  packageCostMarkup: number;
  shippingMarkupPct: number;
  shippingMarkupFlat: number;
  billing_mode: string;
  storageFeePerCuFt: number;
  storageFeeMode: string;
  palletPricingPerMonth: number;
  palletCuFt: number;
}

export interface BillingSummaryQuery {
  from?: string;
  to?: string;
  clientId?: number;
}

export interface UpdateBillingConfigInput {
  pickPackFee?: number;
  additionalUnitFee?: number;
  shippingMarkupPct?: number;
  shippingMarkupFlat?: number;
  billing_mode?: string;
  storageFeePerCuFt?: number;
  storageFeeMode?: string;
  palletPricingPerMonth?: number;
  palletCuFt?: number;
}

export interface BillingSummaryDto {
  clientId: number;
  clientName: string;
  pickPackTotal: number;
  additionalTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  orderCount: number;
  grandTotal: number;
}

export interface BillingDetailsQuery {
  from?: string;
  to?: string;
  clientId?: number;
}

export interface GenerateBillingInput {
  from?: string;
  to?: string;
  clientId?: number;
}

export interface GenerateBillingResult {
  ok: true;
  generated: number;
  total: number;
}

export interface BillingDetailDto {
  orderId: number;
  orderNumber: string;
  shipDate: string;
  totalQty: number;
  pickpackTotal: number;
  additionalTotal: number;
  packageTotal: number;
  shippingTotal: number;
  actualLabelCost: number | null;
  label_weight_oz: number | null;
  label_dims_l: number | null;
  label_dims_w: number | null;
  label_dims_h: number | null;
  ref_usps_rate: number | null;
  ref_ups_rate: number | null;
  packageName: string | null;
  itemNames: string | null;
  itemSkus: string | null;
}

export interface BillingPackagePriceDto {
  packageId: number;
  price: number;
  is_custom: number;
  name: string;
  length: number | null;
  width: number | null;
  height: number | null;
}

export interface BillingPackagePricesQuery {
  clientId?: number;
}

export interface SaveBillingPackagePriceInput {
  packageId: number;
  price: number;
}

export interface SaveBillingPackagePricesInput {
  clientId?: number;
  prices?: SaveBillingPackagePriceInput[];
}

export interface SetDefaultBillingPackagePriceInput {
  packageId?: number;
  price?: number;
}

export interface SetDefaultBillingPackagePriceResult {
  ok: true;
  updated: number;
  skipped: number;
}

export interface BackfillBillingReferenceRatesInput {
  from?: string;
  to?: string;
}

export interface BackfillBillingReferenceRatesResult {
  ok: true;
  filled: number;
  missing: number;
  total?: number;
  message?: string;
}

export interface BillingReferenceRateFetchStatusDto {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  startedAt: number | null;
}

export interface FetchBillingReferenceRatesResult {
  ok: boolean;
  message: string;
  total?: number;
  queued?: number;
  orders?: number;
  status?: BillingReferenceRateFetchStatusDto;
}

export function parseBillingSummaryQuery(url: URL): BillingSummaryQuery {
  return {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
  };
}

export function parseBillingDetailsQuery(url: URL): BillingDetailsQuery {
  return {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
  };
}

export function parseBillingPackagePricesQuery(url: URL): BillingPackagePricesQuery {
  return {
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
  };
}
