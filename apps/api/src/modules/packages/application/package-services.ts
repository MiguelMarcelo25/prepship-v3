import type {
  AutoCreatePackageInput,
  PackageAdjustmentInput,
  PackageDto,
  SavePackageInput,
} from "../../../../../../packages/contracts/src/packages/contracts.ts";
import type { PackageRepository } from "./package-repository.ts";
import type { PackageSyncGateway } from "./package-sync-gateway.ts";
import type { PackageRecord } from "../domain/package.ts";

function mapPackage(record: PackageRecord): PackageDto {
  return {
    packageId: record.packageId,
    name: record.name,
    type: record.type ?? "box",
    length: Number(record.length ?? 0),
    width: Number(record.width ?? 0),
    height: Number(record.height ?? 0),
    tareWeightOz: Number(record.tareWeightOz ?? 0),
    source: record.source,
    carrierCode: record.carrierCode,
    stockQty: record.stockQty,
    reorderLevel: record.reorderLevel,
    unitCost: record.unitCost,
  };
}

const KNOWN_PKG_DIMS: Record<string, { l: number; w: number; h: number; type: string; tare: number }> = {
  "stamps_com|package": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "stamps_com|flat_rate_envelope": { l: 12.5, w: 9.5, h: 0.5, type: "envelope", tare: 1 },
  "stamps_com|flat_rate_legal_envelope": { l: 15, w: 9.5, h: 0.5, type: "envelope", tare: 1.5 },
  "stamps_com|flat_rate_padded_envelope": { l: 12.5, w: 9.5, h: 1, type: "envelope", tare: 2 },
  "stamps_com|large_envelope_or_flat": { l: 15, w: 12, h: 0.75, type: "envelope", tare: 0 },
  "stamps_com|large_flat_rate_box": { l: 12.25, w: 12.25, h: 6, type: "flat_rate_box_lg", tare: 8 },
  "stamps_com|large_package": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "stamps_com|letter": { l: 11.5, w: 6, h: 0.25, type: "envelope", tare: 0 },
  "stamps_com|medium_flat_rate_box": { l: 11.25, w: 8.75, h: 6, type: "flat_rate_box_md", tare: 6 },
  "stamps_com|non_rectangular": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "stamps_com|non_standard": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "stamps_com|regional_rate_box_a": { l: 10, w: 7, h: 4.75, type: "box", tare: 4 },
  "stamps_com|regional_rate_box_b": { l: 12, w: 10.25, h: 5, type: "box", tare: 6 },
  "stamps_com|small_flat_rate_box": { l: 8.63, w: 5.38, h: 1.63, type: "flat_rate_box_sm", tare: 3 },
  "stamps_com|thick_envelope": { l: 12.5, w: 9.5, h: 1.5, type: "envelope", tare: 1 },
  "fedex|YOUR_PACKAGING": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "fedex|FEDEX_ENVELOPE": { l: 12.5, w: 9.5, h: 0.25, type: "envelope", tare: 1.5 },
  "fedex|FEDEX_PAK": { l: 15.5, w: 12, h: 0.5, type: "envelope", tare: 2 },
  "fedex|FEDEX_BOX": { l: 12.375, w: 10.875, h: 1.5, type: "box", tare: 4 },
  "fedex|FEDEX_SMALL_BOX": { l: 12.375, w: 10.875, h: 1.5, type: "box", tare: 3 },
  "fedex|FEDEX_MEDIUM_BOX": { l: 13.25, w: 11.5, h: 2.375, type: "box", tare: 5 },
  "fedex|FEDEX_LARGE_BOX": { l: 17.5, w: 12.375, h: 3, type: "box", tare: 7 },
  "fedex|FEDEX_EXTRA_LARGE_BOX": { l: 11.875, w: 10.75, h: 11, type: "box", tare: 10 },
  "fedex|FEDEX_10KG_BOX": { l: 15.81, w: 12.94, h: 10.19, type: "box", tare: 30 },
  "fedex|FEDEX_25KG_BOX": { l: 21.56, w: 16.56, h: 13.19, type: "box", tare: 55 },
  "fedex|FEDEX_TUBE": { l: 38, w: 6, h: 6, type: "box", tare: 2 },
  "ups|package": { l: 0, w: 0, h: 0, type: "box", tare: 0 },
  "ups|ups_letter": { l: 12.5, w: 9.5, h: 0.25, type: "envelope", tare: 1 },
  "ups|ups_express_pak": { l: 16, w: 11.75, h: 0.5, type: "envelope", tare: 1 },
  "ups|ups_tube": { l: 38, w: 6, h: 6, type: "box", tare: 2 },
  "ups|ups_express_box": { l: 13, w: 11, h: 2, type: "box", tare: 4 },
  "ups|ups_express_box_small": { l: 13.25, w: 9.5, h: 2, type: "box", tare: 3 },
  "ups|ups_express_box_medium": { l: 15.25, w: 11.25, h: 3, type: "box", tare: 5 },
  "ups|ups__express_box_large": { l: 18, w: 13, h: 3, type: "box", tare: 7 },
  "ups|ups_10_kg_box": { l: 16.5, w: 13.25, h: 10.75, type: "box", tare: 30 },
  "ups|ups_25_kg_box": { l: 19.75, w: 17.75, h: 13.25, type: "box", tare: 55 },
};

