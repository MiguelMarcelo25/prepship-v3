import type { DatabaseSync } from "node:sqlite";
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
} from "../../../../../../packages/contracts/src/orders/contracts.ts";
import type { OrderRepository, OrderListResult } from "../application/order-repository.ts";
import type { OrderRecord } from "../domain/order.ts";

export class SqliteOrderRepository implements OrderRepository {
  private readonly db: DatabaseSync;
  private readonly excludedStoreIds: number[];

  constructor(db: DatabaseSync, excludedStoreIds: number[] = []) {
    this.db = db;
    this.excludedStoreIds = excludedStoreIds;
  }

  async list(query: ListOrdersQuery): Promise<OrderListResult> {
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(500, query.pageSize));
    const offset = (page - 1) * pageSize;

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.orderStatus) {
      clauses.push("o.orderStatus = ?");
      params.push(query.orderStatus);
    }

    if (query.storeId != null) {
      clauses.push("o.storeId = ?");
      params.push(query.storeId);
    }


    if (query.clientId != null) {
      clauses.push("o.clientId = ?");
      params.push(query.clientId);
    }
    if (query.dateStart) {
      clauses.push("o.orderDate >= ?");
      params.push(query.dateStart);
    }

    if (query.dateEnd) {
      clauses.push("o.orderDate <= ?");
      params.push(query.dateEnd);
    }

    if (this.excludedStoreIds.length > 0) {
      clauses.push(`o.storeId NOT IN (${this.excludedStoreIds.map(() => "?").join(", ")})`);
      params.push(...this.excludedStoreIds);
    }

    if (query.search) {
      // Search by orderNumber, customerEmail, shipToName
      // Note: trackingNumber search requires separate subquery to avoid LEFT JOIN NULL issues
      clauses.push(`(
        o.orderNumber LIKE ? OR
        o.customerEmail LIKE ? OR
        o.shipToName LIKE ?
      )`);
      const searchTerm = `%${query.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (query.orderStatus === "awaiting_shipment") {
      clauses.push("COALESCE(ol.external_shipped, 0) = 0");
      clauses.push("COALESCE(json_extract(o.raw, '$.externallyFulfilled'), 0) != 1");
      clauses.push("ship.label_cost IS NULL");
    } else if (query.orderStatus === "shipped") {
      clauses.push("(o.orderStatus = 'shipped' OR (o.orderStatus = 'awaiting_shipment' AND ship.label_cost IS NOT NULL))");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const shipmentJoin = `
      LEFT JOIN (
        WITH latest_ship AS (
          SELECT orderId, MAX(shipmentId) AS shipmentId
          FROM shipments
          WHERE voided = 0
          GROUP BY orderId
        )
        SELECT
          s.orderId,
          s.shipmentId AS label_shipmentId,
          (s.shipmentCost + COALESCE(s.otherCost, 0)) AS label_cost,
          s.shipmentCost AS label_raw_cost,
          s.carrierCode AS label_carrier,
          s.serviceCode AS label_service,
          s.trackingNumber AS label_tracking,
          s.shipDate AS label_shipDate,
          s.providerAccountId AS label_provider,
          s.provider_account_nickname AS label_provider_nickname,
          s.label_created_at,
          s.labelUrl AS label_url,
          s.selected_rate_json
        FROM latest_ship ls
        JOIN shipments s ON s.shipmentId = ls.shipmentId
      ) ship ON ship.orderId = o.orderId
    `;

    const fromClause = `
      FROM orders o
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      ${shipmentJoin}
    `;

    const countStatement = this.db.prepare(`
      SELECT COUNT(*) AS total
      ${fromClause}
      ${where}
    `);
    const total = Number((countStatement.get(...params) as { total: number }).total ?? 0);

    const dataStatement = this.db.prepare(`
      SELECT
        o.orderId,
        o.clientId,
        COALESCE(c.name, NULL) AS clientName,
        o.orderNumber,
        o.orderStatus,
        o.orderDate,
        o.storeId,
        o.customerEmail,
        o.shipToName,
        o.shipToCity,
        o.shipToState,
        o.shipToPostalCode,
        o.carrierCode,
        o.serviceCode,
        o.weightValue,
        o.orderTotal,
        o.shippingAmount,
        CASE
          WHEN ol.residential IS NULL THEN NULL
          WHEN ol.residential = 1 THEN 1
          ELSE 0
        END AS residential,
        CASE
          WHEN json_extract(o.raw, '$.shipTo.residential') IS NULL THEN NULL
          WHEN json_extract(o.raw, '$.shipTo.residential') = 1 THEN 1
          ELSE 0
        END AS source_residential,
        COALESCE(ol.external_shipped, 0) AS external_shipped,
        COALESCE(o.externally_fulfilled_verified, 0) AS externally_fulfilled_verified,
        ol.best_rate_json,
        ship.selected_rate_json,
        ship.label_shipmentId,
        ship.label_tracking,
        ship.label_carrier,
        ship.label_service,
        ship.label_provider,
        ship.label_cost,
        ship.label_raw_cost,
        ship.label_shipDate,
        ship.label_created_at,
        ship.label_url,
        o.raw,
        COALESCE(o.items, '[]') AS items
      ${fromClause}
      LEFT JOIN clients c ON c.clientId = o.clientId
      ${where}
      ORDER BY o.orderDate DESC
      LIMIT ? OFFSET ?
    `);

    const rows = dataStatement.all(...params, pageSize, offset) as Array<Record<string, unknown>>;
    const orders = rows.map((row) => this.mapRow(row));

    return { orders, total };
  }

  async getById(orderId: number): Promise<OrderRecord | null> {
    const statement = this.db.prepare(`
      SELECT
        o.orderId,
        o.clientId,
        COALESCE(c.name, NULL) AS clientName,
        o.orderNumber,
        CASE
          WHEN json_extract(o.raw, '$.externallyFulfilled') = 1 THEN 'shipped'
          WHEN ship.label_shipmentId IS NOT NULL THEN 'shipped'
          ELSE o.orderStatus
        END AS orderStatus,
        o.orderDate,
        o.storeId,
        o.customerEmail,
        o.shipToName,
        o.shipToCity,
        o.shipToState,
        o.shipToPostalCode,
        o.carrierCode,
        o.serviceCode,
        o.weightValue,
        o.orderTotal,
        o.shippingAmount,
        CASE
          WHEN ol.residential IS NULL THEN NULL
          WHEN ol.residential = 1 THEN 1
          ELSE 0
        END AS residential,
        CASE
          WHEN json_extract(o.raw, '$.shipTo.residential') IS NULL THEN NULL
          WHEN json_extract(o.raw, '$.shipTo.residential') = 1 THEN 1
          ELSE 0
        END AS source_residential,
        COALESCE(ol.external_shipped, 0) AS external_shipped,
        COALESCE(o.externally_fulfilled_verified, 0) AS externally_fulfilled_verified,
        ol.best_rate_json,
        COALESCE(ship.selected_rate_json, CASE
          WHEN ship.label_shipmentId IS NOT NULL THEN json_object(
            'cost', ship.label_raw_cost,
            'shippingProviderId', ship.label_provider,
            'serviceCode', ship.label_service,
            'serviceName', COALESCE(ship.label_service, ship.label_carrier),
            'carrierCode', ship.label_carrier
          )
          ELSE NULL
        END) AS selected_rate_json,
        ship.label_shipmentId,
        ship.label_tracking,
        ship.label_carrier,
        ship.label_service,
        ship.label_provider,
        ship.label_cost,
        ship.label_raw_cost,
        ship.label_shipDate,
        ship.label_created_at,
        o.raw,
        COALESCE(o.items, '[]') AS items,
        ol.rate_dims_l,
        ol.rate_dims_w,
        ol.rate_dims_h
      FROM orders o
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      LEFT JOIN clients c ON c.clientId = o.clientId
      LEFT JOIN (
        WITH latest_ship AS (
          SELECT orderId, MAX(shipmentId) AS shipmentId
          FROM shipments
          WHERE voided = 0
          GROUP BY orderId
        )
        SELECT
          s.orderId,
          s.shipmentId AS label_shipmentId,
          (s.shipmentCost + COALESCE(s.otherCost, 0)) AS label_cost,
          s.shipmentCost AS label_raw_cost,
          s.carrierCode AS label_carrier,
          s.serviceCode AS label_service,
          s.trackingNumber AS label_tracking,
          s.shipDate AS label_shipDate,
          s.providerAccountId AS label_provider,
          s.label_created_at,
          s.labelUrl AS label_url,
          s.selected_rate_json
        FROM latest_ship ls
        JOIN shipments s ON s.shipmentId = ls.shipmentId
      ) ship ON ship.orderId = o.orderId
      WHERE o.orderId = ?
    `);

    const row = statement.get(orderId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findIdsBySku(query: GetOrderIdsQuery): Promise<number[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.orderStatus) {
      clauses.push("o.orderStatus = ?");
      params.push(query.orderStatus);
    }

    if (query.storeId != null) {
      clauses.push("o.storeId = ?");
      params.push(query.storeId);
    }

    if (this.excludedStoreIds.length > 0) {
      clauses.push(`o.storeId NOT IN (${this.excludedStoreIds.map(() => "?").join(", ")})`);
      params.push(...this.excludedStoreIds);
    }

    clauses.push(`
      EXISTS (
        SELECT 1
        FROM json_each(o.items) je
        WHERE json_extract(je.value, '$.adjustment') != 1
          AND (
            LOWER(COALESCE(json_extract(je.value, '$.sku'), '')) = LOWER(?)
            OR LOWER(COALESCE(json_extract(je.value, '$.name'), '')) = LOWER(?)
          )
      )
    `);
    params.push(query.sku, query.sku);

    if (query.qty != null) {
      clauses.push(`
        (
          SELECT COALESCE(SUM(COALESCE(json_extract(je.value, '$.quantity'), 1)), 0)
          FROM json_each(o.items) je
          WHERE json_extract(je.value, '$.adjustment') != 1
        ) = ?
      `);
      params.push(query.qty);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const statement = this.db.prepare(`
      SELECT o.orderId
      FROM orders o
      ${where}
      ORDER BY o.orderDate DESC
    `);

    return (statement.all(...params) as Array<{ orderId: number }>).map((row) => Number(row.orderId));
  }

  async getPicklist(query: GetOrderPicklistQuery): Promise<OrderPicklistItemDto[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.orderStatus) {
      clauses.push("o.orderStatus = ?");
      params.push(query.orderStatus);
    }

    if (query.storeId != null) {
      clauses.push("o.storeId = ?");
      params.push(query.storeId);
    }

    if (query.dateStart) {
      clauses.push("o.orderDate >= ?");
      params.push(query.dateStart);
    }

    if (query.dateEnd) {
      clauses.push("o.orderDate <= ?");
      params.push(query.dateEnd);
    }

    if (this.excludedStoreIds.length > 0) {
      clauses.push(`o.storeId NOT IN (${this.excludedStoreIds.map(() => "?").join(", ")})`);
      params.push(...this.excludedStoreIds);
    }

    if (query.orderStatus === "awaiting_shipment") {
      clauses.push("COALESCE(ol.external_shipped, 0) = 0");
      clauses.push("COALESCE(json_extract(o.raw, '$.externallyFulfilled'), 0) != 1");
    }

    clauses.push("json_extract(j.value, '$.adjustment') = 0");
    clauses.push("json_extract(j.value, '$.sku') IS NOT NULL");
    clauses.push("json_extract(j.value, '$.sku') != ''");

    const statement = this.db.prepare(`
      SELECT
        o.storeId,
        COALESCE(c.name, 'Unknown') AS clientName,
        json_extract(j.value, '$.sku') AS sku,
        json_extract(j.value, '$.name') AS name,
        json_extract(j.value, '$.imageUrl') AS imageUrl,
        SUM(CAST(json_extract(j.value, '$.quantity') AS INTEGER)) AS totalQty,
        COUNT(DISTINCT o.orderId) AS orderCount
      FROM orders o
      LEFT JOIN order_local ol ON o.orderId = ol.orderId
      LEFT JOIN clients c ON EXISTS (
        SELECT 1 FROM json_each(c.storeIds) si WHERE CAST(si.value AS INTEGER) = o.storeId
      )
      , json_each(o.items) j
      WHERE ${clauses.join(" AND ")}
      GROUP BY o.storeId, json_extract(j.value, '$.sku')
      ORDER BY clientName ASC, totalQty DESC
    `);

    return (statement.all(...params) as Array<Record<string, unknown>>).map((row) => ({
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
    const orderRow = this.db.prepare("SELECT raw FROM orders WHERE orderId = ?").get(orderId) as { raw: string } | undefined;
    if (!orderRow) return null;

    const shipments = this.db.prepare(
      "SELECT * FROM shipments WHERE orderId = ? AND voided = 0 ORDER BY shipDate DESC"
    ).all(orderId) as unknown[];
    const local = this.db.prepare("SELECT * FROM order_local WHERE orderId = ?").get(orderId) as Record<string, unknown> | undefined;
    const raw = JSON.parse(orderRow.raw) as Record<string, unknown>;
    if (Array.isArray(shipments) && shipments.length > 0) {
      raw.orderStatus = "shipped";
    }

    return {
      raw,
      shipments,
      local: local ?? null,
    };
  }

  async updateExternalShipped(orderId: number, externalShipped: boolean, source: string | null = null): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO order_local (orderId, external_shipped, external_shipped_source, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET external_shipped = ?, external_shipped_source = ?, updatedAt = ?
    `).run(orderId, externalShipped ? 1 : 0, source, now, externalShipped ? 1 : 0, source, now);

    if (externalShipped) {
      this.db.prepare("UPDATE shipments SET source = 'external' WHERE orderId = ? AND voided = 0").run(orderId);
    } else {
      this.db.prepare("UPDATE shipments SET source = 'prepship' WHERE orderId = ? AND voided = 0 AND source = 'external'").run(orderId);
    }
  }

  async updateResidential(orderId: number, residential: boolean | null): Promise<void> {
    const now = Date.now();
    const value = residential == null ? null : residential ? 1 : 0;
    this.db.prepare(`
      INSERT INTO order_local (orderId, residential, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET residential = ?, updatedAt = ?
    `).run(orderId, value, now, value, now);
  }

  async updateSelectedPid(orderId: number, selectedPid: number | null): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO order_local (orderId, selected_pid, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET selected_pid = ?, updatedAt = ?
    `).run(orderId, selectedPid, now, selectedPid, now);
  }

  async updateBestRate(orderId: number, bestRate: OrderBestRateDto, bestRateDims: string | null): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO order_local (orderId, best_rate_json, best_rate_at, best_rate_dims, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        best_rate_json = excluded.best_rate_json,
        best_rate_at = excluded.best_rate_at,
        best_rate_dims = excluded.best_rate_dims,
        updatedAt = excluded.updatedAt
    `).run(orderId, JSON.stringify(bestRate), now, bestRateDims, now);
  }

  async updateOrderRateDims(orderId: number, length: number, width: number, height: number): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO order_local (orderId, rate_dims_l, rate_dims_w, rate_dims_h, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        rate_dims_l = excluded.rate_dims_l,
        rate_dims_w = excluded.rate_dims_w,
        rate_dims_h = excluded.rate_dims_h,
        updatedAt = excluded.updatedAt
    `).run(orderId, length, width, height, now);
  }

  async getSkuQtyDims(sku: string, qty: number): Promise<{ length: number; width: number; height: number } | null> {
    if (!this.hasTable("sku_qty_dims")) return null;
    const row = this.db.prepare(`
      SELECT length, width, height FROM sku_qty_dims WHERE sku = ? AND qty = ?
    `).get(sku, qty) as { length: number; width: number; height: number } | undefined;
    if (!row || !row.length || !row.width || !row.height) return null;
    return { length: Number(row.length), width: Number(row.width), height: Number(row.height) };
  }

  async saveSkuQtyDims(sku: string, qty: number, length: number, width: number, height: number): Promise<void> {
    const now = Date.now();
    if (!this.hasTable("sku_qty_dims")) {
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS sku_qty_dims (
          sku       TEXT NOT NULL,
          qty       INTEGER NOT NULL,
          length    REAL NOT NULL,
          width     REAL NOT NULL,
          height    REAL NOT NULL,
          updatedAt INTEGER NOT NULL,
          PRIMARY KEY (sku, qty)
        )
      `).run();
    }
    this.db.prepare(`
      INSERT INTO sku_qty_dims (sku, qty, length, width, height, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku, qty) DO UPDATE SET
        length = excluded.length,
        width = excluded.width,
        height = excluded.height,
        updatedAt = excluded.updatedAt
    `).run(sku, qty, length, width, height, now);
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name) as { name?: string } | undefined;
    return row?.name === name;
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
    const exclusion = this.excludedStoreIds.length > 0
      ? `AND storeId NOT IN (${this.excludedStoreIds.map(() => "?").join(", ")})`
      : "";
    const excludedArgs = this.excludedStoreIds;

    const totalOrders = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE orderDate >= ? AND orderDate <= ?
        AND orderStatus NOT IN ('cancelled')
        ${exclusion}
    `).get(fromStr, toStr, ...excludedArgs) as { cnt: number };

    const needToShip = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE orderDate >= ? AND orderDate <= ?
        AND orderStatus = 'awaiting_shipment'
        ${exclusion}
    `).get(fromStr, toStr, ...excludedArgs) as { cnt: number };

    const upcomingOrders = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE orderDate > ?
        AND orderStatus NOT IN ('cancelled')
        ${exclusion}
    `).get(toStr, ...excludedArgs) as { cnt: number };

    return {
      window: {
        from: fromStr,
        to: toStr,
        fromLabel: this.formatPt(windowStart),
        toLabel: this.formatPt(windowEnd),
      },
      totalOrders: Number(totalOrders.cnt ?? 0),
      needToShip: Number(needToShip.cnt ?? 0),
      upcomingOrders: Number(upcomingOrders.cnt ?? 0),
    };
  }

  async exportOrders(query: OrderExportQuery): Promise<OrderExportRow[]> {
    const clauses: string[] = ["o.raw IS NOT NULL"];
    const params: Array<string | number> = [];

    if (this.excludedStoreIds.length > 0) {
      clauses.push(`o.storeId NOT IN (${this.excludedStoreIds.map(() => "?").join(", ")})`);
      params.push(...this.excludedStoreIds);
    }

    const { orderStatus } = query;
    if (orderStatus === "awaiting_shipment") {
      clauses.push("COALESCE(ol.external_shipped, 0) = 0");
      clauses.push("COALESCE(json_extract(o.raw, '$.externallyFulfilled'), 0) != 1");
      clauses.push("ship.label_cost IS NULL");
    } else {
      // default to shipped view
      clauses.push("(o.orderStatus = 'shipped' OR (o.orderStatus = 'awaiting_shipment' AND ship.label_cost IS NOT NULL))");
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    const shipmentJoin = `
      LEFT JOIN (
        WITH latest_ship AS (
          SELECT orderId, MAX(shipmentId) AS shipmentId
          FROM shipments WHERE voided = 0 GROUP BY orderId
        )
        SELECT s.orderId,
               s.shipmentId          AS label_shipmentId,
               s.shipmentCost + COALESCE(s.otherCost, 0) AS label_cost,
               s.shipmentCost        AS label_raw_cost,
               s.carrierCode         AS label_carrier,
               s.serviceCode         AS label_service,
               s.trackingNumber      AS label_tracking,
               s.shipDate            AS label_shipDate,
               s.providerAccountId   AS label_provider,
               s.label_created_at    AS label_created_at,
               s.selected_rate_json
        FROM latest_ship ls
        JOIN shipments s ON s.shipmentId = ls.shipmentId
      ) ship ON ship.orderId = o.orderId
    `;

    const stmt = this.db.prepare(`
      SELECT o.orderId, o.clientId, o.storeId, o.raw,
             COALESCE(ol.external_shipped, 0) AS external_shipped,
             ol.best_rate_json,
             ship.label_shipmentId, ship.label_cost, ship.label_raw_cost,
             ship.label_carrier, ship.label_service,
             ship.label_tracking, ship.label_shipDate, ship.label_created_at,
             ship.selected_rate_json
      FROM orders o
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      ${shipmentJoin}
      ${where}
      ORDER BY o.orderDate DESC
      LIMIT ?
    `);

    return stmt.all(...params, query.pageSize) as OrderExportRow[];
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
