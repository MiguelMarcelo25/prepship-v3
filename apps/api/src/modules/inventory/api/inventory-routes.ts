import { InputValidationError, parseOptionalIntegerParam } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonRoute, type RouteDef } from "../../../app/router.js";
import type { InventoryHttpHandler } from "./inventory-handler.js";

function parseInventoryId(rawInventoryId: string): number {
  return Number.parseInt(rawInventoryId, 10);
}

function parseParentSkuId(rawParentSkuId: string): number {
  return Number.parseInt(rawParentSkuId, 10);
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createInventoryRoutes(handler: InventoryHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/inventory", ({ url }) => handler.handleList(url)),
    jsonRoute("POST", "/api/inventory/receive", async ({ readJson }) => handler.handleReceive(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["clientId required", "items array required"]),
    }),
    jsonRoute("POST", "/api/inventory/adjust", async ({ readJson }) => handler.handleAdjust(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["invSkuId and qty required"]),
    }),
    jsonRoute("GET", "/api/inventory/ledger", ({ url }) => handler.handleLedger(url)),
    jsonRoute(
      "GET",
      "/api/inventory/alerts",
      ({ url }) => {
        const clientId = parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId") ?? 0;
        return handler.handleAlerts(clientId);
      },
      { getErrorStatus: inputErrorStatusWithMessages(["clientId required"]) },
    ),
    jsonRoute("POST", "/api/inventory/populate", () => handler.handlePopulate()),
    jsonRoute("POST", "/api/inventory/import-dims", ({ url }) => handler.handleImportDimensions(url), {
      getErrorStatus: inputErrorStatus,
    }),
    jsonRoute("POST", "/api/inventory/bulk-update-dims", async ({ readJson }) => handler.handleBulkUpdateDimensions(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["updates array required"]),
    }),
    jsonRoute("GET", "/api/parent-skus", ({ url }) => handler.handleListParentSkus(url), {
      getErrorStatus: (error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        return error instanceof InputValidationError || message === "clientId required" || message === "id required"
          ? 400
          : message === "Parent SKU not found"
            ? 404
            : 500;
      },
    }),
    jsonRoute("POST", "/api/parent-skus", async ({ readJson }) => handler.handleCreateParentSku(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["clientId and name required"]),
    }),
    jsonRoute("DELETE", "/api/parent-skus/:parentSkuId(int)", ({ params }) => handler.handleDeleteParent(parseParentSkuId(params.parentSkuId ?? "0")), {
      getErrorStatus: (error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        return message.startsWith("Cannot delete parent") ? 400 : 500;
      },
    }),
    jsonRoute("GET", "/api/inventory/:inventoryId(int)/ledger", ({ params }) => handler.handleInventoryLedger(parseInventoryId(params.inventoryId ?? "0"))),
    jsonRoute("GET", "/api/inventory/:inventoryId(int)/sku-orders", ({ params, url }) => handler.handleSkuOrders(parseInventoryId(params.inventoryId ?? "0"), url), {
      getErrorStatus: (error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        return error instanceof InputValidationError ? 400 : message === "SKU not found" ? 404 : 500;
      },
    }),
    jsonRoute(
      "PUT",
      "/api/inventory/:inventoryId(int)/set-parent",
      async ({ params, readJson }) => handler.handleSetParent(parseInventoryId(params.inventoryId ?? "0"), await readJson() as never),
      {
        getErrorStatus: (error) => {
          const message = error instanceof Error ? error.message : "Unknown error";
          return error instanceof InputValidationError ? 400 : message === "Parent SKU not found" ? 404 : 500;
        },
      },
    ),
    jsonRoute(
      "PUT",
      "/api/inventory/:inventoryId(int)",
      async ({ params, readJson }) => handler.handleUpdate(parseInventoryId(params.inventoryId ?? "0"), await readJson() as never),
      {
        getErrorStatus: (error) => {
          const message = error instanceof Error ? error.message : "Unknown error";
          return error instanceof InputValidationError || message.includes("dimensions must be all > 0 or all 0") ? 400 : 500;
        },
      },
    ),
  ];
}
