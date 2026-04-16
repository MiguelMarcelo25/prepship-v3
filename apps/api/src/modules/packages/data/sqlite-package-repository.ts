import type { DatabaseSync } from "node:sqlite";
import type {
  AutoCreatePackageInput,
  PackageDto,
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

export class SqlitePackageRepository implements PackageRepository {
  private readonly db: DatabaseSync;
  private readonly packageColumns: Set<string>;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.packageColumns = new Set((this.db.prepare(`PRAGMA table_info(packages)`).all() as Array<{ name: string }>).map((row) => row.name));
  }

  async list(source?: string): Promise<PackageRecord[]> {
    const sql = source && source !== "all"
      ? "SELECT * FROM packages WHERE source = ? ORDER BY source ASC, carrierCode ASC, name ASC"
      : "SELECT * FROM packages ORDER BY source ASC, carrierCode ASC, name ASC";
    const rows = source && source !== "all"
      ? this.db.prepare(sql).all(source)
      : this.db.prepare(sql).all();
    return (rows as Array<Record<string, unknown>>).map((row) => mapPackage(row) as PackageRecord);
  }

  async listLowStock(): Promise<PackageRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM packages
      WHERE source = 'custom' AND COALESCE(stockQty, 0) <= COALESCE(reorderLevel, 10)
      ORDER BY name ASC
    `).all();
    return (rows as Array<Record<string, unknown>>).map((row) => mapPackage(row) as PackageRecord);
  }

  async findByDims(length: number, width: number, height: number): Promise<PackageRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM packages
      WHERE source = 'custom' AND length = ? AND width = ? AND height = ?
      ORDER BY packageId ASC
      LIMIT 1
    `).get(length, width, height) as Record<string, unknown> | undefined;
    return mapPackage(row);
  }

  async getById(packageId: number): Promise<PackageRecord | null> {
    const row = this.db.prepare("SELECT * FROM packages WHERE packageId = ?").get(packageId) as Record<string, unknown> | undefined;
    return mapPackage(row);
  }

  async create(input: SavePackageInput): Promise<number> {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO packages (name, type, length, width, height, tareWeightOz, unitCost, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.type ?? "box",
      input.length ?? 0,
      input.width ?? 0,
      input.height ?? 0,
      input.tareWeightOz ?? 0,
      input.unitCost ?? null,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  async update(packageId: number, input: SavePackageInput): Promise<void> {
    this.db.prepare(`
      UPDATE packages
      SET name = ?, type = ?, length = ?, width = ?, height = ?, tareWeightOz = ?, reorderLevel = ?, unitCost = ?, updatedAt = ?
      WHERE packageId = ?
    `).run(
      input.name,
      input.type ?? "box",
      input.length ?? 0,
      input.width ?? 0,
      input.height ?? 0,
      input.tareWeightOz ?? 0,
      input.reorderLevel ?? 10,
      input.unitCost ?? null,
      Date.now(),
      packageId,
    );
  }

  async delete(packageId: number): Promise<void> {
    this.db.prepare("DELETE FROM packages WHERE packageId = ?").run(packageId);
  }

  async receive(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null> {
    const now = Date.now();
    if (input.costPerUnit != null && input.costPerUnit >= 0) {
      this.db.prepare(`
        UPDATE packages SET stockQty = COALESCE(stockQty, 0) + ?, unitCost = ?, updatedAt = ? WHERE packageId = ?
      `).run(input.qty, input.costPerUnit, now, packageId);
    } else {
      this.db.prepare(`
        UPDATE packages SET stockQty = COALESCE(stockQty, 0) + ?, updatedAt = ? WHERE packageId = ?
      `).run(input.qty, now, packageId);
    }
    this.db.prepare(`
      INSERT INTO package_ledger (packageId, delta, reason, unitCost, createdAt) VALUES (?, ?, ?, ?, ?)
    `).run(packageId, input.qty, `receive: ${input.note ?? ""}`, input.costPerUnit ?? null, now);
    return this.getById(packageId);
  }

  async adjust(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE packages SET stockQty = COALESCE(stockQty, 0) + ?, updatedAt = ? WHERE packageId = ?
    `).run(input.qty, now, packageId);
    this.db.prepare(`
      INSERT INTO package_ledger (packageId, delta, reason, createdAt) VALUES (?, ?, ?, ?)
    `).run(packageId, input.qty, `adjust: ${input.note ?? ""}`, now);
    return this.getById(packageId);
  }

  async setReorderLevel(packageId: number, reorderLevel: number): Promise<void> {
    this.db.prepare("UPDATE packages SET reorderLevel = ?, updatedAt = ? WHERE packageId = ?").run(reorderLevel, Date.now(), packageId);
  }

  async getLedger(packageId: number): Promise<Record<string, unknown>[]> {
    return this.db.prepare(`
      SELECT * FROM package_ledger WHERE packageId = ? ORDER BY createdAt DESC LIMIT 20
    `).all(packageId) as Record<string, unknown>[];
  }

  async autoCreate(input: AutoCreatePackageInput): Promise<{ package: PackageRecord; isNew: boolean }> {
    const [length, width, height] = sortDimsLargestFirst(input.length, input.width, input.height);
    const l2 = normalizeDimension(length);
    const w2 = normalizeDimension(width);
    const h2 = normalizeDimension(height);

    let existing = this.findByDims(l2, w2, h2);
    if (existing) {
      return { package: existing, isNew: false };
    }

    const name = `${l2.toFixed(1).replace(/\.0$/, "")}×${w2.toFixed(1).replace(/\.0$/, "")}×${h2.toFixed(1).replace(/\.0$/, "")}`;
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO packages (name, type, length, width, height, source, createdAt, updatedAt)
      VALUES (?, 'box', ?, ?, ?, 'custom', ?, ?)
    `).run(name, l2, w2, h2, now, now);

    const created = this.getById(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Package creation failed");
    }

    if (input.sku && input.clientId) {
      const invSku = this.db.prepare(`
        SELECT id FROM inventory_skus WHERE clientId = ? AND sku = ?
      `).get(input.clientId, input.sku) as { id: number } | undefined;

      if (invSku) {
        this.db.prepare(`
          UPDATE inventory_skus SET packageId = ?, updatedAt = ? WHERE id = ?
        `).run(created.packageId, now, invSku.id);
      }
    }

    return { package: created, isNew: true };
  }

  async syncCarrierPackages(carrierCode: string, packages: ExternalCarrierPackageRecord[]): Promise<void> {
    const now = Date.now();
    const hasPackageCode = this.packageColumns.has("packageCode");
    const hasDomestic = this.packageColumns.has("domestic");
    const hasInternational = this.packageColumns.has("international");
    const sourceValue = hasPackageCode ? "ss_carrier" : "carrier";

    const findSql = hasPackageCode
      ? `SELECT packageId FROM packages WHERE source = ? AND carrierCode = ? AND packageCode = ? LIMIT 1`
      : `SELECT packageId FROM packages WHERE source = ? AND carrierCode = ? AND name = ? LIMIT 1`;

    for (const pkg of packages) {
      const lookupValue = hasPackageCode ? pkg.code : pkg.name;
      const row = this.db.prepare(findSql).get(sourceValue, carrierCode, lookupValue) as { packageId: number } | undefined;

      if (row) {
        const updateAssignments = [
          "name = ?",
          "type = ?",
          "length = ?",
          "width = ?",
          "height = ?",
          "tareWeightOz = ?",
          "source = ?",
          "carrierCode = ?",
          "updatedAt = ?",
        ];
        const params: Array<string | number | null> = [
          pkg.name,
          pkg.type ?? "box",
          pkg.length ?? 0,
          pkg.width ?? 0,
          pkg.height ?? 0,
          pkg.tareWeightOz ?? 0,
          sourceValue,
          carrierCode,
          now,
        ];
        if (hasDomestic) {
          updateAssignments.push("domestic = ?");
          params.push(pkg.domestic ? 1 : 0);
        }
        if (hasInternational) {
          updateAssignments.push("international = ?");
          params.push(pkg.international ? 1 : 0);
        }
        if (hasPackageCode) {
          updateAssignments.push("packageCode = ?");
          params.push(pkg.code);
        }
        params.push(row.packageId);
        this.db.prepare(`UPDATE packages SET ${updateAssignments.join(", ")} WHERE packageId = ?`).run(...params);
        continue;
      }

      const insertColumns = [
        "name",
        "type",
        "length",
        "width",
        "height",
        "tareWeightOz",
        "source",
        "carrierCode",
        "createdAt",
        "updatedAt",
      ];
      const insertValues: Array<string | number | null> = [
        pkg.name,
        pkg.type ?? "box",
        pkg.length ?? 0,
        pkg.width ?? 0,
        pkg.height ?? 0,
        pkg.tareWeightOz ?? 0,
        sourceValue,
        carrierCode,
        now,
        now,
      ];
      if (hasPackageCode) {
        insertColumns.push("packageCode");
        insertValues.push(pkg.code);
      }
      if (hasDomestic) {
        insertColumns.push("domestic");
        insertValues.push(pkg.domestic ? 1 : 0);
      }
      if (hasInternational) {
        insertColumns.push("international");
        insertValues.push(pkg.international ? 1 : 0);
      }
      this.db.prepare(`INSERT INTO packages (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`).run(...insertValues);
    }

    try {
      this.db.prepare(`
        INSERT INTO sync_meta (key, value)
        VALUES ('lastPackageSync', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(now));
    } catch {
      // Some test fixtures may omit sync_meta.
    }
  }
}
