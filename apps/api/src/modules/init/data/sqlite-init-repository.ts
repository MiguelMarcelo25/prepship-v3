import type { DatabaseSync } from "node:sqlite";
import type {
  InitCountsDto,
  InitStoreDto,
  OrdersByStatusDto,
  OrdersByStatusStoreDto,
} from "../../../../../../../packages/contracts/src/init/contracts.ts";
import type { InitRepository } from "../application/init-repository.ts";

interface ClientStoreRow {
  name: string;
  storeIds: string | null;
}

export class SqliteInitRepository implements InitRepository {
  private readonly db: DatabaseSync;
  private readonly excludedStoreIds: number[];

  constructor(db: DatabaseSync, excludedStoreIds: number[]) {
    this.db = db;
    this.excludedStoreIds = excludedStoreIds;
  }

  async listLocalClientStores(): Promise<InitStoreDto[]> {
    const rows = this.db.prepare(`
      SELECT DISTINCT name, storeIds
      FROM clients
      WHERE active = 1
    `).all() as ClientStoreRow[];

    const stores: InitStoreDto[] = [];
    for (const row of rows) {
      const storeIds = this.parseStoreIds(row.storeIds);
      for (const storeId of storeIds) {
        if (this.excludedStoreIds.includes(storeId)) continue;
        stores.push({
          storeId,
          storeName: row.name,
          marketplaceId: null,
          marketplaceName: "Local Client",
          accountName: null,
          email: null,
          integrationUrl: null,
          active: true,
          companyName: "",
          phone: "",
          publicEmail: "",
          website: "",
          refreshDate: null,
          lastRefreshAttempt: null,
          createDate: null,
          modifyDate: null,
          autoRefresh: false,
          statusMappings: null,
          isLocal: true,
        });
      }
    }

    return stores;
  }

  async getCounts(): Promise<InitCountsDto> {
    const placeholders = this.excludedStoreIds.map(() => "?").join(", ");
    const excludeClause = this.excludedStoreIds.length > 0
      ? `AND o.storeId NOT IN (${placeholders})`
      : "";
    const params = [...this.excludedStoreIds];

    const byStatus = this.db.prepare(`
      SELECT o.orderStatus, COUNT(*) AS cnt
      FROM orders o
      LEFT JOIN order_local ol ON o.orderId = ol.orderId
      WHERE NOT (o.orderStatus = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
        AND NOT (o.orderStatus = 'awaiting_shipment' AND COALESCE(json_extract(o.raw, '$.externallyFulfilled'), 0) = 1)
        AND NOT (
          o.orderStatus = 'awaiting_shipment'
          AND EXISTS (
            SELECT 1 FROM shipments s
            WHERE s.orderId = o.orderId AND s.voided = 0
          )
        )
        ${excludeClause}
      GROUP BY o.orderStatus
    `).all(...params) as OrdersByStatusDto[];

    const byStatusStore = this.db.prepare(`
      SELECT o.orderStatus, CAST(o.storeId AS INTEGER) AS storeId, COUNT(*) AS cnt
      FROM orders o
      LEFT JOIN order_local ol ON o.orderId = ol.orderId
      WHERE NOT (o.orderStatus = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
        AND NOT (o.orderStatus = 'awaiting_shipment' AND COALESCE(json_extract(o.raw, '$.externallyFulfilled'), 0) = 1)
        AND NOT (
          o.orderStatus = 'awaiting_shipment'
          AND EXISTS (
            SELECT 1 FROM shipments s
            WHERE s.orderId = o.orderId AND s.voided = 0
          )
        )
        ${excludeClause}
      GROUP BY o.orderStatus, o.storeId
      ORDER BY cnt DESC
    `).all(...params) as OrdersByStatusStoreDto[];

    return { byStatus, byStatusStore };
  }

  async getRateBrowserMarkups(): Promise<Record<string, unknown>> {
    const row = this.db.prepare(`
      SELECT value
      FROM sync_meta
      WHERE key = 'setting:rbMarkups'
    `).get() as { value?: string } | undefined;

    if (!row?.value) return {};

    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private parseStoreIds(raw: string | null): number[] {
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
    } catch {
      return [];
    }
  }
}
