import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonRoute, type RouteDef } from "../../../app/router.js";
import type { InitHttpHandler } from "./init-handler.js";

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

export function createInitRoutes(handler: InitHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/init-data", () => handler.handleInitData(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("GET", "/api/counts", () => handler.handleCounts(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("GET", "/api/stores", () => handler.handleStores(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("GET", "/api/carriers", () => handler.handleCarriers(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("GET", "/api/carrier-accounts", () => handler.handleCarrierAccounts(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("POST", "/api/cache/refresh-carriers", () => handler.handleRefreshCarriers()),
  ];
}
