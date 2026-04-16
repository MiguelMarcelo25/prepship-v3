import type {
  AutoCreatePackageInput,
  PackageAdjustmentInput,
  SavePackageInput,
} from "../../../../../../packages/contracts/src/packages/contracts.ts";
import type { PackageServices } from "../application/package-services.ts";

export class PackagesHttpHandler {
  private readonly services: PackageServices;

  constructor(services: PackageServices) {
    this.services = services;
  }

  async handleList(source?: string) {
    return await this.services.list(source);
  }

  async handleCreate(body: SavePackageInput) {
    return await this.services.create(body);
  }

  async handleLowStock() {
    return await this.services.lowStock();
  }

  async handleFindByDims(length: number, width: number, height: number) {
    return await this.services.findByDims(length, width, height);
  }

  async handleAutoCreate(body: AutoCreatePackageInput) {
    return await this.services.autoCreate(body);
  }

  async handleGetById(packageId: number) {
    return await this.services.getById(packageId);
  }

  async handleUpdate(packageId: number, body: SavePackageInput) {
    return await this.services.update(packageId, body);
  }

  async handleDelete(packageId: number) {
    return await this.services.delete(packageId);
  }

  async handleReceive(packageId: number, body: PackageAdjustmentInput) {
    return await this.services.receive(packageId, body);
  }

  async handleAdjust(packageId: number, body: PackageAdjustmentInput) {
    return await this.services.adjust(packageId, body);
  }

  async handleSetReorderLevel(packageId: number, reorderLevel: number) {
    return await this.services.setReorderLevel(packageId, reorderLevel);
  }

  async handleLedger(packageId: number) {
    return await this.services.ledger(packageId);
  }

  handleSync() {
    return this.services.sync();
  }
}
