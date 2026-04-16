import type {
  AnalysisDailySalesQuery,
  AnalysisDailySalesResponse,
  AnalysisSkuDto,
  AnalysisSkuQuery,
  AnalysisSkusResponse,
  TopSkuDto,
} from "../../../../../../packages/contracts/src/analysis/contracts.ts";
import { EXPEDITED_SERVICES } from "../../../common/prepship-config.ts";
import type { AnalysisRepository } from "./analysis-repository.ts";

interface MutableSkuStats {
  sku: string;
  name: string;
  clientName: string;
  invSkuId: number | null;
  orders: number;
  qty: number;
  externalOrders: number;
  standardOrders: number;
  standardShipping: number;
  standardShipCount: number;
  expeditedOrders: number;
  expeditedShipping: number;
  expeditedShipCount: number;
  totalShipping: number;
  shipCountWithCost: number;
}

export class AnalysisServices {
  private readonly repository: AnalysisRepository;

  constructor(repository: AnalysisRepository) {
    this.repository = repository;
  }

  async getSkuAnalysis(query: AnalysisSkuQuery): Promise<AnalysisSkusResponse> {
    const rows = await this.repository.listOrderRows(query);
    const clientMap = await this.repository.getStoreClientNameMap();
    const invSkuMap = await this.repository.getInventorySkuMap();
    const skuMap = new Map<string, MutableSkuStats>();

    for (const row of rows) {
      let items: Array<Record<string, unknown>> = [];
      try {
        items = JSON.parse(row.items ?? "[]") as Array<Record<string, unknown>>;
      } catch {}

      const validItems = items.filter((item) => item.adjustment !== true && Number(item.quantity ?? 1) > 0);
      const uniqueKeyCount = new Set(validItems.map((item) => this.makeSkuKey(item))).size;
      const skuDivisor = Math.max(uniqueKeyCount, 1);
      const hasRealCost = row.labelCost != null && row.labelCost > 0;
      const allocated = hasRealCost ? Number(row.labelCost) / skuDivisor : 0;
      const isExternal = row.isExternal === 1;
      const isExpedited = EXPEDITED_SERVICES.has(row.serviceCode ?? "");
      const clientName = row.storeId != null ? (clientMap[row.storeId] ?? "") : "";
      const seenInRow = new Set<string>();

      for (const item of validItems) {
        const key = this.makeSkuKey(item);
        const skuValue = typeof item.sku === "string" ? item.sku : "";
        const nameValue = typeof item.name === "string" && item.name.length > 0 ? item.name : "—";
        let stats = skuMap.get(key);
        if (!stats) {
          stats = {
            sku: skuValue,
            name: nameValue,
            clientName,
            invSkuId: skuValue ? (invSkuMap.get(skuValue) ?? null) : null,
            orders: 0,
            qty: 0,
            externalOrders: 0,
            standardOrders: 0,
            standardShipping: 0,
            standardShipCount: 0,
            expeditedOrders: 0,
            expeditedShipping: 0,
            expeditedShipCount: 0,
            totalShipping: 0,
            shipCountWithCost: 0,
          };
          skuMap.set(key, stats);
        }

        if (nameValue.length > stats.name.length) {
          stats.name = nameValue;
        }

        if (!seenInRow.has(key)) {
          seenInRow.add(key);
          stats.orders += 1;
          if (isExternal) {
            stats.externalOrders += 1;
          } else if (hasRealCost) {
            stats.totalShipping += allocated;
            stats.shipCountWithCost += 1;
            if (isExpedited) {
              stats.expeditedOrders += 1;
              stats.expeditedShipping += allocated;
              stats.expeditedShipCount += 1;
            } else {
              stats.standardOrders += 1;
              stats.standardShipping += allocated;
              stats.standardShipCount += 1;
            }
          } else if (isExpedited) {
            stats.expeditedOrders += 1;
          } else {
            stats.standardOrders += 1;
          }
        }

        stats.qty += Number(item.quantity ?? 1);
      }
    }

    const skus = Array.from(skuMap.values()).map((stats): AnalysisSkuDto => ({
      sku: stats.sku,
      name: stats.name,
      clientName: stats.clientName,
      invSkuId: stats.invSkuId,
      orders: stats.orders,
      qty: stats.qty,
      pendingOrders: Math.max(0, stats.orders - stats.externalOrders - stats.standardShipCount - stats.expeditedShipCount),
      externalOrders: stats.externalOrders,
      standardOrders: stats.standardOrders,
      standardShipCount: stats.standardShipCount,
      standardAvgShipping: stats.standardShipCount > 0 ? Number((stats.standardShipping / stats.standardShipCount).toFixed(2)) : 0,
      standardTotalShipping: Number(stats.standardShipping.toFixed(2)),
      expeditedOrders: stats.expeditedOrders,
      expeditedShipCount: stats.expeditedShipCount,
      expeditedAvgShipping: stats.expeditedShipCount > 0 ? Number((stats.expeditedShipping / stats.expeditedShipCount).toFixed(2)) : 0,
      expeditedTotalShipping: Number(stats.expeditedShipping.toFixed(2)),
      shipCountWithCost: stats.shipCountWithCost,
      blendedAvgShipping: stats.shipCountWithCost > 0 ? Number((stats.totalShipping / stats.shipCountWithCost).toFixed(2)) : 0,
      totalShipping: Number(stats.totalShipping.toFixed(2)),
    })).sort((left, right) => right.qty - left.qty);

    return { skus, orderCount: rows.length };
  }

  async getDailySales(query: AnalysisDailySalesQuery): Promise<AnalysisDailySalesResponse> {
    const since = query.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const until = query.to ? `${query.to}T23:59:59` : new Date().toISOString();
    const startMs = new Date(since).getTime();
    const endMs = new Date(until.slice(0, 10)).getTime();
    const days = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const rows = await this.repository.listDailySalesRows(query, since, until);

    const totals: Record<string, number> = {};
    const names: Record<string, string> = {};
    for (const row of rows) {
      totals[row.sku] = (totals[row.sku] ?? 0) + Number(row.qty);
      if (!names[row.sku] || (row.name ?? "").length > names[row.sku].length) {
        names[row.sku] = row.name ?? row.sku;
      }
    }

    const topSkus: TopSkuDto[] = Object.entries(totals)
      .sort((left, right) => right[1] - left[1])
      .slice(0, query.top)
      .map(([sku]) => ({ sku, name: names[sku] ?? sku, total: totals[sku] ?? 0 }));

    const dates: string[] = [];
    for (let index = 0; index < days; index += 1) {
      dates.push(new Date(startMs + index * 86400000).toISOString().slice(0, 10));
    }

    const byDay: Record<string, Record<string, number>> = {};
    const skuSet = new Set(topSkus.map((sku) => sku.sku));
    for (const row of rows) {
      if (!skuSet.has(row.sku)) continue;
      if (!byDay[row.day]) byDay[row.day] = {};
      byDay[row.day][row.sku] = (byDay[row.day][row.sku] ?? 0) + Number(row.qty);
    }

    const series: Record<string, number[]> = {};
    for (const sku of topSkus) {
      series[sku.sku] = dates.map((day) => byDay[day]?.[sku.sku] ?? 0);
    }

    return { topSkus, dates, series };
  }

  private makeSkuKey(item: Record<string, unknown>): string {
    if (typeof item.sku === "string" && item.sku.length > 0) {
      return item.sku;
    }
    const name = typeof item.name === "string" ? item.name.toLowerCase().trim() : "";
    return `_name_:${name}`;
  }
}
