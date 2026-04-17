import type { PgClient } from "../../../../../../../packages/shared/src/postgres/database.js";
import type {
  InitCountsDto,
  InitStoreDto,
  OrdersByStatusDto,
  OrdersByStatusStoreDto,
} from "../../../../../../../packages/contracts/src/init/contracts.js";
import type { InitRepository } from "../application/init-repository.js";

interface ClientStoreRow {
  name: string;
  storeIds: string | null;
}

export class PgInitRepository implements InitRepository {
  private readonly sql: PgClient;
  private readonly excludedStoreIds: number[];

  constructor(sql: PgClient, excludedStoreIds: number[]) {
    this.sql = sql;
    this.excludedStoreIds = excludedStoreIds;
  }

  async listLocalClientStores(): Promise<InitStoreDto[]> {
    const rows = await this.sql`
      SELECT DISTINCT name, "storeIds"
      FROM clients
      WHERE active = 1
    ` as ClientStoreRow[];

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
    // Build the exclude clause dynamically.
    // Since Neon tagged templates don't support dynamic IN-lists directly,
    // we use a subquery approach or filter in JS for excluded store IDs.
    // However, for correctness we'll handle this with conditional queries.

    let byStatus: OrdersByStatusDto[];
    let byStatusStore: OrdersByStatusStoreDto[];

    if (this.excludedStoreIds.length > 0) {
      byStatus = await this.sql`
        SELECT o."orderStatus", COUNT(*)::int AS cnt
        FROM orders o
        LEFT JOIN order_local ol ON o."orderId" = ol."orderId"
        WHERE NOT (o."orderStatus" = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
          AND NOT (o."orderStatus" = 'awaiting_shipment' AND (normalize_jsonb(o.raw)->>'externallyFulfilled') IN ('1', 'true'))
          AND NOT (
            o."orderStatus" = 'awaiting_shipment'
            AND EXISTS (
              SELECT 1 FROM shipments s
              WHERE s."orderId" = o."orderId" AND s.voided = 0
            )
          )
          AND o."storeId" != ALL(${this.excludedStoreIds}::int[])
        GROUP BY o."orderStatus"
      ` as OrdersByStatusDto[];

      byStatusStore = await this.sql`
        SELECT o."orderStatus", CAST(o."storeId" AS INTEGER) AS "storeId", COUNT(*)::int AS cnt
        FROM orders o
        LEFT JOIN order_local ol ON o."orderId" = ol."orderId"
        WHERE NOT (o."orderStatus" = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
          AND NOT (o."orderStatus" = 'awaiting_shipment' AND (normalize_jsonb(o.raw)->>'externallyFulfilled') IN ('1', 'true'))
          AND NOT (
            o."orderStatus" = 'awaiting_shipment'
            AND EXISTS (
              SELECT 1 FROM shipments s
              WHERE s."orderId" = o."orderId" AND s.voided = 0
            )
          )
          AND o."storeId" != ALL(${this.excludedStoreIds}::int[])
        GROUP BY o."orderStatus", o."storeId"
        ORDER BY cnt DESC
      ` as OrdersByStatusStoreDto[];
    } else {
      byStatus = await this.sql`
        SELECT o."orderStatus", COUNT(*)::int AS cnt
        FROM orders o
        LEFT JOIN order_local ol ON o."orderId" = ol."orderId"
        WHERE NOT (o."orderStatus" = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
          AND NOT (o."orderStatus" = 'awaiting_shipment' AND (normalize_jsonb(o.raw)->>'externallyFulfilled') IN ('1', 'true'))
          AND NOT (
            o."orderStatus" = 'awaiting_shipment'
            AND EXISTS (
              SELECT 1 FROM shipments s
              WHERE s."orderId" = o."orderId" AND s.voided = 0
            )
          )
        GROUP BY o."orderStatus"
      ` as OrdersByStatusDto[];

      byStatusStore = await this.sql`
        SELECT o."orderStatus", CAST(o."storeId" AS INTEGER) AS "storeId", COUNT(*)::int AS cnt
        FROM orders o
        LEFT JOIN order_local ol ON o."orderId" = ol."orderId"
        WHERE NOT (o."orderStatus" = 'awaiting_shipment' AND COALESCE(ol.external_shipped, 0) = 1)
          AND NOT (o."orderStatus" = 'awaiting_shipment' AND (normalize_jsonb(o.raw)->>'externallyFulfilled') IN ('1', 'true'))
          AND NOT (
            o."orderStatus" = 'awaiting_shipment'
            AND EXISTS (
              SELECT 1 FROM shipments s
              WHERE s."orderId" = o."orderId" AND s.voided = 0
            )
          )
        GROUP BY o."orderStatus", o."storeId"
        ORDER BY cnt DESC
      ` as OrdersByStatusStoreDto[];
    }

    return { byStatus, byStatusStore };
  }

  async getRateBrowserMarkups(): Promise<Record<string, unknown>> {
    const rows = await this.sql`
      SELECT value
      FROM sync_meta
      WHERE key = 'setting:rbMarkups'
    `;
    const row = rows[0] as { value?: string } | undefined;

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
