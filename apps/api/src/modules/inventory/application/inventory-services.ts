import type {
  AdjustInventoryInput,
  BulkUpdateInventoryDimensionsInput,
  InventoryAlertDto,
  InventoryItemDto,
  ListInventoryLedgerQuery,
  ListInventoryQuery,
  SaveParentSkuInput,
  SetInventoryParentInput,
  ReceiveInventoryInput,
  UpdateInventoryItemInput,
} from "../../../../../../packages/contracts/src/inventory/contracts.js";
import type { InventoryRepository } from "./inventory-repository.js";

function validateDimensionTriplet(label: string, values: number[]) {
  const count = values.filter((value) => value > 0).length;
  if (count > 0 && count < 3) {
    throw new Error(`${label} dimensions must be all > 0 or all 0`);
  }
}

function normalizePositive(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return parsed > 0 ? parsed : 0;
}

export class InventoryServices {
  private readonly repository: InventoryRepository;

  constructor(repository: InventoryRepository) {
    this.repository = repository;
  }

  async list(query: ListInventoryQuery): Promise<InventoryItemDto[]> {
    return (await this.repository.list(query)).map((record) => {
      const baseUnits = record.currentStock * (record.baseUnitQty || 1);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { unitsPerPack, ...rest } = record;
      return {
        ...rest,
        active: Boolean(record.active), // Convert SQLite 0/1 to boolean
        packageLength: record.packageLength,
        packageWidth: record.packageWidth,
        packageHeight: record.packageHeight,
        units_per_pack: record.unitsPerPack,
        baseUnits,
        status: baseUnits <= 0 ? "out" : baseUnits <= record.minStock ? "low" : "ok",
      };
    });
  }

  async receive(input: ReceiveInventoryInput) {
    if (!input.clientId) throw new Error("clientId required");
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("items array required");
    return { ok: true, received: await this.repository.receive(input) };
  }

  async adjust(input: AdjustInventoryInput) {
    if (!input.invSkuId || input.qty == null) throw new Error("invSkuId and qty required");
    return { ok: true, newStock: await this.repository.adjust(input) };
  }

  async update(inventoryId: number, input: UpdateInventoryItemInput) {
    const packageDims = [
      normalizePositive(input.length),
      normalizePositive(input.width),
      normalizePositive(input.height),
    ];
    const productDims = [
      normalizePositive(input.productLength),
      normalizePositive(input.productWidth),
      normalizePositive(input.productHeight),
    ];
    validateDimensionTriplet("Package", packageDims);
    validateDimensionTriplet("Product", productDims);

    await this.repository.update(inventoryId, {
      ...input,
      length: packageDims[0],
      width: packageDims[1],
      height: packageDims[2],
      productLength: productDims[0],
      productWidth: productDims[1],
      productHeight: productDims[2],
      cuFtOverride: input.cuFtOverride != null && Number(input.cuFtOverride) > 0 ? Number(input.cuFtOverride) : null,
      units_per_pack: Math.max(1, Number.parseInt(String(input.units_per_pack ?? 1), 10) || 1),
    });
    return { ok: true };
  }

  async listLedger(query: ListInventoryLedgerQuery) {
    return await this.repository.listLedger(query);
  }

  async getLedger(inventoryId: number) {
    return await this.repository.getLedgerByInventoryId(inventoryId);
  }

  async listAlerts(clientId: number): Promise<InventoryAlertDto[]> {
    if (!clientId) throw new Error("clientId required");
    return (await this.repository.listAlerts(clientId)).map((alert) => ({
      ...alert,
      status: alert.stock <= 0 ? "out" : "low",
    }));
  }

  async populate() {
    return await this.repository.populate();
  }

  async importProductDimensions(clientId?: number, overwrite = false) {
    return await this.repository.importProductDimensions(clientId, overwrite);
  }

  async bulkUpdateDimensions(input: BulkUpdateInventoryDimensionsInput) {
    if (!Array.isArray(input.updates) || input.updates.length === 0) {
      throw new Error("updates array required");
    }
    return await this.repository.bulkUpdateDimensions(input);
  }

  async listParentSkus(clientId: number) {
    if (!clientId) throw new Error("clientId required");
    return await this.repository.listParentSkus(clientId);
  }

  async getParentSku(parentSkuId: number) {
    const result = await this.repository.getParentSku(parentSkuId);
    if (!result) {
      throw new Error("Parent SKU not found");
    }
    // Convert SQLite 0/1 to boolean for active field in children
    return {
      ...result,
      children: result.children.map((child) => ({
        ...child,
        active: Boolean(child.active),
      })),
      lowStockChildren: result.lowStockChildren.map((child) => ({
        ...child,
        active: Boolean(child.active),
      })),
    };
  }

  async createParentSku(input: SaveParentSkuInput) {
    if (!input.clientId || !input.name) {
      throw new Error("clientId and name required");
    }
    return await this.repository.createParentSku(input);
  }

  async setParent(inventoryId: number, input: SetInventoryParentInput) {
    return await this.repository.setParent(inventoryId, input);
  }

  async deleteParent(parentSkuId: number) {
    return await this.repository.deleteParent(parentSkuId);
  }

  async getSkuOrders(inventoryId: number, days?: number) {
    const result = await this.repository.getSkuOrders(inventoryId, days);
    if (!result) {
      throw new Error("SKU not found");
    }
    return result;
  }
}
