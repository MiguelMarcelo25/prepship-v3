import type {
  GetOrderIdsQuery,
  GetOrderPicklistQuery,
  OrderBestRateDto,
  OrderExportQuery,
  OrderExportRow,
  OrderFullDto,
  OrdersDailyStatsDto,
  OrderPicklistItemDto,
  ListOrdersQuery,
} from "../../../../../../packages/contracts/src/orders/contracts.ts";
import type { OrderRecord } from "../domain/order.ts";

export interface OrderListResult {
  orders: OrderRecord[];
  total: number;
}

export interface OrderRepository {
  list(query: ListOrdersQuery): Promise<OrderListResult>;
  getById(orderId: number): Promise<OrderRecord | null>;
  findIdsBySku(query: GetOrderIdsQuery): Promise<number[]>;
  getPicklist(query: GetOrderPicklistQuery): Promise<OrderPicklistItemDto[]>;
  getFullById(orderId: number): Promise<OrderFullDto | null>;
  updateExternalShipped(orderId: number, externalShipped: boolean, source?: string | null): Promise<void>;
  updateResidential(orderId: number, residential: boolean | null): Promise<void>;
  updateSelectedPid(orderId: number, selectedPid: number | null): Promise<void>;
  updateBestRate(orderId: number, bestRate: OrderBestRateDto, bestRateDims: string | null): Promise<void>;
  updateOrderRateDims(orderId: number, length: number, width: number, height: number): Promise<void>;
  getSkuQtyDims(sku: string, qty: number): Promise<{ length: number; width: number; height: number } | null>;
  saveSkuQtyDims(sku: string, qty: number, length: number, width: number, height: number): Promise<void>;
  getDailyStats(): Promise<OrdersDailyStatsDto>;
  exportOrders(query: OrderExportQuery): Promise<OrderExportRow[]>;
}
