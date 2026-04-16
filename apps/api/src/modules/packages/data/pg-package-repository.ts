import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type {
  AutoCreatePackageInput,
  PackageAdjustmentInput,
  SavePackageInput,
} from "../../../../../../packages/contracts/src/packages/contracts.js";
import type { ExternalCarrierPackageRecord } from "../application/package-sync-gateway.js";
import type { PackageRepository } from "../application/package-repository.js";
import type { PackageRecord } from "../domain/package.js";

function sortDimsLargestFirst(length: number, width: number, height: number): [number, number, number] {
  const dims = [length, width, height].filter((value) => value && value > 0).sort((a, b) => b - a);
  return dims.length === 3 ? [dims[0], dims[1], dims[2]] : [0, 0, 0];
}

function normalizeDimension(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapPackage(row: Record<string, unknown> | undefined): PackageRecord | null {
  if (!row) return null;
  return {
    packageId: Number(row.packageId),
    name: String(row.name),
    type: row.type == null ? null : String(row.type),
    length: row.length == null ? null : Number(row.length),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    tareWeightOz: row.tareWeightOz == null ? null : Number(row.tareWeightOz),
    source: row.source == null ? null : String(row.source),
    carrierCode: row.carrierCode == null ? null : String(row.carrierCode),
    stockQty: row.stockQty == null ? null : Number(row.stockQty),
    reorderLevel: row.reorderLevel == null ? null : Number(row.reorderLevel),
    unitCost: row.unitCost == null ? null : Number(row.unitCost),
  };
}

export class PgPackageRepository implements PackageRepository {
  private readonly sql: PgClient;
  private packageColumnsPromise: Promise<Set<string>> | null = null;

  constructor(sql: PgClient) {
    this.sql = sql;
  }

  private async getPackageColumns(): Promise<Set<string>> {
    if (!this.packageColumnsPromise) {
      this.packageColumnsPromise = (async () => {
        const rows = await this.sql`
          SELECT column_name FROM information_schema.columns WHERE table_name = 'packages'
        `;
        return new Set((rows as Array<{ column_name: string }>).map((row) => row.column_name));
      })();
    }
    return this.packageColumnsPromise;
  }

  async list(source?: string): Promise<PackageRecord[]> {
    const rows = source && source !== "all"
      ? await this.sql`SELECT * FROM packages WHERE source = ${source} ORDER BY source ASC, "carrierCode" ASC, name ASC`
      : await this.sql`SELECT * FROM packages ORDER BY source ASC, "carrierCode" ASC, name ASC`;
    return (rows as Array<Record<string, unknown>>).map((row) => mapPackage(row) as PackageRecord);
  }

  async listLowStock(): Promise<PackageRecord[]> {
    const rows = await this.sql`
      SELECT * FROM packages
      WHERE source = 'custom' AND COALESCE("stockQty", 0) <= COALESCE("reorderLevel", 10)
      ORDER BY name ASC
    `;
    return (rows as Array<Record<string, unknown>>).map((row) => mapPackage(row) as PackageRecord);
  }

  async findByDims(length: number, width: number, height: number): Promise<PackageRecord | null> {
    const rows = await this.sql`
      SELECT * FROM packages
      WHERE source = 'custom' AND length = ${length} AND width = ${width} AND height = ${height}
      ORDER BY "packageId" ASC
      LIMIT 1
    `;
    return mapPackage((rows as Array<Record<string, unknown>>)[0]);
  }

  async getById(packageId: number): Promise<PackageRecord | null> {
    const rows = await this.sql`SELECT * FROM packages WHERE "packageId" = ${packageId}`;
    return mapPackage((rows as Array<Record<string, unknown>>)[0]);
  }

  async create(input: SavePackageInput): Promise<number> {
    const now = Date.now();
    const rows = await this.sql`
      INSERT INTO packages (name, type, length, width, height, "tareWeightOz", "unitCost", "createdAt", "updatedAt")
      VALUES (${input.name}, ${input.type ?? "box"}, ${input.length ?? 0}, ${input.width ?? 0}, ${input.height ?? 0}, ${input.tareWeightOz ?? 0}, ${input.unitCost ?? null}, ${now}, ${now})
      RETURNING "packageId"
    `;
    return Number((rows[0] as { packageId: number }).packageId);
  }

  async update(packageId: number, input: SavePackageInput): Promise<void> {
    await this.sql`
      UPDATE packages
      SET name = ${input.name}, type = ${input.type ?? "box"}, length = ${input.length ?? 0}, width = ${input.width ?? 0}, height = ${input.height ?? 0}, "tareWeightOz" = ${input.tareWeightOz ?? 0}, "reorderLevel" = ${input.reorderLevel ?? 10}, "unitCost" = ${input.unitCost ?? null}, "updatedAt" = ${Date.now()}
      WHERE "packageId" = ${packageId}
    `;
  }

  async delete(packageId: number): Promise<void> {
    await this.sql`DELETE FROM packages WHERE "packageId" = ${packageId}`;
  }

  async receive(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null> {
    const now = Date.now();
    if (input.costPerUnit != null && input.costPerUnit >= 0) {
      await this.sql`
        UPDATE packages SET "stockQty" = COALESCE("stockQty", 0) + ${input.qty}, "unitCost" = ${input.costPerUnit}, "updatedAt" = ${now} WHERE "packageId" = ${packageId}
      `;
    } else {
      await this.sql`
        UPDATE packages SET "stockQty" = COALESCE("stockQty", 0) + ${input.qty}, "updatedAt" = ${now} WHERE "packageId" = ${packageId}
      `;
    }
    await this.sql`
      INSERT INTO package_ledger ("packageId", delta, reason, "unitCost", "createdAt") VALUES (${packageId}, ${input.qty}, ${`receive: ${input.note ?? ""}`}, ${input.costPerUnit ?? null}, ${now})
    `;
    return this.getById(packageId);
  }

  async adjust(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null> {
    const now = Date.now();
    await this.sql`
      UPDATE packages SET "stockQty" = COALESCE("stockQty", 0) + ${input.qty}, "updatedAt" = ${now} WHERE "packageId" = ${packageId}
    `;
    await this.sql`
      INSERT INTO package_ledger ("packageId", delta, reason, "createdAt") VALUES (${packageId}, ${input.qty}, ${`adjust: ${input.note ?? ""}`}, ${now})
    `;
    return this.getById(packageId);
  }

  async setReorderLevel(packageId: number, reorderLevel: number): Promise<void> {
    await this.sql`UPDATE packages SET "reorderLevel" = ${reorderLevel}, "updatedAt" = ${Date.now()} WHERE "packageId" = ${packageId}`;
  }

  async getLedger(packageId: number): Promise<Record<string, unknown>[]> {
    return await this.sql`
      SELECT * FROM package_ledger WHERE "packageId" = ${packageId} ORDER BY "createdAt" DESC LIMIT 20
    ` as Record<string, unknown>[];
  }

  async autoCreate(input: AutoCreatePackageInput): Promise<{ package: PackageRecord; isNew: boolean }> {
    const [length, width, height] = sortDimsLargestFirst(input.length, input.width, input.height);
    const l2 = normalizeDimension(length);
    const w2 = normalizeDimension(width);
    const h2 = normalizeDimension(height);

    const existing = await this.findByDims(l2, w2, h2);
    if (existing) {
      return { package: existing, isNew: false };
    }

    const name = `${l2.toFixed(1).replace(/\.0$/, "")}x${w2.toFixed(1).replace(/\.0$/, "")}x${h2.toFixed(1).replace(/\.0$/, "")}`;
    const now = Date.now();
    const insertRows = await this.sql`
      INSERT INTO packages (name, type, length, width, height, source, "createdAt", "updatedAt")
      VALUES (${name}, 'box', ${l2}, ${w2}, ${h2}, 'custom', ${now}, ${now})
      RETURNING "packageId"
    `;
    const newPackageId = Number((insertRows[0] as { packageId: number }).packageId);

    const created = await this.getById(newPackageId);
    if (!created) {
      throw new Error("Package creation failed");
    }

    if (input.sku && input.clientId) {
      const invSkuRows = await this.sql`
        SELECT id FROM inventory_skus WHERE "clientId" = ${input.clientId} AND sku = ${input.sku}
      `;
      const invSku = invSkuRows[0] as { id: number } | undefined;

      if (invSku) {
        await this.sql`
          UPDATE inventory_skus SET "packageId" = ${created.packageId}, "updatedAt" = ${now} WHERE id = ${invSku.id}
        `;
      }
    }

    return { package: created, isNew: true };
  }

  async syncCarrierPackages(carrierCode: string, packages: ExternalCarrierPackageRecord[]): Promise<void> {
    const now = Date.now();
    const packageColumns = await this.getPackageColumns();
    const hasPackageCode = packageColumns.has("packageCode");
    const hasDomestic = packageColumns.has("domestic");
    const hasInternational = packageColumns.has("international");
    const sourceValue = hasPackageCode ? "ss_carrier" : "carrier";

    for (const pkg of packages) {
      const lookupValue = hasPackageCode ? pkg.code : pkg.name;

      // Find existing row
      let existingRows: Array<Record<string, unknown>>;
      if (hasPackageCode) {
        existingRows = await this.sql`
          SELECT "packageId" FROM packages WHERE source = ${sourceValue} AND "carrierCode" = ${carrierCode} AND "packageCode" = ${lookupValue} LIMIT 1
        ` as Array<Record<string, unknown>>;
      } else {
        existingRows = await this.sql`
          SELECT "packageId" FROM packages WHERE source = ${sourceValue} AND "carrierCode" = ${carrierCode} AND name = ${lookupValue} LIMIT 1
        ` as Array<Record<string, unknown>>;
      }

      const row = existingRows[0] as { packageId: number } | undefined;

      if (row) {
        // Update existing package - build update using core fields always present
        // We need to handle optional columns; since tagged templates don't allow dynamic column names,
        // we use separate queries based on which columns exist.
        if (hasPackageCode && hasDomestic && hasInternational) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              domestic = ${pkg.domestic ? 1 : 0}, international = ${pkg.international ? 1 : 0}, "packageCode" = ${pkg.code}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasPackageCode && hasDomestic) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              domestic = ${pkg.domestic ? 1 : 0}, "packageCode" = ${pkg.code}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasPackageCode && hasInternational) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              international = ${pkg.international ? 1 : 0}, "packageCode" = ${pkg.code}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasDomestic && hasInternational) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              domestic = ${pkg.domestic ? 1 : 0}, international = ${pkg.international ? 1 : 0}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasPackageCode) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              "packageCode" = ${pkg.code}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasDomestic) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              domestic = ${pkg.domestic ? 1 : 0}
            WHERE "packageId" = ${row.packageId}
          `;
        } else if (hasInternational) {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now},
              international = ${pkg.international ? 1 : 0}
            WHERE "packageId" = ${row.packageId}
          `;
        } else {
          await this.sql`
            UPDATE packages SET
              name = ${pkg.name}, type = ${pkg.type ?? "box"}, length = ${pkg.length ?? 0}, width = ${pkg.width ?? 0}, height = ${pkg.height ?? 0},
              "tareWeightOz" = ${pkg.tareWeightOz ?? 0}, source = ${sourceValue}, "carrierCode" = ${carrierCode}, "updatedAt" = ${now}
            WHERE "packageId" = ${row.packageId}
          `;
        }
        continue;
      }

      // Insert new package
      if (hasPackageCode && hasDomestic && hasInternational) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", "packageCode", domestic, international)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.code}, ${pkg.domestic ? 1 : 0}, ${pkg.international ? 1 : 0})
        `;
      } else if (hasPackageCode && hasDomestic) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", "packageCode", domestic)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.code}, ${pkg.domestic ? 1 : 0})
        `;
      } else if (hasPackageCode && hasInternational) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", "packageCode", international)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.code}, ${pkg.international ? 1 : 0})
        `;
      } else if (hasDomestic && hasInternational) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", domestic, international)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.domestic ? 1 : 0}, ${pkg.international ? 1 : 0})
        `;
      } else if (hasPackageCode) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", "packageCode")
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.code})
        `;
      } else if (hasDomestic) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", domestic)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.domestic ? 1 : 0})
        `;
      } else if (hasInternational) {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt", international)
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now}, ${pkg.international ? 1 : 0})
        `;
      } else {
        await this.sql`
          INSERT INTO packages (name, type, length, width, height, "tareWeightOz", source, "carrierCode", "createdAt", "updatedAt")
          VALUES (${pkg.name}, ${pkg.type ?? "box"}, ${pkg.length ?? 0}, ${pkg.width ?? 0}, ${pkg.height ?? 0}, ${pkg.tareWeightOz ?? 0}, ${sourceValue}, ${carrierCode}, ${now}, ${now})
        `;
      }
    }

    try {
      await this.sql`
        INSERT INTO sync_meta (key, value)
        VALUES ('lastPackageSync', ${String(now)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
    } catch {
      // Some test fixtures may omit sync_meta.
    }
  }
}
