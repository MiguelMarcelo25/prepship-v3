import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { LocationsHttpHandler } from "./locations-handler.js";

function parseLocationId(rawLocationId: string): number {
  return Number.parseInt(rawLocationId, 10);
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createLocationRoutes(handler: LocationsHttpHandler): RouteDef[] {
  return [
    route("GET", "/api/locations", () => jsonResponse(200, handler.handleList())),
    jsonRoute("POST", "/api/locations", async ({ readJson }) => handler.handleCreate(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["name is required"]),
    }),
    jsonRoute(
      "PUT",
      "/api/locations/:locationId(int)",
      async ({ params, readJson }) => handler.handleUpdate(parseLocationId(params.locationId ?? "0"), await readJson() as never),
      { getErrorStatus: inputErrorStatus },
    ),
    jsonRoute("DELETE", "/api/locations/:locationId(int)", ({ params }) => handler.handleDelete(parseLocationId(params.locationId ?? "0")), {
      getErrorStatus: inputErrorStatus,
    }),
    route("POST", "/api/locations/:locationId(int)/setDefault", ({ params }) => {
      try {
        return jsonResponse(200, handler.handleSetDefault(parseLocationId(params.locationId ?? "0")));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(500, { error: message });
      }
    }),
  ];
}
