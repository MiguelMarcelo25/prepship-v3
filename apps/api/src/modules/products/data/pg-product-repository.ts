import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type {
  ProductBulkItemDto,
  SaveProductDefaultsInput,
} from "../../../../../../packages/contracts/src/products/contracts.js";
import type { ProductRepository } from "../application/product-repository.js";
import type { ProductDefaultsRecord, SaveProductDefaultsRecordResult } from "../domain/product.js";

export class PgProductRepository implements ProductRepository {
  constructor(private readonly sql: PgClient) {}

  async getBulk(skus: string[]): Promise<Record<string, ProductBulkItemDto>> {
    if (skus.length === 0) return {};

    const rows = await this.sql`
      SELECT sku, "weightOz", length, width, height, "defaultPackageCode"
      FROM products
      WHERE sku = ANY(${skus})
    ` as ProductBulkItemDto[];

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
      const fallbackRows = await this.sql`
        SELECT sku, "weightOz", length, width, height
        FROM inventory_skus
        WHERE sku = ANY(${missing}) AND (COALESCE("weightOz", 0) > 0 OR COALESCE(length, 0) > 0)
      ` as Array<{ sku: string; weightOz: number; length: number; width: number; height: number }>;

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
    const productRows = await this.sql`
      SELECT sku, "weightOz", length, width, height, "defaultPackageCode"
      FROM products
      WHERE sku = ${sku}
      ORDER BY COALESCE("modifyDate", "updatedAt", "createdAt", '0') DESC
      LIMIT 1
    `;
    const row = productRows[0] as ProductDefaultsRecord | undefined;

    let defaults: { sku: string; weightOz: number; length: number; width: number; height: number; packageCode?: string | null } | undefined;
    if (await this.hasTable("sku_defaults")) {
      const defaultRows = await this.sql`
        SELECT sku, "weightOz", length, width, height, "packageCode"
        FROM sku_defaults
        WHERE sku = ${sku}
      `;
      defaults = defaultRows[0] as typeof defaults;
    }

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
      const existingRows = await this.sql`
        SELECT "packageId", name, length, width, height, source
        FROM packages
        WHERE ABS(COALESCE(length, 0) - ${length}) <= 0.1
          AND ABS(COALESCE(width, 0) - ${width}) <= 0.1
          AND ABS(COALESCE(height, 0) - ${height}) <= 0.1
          AND (source = 'custom' OR source IS NULL)
        LIMIT 1
      `;
      const existing = existingRows[0] as { packageId: number; name: string; length: number; width: number; height: number; source: string | null } | undefined;

      if (existing) {
        resolvedPackageId = Number(existing.packageId);
      } else {
        const packageName = `${length}x${width}x${height}`;
        const now = Date.now();
        const [newPkg] = await this.sql`
          INSERT INTO packages (name, type, length, width, height, source, "isDefault", "createdAt", "updatedAt")
          VALUES (${packageName}, 'box', ${length}, ${width}, ${height}, 'custom', 0, ${now}, ${now})
          RETURNING "packageId"
        `;
        resolvedPackageId = Number((newPkg as { packageId: number }).packageId);
        newPackageCreated = true;
      }
      packageCode = resolvedPackageId ? String(resolvedPackageId) : null;
    }

    const packageData = resolvedPackageId ? await this.getPackageData(resolvedPackageId) : null;

    let productRow: { productId: number; sku: string } | undefined;
    if (input.productId != null) {
      const rows = await this.sql`
        SELECT "productId", sku
        FROM products
        WHERE "productId" = ${input.productId}
        LIMIT 1
      `;
      productRow = rows[0] as { productId: number; sku: string } | undefined;
    } else if (input.sku) {
      const rows = await this.sql`
        SELECT "productId", sku
        FROM products
        WHERE sku = ${input.sku}
        ORDER BY COALESCE("modifyDate", "updatedAt", "createdAt", '0') DESC
        LIMIT 1
      `;
      productRow = rows[0] as { productId: number; sku: string } | undefined;
    }

    if (!productRow) {
      if (!input.sku) {
        throw new Error("Product not found");
      }
      if (!(await this.hasTable("sku_defaults"))) {
        throw new Error("Product not found");
      }

      const existingDefaultsRows = await this.sql`
        SELECT "weightOz", length, width, height, "packageCode"
        FROM sku_defaults
        WHERE sku = ${input.sku}
      `;
      const existingDefaults = existingDefaultsRows[0] as { weightOz?: number; length?: number; width?: number; height?: number; packageCode?: string | null } | undefined;

      await this.sql`
        INSERT INTO sku_defaults (sku, "weightOz", length, width, height, "packageCode", "updatedAt")
        VALUES (
          ${input.sku},
          ${weightOz || Number(existingDefaults?.weightOz ?? 0)},
          ${length || Number(existingDefaults?.length ?? 0)},
          ${width || Number(existingDefaults?.width ?? 0)},
          ${height || Number(existingDefaults?.height ?? 0)},
          ${packageCode ?? existingDefaults?.packageCode ?? null},
          ${Date.now()}
        )
        ON CONFLICT (sku) DO UPDATE SET
          "weightOz" = EXCLUDED."weightOz",
          length = EXCLUDED.length,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          "packageCode" = EXCLUDED."packageCode",
          "updatedAt" = EXCLUDED."updatedAt"
      `;

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

    await this.sql`
      UPDATE products
      SET "weightOz" = COALESCE(${(saved.weightOz as number) ?? null}, "weightOz"),
          length = COALESCE(${(saved.length as number) ?? null}, length),
          width = COALESCE(${(saved.width as number) ?? null}, width),
          height = COALESCE(${(saved.height as number) ?? null}, height),
          "defaultPackageCode" = COALESCE(${(saved.defaultPackageCode as string) ?? null}, "defaultPackageCode"),
          "updatedAt" = ${Date.now()}
      WHERE "productId" = ${productRow.productId}
    `;

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

  private async getPackageData(packageId: number) {
    const rows = await this.sql`
      SELECT "packageId", name, length, width, height, source
      FROM packages
      WHERE "packageId" = ${packageId}
    `;
    return (rows[0] as { packageId: number; name: string; length: number | null; width: number | null; height: number | null; source: string | null }) ?? null;
  }

  private positive(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private async hasTable(name: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    `;
    return rows.length > 0;
  }
}
