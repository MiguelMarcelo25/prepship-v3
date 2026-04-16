import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonRoute, type RouteDef } from "../../../app/router.js";
import type { ClientsHttpHandler } from "./clients-handler.js";

function getErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function getCreateErrorStatus(error: unknown): number {
  return error instanceof InputValidationError || (error instanceof Error && error.message === "name is required") ? 400 : 500;
}

function parseClientId(rawClientId: string): number {
  return Number.parseInt(rawClientId, 10);
}

export function createClientRoutes(handler: ClientsHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/clients", () => handler.handleList()),
    jsonRoute("POST", "/api/clients", async ({ readJson }) => handler.handleCreate(await readJson()), { getErrorStatus: getCreateErrorStatus }),
    jsonRoute("POST", "/api/clients/sync-stores", () => handler.handleSyncStores(), { getErrorStatus }),
    jsonRoute(
      "PUT",
      "/api/clients/:clientId(int)",
      async ({ params, readJson }) => handler.handleUpdate(parseClientId(params.clientId ?? "0"), await readJson()),
      { getErrorStatus },
    ),
    jsonRoute(
      "DELETE",
      "/api/clients/:clientId(int)",
      ({ params }) => handler.handleDelete(parseClientId(params.clientId ?? "0")),
      { getErrorStatus: () => 500 },
    ),
  ];
}
