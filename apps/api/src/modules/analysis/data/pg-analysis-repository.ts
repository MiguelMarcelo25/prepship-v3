import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type {
  AnalysisDailySalesQuery,
  AnalysisSkuQuery,
} from "../../../../../../packages/contracts/src/analysis/contracts.js";
import { EXCLUDED_STORE_IDS } from "../../../common/prepship-config.js";
import type { AnalysisRepository } from "../application/analysis-repository.js";
import type { AnalysisDailySalesRow, AnalysisOrderRow } from "../domain/analysis.js";

export class PgAnalysisRepository implements AnalysisRepository {
  constructor(private readonly sql: PgClient) {}

  async listOrderRows(query: AnalysisSkuQuery): Promise<AnalysisOrderRow[]> {
    const storeIds = query.clientId != null ? await this.getClientStoreIds(query.clientId) : [];
    if (query.clientId != null && storeIds.length === 0) return [];

    // Build query based on which filters are active.
    // Neon tagged templates don't support dynamic WHERE clauses easily,
    // so we use conditional branches.
    if (query.from && query.to && query.clientId != null) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${query.from}
          AND o."orderDate" <= ${`${query.to}T23:59:59`}
          AND o."storeId" = ANY(${storeIds}::int[])
      ` as AnalysisOrderRow[];
    }

    if (query.from && query.to) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${query.from}
          AND o."orderDate" <= ${`${query.to}T23:59:59`}
      ` as AnalysisOrderRow[];
    }

