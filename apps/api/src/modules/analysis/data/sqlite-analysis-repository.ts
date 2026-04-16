import type { DatabaseSync } from "node:sqlite";
import type {
  AnalysisDailySalesQuery,
  AnalysisSkuQuery,
} from "../../../../../../packages/contracts/src/analysis/contracts.ts";
import { EXCLUDED_STORE_IDS } from "../../../common/prepship-config.ts";
import type { AnalysisRepository } from "../application/analysis-repository.ts";
import type { AnalysisDailySalesRow, AnalysisOrderRow } from "../domain/analysis.ts";

export class SqliteAnalysisRepository implements AnalysisRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listOrderRows(query: AnalysisSkuQuery): Promise<AnalysisOrderRow[]> {
    const where = ["o.orderStatus NOT IN ('cancelled')"];
    const params: Array<string | number> = [];
    if (query.from) {
      where.push("o.orderDate >= ?");
      params.push(query.from);
    }
    if (query.to) {
      where.push("o.orderDate <= ?");
      params.push(`${query.to}T23:59:59`);
    }
    const storeIds = query.clientId != null ? this.getClientStoreIds(query.clientId) : [];
    if (query.clientId != null) {
      if (storeIds.length === 0) return [];
      where.push(`o.storeId IN (${storeIds.map(() => "?").join(",")})`);
      params.push(...storeIds);
    }

    return this.db.prepare(`
      SELECT o.items, o.serviceCode, o.storeId, o.orderStatus,
             ls.label_cost AS labelCost,
             CASE WHEN o.orderStatus = 'shipped' AND ls.orderId IS NULL THEN 1 ELSE 0 END AS isExternal
      FROM orders o
      LEFT JOIN (
        SELECT orderId, shipmentCost + COALESCE(otherCost, 0) AS label_cost
        FROM shipments
        WHERE voided = 0
          AND shipmentId IN (SELECT MAX(shipmentId) FROM shipments WHERE voided = 0 GROUP BY orderId)
      ) ls ON ls.orderId = o.orderId
      WHERE ${where.join(" AND ")}
    `).all(...params) as AnalysisOrderRow[];
  }

  async listDailySalesRows(query: AnalysisDailySalesQuery, since: string, until: string): Promise<AnalysisDailySalesRow[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (EXCLUDED_STORE_IDS.length > 0) {
      where.push(`o.storeId NOT IN (${EXCLUDED_STORE_IDS.map(() => "?").join(",")})`);
      params.push(...EXCLUDED_STORE_IDS);
    }
    const storeIds = query.clientId != null ? this.getClientStoreIds(query.clientId) : [];
    if (query.clientId != null) {
      if (storeIds.length === 0) return [];
      where.push(`o.storeId IN (${storeIds.map(() => "?").join(",")})`);
      params.push(...storeIds);
    }
    const extraWhere = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";

    return this.db.prepare(`
      SELECT
        substr(o.orderDate, 1, 10) AS day,
        COALESCE(
          NULLIF(json_extract(j.value, '$.sku'), ''),
          '_name_:' || lower(trim(COALESCE(json_extract(j.value, '$.name'), '')))
        ) AS sku,
        json_extract(j.value, '$.name') AS name,
        SUM(CAST(COALESCE(json_extract(j.value, '$.quantity'), 1) AS INTEGER)) AS qty
      FROM orders o, json_each(o.items) j
      WHERE o.orderStatus NOT IN ('cancelled')
        AND o.orderDate >= ?
        AND o.orderDate <= ?
        AND COALESCE(json_extract(j.value, '$.adjustment'), 0) = 0
        ${extraWhere}
      GROUP BY day, COALESCE(NULLIF(json_extract(j.value, '$.sku'), ''), '_name_:' || lower(trim(COALESCE(json_extract(j.value, '$.name'), ''))))
      ORDER BY day ASC
    `).all(since, until, ...params) as AnalysisDailySalesRow[];
  }

  async getStoreClientNameMap(): Promise<Record<number, string>> {
    const map: Record<number, string> = {};
    const rows = this.db.prepare("SELECT clientId, name, storeIds FROM clients WHERE active = 1").all() as Array<{ name: string; storeIds: string | null }>;
    for (const row of rows) {
      try {
        const storeIds = JSON.parse(row.storeIds ?? "[]") as unknown[];
        for (const storeId of storeIds) {
          const parsed = Number.parseInt(String(storeId), 10);
          if (Number.isFinite(parsed)) map[parsed] = row.name;
        }
      } catch {}
    }
    return map;
  }

  async getInventorySkuMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const rows = this.db.prepare("SELECT sku, id FROM inventory_skus").all() as Array<{ sku: string | null; id: number }>;
    for (const row of rows) {
      if (row.sku && !map.has(row.sku)) {
        map.set(row.sku, Number(row.id));
      }
    }
    return map;
  }

  async getClientStoreIds(clientId: number): Promise<number[]> {
    const row = this.db.prepare("SELECT storeIds FROM clients WHERE clientId = ?").get(clientId) as { storeIds?: string | null } | undefined;
    if (!row?.storeIds) return [];
    try {
      return (JSON.parse(row.storeIds) as unknown[])
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
    } catch {
      return [];
    }
  }
}
