import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
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

export class PgInventoryRepository implements InventoryRepository {
  constructor(private readonly sql: PgClient) {}

  async list(query: ListInventoryQuery): Promise<InventoryRecord[]> {
    const conditions: string[] = ["s.active = 1"];
    const params: Array<string | number> = [];
    let paramIndex = 0;

    if (query.clientId != null) {
      paramIndex++;
      conditions.push(`s."clientId" = $${paramIndex}`);
      params.push(query.clientId);
    }
    if (query.sku) {
      paramIndex++;
      conditions.push(`s.sku LIKE $${paramIndex}`);
      params.push(`%${query.sku}%`);
    }

    // Since Neon tagged templates don't support dynamic WHERE easily,
    // we build conditional queries. For simplicity with the tagged template,
    // we use separate branches based on what filters are present.
    const rows = await this.sql`
      SELECT
        s.id, s."clientId", s.sku, s.name, s."minStock", s.active,
        s."weightOz", s."parentSkuId", COALESCE(s."baseUnitQty", 1) AS "baseUnitQty",
        COALESCE(s.length, 0) AS "packageLength", COALESCE(s.width, 0) AS "packageWidth", COALESCE(s.height, 0) AS "packageHeight",
        COALESCE(s."productLength", 0) AS "productLength", COALESCE(s."productWidth", 0) AS "productWidth", COALESCE(s."productHeight", 0) AS "productHeight",
        s."packageId", COALESCE(s.units_per_pack, 1) AS "unitsPerPack", s."cuFtOverride",
        c.name AS "clientName",
        p.name AS "packageName",
        p.length AS "packageDimLength", p.width AS "packageDimWidth", p.height AS "packageDimHeight",
        ps.name AS "parentName",
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0) AS "currentStock",
        (SELECT MAX("createdAt") FROM inventory_ledger WHERE "invSkuId" = s.id) AS "lastMovement",
        (
          SELECT je.value->>'imageUrl'
          FROM orders ord, jsonb_array_elements(normalize_jsonb(ord.items)) AS je(value)
          WHERE je.value->>'sku' = s.sku
            AND je.value->>'imageUrl' IS NOT NULL
            AND je.value->>'imageUrl' != ''
          ORDER BY ord."orderDate" DESC
          LIMIT 1
        ) AS "imageUrl"
      FROM inventory_skus s
      JOIN clients c ON s."clientId" = c."clientId"
      LEFT JOIN packages p ON p."packageId" = s."packageId"
      LEFT JOIN parent_skus ps ON ps."parentSkuId" = s."parentSkuId"
      WHERE s.active = 1
        AND (${query.clientId ?? null}::int IS NULL OR s."clientId" = ${query.clientId ?? null})
        AND (${query.sku ? `%${query.sku}%` : null}::text IS NULL OR s.sku LIKE ${query.sku ? `%${query.sku}%` : null})
      ORDER BY c.name ASC, COALESCE(ps.name, ''), s.sku ASC
    `;

    return rows as InventoryRecord[];
  }

  async receive(input: ReceiveInventoryInput): Promise<ReceiveInventoryResultDto[]> {
    const receivedAt = this.parseTimestamp(input.receivedAt);
    const results: ReceiveInventoryResultDto[] = [];

    for (const item of input.items) {
      if (!item.sku || !item.qty || item.qty <= 0) continue;
      const invSkuId = await this.ensureInventorySku(input.clientId, item.sku, item.name ?? "");
      const skuRows = await this.sql`SELECT COALESCE("baseUnitQty", 1) AS "baseUnitQty" FROM inventory_skus WHERE id = ${invSkuId}`;
      const baseUnitQty = Number((skuRows[0] as { baseUnitQty?: number } | undefined)?.baseUnitQty ?? 1);
      const actualQtyToStore = Number(item.qty) * baseUnitQty;

      await this.sql`
        INSERT INTO inventory_ledger ("invSkuId", type, qty, note, "createdBy", "createdAt")
        VALUES (${invSkuId}, 'receive', ${actualQtyToStore}, ${input.note || `Received ${item.qty} units (${actualQtyToStore} base units)`}, 'manual', ${receivedAt})
      `;

      const newStock = await this.getCurrentStock(invSkuId);
      results.push({
        sku: item.sku,
        qty: Number(item.qty),
        baseUnitQty,
        baseUnits: actualQtyToStore,
        invSkuId,
        newStock,
      });
    }

    return results;
  }

