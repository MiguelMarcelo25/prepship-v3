import type { DatabaseSync } from "node:sqlite";
import type {
  AdjustInventoryInput,
  BulkUpdateInventoryDimensionsInput,
  ListInventoryLedgerQuery,
  ListInventoryQuery,
  ParentSkuDetailDto,
  ParentSkuDto,
  ReceiveInventoryInput,
  ReceiveInventoryResultDto,
  SaveParentSkuInput,
  SetInventoryParentInput,
  UpdateInventoryItemInput,
} from "../../../../../../packages/contracts/src/inventory/contracts.js";
import type { InventoryRepository } from "../application/inventory-repository.js";
import type { InventoryAlertRecord, InventoryRecord } from "../domain/inventory.js";

interface InventoryIdRow {
  id: number;
}

export class SqliteInventoryRepository implements InventoryRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(query: ListInventoryQuery): Promise<InventoryRecord[]> {
    const where = ["s.active = 1"];
    const params: Array<string | number> = [];
    if (query.clientId != null) {
      where.push("s.clientId = ?");
      params.push(query.clientId);
    }
    if (query.sku) {
      where.push("s.sku LIKE ?");
      params.push(`%${query.sku}%`);
    }

    const rows = this.db.prepare(`
      SELECT
        s.id, s.clientId, s.sku, s.name, s.minStock, s.active,
        s.weightOz, s.parentSkuId, COALESCE(s.baseUnitQty, 1) AS baseUnitQty,
        COALESCE(s.length, 0) AS packageLength, COALESCE(s.width, 0) AS packageWidth, COALESCE(s.height, 0) AS packageHeight,
        COALESCE(s.productLength, 0) AS productLength, COALESCE(s.productWidth, 0) AS productWidth, COALESCE(s.productHeight, 0) AS productHeight,
        s.packageId, COALESCE(s.units_per_pack, 1) AS unitsPerPack, s.cuFtOverride,
        c.name AS clientName,
        p.name AS packageName,
        p.length AS packageDimLength, p.width AS packageDimWidth, p.height AS packageDimHeight,
        ps.name AS parentName,
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0) AS currentStock,
        (SELECT MAX(createdAt) FROM inventory_ledger WHERE invSkuId = s.id) AS lastMovement,
        (
          SELECT json_extract(j.value, '$.imageUrl')
          FROM orders ord, json_each(ord.items) j
          WHERE json_extract(j.value, '$.sku') = s.sku
            AND json_extract(j.value, '$.imageUrl') IS NOT NULL
            AND json_extract(j.value, '$.imageUrl') != ''
          ORDER BY ord.orderDate DESC
          LIMIT 1
        ) AS imageUrl
      FROM inventory_skus s
      JOIN clients c ON s.clientId = c.clientId
      LEFT JOIN packages p ON p.packageId = s.packageId
      LEFT JOIN parent_skus ps ON ps.parentSkuId = s.parentSkuId
      WHERE ${where.join(" AND ")}
      ORDER BY c.name ASC, COALESCE(ps.name, ''), s.sku ASC
    `).all(...params) as InventoryRecord[];

