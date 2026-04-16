import type {
  AdjustInventoryInput,
  BulkUpdateInventoryDimensionsInput,
  ReceiveInventoryInput,
  SaveParentSkuInput,
  SetInventoryParentInput,
  UpdateInventoryItemInput,
} from "../../../../../../packages/contracts/src/inventory/contracts.js";
import { InputValidationError, parseOptionalIntegerParam } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { parseListInventoryLedgerQuery, parseListInventoryQuery } from "../../../../../../packages/contracts/src/inventory/contracts.js";
import type { InventoryServices } from "../application/inventory-services.js";

export class InventoryHttpHandler {
  private readonly services: InventoryServices;

  constructor(services: InventoryServices) {
    this.services = services;
  }

  async handleList(url: URL) {
    return await this.services.list(parseListInventoryQuery(url));
  }

  async handleReceive(body: ReceiveInventoryInput) {
    return await this.services.receive(body);
  }

  async handleAdjust(body: AdjustInventoryInput) {
    return await this.services.adjust(body);
  }

  async handleUpdate(inventoryId: number, body: UpdateInventoryItemInput) {
    return await this.services.update(inventoryId, body);
  }

  async handleLedger(url: URL) {
    return await this.services.listLedger(parseListInventoryLedgerQuery(url));
  }

  async handleInventoryLedger(inventoryId: number) {
    return await this.services.getLedger(inventoryId);
  }

  async handleAlerts(clientId: number) {
    return await this.services.listAlerts(clientId);
  }

  async handlePopulate() {
    return await this.services.populate();
  }

  async handleImportDimensions(url: URL) {
    const clientId = parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId");
    return await this.services.importProductDimensions(clientId, url.searchParams.get("overwrite") === "1");
  }

  async handleBulkUpdateDimensions(body: BulkUpdateInventoryDimensionsInput) {
    return await this.services.bulkUpdateDimensions(body);
  }

  async handleListParentSkus(url: URL) {
    const rawId = url.searchParams.get("id");
    if (rawId) {
      const parentSkuId = parseOptionalIntegerParam(rawId, "id");
      if (parentSkuId == null) {
        throw new InputValidationError("id required");
      }
      return await this.services.getParentSku(parentSkuId);
    }
    const clientId = parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId");
    return await this.services.listParentSkus(clientId ?? 0);
  }

  async handleCreateParentSku(body: SaveParentSkuInput) {
    return await this.services.createParentSku(body);
  }

  async handleSetParent(inventoryId: number, body: SetInventoryParentInput) {
    return await this.services.setParent(inventoryId, body);
  }

  async handleDeleteParent(parentSkuId: number) {
    return await this.services.deleteParent(parentSkuId);
  }

  async handleSkuOrders(inventoryId: number, url: URL) {
    const days = parseOptionalIntegerParam(url.searchParams.get("days"), "days");
    return await this.services.getSkuOrders(inventoryId, days);
  }
}
