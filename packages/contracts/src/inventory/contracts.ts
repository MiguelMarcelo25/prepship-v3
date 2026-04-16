import { parseOptionalIntegerParam } from "../common/input-validation.js";

export interface InventoryItemDto {
  id: number;
  clientId: number;
  sku: string;
  name: string;
  minStock: number;
  active: boolean;
  weightOz: number;
  parentSkuId: number | null;
  baseUnitQty: number;
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  productLength: number;
  productWidth: number;
  productHeight: number;
  packageId: number | null;
  units_per_pack: number;
  cuFtOverride: number | null;
  clientName: string;
  packageName: string | null;
  packageDimLength: number | null;
  packageDimWidth: number | null;
  packageDimHeight: number | null;
  parentName: string | null;
  currentStock: number;
  lastMovement: number | null;
  imageUrl: string | null;
  baseUnits: number;
  status: "ok" | "low" | "out";
}

export interface InventoryLedgerEntryDto {
  id: number;
  invSkuId: number;
  type: string;
  qty: number;
  orderId: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  sku: string;
  skuName: string;
  clientId: number;
  clientName: string;
}

export interface InventoryAlertDto {
  type: "sku" | "parent";
  id: number;
  sku?: string;
  name: string;
  stock: number;
  minStock: number;
  parentSkuId: number | null;
  status: "out" | "low";
}

export interface ParentSkuDto {
  parentSkuId: number;
  clientId: number;
  name: string;
  sku?: string | null;
  baseUnitQty?: number;
  childCount?: number;
  totalBaseUnits?: number;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface ParentSkuDetailDto extends ParentSkuDto {
  children: Array<{
    id: number;
    sku: string;
    name: string;
    minStock: number;
    active: boolean;
    baseUnitQty: number;
    baseUnits: number;
  }>;
  lowStockCount: number;
  lowStockChildren: Array<{
    id: number;
    sku: string;
    name: string;
    minStock: number;
    active: boolean;
    baseUnitQty: number;
    baseUnits: number;
  }>;
}

export interface SaveParentSkuInput {
  clientId: number;
  name: string;
  sku?: string;
  baseUnitQty?: number;
}

export interface SetInventoryParentInput {
  parentSkuId: number | null;
  baseUnitQty?: number;
}

export interface ReceiveInventoryItemInput {
  sku: string;
  name?: string;
  qty: number;
}

export interface ReceiveInventoryInput {
  clientId: number;
  items: ReceiveInventoryItemInput[];
  note?: string;
  receivedAt?: string | number;
}

export interface ReceiveInventoryResultDto {
  sku: string;
  qty: number;
  baseUnitQty: number;
  baseUnits: number;
  invSkuId: number;
  newStock: number;
}

export interface AdjustInventoryInput {
  invSkuId: number;
  qty: number;
  note?: string;
  type?: string;
  adjustedAt?: string | number;
}

export interface UpdateInventoryItemInput {
  name?: string;
  minStock?: number;
  weightOz?: number;
  length?: number;
  width?: number;
  height?: number;
  productLength?: number;
  productWidth?: number;
  productHeight?: number;
  packageId?: number | null;
  units_per_pack?: number;
  cuFtOverride?: number | null;
}

export interface ListInventoryQuery {
  clientId?: number;
  sku?: string;
}

export interface ListInventoryLedgerQuery {
  clientId?: number;
  type?: string;
  dateStart?: number;
  dateEnd?: number;
  limit: number;
}

export interface BulkUpdateInventoryDimensionsInput {
  updates: Array<{
    invSkuId: number;
    weightOz?: number;
    productLength?: number;
    productWidth?: number;
    productHeight?: number;
  }>;
}

export function parseListInventoryQuery(url: URL): ListInventoryQuery {
  return {
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
    sku: url.searchParams.get("sku") ?? undefined,
  };
}

export function parseListInventoryLedgerQuery(url: URL): ListInventoryLedgerQuery {
  const limit = parseOptionalIntegerParam(url.searchParams.get("limit"), "limit") ?? 500;
  return {
    clientId: parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId"),
    type: url.searchParams.get("type") ?? undefined,
    dateStart: parseOptionalIntegerParam(url.searchParams.get("dateStart"), "dateStart"),
    dateEnd: parseOptionalIntegerParam(url.searchParams.get("dateEnd"), "dateEnd"),
    limit: Math.min(Math.max(limit, 1), 2000),
  };
}
