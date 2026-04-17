import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type {
  GetOrderIdsQuery,
  GetOrderPicklistQuery,
  ListOrdersQuery,
  OrderBestRateDto,
  OrderExportQuery,
  OrderExportRow,
  OrderFullDto,
  OrdersDailyStatsDto,
  OrderPicklistItemDto,
} from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository, OrderListResult } from "../application/order-repository.js";
import type { OrderRecord } from "../domain/order.js";

export class PgOrderRepository implements OrderRepository {
  constructor(
    private readonly sql: PgClient,
    private readonly excludedStoreIds: number[] = [],
  ) {}

  async list(query: ListOrdersQuery): Promise<OrderListResult> {
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(500, query.pageSize));
    const offset = (page - 1) * pageSize;

    // Build dynamic conditions using the nullable-parameter pattern
    const searchTerm = query.search ? `%${query.search}%` : null;
    const isAwaitingShipment = query.orderStatus === "awaiting_shipment";
    const isShipped = query.orderStatus === "shipped";

    // For excluded store IDs we need to filter them. Since tagged templates
    // don't support dynamic IN lists easily, we pass them as a JSON array
    // and use a subquery.
    const excludedJson = this.sql.json(this.excludedStoreIds);

    const shipmentJoin = `
      LEFT JOIN (
        SELECT DISTINCT ON (s2."orderId")
          s2."orderId",
          s2."shipmentId" AS label_shipmentId,
          (s2."shipmentCost" + COALESCE(s2."otherCost", 0)) AS label_cost,
          s2."shipmentCost" AS label_raw_cost,
          s2."carrierCode" AS label_carrier,
          s2."serviceCode" AS label_service,
          s2."trackingNumber" AS label_tracking,
          s2."shipDate" AS label_shipDate,
          s2."providerAccountId" AS label_provider,
          s2.provider_account_nickname AS label_provider_nickname,
          s2.label_created_at,
          s2."labelUrl" AS label_url,
          s2.selected_rate_json
        FROM shipments s2
        WHERE s2.voided = 0
        ORDER BY s2."orderId", s2."shipmentId" DESC
      ) ship ON ship."orderId" = o."orderId"
    `;

    // Count query
    const countRows = await this.sql`
      SELECT COUNT(*) AS total
      FROM orders o
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      LEFT JOIN (
        SELECT DISTINCT ON (s2."orderId")
          s2."orderId",
          (s2."shipmentCost" + COALESCE(s2."otherCost", 0)) AS label_cost
        FROM shipments s2
        WHERE s2.voided = 0
        ORDER BY s2."orderId", s2."shipmentId" DESC
      ) ship ON ship."orderId" = o."orderId"
      WHERE
        (${query.orderStatus ?? null}::text IS NULL OR o."orderStatus" = ${query.orderStatus ?? null})
        AND (${query.storeId ?? null}::int IS NULL OR o."storeId" = ${query.storeId ?? null})
        AND (${query.clientId ?? null}::int IS NULL OR o."clientId" = ${query.clientId ?? null})
        AND (${query.dateStart ?? null}::text IS NULL OR o."orderDate" >= ${query.dateStart ?? null})
        AND (${query.dateEnd ?? null}::text IS NULL OR o."orderDate" <= ${query.dateEnd ?? null})
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
        AND (${searchTerm}::text IS NULL OR (
          o."orderNumber" LIKE ${searchTerm} OR
          o."customerEmail" LIKE ${searchTerm} OR
          o."shipToName" LIKE ${searchTerm}
        ))
        AND (NOT ${isAwaitingShipment} OR (
          COALESCE(ol.external_shipped, 0) = 0
          AND COALESCE((normalize_jsonb(o.raw))->>'externallyFulfilled', '0') != '1'
          AND ship.label_cost IS NULL
        ))
        AND (NOT ${isShipped} OR (
          o."orderStatus" = 'shipped' OR (o."orderStatus" = 'awaiting_shipment' AND ship.label_cost IS NOT NULL)
        ))
    `;
    const total = Number((countRows[0] as { total: number }).total ?? 0);

