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
import type { InventoryAlertRecord, InventoryRecord } from "../domain/inventory.js";

export interface InventoryRepository {
  list(query: ListInventoryQuery): Promise<InventoryRecord[]>;
  receive(input: ReceiveInventoryInput): Promise<ReceiveInventoryResultDto[]>;
  adjust(input: AdjustInventoryInput): Promise<number>;
  update(inventoryId: number, input: UpdateInventoryItemInput): Promise<void>;
  listLedger(query: ListInventoryLedgerQuery): Promise<Record<string, unknown>[]>;
  getLedgerByInventoryId(inventoryId: number): Promise<Record<string, unknown>[]>;
  listAlerts(clientId: number): Promise<InventoryAlertRecord[]>;
  populate(): Promise<{ ok: true; skusRegistered: number; shippedProcessed: number }>;
  importProductDimensions(clientId?: number, overwrite?: boolean): Promise<{ ok: true; updated: number; skipped: number; noMatch: number; total: number }>;
  bulkUpdateDimensions(input: BulkUpdateInventoryDimensionsInput): Promise<{ ok: true; updated: number }>;
  listParentSkus(clientId: number): Promise<ParentSkuDto[]>;
  getParentSku(parentSkuId: number): Promise<ParentSkuDetailDto | null>;
  createParentSku(input: SaveParentSkuInput): Promise<{ ok: true; parentSkuId: number; sku?: string; baseUnitQty: number }>;
  setParent(inventoryId: number, input: SetInventoryParentInput): Promise<{ ok: true }>;
  deleteParent(parentSkuId: number): Promise<{ ok: true }>;
  getSkuOrders(inventoryId: number, days?: number): Promise<Record<string, unknown> | null>;
}