    if (query.from && query.clientId != null) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${query.from}
          AND o."storeId" = ANY(${storeIds}::int[])
      ` as AnalysisOrderRow[];
    }

    if (query.to && query.clientId != null) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" <= ${`${query.to}T23:59:59`}
          AND o."storeId" = ANY(${storeIds}::int[])
      ` as AnalysisOrderRow[];
    }

    if (query.from) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${query.from}
      ` as AnalysisOrderRow[];
    }

    if (query.to) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" <= ${`${query.to}T23:59:59`}
      ` as AnalysisOrderRow[];
    }

    if (query.clientId != null) {
      return await this.sql`
        SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
               ls.label_cost AS "labelCost",
               CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
        FROM orders o
        LEFT JOIN (
          SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
          FROM shipments
          WHERE voided = 0
            AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
        ) ls ON ls."orderId" = o."orderId"
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."storeId" = ANY(${storeIds}::int[])
      ` as AnalysisOrderRow[];
    }

    // No filters except cancelled exclusion
    return await this.sql`
      SELECT o.items, o."serviceCode", o."storeId", o."orderStatus",
             ls.label_cost AS "labelCost",
             CASE WHEN o."orderStatus" = 'shipped' AND ls."orderId" IS NULL THEN 1 ELSE 0 END AS "isExternal"
      FROM orders o
      LEFT JOIN (
        SELECT "orderId", "shipmentCost" + COALESCE("otherCost", 0) AS label_cost
        FROM shipments
        WHERE voided = 0
          AND "shipmentId" IN (SELECT MAX("shipmentId") FROM shipments WHERE voided = 0 GROUP BY "orderId")
      ) ls ON ls."orderId" = o."orderId"
      WHERE o."orderStatus" NOT IN ('cancelled')
    ` as AnalysisOrderRow[];
  }

  async listDailySalesRows(query: AnalysisDailySalesQuery, since: string, until: string): Promise<AnalysisDailySalesRow[]> {
    const storeIds = query.clientId != null ? await this.getClientStoreIds(query.clientId) : [];
    if (query.clientId != null && storeIds.length === 0) return [];

    // Determine which combination of filters to apply
    const hasExcluded = EXCLUDED_STORE_IDS.length > 0;
    const hasClient = query.clientId != null;

    if (hasExcluded && hasClient) {
      return await this.sql`
        SELECT
          substr(o."orderDate", 1, 10) AS day,
          COALESCE(
            NULLIF(j.value->>'sku', ''),
            '_name_:' || lower(trim(COALESCE(j.value->>'name', '')))
          ) AS sku,
          MAX(j.value->>'name') AS name,
          SUM(CAST(COALESCE(j.value->>'quantity', '1') AS INTEGER)) AS qty
        FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) j(value)
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${since}
          AND o."orderDate" <= ${until}
          AND COALESCE(j.value->>'adjustment', 'false') IN ('false', '0', '')
          AND o."storeId" != ALL(${EXCLUDED_STORE_IDS}::int[])
          AND o."storeId" = ANY(${storeIds}::int[])
        GROUP BY day, COALESCE(NULLIF(j.value->>'sku', ''), '_name_:' || lower(trim(COALESCE(j.value->>'name', ''))))
        ORDER BY day ASC
      ` as AnalysisDailySalesRow[];
    }

    if (hasExcluded) {
      return await this.sql`
        SELECT
          substr(o."orderDate", 1, 10) AS day,
          COALESCE(
            NULLIF(j.value->>'sku', ''),
            '_name_:' || lower(trim(COALESCE(j.value->>'name', '')))
          ) AS sku,
          MAX(j.value->>'name') AS name,
          SUM(CAST(COALESCE(j.value->>'quantity', '1') AS INTEGER)) AS qty
        FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) j(value)
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${since}
          AND o."orderDate" <= ${until}
          AND COALESCE(j.value->>'adjustment', 'false') IN ('false', '0', '')
          AND o."storeId" != ALL(${EXCLUDED_STORE_IDS}::int[])
        GROUP BY day, COALESCE(NULLIF(j.value->>'sku', ''), '_name_:' || lower(trim(COALESCE(j.value->>'name', ''))))
        ORDER BY day ASC
      ` as AnalysisDailySalesRow[];
    }

    if (hasClient) {
      return await this.sql`
        SELECT
          substr(o."orderDate", 1, 10) AS day,
          COALESCE(
            NULLIF(j.value->>'sku', ''),
            '_name_:' || lower(trim(COALESCE(j.value->>'name', '')))
          ) AS sku,
          MAX(j.value->>'name') AS name,
          SUM(CAST(COALESCE(j.value->>'quantity', '1') AS INTEGER)) AS qty
        FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) j(value)
        WHERE o."orderStatus" NOT IN ('cancelled')
          AND o."orderDate" >= ${since}
          AND o."orderDate" <= ${until}
          AND COALESCE(j.value->>'adjustment', 'false') IN ('false', '0', '')
          AND o."storeId" = ANY(${storeIds}::int[])
        GROUP BY day, COALESCE(NULLIF(j.value->>'sku', ''), '_name_:' || lower(trim(COALESCE(j.value->>'name', ''))))
        ORDER BY day ASC
      ` as AnalysisDailySalesRow[];
    }

    return await this.sql`
      SELECT
        substr(o."orderDate", 1, 10) AS day,
        COALESCE(
          NULLIF(j.value->>'sku', ''),
          '_name_:' || lower(trim(COALESCE(j.value->>'name', '')))
        ) AS sku,
        MAX(j.value->>'name') AS name,
        SUM(CAST(COALESCE(j.value->>'quantity', '1') AS INTEGER)) AS qty
      FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) j(value)
      WHERE o."orderStatus" NOT IN ('cancelled')
        AND o."orderDate" >= ${since}
        AND o."orderDate" <= ${until}
        AND COALESCE(j.value->>'adjustment', 'false') IN ('false', '0', '')
      GROUP BY day, COALESCE(NULLIF(j.value->>'sku', ''), '_name_:' || lower(trim(COALESCE(j.value->>'name', ''))))
      ORDER BY day ASC
    ` as AnalysisDailySalesRow[];
  }

  async getStoreClientNameMap(): Promise<Record<number, string>> {
    const map: Record<number, string> = {};
    const rows = await this.sql`SELECT "clientId", name, "storeIds" FROM clients WHERE active = 1` as Array<{ name: string; storeIds: string | null }>;
    for (const row of rows) {
      try {
        const storeIds = JSON.parse(row.storeIds ?? "[]") as unknown[];
        for (const storeId of storeIds) {
          const parsed = Number.parseInt(String(storeId), 10);
          if (Number.isFinite(parsed)) map[parsed] = row.name;
        }
      } catch { /* ignore malformed JSON */ }
    }
    return map;
  }

  async getInventorySkuMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const rows = await this.sql`SELECT sku, id FROM inventory_skus` as Array<{ sku: string | null; id: number }>;
    for (const row of rows) {
      if (row.sku && !map.has(row.sku)) {
        map.set(row.sku, Number(row.id));
      }
    }
    return map;
  }

  async getClientStoreIds(clientId: number): Promise<number[]> {
    const rows = await this.sql`SELECT "storeIds" FROM clients WHERE "clientId" = ${clientId}`;
    const row = rows[0] as { storeIds?: string | null } | undefined;
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