    // Data query
    const rows = await this.sql`
      SELECT
        o."orderId",
        o."clientId",
        COALESCE(c.name, NULL) AS "clientName",
        o."orderNumber",
        o."orderStatus",
        o."orderDate",
        o."storeId",
        o."customerEmail",
        o."shipToName",
        o."shipToCity",
        o."shipToState",
        o."shipToPostalCode",
        o."carrierCode",
        o."serviceCode",
        o."weightValue",
        o."orderTotal",
        o."shippingAmount",
        CASE
          WHEN ol.residential IS NULL THEN NULL
          WHEN ol.residential = 1 THEN 1
          ELSE 0
        END AS residential,
        CASE
          WHEN (normalize_jsonb(o.raw))->'shipTo'->>'residential' IS NULL THEN NULL
          WHEN (normalize_jsonb(o.raw))->'shipTo'->>'residential' = '1' THEN 1
          WHEN (normalize_jsonb(o.raw))->'shipTo'->'residential' = 'true'::jsonb THEN 1
          ELSE 0
        END AS source_residential,
        COALESCE(ol.external_shipped, 0) AS external_shipped,
        COALESCE(o.externally_fulfilled_verified, 0) AS externally_fulfilled_verified,
        ol.best_rate_json,
        ship.selected_rate_json,
        ship.label_shipmentId AS "labelShipmentId",
        ship.label_tracking,
        ship.label_carrier,
        ship.label_service,
        ship.label_provider,
        ship.label_provider_nickname,
        ship.label_cost,
        ship.label_raw_cost,
        ship.label_shipDate AS "label_shipDate",
        ship.label_created_at,
        ship.label_url,
        o.raw,
        COALESCE(o.items, '[]') AS items
      FROM orders o
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      LEFT JOIN (
        SELECT DISTINCT ON (s2."orderId")
          s2."orderId",
          s2."shipmentId" AS label_shipmentId,
          (s2."shipmentCost" + COALESCE(s2."otherCost", 0)) AS label_cost,
          s2."shipmentCost" AS label_raw_cost,
          s2."carrierCode" AS label_carrier,
          s2."serviceCode" AS label_service,
          s2."trackingNumber" AS label_tracking,
          s2."shipDate" AS label_shipDate,
          s2."providerAccountId" AS label_provider,
          s2.provider_account_nickname AS label_provider_nickname,
          s2.label_created_at,
          s2."labelUrl" AS label_url,
          s2.selected_rate_json
        FROM shipments s2
        WHERE s2.voided = 0
        ORDER BY s2."orderId", s2."shipmentId" DESC
      ) ship ON ship."orderId" = o."orderId"
      LEFT JOIN clients c ON c."clientId" = o."clientId"
      WHERE
        (${query.orderStatus ?? null}::text IS NULL OR o."orderStatus" = ${query.orderStatus ?? null})
        AND (${query.storeId ?? null}::int IS NULL OR o."storeId" = ${query.storeId ?? null})
        AND (${query.clientId ?? null}::int IS NULL OR o."clientId" = ${query.clientId ?? null})
        AND (${query.dateStart ?? null}::text IS NULL OR o."orderDate" >= ${query.dateStart ?? null})
        AND (${query.dateEnd ?? null}::text IS NULL OR o."orderDate" <= ${query.dateEnd ?? null})
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
        AND (${searchTerm}::text IS NULL OR (
          o."orderNumber" LIKE ${searchTerm} OR
          o."customerEmail" LIKE ${searchTerm} OR
          o."shipToName" LIKE ${searchTerm}
        ))
        AND (NOT ${isAwaitingShipment} OR (
          COALESCE(ol.external_shipped, 0) = 0
          AND COALESCE((normalize_jsonb(o.raw))->>'externallyFulfilled', '0') != '1'
          AND ship.label_cost IS NULL
        ))
        AND (NOT ${isShipped} OR (
          o."orderStatus" = 'shipped' OR (o."orderStatus" = 'awaiting_shipment' AND ship.label_cost IS NOT NULL)
        ))
      ORDER BY o."orderDate" DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const orders = (rows as Array<Record<string, unknown>>).map((row) => this.mapRow(row));
    return { orders, total };
  }

  async getById(orderId: number): Promise<OrderRecord | null> {
    const rows = await this.sql`
      SELECT
        o."orderId",
        o."clientId",
        COALESCE(c.name, NULL) AS "clientName",
        o."orderNumber",
        CASE
          WHEN (normalize_jsonb(o.raw))->>'externallyFulfilled' = '1' THEN 'shipped'
          WHEN ship.label_shipmentId IS NOT NULL THEN 'shipped'
          ELSE o."orderStatus"
        END AS "orderStatus",
        o."orderDate",
        o."storeId",
        o."customerEmail",
        o."shipToName",
        o."shipToCity",
        o."shipToState",
        o."shipToPostalCode",
        o."carrierCode",
        o."serviceCode",
        o."weightValue",
        o."orderTotal",
        o."shippingAmount",
        CASE
          WHEN ol.residential IS NULL THEN NULL
          WHEN ol.residential = 1 THEN 1
          ELSE 0
        END AS residential,
        CASE
          WHEN (normalize_jsonb(o.raw))->'shipTo'->>'residential' IS NULL THEN NULL
          WHEN (normalize_jsonb(o.raw))->'shipTo'->>'residential' = '1' THEN 1
          WHEN (normalize_jsonb(o.raw))->'shipTo'->'residential' = 'true'::jsonb THEN 1
          ELSE 0
        END AS source_residential,
        COALESCE(ol.external_shipped, 0) AS external_shipped,
        COALESCE(o.externally_fulfilled_verified, 0) AS externally_fulfilled_verified,
        ol.best_rate_json,
        COALESCE(ship.selected_rate_json, CASE
          WHEN ship.label_shipmentId IS NOT NULL THEN jsonb_build_object(
            'cost', ship.label_raw_cost,
            'shippingProviderId', ship.label_provider,
            'serviceCode', ship.label_service,
            'serviceName', COALESCE(ship.label_service, ship.label_carrier),
            'carrierCode', ship.label_carrier
          )::text
          ELSE NULL
        END) AS selected_rate_json,
        ship.label_shipmentId AS "labelShipmentId",
        ship.label_tracking,
        ship.label_carrier,
        ship.label_service,
        ship.label_provider,
        ship.label_cost,
        ship.label_raw_cost,
        ship.label_shipDate AS "label_shipDate",
        ship.label_created_at,
        o.raw,
        COALESCE(o.items, '[]') AS items,
        ol.rate_dims_l,
        ol.rate_dims_w,
        ol.rate_dims_h
      FROM orders o
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      LEFT JOIN clients c ON c."clientId" = o."clientId"
      LEFT JOIN (
        SELECT DISTINCT ON (s2."orderId")
          s2."orderId",
          s2."shipmentId" AS label_shipmentId,
          (s2."shipmentCost" + COALESCE(s2."otherCost", 0)) AS label_cost,
          s2."shipmentCost" AS label_raw_cost,
          s2."carrierCode" AS label_carrier,
          s2."serviceCode" AS label_service,
          s2."trackingNumber" AS label_tracking,
          s2."shipDate" AS label_shipDate,
          s2."providerAccountId" AS label_provider,
          s2.label_created_at,
          s2."labelUrl" AS label_url,
          s2.selected_rate_json
        FROM shipments s2
        WHERE s2.voided = 0
        ORDER BY s2."orderId", s2."shipmentId" DESC
      ) ship ON ship."orderId" = o."orderId"
      WHERE o."orderId" = ${orderId}
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findIdsBySku(query: GetOrderIdsQuery): Promise<number[]> {
    const excludedJson = this.sql.json(this.excludedStoreIds);

    const rows = await this.sql`
      SELECT o."orderId"
      FROM orders o
      WHERE
        (${query.orderStatus ?? null}::text IS NULL OR o."orderStatus" = ${query.orderStatus ?? null})
        AND (${query.storeId ?? null}::int IS NULL OR o."storeId" = ${query.storeId ?? null})
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(normalize_jsonb(o.items)) AS je(value)
          WHERE (je.value->>'adjustment')::text != '1'
            AND (
              LOWER(COALESCE(je.value->>'sku', '')) = LOWER(${query.sku})
              OR LOWER(COALESCE(je.value->>'name', '')) = LOWER(${query.sku})
            )
        )
        AND (${query.qty ?? null}::int IS NULL OR (
          SELECT COALESCE(SUM(COALESCE((je2.value->>'quantity')::int, 1)), 0)
          FROM jsonb_array_elements(normalize_jsonb(o.items)) AS je2(value)
          WHERE (je2.value->>'adjustment')::text != '1'
        ) = ${query.qty ?? null})
      ORDER BY o."orderDate" DESC
    `;

    return (rows as Array<{ orderId: number }>).map((row) => Number(row.orderId));
  }

