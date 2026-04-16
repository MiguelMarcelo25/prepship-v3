import type { DatabaseSync } from "node:sqlite";
import type {
  ProductBulkItemDto,
  SaveProductDefaultsInput,
} from "../../../../../../packages/contracts/src/products/contracts.ts";
import type { ProductRepository } from "../application/product-repository.ts";
import type { ProductDefaultsRecord, SaveProductDefaultsRecordResult } from "../domain/product.ts";

export class SqliteProductRepository implements ProductRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async getBulk(skus: string[]): Promise<Record<string, ProductBulkItemDto>> {
    if (skus.length === 0) return {};

    const placeholders = skus.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT sku, weightOz, length, width, height, defaultPackageCode
      FROM products
      WHERE sku IN (${placeholders})
    `).all(...skus) as ProductBulkItemDto[];

    const map: Record<string, ProductBulkItemDto> = {};
    for (const row of rows) {
      if (Number(row.weightOz ?? 0) > 0 || Number(row.length ?? 0) > 0) {
        map[row.sku] = {
          sku: row.sku,
          weightOz: Number(row.weightOz ?? 0),
          length: Number(row.length ?? 0),
          width: Number(row.width ?? 0),
          height: Number(row.height ?? 0),
          defaultPackageCode: row.defaultPackageCode ?? null,
        };
      }
    }

    const missing = skus.filter((sku) => !map[sku]);
    if (missing.length > 0) {
      const fallbackPlaceholders = missing.map(() => "?").join(", ");
      const fallbackRows = this.db.prepare(`
        SELECT sku, weightOz, length, width, height
        FROM inventory_skus
        WHERE sku IN (${fallbackPlaceholders}) AND (COALESCE(weightOz, 0) > 0 OR COALESCE(length, 0) > 0)
      `).all(...missing) as Array<{ sku: string; weightOz: number; length: number; width: number; height: number }>;

      for (const row of fallbackRows) {
        if (!map[row.sku]) {
          map[row.sku] = {
            sku: row.sku,
            weightOz: Number(row.weightOz ?? 0),
            length: Number(row.length ?? 0),
            width: Number(row.width ?? 0),
            height: Number(row.height ?? 0),
            defaultPackageCode: null,
          };
        }
      }
    }

    return map;
  }

  async getBySku(sku: string): Promise<ProductDefaultsRecord | null> {
    const row = this.db.prepare(`
      SELECT sku, weightOz, length, width, height, defaultPackageCode
      FROM products
      WHERE sku = ?
      ORDER BY COALESCE(modifyDate, updatedAt, createdAt, 0) DESC
      LIMIT 1
    `).get(sku) as ProductDefaultsRecord | undefined;

    const defaults = this.hasTable("sku_defaults")
      ? this.db.prepare(`
          SELECT sku, weightOz, length, width, height, packageCode
          FROM sku_defaults
          WHERE sku = ?
        `).get(sku) as { sku: string; weightOz: number; length: number; width: number; height: number; packageCode?: string | null } | undefined
      : undefined;

    if (row) {
      const needsMerge = !(Number(row.weightOz ?? 0) > 0 && Number(row.length ?? 0) > 0 && Number(row.width ?? 0) > 0 && Number(row.height ?? 0) > 0);
      if (needsMerge && defaults) {
        return {
          sku: row.sku,
          weightOz: Number(row.weightOz ?? 0) > 0 ? Number(row.weightOz) : Number(defaults.weightOz ?? 0),
          length: Number(row.length ?? 0) > 0 ? Number(row.length) : Number(defaults.length ?? 0),
          width: Number(row.width ?? 0) > 0 ? Number(row.width) : Number(defaults.width ?? 0),
          height: Number(row.height ?? 0) > 0 ? Number(row.height) : Number(defaults.height ?? 0),
          defaultPackageCode: row.defaultPackageCode ?? defaults.packageCode ?? null,
        };
      }
      return {
        sku: row.sku,
        weightOz: Number(row.weightOz ?? 0),
        length: Number(row.length ?? 0),
        width: Number(row.width ?? 0),
        height: Number(row.height ?? 0),
        defaultPackageCode: row.defaultPackageCode ?? null,
      };
    }

    if (!defaults) return null;

    return {
      sku: defaults.sku,
      weightOz: Number(defaults.weightOz ?? 0),
      length: Number(defaults.length ?? 0),
      width: Number(defaults.width ?? 0),
      height: Number(defaults.height ?? 0),
      defaultPackageCode: defaults.packageCode ?? null,
      _localOnly: true,
    };
  }

  async saveDefaults(input: SaveProductDefaultsInput): Promise<SaveProductDefaultsRecordResult> {
    const weightOz = this.positive(input.weightOz ?? input.weight);
    const length = this.positive(input.length);
    const width = this.positive(input.width);
    const height = this.positive(input.height);

    let packageCode = typeof input.packageCode === "string" && input.packageCode.trim() !== "" ? input.packageCode : null;
    const incomingPackageId = input.packageId != null && String(input.packageId).trim() !== "" ? String(input.packageId) : null;
    if (!packageCode && incomingPackageId) packageCode = incomingPackageId;

    let resolvedPackageId: number | null = null;
    let newPackageCreated = false;

    if (!packageCode && length > 0 && width > 0 && height > 0) {
      const existing = this.db.prepare(`
        SELECT packageId, name, length, width, height, source
        FROM packages
        WHERE ABS(COALESCE(length, 0) - ?) <= 0.1
          AND ABS(COALESCE(width, 0) - ?) <= 0.1
          AND ABS(COALESCE(height, 0) - ?) <= 0.1
          AND (source = 'custom' OR source IS NULL)
        LIMIT 1
      `).get(length, width, height) as { packageId: number; name: string; length: number; width: number; height: number; source: string | null } | undefined;

      if (existing) {
        resolvedPackageId = Number(existing.packageId);
      } else {
        const packageName = `${length}x${width}x${height}`;
        const now = Date.now();
        const result = this.db.prepare(`
          INSERT INTO packages (name, type, length, width, height, source, isDefault, createdAt, updatedAt)
          VALUES (?, 'box', ?, ?, ?, 'custom', 0, ?, ?)
        `).run(packageName, length, width, height, now, now);
        resolvedPackageId = Number(result.lastInsertRowid);
        newPackageCreated = true;
      }
      packageCode = resolvedPackageId ? String(resolvedPackageId) : null;
    }

    const packageData = resolvedPackageId ? this.getPackageData(resolvedPackageId) : null;

    const productRow = input.productId != null
      ? this.db.prepare(`
          SELECT productId, sku
          FROM products
          WHERE productId = ?
          LIMIT 1
        `).get(input.productId) as { productId: number; sku: string } | undefined
      : input.sku
        ? this.db.prepare(`
            SELECT productId, sku
            FROM products
            WHERE sku = ?
            ORDER BY COALESCE(modifyDate, updatedAt, createdAt, 0) DESC
            LIMIT 1
          `).get(input.sku) as { productId: number; sku: string } | undefined
        : undefined;

    if (!productRow) {
      if (!input.sku) {
        throw new Error("Product not found");
      }
      if (!this.hasTable("sku_defaults")) {
        throw new Error("Product not found");
      }
      const existingDefaults = this.db.prepare(`
        SELECT weightOz, length, width, height, packageCode
        FROM sku_defaults
        WHERE sku = ?
      `).get(input.sku) as { weightOz?: number; length?: number; width?: number; height?: number; packageCode?: string | null } | undefined;

      this.db.prepare(`
        INSERT INTO sku_defaults (sku, weightOz, length, width, height, packageCode, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sku) DO UPDATE SET
          weightOz = excluded.weightOz,
          length = excluded.length,
          width = excluded.width,
          height = excluded.height,
          packageCode = excluded.packageCode,
          updatedAt = excluded.updatedAt
      `).run(
        input.sku,
        weightOz || Number(existingDefaults?.weightOz ?? 0),
        length || Number(existingDefaults?.length ?? 0),
        width || Number(existingDefaults?.width ?? 0),
        height || Number(existingDefaults?.height ?? 0),
        packageCode ?? existingDefaults?.packageCode ?? null,
        Date.now(),
      );

      return {
        ok: true,
        localOnly: true,
        resolvedPackageId,
        newPackageCreated,
        packageData,
      };
    }

    const saved: Record<string, unknown> = {};
    if (weightOz > 0) saved.weightOz = weightOz;
    if (length > 0) saved.length = length;
    if (width > 0) saved.width = width;
    if (height > 0) saved.height = height;
    if (packageCode) saved.defaultPackageCode = packageCode;
    if (Object.keys(saved).length === 0) {
      throw new Error("Nothing to save");
    }

    this.db.prepare(`
      UPDATE products
      SET weightOz = COALESCE(?, weightOz),
          length = COALESCE(?, length),
          width = COALESCE(?, width),
          height = COALESCE(?, height),
          defaultPackageCode = COALESCE(?, defaultPackageCode),
          updatedAt = ?
      WHERE productId = ?
    `).run(
      saved.weightOz ?? null,
      saved.length ?? null,
      saved.width ?? null,
      saved.height ?? null,
      saved.defaultPackageCode ?? null,
      Date.now(),
      productRow.productId,
    );

    return {
      ok: true,
      productId: productRow.productId,
      sku: productRow.sku,
      saved,
      resolvedPackageId,
      newPackageCreated,
      packageData,
    };
  }

  private getPackageData(packageId: number) {
    return this.db.prepare(`
      SELECT packageId, name, length, width, height, source
      FROM packages
      WHERE packageId = ?
    `).get(packageId) as { packageId: number; name: string; length: number | null; width: number | null; height: number | null; source: string | null } | null;
  }

  private positive(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(name) as { name?: string } | undefined;
    return row?.name === name;
  }
}