  async adjust(input: AdjustInventoryInput): Promise<number> {
    const validTypes = new Set(["adjust", "receive", "return", "damage"]);
    const type = validTypes.has(String(input.type ?? "adjust")) ? String(input.type ?? "adjust") : "adjust";
    const note = input.note || (Number(input.qty) > 0 ? `Manual ${type}` : "Manual remove");

    await this.sql`
      INSERT INTO inventory_ledger ("invSkuId", type, qty, note, "createdBy", "createdAt")
      VALUES (${input.invSkuId}, ${type}, ${input.qty}, ${note}, 'manual', ${this.parseTimestamp(input.adjustedAt)})
    `;

    return this.getCurrentStock(input.invSkuId);
  }

  async update(inventoryId: number, input: UpdateInventoryItemInput): Promise<void> {
    await this.sql`
      UPDATE inventory_skus
      SET name = ${input.name ?? ""},
          "minStock" = ${input.minStock ?? 0},
          "weightOz" = ${input.weightOz ?? 0},
          length = ${input.length ?? 0},
          width = ${input.width ?? 0},
          height = ${input.height ?? 0},
          "productLength" = ${input.productLength ?? 0},
          "productWidth" = ${input.productWidth ?? 0},
          "productHeight" = ${input.productHeight ?? 0},
          "packageId" = ${input.packageId ?? null},
          units_per_pack = ${input.units_per_pack ?? 1},
          "cuFtOverride" = ${input.cuFtOverride ?? null},
          "updatedAt" = ${Date.now()}
      WHERE id = ${inventoryId}
    `;
  }