  async getPicklist(query: GetOrderPicklistQuery): Promise<OrderPicklistItemDto[]> {
    const isAwaitingShipment = query.orderStatus === "awaiting_shipment";
    const excludedJson = this.sql.json(this.excludedStoreIds);

    const rows = await this.sql`
      SELECT
        o."storeId",
        COALESCE(c.name, 'Unknown') AS "clientName",
        je.value->>'sku' AS sku,
        je.value->>'name' AS name,
        je.value->>'imageUrl' AS "imageUrl",
        SUM(CAST(je.value->>'quantity' AS INTEGER)) AS "totalQty",
        COUNT(DISTINCT o."orderId") AS "orderCount"
      FROM orders o
      LEFT JOIN order_local ol ON o."orderId" = ol."orderId"
      LEFT JOIN clients c ON EXISTS (
        SELECT 1 FROM jsonb_array_elements(normalize_jsonb(c."storeIds")) si WHERE si::text::integer = o."storeId"
      )
      , jsonb_array_elements(normalize_jsonb(o.items)) AS je(value)
      WHERE
        (${query.orderStatus ?? null}::text IS NULL OR o."orderStatus" = ${query.orderStatus ?? null})
        AND (${query.storeId ?? null}::int IS NULL OR o."storeId" = ${query.storeId ?? null})
        AND (${query.dateStart ?? null}::text IS NULL OR o."orderDate" >= ${query.dateStart ?? null})
        AND (${query.dateEnd ?? null}::text IS NULL OR o."orderDate" <= ${query.dateEnd ?? null})
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
        AND (NOT ${isAwaitingShipment} OR (
          COALESCE(ol.external_shipped, 0) = 0
          AND COALESCE((normalize_jsonb(o.raw))->>'externallyFulfilled', '0') != '1'
        ))
        AND (je.value->>'adjustment')::text = '0'
        AND je.value->>'sku' IS NOT NULL
        AND je.value->>'sku' != ''
      GROUP BY o."storeId", je.value->>'sku', je.value->>'name', je.value->>'imageUrl', c.name
      ORDER BY "clientName" ASC, "totalQty" DESC
    `;

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      storeId: row.storeId == null ? null : Number(row.storeId),
      clientName: String(row.clientName ?? "Unknown"),
      sku: String(row.sku),
      name: row.name == null ? null : String(row.name),
      imageUrl: row.imageUrl == null ? null : String(row.imageUrl),
      totalQty: Number(row.totalQty ?? 0),
      orderCount: Number(row.orderCount ?? 0),
    }));
  }

  async getFullById(orderId: number): Promise<OrderFullDto | null> {
    const orderRows = await this.sql`SELECT raw FROM orders WHERE "orderId" = ${orderId}`;
    if (!orderRows[0]) return null;

    const shipments = await this.sql`
      SELECT * FROM shipments WHERE "orderId" = ${orderId} AND voided = 0 ORDER BY "shipDate" DESC
    `;
    const localRows = await this.sql`SELECT * FROM order_local WHERE "orderId" = ${orderId}`;
    const raw = JSON.parse((orderRows[0] as { raw: string }).raw) as Record<string, unknown>;
    if (Array.isArray(shipments) && shipments.length > 0) {
      raw.orderStatus = "shipped";
    }

    return {
      raw,
      shipments: shipments as unknown[],
      local: (localRows[0] as Record<string, unknown>) ?? null,
    };
  }

  async updateExternalShipped(orderId: number, externalShipped: boolean, source: string | null = null): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO order_local ("orderId", external_shipped, external_shipped_source, "updatedAt")
      VALUES (${orderId}, ${externalShipped ? 1 : 0}, ${source}, ${now})
      ON CONFLICT("orderId") DO UPDATE SET
        external_shipped = ${externalShipped ? 1 : 0},
        external_shipped_source = ${source},
        "updatedAt" = ${now}
    `;

    if (externalShipped) {
      await this.sql`UPDATE shipments SET source = 'external' WHERE "orderId" = ${orderId} AND voided = 0`;
    } else {
      await this.sql`UPDATE shipments SET source = 'prepship' WHERE "orderId" = ${orderId} AND voided = 0 AND source = 'external'`;
    }
  }

  async updateResidential(orderId: number, residential: boolean | null): Promise<void> {
    const now = Date.now();
    const value = residential == null ? null : residential ? 1 : 0;
    await this.sql`
      INSERT INTO order_local ("orderId", residential, "updatedAt")
      VALUES (${orderId}, ${value}, ${now})
      ON CONFLICT("orderId") DO UPDATE SET
        residential = ${value},
        "updatedAt" = ${now}
    `;
  }

  async updateSelectedPid(orderId: number, selectedPid: number | null): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO order_local ("orderId", selected_pid, "updatedAt")
      VALUES (${orderId}, ${selectedPid}, ${now})
      ON CONFLICT("orderId") DO UPDATE SET
        selected_pid = ${selectedPid},
        "updatedAt" = ${now}
    `;
  }

  async updateBestRate(orderId: number, bestRate: OrderBestRateDto, bestRateDims: string | null): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO order_local ("orderId", best_rate_json, best_rate_at, best_rate_dims, "updatedAt")
      VALUES (${orderId}, ${JSON.stringify(bestRate)}, ${now}, ${bestRateDims}, ${now})
      ON CONFLICT("orderId") DO UPDATE SET
        best_rate_json = EXCLUDED.best_rate_json,
        best_rate_at = EXCLUDED.best_rate_at,
        best_rate_dims = EXCLUDED.best_rate_dims,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async updateOrderRateDims(orderId: number, length: number, width: number, height: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO order_local ("orderId", rate_dims_l, rate_dims_w, rate_dims_h, "updatedAt")
      VALUES (${orderId}, ${length}, ${width}, ${height}, ${now})
      ON CONFLICT("orderId") DO UPDATE SET
        rate_dims_l = EXCLUDED.rate_dims_l,
        rate_dims_w = EXCLUDED.rate_dims_w,
        rate_dims_h = EXCLUDED.rate_dims_h,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async getSkuQtyDims(sku: string, qty: number): Promise<{ length: number; width: number; height: number } | null> {
    const rows = await this.sql`
      SELECT length, width, height FROM sku_qty_dims WHERE sku = ${sku} AND qty = ${qty}
    `;
    const row = rows[0] as { length: number; width: number; height: number } | undefined;
    if (!row || !row.length || !row.width || !row.height) return null;
    return { length: Number(row.length), width: Number(row.width), height: Number(row.height) };
  }

  async saveSkuQtyDims(sku: string, qty: number, length: number, width: number, height: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO sku_qty_dims (sku, qty, length, width, height, "updatedAt")
      VALUES (${sku}, ${qty}, ${length}, ${width}, ${height}, ${now})
      ON CONFLICT(sku, qty) DO UPDATE SET
        length = EXCLUDED.length,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async getDailyStats(): Promise<OrdersDailyStatsDto> {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const today6pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const isPm = now >= today6pm;
    const dow = now.getDay();

    let windowStart: Date;
    let windowEnd: Date;

    if (dow === 6) {
      windowStart = new Date(todayNoon.getTime() - dayMs);
      windowEnd = new Date(todayNoon.getTime() + (2 * dayMs));
    } else if (dow === 0) {
      windowStart = new Date(todayNoon.getTime() - (2 * dayMs));
      windowEnd = new Date(todayNoon.getTime() + dayMs);
    } else if (dow === 1) {
      if (isPm) {
        windowStart = todayNoon;
        windowEnd = new Date(todayNoon.getTime() + dayMs);
      } else {
        windowStart = new Date(todayNoon.getTime() - (3 * dayMs));
        windowEnd = todayNoon;
      }
    } else if (dow === 5) {
      if (isPm) {
        windowStart = todayNoon;
        windowEnd = new Date(todayNoon.getTime() + (3 * dayMs));
      } else {
        windowStart = new Date(todayNoon.getTime() - dayMs);
        windowEnd = todayNoon;
      }
    } else if (isPm) {
      windowStart = todayNoon;
      windowEnd = new Date(todayNoon.getTime() + dayMs);
    } else {
      windowStart = new Date(todayNoon.getTime() - dayMs);
      windowEnd = todayNoon;
    }

    const fromStr = this.localIso(windowStart);
    const toStr = this.localIso(windowEnd);
    const excludedJson = this.sql.json(this.excludedStoreIds);

    const totalOrdersRows = await this.sql`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE "orderDate" >= ${fromStr} AND "orderDate" <= ${toStr}
        AND "orderStatus" NOT IN ('cancelled')
        AND ("storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
    `;

    const needToShipRows = await this.sql`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE "orderDate" >= ${fromStr} AND "orderDate" <= ${toStr}
        AND "orderStatus" = 'awaiting_shipment'
        AND ("storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
    `;

    const upcomingOrdersRows = await this.sql`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE "orderDate" > ${toStr}
        AND "orderStatus" NOT IN ('cancelled')
        AND ("storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
    `;

    return {
      window: {
        from: fromStr,
        to: toStr,
        fromLabel: this.formatPt(windowStart),
        toLabel: this.formatPt(windowEnd),
      },
      totalOrders: Number((totalOrdersRows[0] as { cnt: number }).cnt ?? 0),
      needToShip: Number((needToShipRows[0] as { cnt: number }).cnt ?? 0),
      upcomingOrders: Number((upcomingOrdersRows[0] as { cnt: number }).cnt ?? 0),
    };
  }

  async exportOrders(query: OrderExportQuery): Promise<OrderExportRow[]> {
    const excludedJson = this.sql.json(this.excludedStoreIds);
    const isAwaitingShipment = query.orderStatus === "awaiting_shipment";

    const rows = await this.sql`
      SELECT o."orderId", o."clientId", o."storeId", o.raw,
             COALESCE(ol.external_shipped, 0) AS external_shipped,
             ol.best_rate_json,
             ship.label_shipmentId, ship.label_cost, ship.label_raw_cost,
             ship.label_carrier, ship.label_service,
             ship.label_tracking, ship.label_shipDate AS "label_shipDate", ship.label_created_at,
             ship.selected_rate_json
      FROM orders o
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      LEFT JOIN (
        SELECT DISTINCT ON (s2."orderId")
          s2."orderId",
          s2."shipmentId" AS label_shipmentId,
          s2."shipmentCost" + COALESCE(s2."otherCost", 0) AS label_cost,
          s2."shipmentCost" AS label_raw_cost,
          s2."carrierCode" AS label_carrier,
          s2."serviceCode" AS label_service,
          s2."trackingNumber" AS label_tracking,
          s2."shipDate" AS label_shipDate,
          s2."providerAccountId" AS label_provider,
          s2.label_created_at,
          s2.selected_rate_json
        FROM shipments s2
        WHERE s2.voided = 0
        ORDER BY s2."orderId", s2."shipmentId" DESC
      ) ship ON ship."orderId" = o."orderId"
      WHERE o.raw IS NOT NULL
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
        AND (${isAwaitingShipment} OR (
          o."orderStatus" = 'shipped' OR (o."orderStatus" = 'awaiting_shipment' AND ship.label_cost IS NOT NULL)
        ))
        AND (NOT ${isAwaitingShipment} OR (
          COALESCE(ol.external_shipped, 0) = 0
          AND COALESCE((normalize_jsonb(o.raw))->>'externallyFulfilled', '0') != '1'
          AND ship.label_cost IS NULL
        ))
      ORDER BY o."orderDate" DESC
      LIMIT ${query.pageSize}
    `;

    return rows as OrderExportRow[];
  }

  async getStoreCounts(orderStatus: string, dateStart?: string, dateEnd?: string): Promise<Array<{ storeId: number; count: number }>> {
    const excludedJson = this.sql.json(this.excludedStoreIds);
    const rows = await this.sql`
      SELECT o."storeId" AS "storeId", COUNT(*)::int AS count
      FROM orders o
      WHERE o."orderStatus" = ${orderStatus}
        AND (${dateStart ?? null}::text IS NULL OR o."orderDate" >= ${dateStart ?? null})
        AND (${dateEnd ?? null}::text IS NULL OR o."orderDate" <= ${dateEnd ?? null})
        AND (o."storeId"::text NOT IN (SELECT jsonb_array_elements_text(${excludedJson})))
      GROUP BY o."storeId"
    `;
    return (rows as unknown as Array<{ storeId: number | string; count: number | string }>).map((r) => ({
      storeId: Number(r.storeId),
      count: Number(r.count),
    }));
  }

  private mapRow(row: Record<string, unknown>): OrderRecord {
    return {
      orderId: Number(row.orderId),
      clientId: row.clientId == null ? null : Number(row.clientId),
      clientName: row.clientName == null ? null : String(row.clientName),
      orderNumber: row.orderNumber == null ? null : String(row.orderNumber),
      orderStatus: String(row.orderStatus),
      orderDate: row.orderDate == null ? null : String(row.orderDate),
      storeId: row.storeId == null ? null : Number(row.storeId),
      customerEmail: row.customerEmail == null ? null : String(row.customerEmail),
      shipToName: row.shipToName == null ? null : String(row.shipToName),
      shipToCity: row.shipToCity == null ? null : String(row.shipToCity),
      shipToState: row.shipToState == null ? null : String(row.shipToState),
      shipToPostalCode: row.shipToPostalCode == null ? null : String(row.shipToPostalCode),
      carrierCode: row.carrierCode == null ? null : String(row.carrierCode),
      serviceCode: row.serviceCode == null ? null : String(row.serviceCode),
      weightValue: row.weightValue == null ? null : Number(row.weightValue),
      orderTotal: row.orderTotal == null ? null : Number(row.orderTotal),
      shippingAmount: row.shippingAmount == null ? null : Number(row.shippingAmount),
      residential: row.residential == null ? null : Number(row.residential) === 1,
      sourceResidential: row.source_residential == null ? null : Number(row.source_residential) === 1,
      externalShipped: Number(row.external_shipped ?? 0) === 1,
      externallyFulfilledVerified: Number(row.externally_fulfilled_verified ?? 0) === 1,
      bestRateJson: row.best_rate_json == null ? null : String(row.best_rate_json),
      selectedRateJson: row.selected_rate_json == null ? null : String(row.selected_rate_json),
      labelShipmentId: row.labelShipmentId == null ? null : Number(row.labelShipmentId),
      labelTracking: row.label_tracking == null ? null : String(row.label_tracking),
      labelCarrier: row.label_carrier == null ? null : String(row.label_carrier),
      labelService: row.label_service == null ? null : String(row.label_service),
      labelProvider: row.label_provider == null ? null : Number(row.label_provider),
      labelProviderNickname: row.label_provider_nickname == null ? null : String(row.label_provider_nickname),
      labelCost: row.label_cost == null ? null : Number(row.label_cost),
      labelRawCost: row.label_raw_cost == null ? null : Number(row.label_raw_cost),
      labelShipDate: row.label_shipDate == null ? null : String(row.label_shipDate),
      labelCreatedAt: row.label_created_at == null ? null : Number(row.label_created_at),
      labelUrl: row.label_url == null ? null : String(row.label_url),
      raw: String(row.raw ?? "{}"),
      items: String(row.items ?? "[]"),
      rateDimsL: row.rate_dims_l == null ? null : Number(row.rate_dims_l),
      rateDimsW: row.rate_dims_w == null ? null : Number(row.rate_dims_w),
      rateDimsH: row.rate_dims_h == null ? null : Number(row.rate_dims_h),
    };
  }

  private localIso(value: Date): string {
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }

  private formatPt(value: Date): string {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const hours = value.getHours() % 12 || 12;
    const suffix = value.getHours() >= 12 ? "pm" : "am";
    return `${months[value.getMonth()]} ${value.getDate()}, ${hours}${suffix} PT`;
  }
}
