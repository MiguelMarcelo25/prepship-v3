import type {
  AutoCreatePackageInput,
  PackageDto,
  PackageAdjustmentInput,
  SavePackageInput,
} from "../../../../../../packages/contracts/src/packages/contracts.ts";
import type { PackageRecord } from "../domain/package.ts";
import type { ExternalCarrierPackageRecord } from "./package-sync-gateway.ts";

export interface PackageRepository {
  list(source?: string): Promise<PackageRecord[]>;
  listLowStock(): Promise<PackageRecord[]>;
  findByDims(length: number, width: number, height: number): Promise<PackageRecord | null>;
  getById(packageId: number): Promise<PackageRecord | null>;
  create(input: SavePackageInput): Promise<number>;
  update(packageId: number, input: SavePackageInput): Promise<void>;
  delete(packageId: number): Promise<void>;
  receive(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null>;
  adjust(packageId: number, input: PackageAdjustmentInput): Promise<PackageRecord | null>;
  setReorderLevel(packageId: number, reorderLevel: number): Promise<void>;
  getLedger(packageId: number): Promise<Record<string, unknown>[]>;
  autoCreate(input: AutoCreatePackageInput): Promise<{ package: PackageRecord; isNew: boolean }>;
  syncCarrierPackages(carrierCode: string, packages: ExternalCarrierPackageRecord[]): Promise<void>;
}