const CARRIER_DISPLAY: Record<string, string> = {
  stamps_com: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  ups_walleted: "UPS",
  fedex_walleted: "FedEx",
};

export class PackageServices {
  private readonly repository: PackageRepository;
  private readonly syncGateway: PackageSyncGateway;
  private syncRunning = false;

  constructor(repository: PackageRepository, syncGateway: PackageSyncGateway) {
    this.repository = repository;
    this.syncGateway = syncGateway;
  }

  async list(source?: string): Promise<PackageDto[]> {
    return (await this.repository.list(source)).map(mapPackage);
  }

  async create(input: SavePackageInput) {
    if (!input.name) throw new Error("name is required");
    return { ok: true, packageId: await this.repository.create(input) };
  }

  async lowStock(): Promise<PackageDto[]> {
    return (await this.repository.listLowStock()).map(mapPackage);
  }

  async findByDims(length: number, width: number, height: number): Promise<PackageDto | null> {
    if (!length || !width || !height) return null;
    const record = await this.repository.findByDims(length, width, height);
    return record ? mapPackage(record) : null;
  }

  async autoCreate(input: AutoCreatePackageInput) {
    if (!input.length || !input.width || !input.height) {
      throw new Error("length, width, height are required");
    }
    const result = await this.repository.autoCreate(input);
    return {
      ok: true,
      package: mapPackage(result.package),
      isNew: result.isNew,
    };
  }

  async getById(packageId: number) {
    const record = await this.repository.getById(packageId);
    return record ? mapPackage(record) : null;
  }

  async update(packageId: number, input: SavePackageInput) {
    await this.repository.update(packageId, input);
    return { ok: true };
  }

  async delete(packageId: number) {
    await this.repository.delete(packageId);
    return { ok: true };
  }

  async receive(packageId: number, input: PackageAdjustmentInput) {
    if (!input.qty || input.qty <= 0) throw new Error("qty must be > 0");
    return { ok: true, package: await this.repository.receive(packageId, input) };
  }

  async adjust(packageId: number, input: PackageAdjustmentInput) {
    if (input.qty == null) throw new Error("qty is required");
    return { ok: true, package: await this.repository.adjust(packageId, input) };
  }

  async setReorderLevel(packageId: number, reorderLevel: number) {
    if (!Number.isFinite(reorderLevel)) throw new Error("reorderLevel must be a number");
    await this.repository.setReorderLevel(packageId, reorderLevel);
    return { ok: true };
  }

  async ledger(packageId: number) {
    return await this.repository.getLedger(packageId);
  }

  sync() {
    if (!this.syncRunning) {
      this.syncRunning = true;
      void this.runCarrierSync().finally(() => {
        this.syncRunning = false;
      });
    }
    return { queued: true };
  }

  private async runCarrierSync(): Promise<void> {
    for (const carrierCode of ["stamps_com", "ups", "fedex"]) {
      const packages = await this.syncGateway.listCarrierPackages(carrierCode);
      const carrierLabel = CARRIER_DISPLAY[carrierCode] || carrierCode.toUpperCase();
      await this.repository.syncCarrierPackages(carrierCode, packages.map((entry) => {
        const dims = KNOWN_PKG_DIMS[`${carrierCode}|${entry.code}`] || { l: 0, w: 0, h: 0, type: "box", tare: 0 };
        return {
          ...entry,
          name: `[${carrierLabel}] ${entry.name}`,
          type: dims.type,
          length: dims.l,
          width: dims.w,
          height: dims.h,
          tareWeightOz: dims.tare,
        };
      }));
    }
  }
}