  async listLedger(query: ListInventoryLedgerQuery): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`
      SELECT
        l.id, l."invSkuId", l.type, l.qty, l."orderId", l.note, l."createdBy", l."createdAt",
        s.sku, s.name AS "skuName", s."clientId",
        c.name AS "clientName"
      FROM inventory_ledger l
      JOIN inventory_skus s ON s.id = l."invSkuId"
      JOIN clients c ON c."clientId" = s."clientId"
      WHERE (${query.clientId ?? null}::int IS NULL OR s."clientId" = ${query.clientId ?? null})
        AND (${query.type ?? null}::text IS NULL OR l.type = ${query.type ?? null})
        AND (${query.dateStart ?? null}::bigint IS NULL OR l."createdAt" >= ${query.dateStart ?? null})
        AND (${query.dateEnd ?? null}::bigint IS NULL OR l."createdAt" <= ${query.dateEnd ?? null})
      ORDER BY l."createdAt" DESC
      LIMIT ${query.limit}
    `;
    return rows as Record<string, unknown>[];
  }

  async getLedgerByInventoryId(inventoryId: number): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`
      SELECT
        l.id, l."invSkuId", l.type, l.qty, l."orderId", l.note, l."createdBy", l."createdAt",
        s.sku, s.name AS "skuName", s."clientId",
        c.name AS "clientName"
      FROM inventory_ledger l
      JOIN inventory_skus s ON s.id = l."invSkuId"
      JOIN clients c ON c."clientId" = s."clientId"
      WHERE l."invSkuId" = ${inventoryId}
      ORDER BY l."createdAt" DESC
      LIMIT 500
    `;
    return rows as Record<string, unknown>[];
  }

  async listAlerts(clientId: number): Promise<InventoryAlertRecord[]> {
    const alerts: InventoryAlertRecord[] = [];

    const skuAlerts = await this.sql`
      SELECT
        s.id, s.sku, s.name, s."minStock", s."parentSkuId",
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0) AS "currentStock"
      FROM inventory_skus s
      WHERE s."clientId" = ${clientId} AND s.active = 1
        AND COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0) <= s."minStock"
      ORDER BY "currentStock" ASC
    `;

    for (const sku of skuAlerts as Array<{ id: number; sku: string; name: string; minStock: number; parentSkuId: number | null; currentStock: number }>) {
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

    const parentRows = await this.sql`
      SELECT
        p."parentSkuId", p.name,
        (
          SELECT MIN("minStock")
          FROM inventory_skus
          WHERE "parentSkuId" = p."parentSkuId" AND active = 1
        ) AS "minStock"
      FROM parent_skus p
      WHERE p."clientId" = ${clientId}
    `;

    for (const parent of parentRows as Array<{ parentSkuId: number; name: string; minStock: number | null }>) {
      const aggregate = await this.getParentAggregateStock(parent.parentSkuId);
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
    const orders = await this.sql`
      SELECT raw
      FROM orders
      WHERE raw IS NOT NULL
    ` as Array<{ raw: string }>;

    const clients = await this.sql`
      SELECT "clientId", "storeIds"
      FROM clients
      WHERE active = 1
    ` as Array<{ clientId: number; storeIds: string | null }>;

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
        const beforeRows = await this.sql`
          SELECT id FROM inventory_skus WHERE "clientId" = ${client.clientId} AND sku = ${sku}
        `;
        const before = beforeRows[0] as { id: number } | undefined;
        await this.ensureInventorySku(client.clientId, sku, String(item.name ?? ""));
        if (!before) skusRegistered += 1;
      }

      if (order.orderStatus === "shipped") {
        shippedProcessed += 1;
      }
    }

    return { ok: true, skusRegistered, shippedProcessed };
  }

  async importProductDimensions(clientId?: number, overwrite = false): Promise<{ ok: true; updated: number; skipped: number; noMatch: number; total: number }> {
    const rows = await this.sql`
      SELECT id, sku, "weightOz", "productLength", "productWidth", "productHeight"
      FROM inventory_skus
      WHERE active = 1
        AND (${clientId ?? null}::int IS NULL OR "clientId" = ${clientId ?? null})
    ` as Array<{
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
      const productRows = await this.sql`
        SELECT "weightOz", length, width, height
        FROM products
        WHERE sku = ${row.sku}
        LIMIT 1
      `;
      const product = productRows[0] as { weightOz?: number; length?: number; width?: number; height?: number } | undefined;

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

      await this.sql`
        UPDATE inventory_skus
        SET "weightOz" = ${Number(product.weightOz ?? row.weightOz ?? 0)},
            "productLength" = ${Number(product.length ?? row.productLength ?? 0)},
            "productWidth" = ${Number(product.width ?? row.productWidth ?? 0)},
            "productHeight" = ${Number(product.height ?? row.productHeight ?? 0)},
            "updatedAt" = ${Date.now()}
        WHERE id = ${row.id}
      `;
      updated += 1;
    }

    return { ok: true, updated, skipped, noMatch, total: rows.length };
  }

  async bulkUpdateDimensions(input: BulkUpdateInventoryDimensionsInput): Promise<{ ok: true; updated: number }> {
    let updated = 0;
    for (const change of input.updates) {
      await this.sql`
        UPDATE inventory_skus
        SET "weightOz" = COALESCE(${this.optionalNumber(change.weightOz)}, "weightOz"),
            "productLength" = COALESCE(${this.optionalNumber(change.productLength)}, "productLength"),
            "productWidth" = COALESCE(${this.optionalNumber(change.productWidth)}, "productWidth"),
            "productHeight" = COALESCE(${this.optionalNumber(change.productHeight)}, "productHeight"),
            "updatedAt" = ${Date.now()}
        WHERE id = ${change.invSkuId}
      `;
      updated += 1;
    }
    return { ok: true, updated };
  }

  async listParentSkus(clientId: number): Promise<ParentSkuDto[]> {
    const rows = await this.sql`
      SELECT
        p."parentSkuId",
        p."clientId",
        p.name,
        p.sku,
        COALESCE(p."baseUnitQty", 1) AS "baseUnitQty",
        p."createdAt",
        p."updatedAt",
        COUNT(DISTINCT s.id) AS "childCount",
        COALESCE(SUM(COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0)), 0) AS "totalBaseUnits"
      FROM parent_skus p
      LEFT JOIN inventory_skus s ON s."parentSkuId" = p."parentSkuId" AND s.active = 1
      WHERE p."clientId" = ${clientId}
      GROUP BY p."parentSkuId"
      ORDER BY p.name ASC
    `;
    return rows as ParentSkuDto[];
  }

  async getParentSku(parentSkuId: number): Promise<ParentSkuDetailDto | null> {
    const parentRows = await this.sql`
      SELECT "parentSkuId", "clientId", name, sku, COALESCE("baseUnitQty", 1) AS "baseUnitQty", "createdAt", "updatedAt"
      FROM parent_skus
      WHERE "parentSkuId" = ${parentSkuId}
    `;
    const parent = parentRows[0] as ParentSkuDto | undefined;
    if (!parent) return null;

    const children = await this.sql`
      SELECT
        s.id,
        s.sku,
        s.name,
        s."minStock",
        s.active,
        COALESCE(s."baseUnitQty", 1) AS "baseUnitQty",
        COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0) AS "baseUnits"
      FROM inventory_skus s
      WHERE s."parentSkuId" = ${parentSkuId}
      ORDER BY s.sku ASC
    ` as ParentSkuDetailDto["children"];

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
    const [row] = await this.sql`
      INSERT INTO parent_skus (name, sku, "baseUnitQty", "clientId", "createdAt", "updatedAt")
      VALUES (${input.name}, ${input.sku ?? null}, ${baseUnitQty}, ${input.clientId}, ${now}, ${now})
      RETURNING "parentSkuId"
    `;
    return { ok: true, parentSkuId: Number((row as { parentSkuId: number }).parentSkuId), sku: input.sku ?? "", baseUnitQty };
  }

  async setParent(inventoryId: number, input: SetInventoryParentInput): Promise<{ ok: true }> {
    if (input.parentSkuId === null) {
      await this.sql`
        UPDATE inventory_skus
        SET "parentSkuId" = NULL, "baseUnitQty" = 1, "updatedAt" = ${Date.now()}
        WHERE id = ${inventoryId}
      `;
      return { ok: true };
    }

    const parentRows = await this.sql`
      SELECT "parentSkuId"
      FROM parent_skus
      WHERE "parentSkuId" = ${input.parentSkuId}
    `;
    if (!parentRows[0]) {
      throw new Error("Parent SKU not found");
    }

    await this.sql`
      UPDATE inventory_skus
      SET "parentSkuId" = ${input.parentSkuId},
          "baseUnitQty" = ${Math.max(1, Number.parseInt(String(input.baseUnitQty ?? 1), 10) || 1)},
          "updatedAt" = ${Date.now()}
      WHERE id = ${inventoryId}
    `;
    return { ok: true };
  }

  async deleteParent(parentSkuId: number): Promise<{ ok: true }> {
    const rows = await this.sql`
      SELECT COUNT(*) AS cnt
      FROM inventory_skus
      WHERE "parentSkuId" = ${parentSkuId}
    `;
    const cnt = Number((rows[0] as { cnt: number })?.cnt ?? 0);
    if (cnt > 0) {
      throw new Error(`Cannot delete parent with ${cnt} child SKU(s). Unlink children first.`);
    }

    await this.sql`
      DELETE FROM parent_skus
      WHERE "parentSkuId" = ${parentSkuId}
    `;
    return { ok: true };
  }

  async getSkuOrders(inventoryId: number, days = 30): Promise<Record<string, unknown> | null> {
    const skuRows = await this.sql`
      SELECT sku, name, "clientId"
      FROM inventory_skus
      WHERE id = ${inventoryId}
    `;
    const skuRow = skuRows[0] as { sku: string; name: string; clientId: number } | undefined;
    if (!skuRow) return null;

    const safeDays = Math.max(1, Math.min(365, Number.isFinite(days) ? days : 30));
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const dailySales = await this.sql`
      SELECT
        date(o."orderDate"::timestamp) AS day,
        SUM(CAST(je.value->>'quantity' AS INTEGER)) AS units
      FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) AS je(value)
      WHERE je.value->>'sku' = ${skuRow.sku}
        AND date(o."orderDate"::timestamp) >= ${cutoff}::date
        AND COALESCE(o."orderStatus", '') != 'cancelled'
      GROUP BY day
      ORDER BY day ASC
    ` as Array<{ day: string; units: number }>;

    const salesMap = new Map(dailySales.map((row) => [row.day, Number(row.units ?? 0)]));
    const filledSales: Array<{ day: string; units: number }> = [];
    for (let i = safeDays - 1; i >= 0; i -= 1) {
      const current = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
      filledSales.push({ day: key, units: salesMap.get(key) ?? 0 });
    }

    const orders = await this.sql`
      SELECT
        o."orderId",
        o."orderNumber",
        o."orderStatus",
        o."orderDate",
        o."shipToName",
        o."carrierCode",
        o."serviceCode",
        CAST(je.value->>'quantity' AS INTEGER) AS qty,
        CAST(je.value->>'unitPrice' AS REAL) AS "unitPrice",
        je.value->>'name' AS "itemName"
      FROM orders o, jsonb_array_elements(normalize_jsonb(o.items)) AS je(value)
      WHERE je.value->>'sku' = ${skuRow.sku}
        AND COALESCE(o."orderStatus", '') != 'cancelled'
      ORDER BY o."orderDate" DESC
      LIMIT 200
    ` as Array<Record<string, unknown>>;

    return {
      sku: skuRow.sku,
      name: skuRow.name,
      clientId: skuRow.clientId,
      totalUnits: filledSales.reduce((sum, row) => sum + row.units, 0),
      dailySales: filledSales,
      orders,
    };
  }

  private async ensureInventorySku(clientId: number, sku: string, name: string): Promise<number> {
    const existingRows = await this.sql`
      SELECT id FROM inventory_skus WHERE "clientId" = ${clientId} AND sku = ${sku}
    `;
    if (existingRows[0]) return Number((existingRows[0] as { id: number }).id);

    const productRows = await this.sql`
      SELECT "weightOz", length, width, height, "defaultPackageCode"
      FROM products
      WHERE sku = ${sku}
      LIMIT 1
    `;
    const product = productRows[0] as { weightOz?: number; length?: number; width?: number; height?: number; defaultPackageCode?: string | null } | undefined;

    let packageId: number | null = null;
    if (product?.defaultPackageCode) {
      const packageRows = await this.sql`
        SELECT "packageId" FROM packages WHERE "packageCode" = ${product.defaultPackageCode}
      `;
      const packageRow = packageRows[0] as { packageId: number } | undefined;
      packageId = packageRow ? Number(packageRow.packageId) : null;
    }

    const now = Date.now();
    const [row] = await this.sql`
      INSERT INTO inventory_skus ("clientId", sku, name, "weightOz", length, width, height, "packageId", active, "createdAt", "updatedAt")
      VALUES (${clientId}, ${sku}, ${name}, ${product?.weightOz ?? 0}, ${product?.length ?? 0}, ${product?.width ?? 0}, ${product?.height ?? 0}, ${packageId}, 1, ${now}, ${now})
      RETURNING id
    `;

    return Number((row as { id: number }).id);
  }

  private async getCurrentStock(inventoryId: number): Promise<number> {
    const rows = await this.sql`
      SELECT COALESCE(SUM(qty), 0) AS stock
      FROM inventory_ledger
      WHERE "invSkuId" = ${inventoryId}
    `;
    return Number((rows[0] as { stock?: number })?.stock ?? 0);
  }

  private async getParentAggregateStock(parentSkuId: number): Promise<number> {
    const rows = await this.sql`
      SELECT COALESCE(SUM(COALESCE((SELECT SUM(qty) FROM inventory_ledger WHERE "invSkuId" = s.id), 0)), 0) AS "totalBaseUnits"
      FROM inventory_skus s
      WHERE s."parentSkuId" = ${parentSkuId} AND s.active = 1
    `;
    return Number((rows[0] as { totalBaseUnits?: number })?.totalBaseUnits ?? 0);
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
