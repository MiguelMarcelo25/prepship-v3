import { parseOptionalIntegerParam } from "../common/input-validation.js";

export interface AnalysisSkuQuery {
  from?: string;
  to?: string;
  clientId?: number;
}

export interface AnalysisSkuDto {
  sku: string;
  name: string;
  clientName: string;
  invSkuId: number | null;
  orders: number;
  qty: number;
  pendingOrders: number;
  externalOrders: number;
  standardOrders: number;
  standardShipCount: number;
  standardAvgShipping: number;
  standardTotalShipping: number;
  expeditedOrders: number;
  expeditedShipCount: number;
  expeditedAvgShipping: number;
  expeditedTotalShipping: number;
  shipCountWithCost: number;
  blendedAvgShipping: number;
  totalShipping: number;
}

export interface AnalysisSkusResponse {
  skus: AnalysisSkuDto[];
  orderCount: number;
}

export interface AnalysisDailySalesQuery {
  from?: string;
  to?: string;
  clientId?: number;
  top: number;
}

export interface TopSkuDto {
  sku: string;
  name: string;
  total: number;
}

export interface AnalysisDailySalesResponse {
  topSkus: TopSkuDto[];
  dates: string[];
  series: Record<string, number[]>;
}

export function parseAnalysisSkuQuery(url: URL): AnalysisSkuQuery {
  return {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
  };
}

export function parseAnalysisDailySalesQuery(url: URL): AnalysisDailySalesQuery {
  const top = parseOptionalIntegerParam(url.searchParams.get("top"), "top") ?? 5;
  return {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
    top: Math.min(Math.max(top, 1), 10),
  };
}