    return rows;
  }

  async receive(input: ReceiveInventoryInput): Promise<ReceiveInventoryResultDto[]> {
    const receivedAt = this.parseTimestamp(input.receivedAt);
    const results: ReceiveInventoryResultDto[] = [];
    try {
      this.db.exec("BEGIN");
      for (const item of input.items) {
        if (!item.sku || !item.qty || item.qty <= 0) continue;
        const invSkuId = this.ensureInventorySku(input.clientId, item.sku, item.name ?? "");
        const skuData = this.db.prepare("SELECT COALESCE(baseUnitQty, 1) AS baseUnitQty FROM inventory_skus WHERE id = ?").get(invSkuId) as { baseUnitQty?: number } | undefined;
        const baseUnitQty = Number(skuData?.baseUnitQty ?? 1);
        const actualQtyToStore = Number(item.qty) * baseUnitQty;
        this.db.prepare(`
          INSERT INTO inventory_ledger (invSkuId, type, qty, note, createdBy, createdAt)
          VALUES (?, 'receive', ?, ?, 'manual', ?)
        `).run(invSkuId, actualQtyToStore, input.note || `Received ${item.qty} units (${actualQtyToStore} base units)`, receivedAt);
        results.push({
          sku: item.sku,
          qty: Number(item.qty),
          baseUnitQty,
          baseUnits: actualQtyToStore,
          invSkuId,
          newStock: this.getCurrentStock(invSkuId),
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return results;
  }

  async adjust(input: AdjustInventoryInput): Promise<number> {
    const validTypes = new Set(["adjust", "receive", "return", "damage"]);
    const type = validTypes.has(String(input.type ?? "adjust")) ? String(input.type ?? "adjust") : "adjust";
    const note = input.note || (Number(input.qty) > 0 ? `Manual ${type}` : "Manual remove");
    this.db.prepare(`
      INSERT INTO inventory_ledger (invSkuId, type, qty, note, createdBy, createdAt)
      VALUES (?, ?, ?, ?, 'manual', ?)
    `).run(input.invSkuId, type, input.qty, note, this.parseTimestamp(input.adjustedAt));
    return this.getCurrentStock(input.invSkuId);
  }

  async update(inventoryId: number, input: UpdateInventoryItemInput): Promise<void> {
    this.db.prepare(`
      UPDATE inventory_skus
      SET name = ?, minStock = ?, weightOz = ?,
          length = ?, width = ?, height = ?,
          productLength = ?, productWidth = ?, productHeight = ?,
          packageId = ?, units_per_pack = ?, cuFtOverride = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      input.name ?? "",
      input.minStock ?? 0,
      input.weightOz ?? 0,
      input.length ?? 0,
      input.width ?? 0,
      input.height ?? 0,
      input.productLength ?? 0,
      input.productWidth ?? 0,
      input.productHeight ?? 0,
      input.packageId ?? null,
      input.units_per_pack ?? 1,
      input.cuFtOverride ?? null,
      Date.now(),
      inventoryId,
    );
  }

  async listLedger(query: ListInventoryLedgerQuery): Promise<Record<string, unknown>[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.clientId != null) {
      where.push("s.clientId = ?");
      params.push(query.clientId);
    }
    if (query.type) {
      where.push("l.type = ?");
      params.push(query.type);
    }
    if (query.dateStart != null) {
      where.push("l.createdAt >= ?");
      params.push(query.dateStart);
    }
    if (query.dateEnd != null) {
      where.push("l.createdAt <= ?");
      params.push(query.dateEnd);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT
        l.id, l.invSkuId, l.type, l.qty, l.orderId, l.note, l.createdBy, l.createdAt,
        s.sku, s.name AS skuName, s.clientId,
        c.name AS clientName
      FROM inventory_ledger l
      JOIN inventory_skus s ON s.id = l.invSkuId
      JOIN clients c ON c.clientId = s.clientId
      ${whereClause}
      ORDER BY l.createdAt DESC
      LIMIT ?
    `).all(...params, query.limit) as Record<string, unknown>[];
  }

  async getLedgerByInventoryId(inventoryId: number): Promise<Record<string, unknown>[]> {
    return this.db.prepare(`
      SELECT
        l.id, l.invSkuId, l.type, l.qty, l.orderId, l.note, l.createdBy, l.createdAt,
        s.sku, s.name AS skuName, s.clientId,
        c.name AS clientName
      FROM inventory_ledger l
      JOIN inventory_skus s ON s.id = l.invSkuId
      JOIN clients c ON c.clientId = s.clientId
      WHERE l.invSkuId = ?
      ORDER BY l.createdAt DESC
      LIMIT 500
    `).all(inventoryId) as Record<string, unknown>[];
  }

  async listAlerts(clientId: number): Promise<InventoryAlertRecord[]> {
    const alerts: InventoryAlertRecord[] = [];
    const skuAlerts = this.db.prepare(`
      SELECT
        s.id, s.sku, s.name, s.minStock, s.parentSkuId,
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0) AS currentStock
      FROM inventory_skus s
      WHERE s.clientId = ? AND s.active = 1
        AND COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0) <= s.minStock
      ORDER BY currentStock ASC
    `).all(clientId) as Array<{ id: number; sku: string; name: string; minStock: number; parentSkuId: number | null; currentStock: number }>;

    for (const sku of skuAlerts) {
      alerts.push({
        type: "sku",
        id: sku.id,
        sku: sku.sku,
        name: sku.name,
        stock: Number(sku.currentStock ?? 0),
        minStock: Number(sku.minStock ?? 0),
        parentSkuId: sku.parentSkuId,
      });
    }

    const parentRows = this.db.prepare(`
      SELECT
        p.parentSkuId, p.name,
        (
          SELECT MIN(minStock)
          FROM inventory_skus
          WHERE parentSkuId = p.parentSkuId AND active = 1
        ) AS minStock
      FROM parent_skus p
      WHERE p.clientId = ?
    `).all(clientId) as Array<{ parentSkuId: number; name: string; minStock: number | null }>;

    for (const parent of parentRows) {
      const aggregate = this.getParentAggregateStock(parent.parentSkuId);
      const minStock = Number(parent.minStock ?? 0);
      if (aggregate <= minStock) {
        alerts.push({
          type: "parent",
          id: parent.parentSkuId,
          name: parent.name,
          stock: aggregate,
          minStock,
          parentSkuId: parent.parentSkuId,
        });
      }
    }

    return alerts;
  }

  async populate(): Promise<{ ok: true; skusRegistered: number; shippedProcessed: number }> {
    const orders = this.db.prepare(`
      SELECT raw
      FROM orders
      WHERE raw IS NOT NULL
    `).all() as Array<{ raw: string }>;
    const clients = this.db.prepare(`
      SELECT clientId, storeIds
      FROM clients
      WHERE active = 1
    `).all() as Array<{ clientId: number; storeIds: string | null }>;

    let skusRegistered = 0;
    let shippedProcessed = 0;

    for (const row of orders) {
      let order: Record<string, unknown>;
      try {
        order = JSON.parse(row.raw);
      } catch {
        continue;
      }
      const advancedOptions = order.advancedOptions as Record<string, unknown> | undefined;
      const storeId = Number(advancedOptions?.storeId ?? order.storeId ?? 0);
      if (!storeId) continue;

      const client = clients.find((entry) => this.parseStoreIds(entry.storeIds).includes(storeId));
      if (!client) continue;

      const items = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : [];
      for (const item of items.filter((entry) => entry.adjustment !== true && entry.sku)) {
        const sku = String(item.sku);
        const before = this.db.prepare(`
          SELECT id
          FROM inventory_skus
          WHERE clientId = ? AND sku = ?
        `).get(client.clientId, sku) as InventoryIdRow | undefined;
        this.ensureInventorySku(client.clientId, sku, String(item.name ?? ""));
        if (!before) skusRegistered += 1;
      }

      if (order.orderStatus === "shipped") {
        shippedProcessed += 1;
      }
    }

    return { ok: true, skusRegistered, shippedProcessed };
  }

  async importProductDimensions(clientId?: number, overwrite = false): Promise<{ ok: true; updated: number; skipped: number; noMatch: number; total: number }> {
    const where = ["active = 1"];
    const params: Array<number> = [];
    if (clientId != null) {
      where.push("clientId = ?");
      params.push(clientId);
    }

    const rows = this.db.prepare(`
      SELECT id, sku, weightOz, productLength, productWidth, productHeight
      FROM inventory_skus
      WHERE ${where.join(" AND ")}
    `).all(...params) as Array<{
      id: number;
      sku: string;
      weightOz: number;
      productLength: number;
      productWidth: number;
      productHeight: number;
    }>;

    let updated = 0;
    let skipped = 0;
    let noMatch = 0;

    for (const row of rows) {
      const product = this.db.prepare(`
        SELECT weightOz, length, width, height
        FROM products
        WHERE sku = ?
        LIMIT 1
      `).get(row.sku) as { weightOz?: number; length?: number; width?: number; height?: number } | undefined;

      if (!product || !(Number(product.weightOz ?? 0) > 0 || Number(product.length ?? 0) > 0 || Number(product.width ?? 0) > 0 || Number(product.height ?? 0) > 0)) {
        noMatch += 1;
        continue;
      }

      const hasProductDims = Number(row.productLength ?? 0) > 0 && Number(row.productWidth ?? 0) > 0 && Number(row.productHeight ?? 0) > 0;
      const hasWeight = Number(row.weightOz ?? 0) > 0;
      if (!overwrite && hasWeight && hasProductDims) {
        skipped += 1;
        continue;
      }

      this.db.prepare(`
        UPDATE inventory_skus
        SET weightOz = ?, productLength = ?, productWidth = ?, productHeight = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        Number(product.weightOz ?? row.weightOz ?? 0),
        Number(product.length ?? row.productLength ?? 0),
        Number(product.width ?? row.productWidth ?? 0),
        Number(product.height ?? row.productHeight ?? 0),
        Date.now(),
        row.id,
      );
      updated += 1;
    }

    return { ok: true, updated, skipped, noMatch, total: rows.length };
  }

  async bulkUpdateDimensions(input: BulkUpdateInventoryDimensionsInput): Promise<{ ok: true; updated: number }> {
    let updated = 0;
    for (const change of input.updates) {
      this.db.prepare(`
        UPDATE inventory_skus
        SET weightOz = COALESCE(?, weightOz),
            productLength = COALESCE(?, productLength),
            productWidth = COALESCE(?, productWidth),
            productHeight = COALESCE(?, productHeight),
            updatedAt = ?
        WHERE id = ?
      `).run(
        this.optionalNumber(change.weightOz),
        this.optionalNumber(change.productLength),
        this.optionalNumber(change.productWidth),
        this.optionalNumber(change.productHeight),
        Date.now(),
        change.invSkuId,
      );
      updated += 1;
    }
    return { ok: true, updated };
  }

  async listParentSkus(clientId: number): Promise<ParentSkuDto[]> {
    return this.db.prepare(`
      SELECT
        p.parentSkuId,
        p.clientId,
        p.name,
        p.sku,
        COALESCE(p.baseUnitQty, 1) AS baseUnitQty,
        p.createdAt,
        p.updatedAt,
        COUNT(DISTINCT s.id) AS childCount,
        COALESCE(SUM(COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0)), 0) AS totalBaseUnits
      FROM parent_skus p
      LEFT JOIN inventory_skus s ON s.parentSkuId = p.parentSkuId AND s.active = 1
      WHERE p.clientId = ?
      GROUP BY p.parentSkuId
      ORDER BY p.name ASC
    `).all(clientId) as ParentSkuDto[];
  }

  async getParentSku(parentSkuId: number): Promise<ParentSkuDetailDto | null> {
    const parent = this.db.prepare(`
      SELECT parentSkuId, clientId, name, sku, COALESCE(baseUnitQty, 1) AS baseUnitQty, createdAt, updatedAt
      FROM parent_skus
      WHERE parentSkuId = ?
    `).get(parentSkuId) as ParentSkuDto | undefined;

    if (!parent) return null;

    const children = this.db.prepare(`
      SELECT
        s.id,
        s.sku,
        s.name,
        s.minStock,
        s.active,
        COALESCE(s.baseUnitQty, 1) AS baseUnitQty,
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0) AS baseUnits
      FROM inventory_skus s
      WHERE s.parentSkuId = ?
      ORDER BY s.sku ASC
    `).all(parentSkuId) as ParentSkuDetailDto["children"];

    const lowStockChildren = children.filter((child) => Number(child.baseUnits ?? 0) <= Number(child.minStock ?? 0));
    const totalBaseUnits = children.reduce((sum, child) => sum + Number(child.baseUnits ?? 0), 0);

    return {
      ...parent,
      children,
      totalBaseUnits,
      lowStockCount: lowStockChildren.length,
      lowStockChildren,
    };
  }

  async createParentSku(input: SaveParentSkuInput): Promise<{ ok: true; parentSkuId: number; sku?: string; baseUnitQty: number }> {
    const baseUnitQty = Math.max(1, Number.parseInt(String(input.baseUnitQty ?? 1), 10) || 1);
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO parent_skus (name, sku, baseUnitQty, clientId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.name, input.sku ?? null, baseUnitQty, input.clientId, now, now);
    return { ok: true, parentSkuId: Number(result.lastInsertRowid), sku: input.sku ?? "", baseUnitQty };
  }

  async setParent(inventoryId: number, input: SetInventoryParentInput): Promise<{ ok: true }> {
    if (input.parentSkuId === null) {
      this.db.prepare(`
        UPDATE inventory_skus
        SET parentSkuId = NULL, baseUnitQty = 1, updatedAt = ?
        WHERE id = ?
      `).run(Date.now(), inventoryId);
      return { ok: true };
    }

    const parent = this.db.prepare(`
      SELECT parentSkuId
      FROM parent_skus
      WHERE parentSkuId = ?
    `).get(input.parentSkuId) as { parentSkuId: number } | undefined;
    if (!parent) {
      throw new Error("Parent SKU not found");
    }

    this.db.prepare(`
      UPDATE inventory_skus
      SET parentSkuId = ?, baseUnitQty = ?, updatedAt = ?
      WHERE id = ?
    `).run(input.parentSkuId, Math.max(1, Number.parseInt(String(input.baseUnitQty ?? 1), 10) || 1), Date.now(), inventoryId);
    return { ok: true };
  }

  async deleteParent(parentSkuId: number): Promise<{ ok: true }> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM inventory_skus
      WHERE parentSkuId = ?
    `).get(parentSkuId) as { cnt: number } | undefined;
    if (Number(row?.cnt ?? 0) > 0) {
      throw new Error(`Cannot delete parent with ${row?.cnt ?? 0} child SKU(s). Unlink children first.`);
    }

    this.db.prepare(`
      DELETE FROM parent_skus
      WHERE parentSkuId = ?
    `).run(parentSkuId);
    return { ok: true };
  }

  async getSkuOrders(inventoryId: number, days = 30): Promise<Record<string, unknown> | null> {
    const skuRow = this.db.prepare(`
      SELECT sku, name, clientId
      FROM inventory_skus
      WHERE id = ?
    `).get(inventoryId) as { sku: string; name: string; clientId: number } | undefined;
    if (!skuRow) return null;

    const safeDays = Math.max(1, Math.min(365, Number.isFinite(days) ? days : 30));
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dailySales = this.db.prepare(`
      SELECT
        date(o.orderDate) AS day,
        SUM(CAST(json_extract(j.value, '$.quantity') AS INTEGER)) AS units
      FROM orders o, json_each(o.items) j
      WHERE json_extract(j.value, '$.sku') = ?
        AND date(o.orderDate) >= ?
        AND COALESCE(o.orderStatus, '') != 'cancelled'
      GROUP BY day
      ORDER BY day ASC
    `).all(skuRow.sku, cutoff) as Array<{ day: string; units: number }>;

    const salesMap = new Map(dailySales.map((row) => [row.day, Number(row.units ?? 0)]));
    const filledSales: Array<{ day: string; units: number }> = [];
    for (let i = safeDays - 1; i >= 0; i -= 1) {
      const current = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
      filledSales.push({ day: key, units: salesMap.get(key) ?? 0 });
    }

    const orders = this.db.prepare(`
      SELECT
        o.orderId,
        o.orderNumber,
        o.orderStatus,
        o.orderDate,
        o.shipToName,
        o.carrierCode,
        o.serviceCode,
        CAST(json_extract(j.value, '$.quantity') AS INTEGER) AS qty,
        CAST(json_extract(j.value, '$.unitPrice') AS REAL) AS unitPrice,
        json_extract(j.value, '$.name') AS itemName
      FROM orders o, json_each(o.items) j
      WHERE json_extract(j.value, '$.sku') = ?
        AND COALESCE(o.orderStatus, '') != 'cancelled'
      ORDER BY o.orderDate DESC
      LIMIT 200
    `).all(skuRow.sku) as Array<Record<string, unknown>>;

    return {
      sku: skuRow.sku,
      name: skuRow.name,
      clientId: skuRow.clientId,
      totalUnits: filledSales.reduce((sum, row) => sum + row.units, 0),
      dailySales: filledSales,
      orders,
    };
  }

  private ensureInventorySku(clientId: number, sku: string, name: string): number {
    let row = this.db.prepare("SELECT id FROM inventory_skus WHERE clientId = ? AND sku = ?").get(clientId, sku) as InventoryIdRow | undefined;
    if (row) return Number(row.id);

    const product = this.db.prepare(`
      SELECT weightOz, length, width, height, defaultPackageCode
      FROM products
      WHERE sku = ?
      LIMIT 1
    `).get(sku) as { weightOz?: number; length?: number; width?: number; height?: number; defaultPackageCode?: string | null } | undefined;

    let packageId: number | null = null;
    if (product?.defaultPackageCode) {
      const packageRow = this.db.prepare("SELECT packageId FROM packages WHERE packageCode = ?").get(product.defaultPackageCode) as { packageId: number } | undefined;
      packageId = packageRow ? Number(packageRow.packageId) : null;
    }

    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO inventory_skus (clientId, sku, name, weightOz, length, width, height, packageId, active, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      clientId,
      sku,
      name,
      product?.weightOz ?? 0,
      product?.length ?? 0,
      product?.width ?? 0,
      product?.height ?? 0,
      packageId,
      now,
      now,
    );

    return Number(result.lastInsertRowid);
  }

  private getCurrentStock(inventoryId: number): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(qty), 0) AS stock
      FROM inventory_ledger
      WHERE invSkuId = ?
    `).get(inventoryId) as { stock?: number } | undefined;
    return Number(row?.stock ?? 0);
  }

  private getParentAggregateStock(parentSkuId: number): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE invSkuId = s.id), 0)), 0) AS totalBaseUnits
      FROM inventory_skus s
      WHERE s.parentSkuId = ? AND s.active = 1
    `).get(parentSkuId) as { totalBaseUnits?: number } | undefined;
    return Number(row?.totalBaseUnits ?? 0);
  }

  private parseTimestamp(value: string | number | undefined): number {
    if (value == null) return Date.now();
    if (typeof value === "number") return Number.isFinite(value) ? value : Date.now();
    const fromDate = new Date(value).getTime();
    return Number.isFinite(fromDate) ? fromDate : Date.now();
  }

  private parseStoreIds(raw: string | null): number[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((value) => Number.parseInt(String(value), 10)).filter(Number.isFinite);
    } catch {
      return [];
    }
  }

  private optionalNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
