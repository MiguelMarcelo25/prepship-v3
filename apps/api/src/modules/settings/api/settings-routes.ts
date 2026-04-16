import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { route, type RouteDef } from "../../../app/router.js";
import type { SettingsHttpHandler } from "./settings-handler.js";

export function createSettingsRoutes(handler: SettingsHttpHandler): RouteDef[] {
  return [
    route("GET", "/api/settings/:key", async ({ params }) => {
      try {
        return jsonResponse(200, await handler.handleGet(params.key ?? ""));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = error instanceof InputValidationError ? 400 : message === "Unknown setting" ? 404 : 500;
        return jsonResponse(status, { error: message });
      }
    }),
    route("PUT", "/api/settings/:key", async ({ params, readJson }) => {
      try {
        return jsonResponse(200, await handler.handlePut(params.key ?? "", await readJson()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message === "Unknown setting" ? 404 : 500;
        return jsonResponse(status, { error: message });
      }
    }),
    route("POST", "/api/cache/clear-and-refetch", async () => {
      try {
        return jsonResponse(200, await handler.handleClearAndRefetch());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(500, { error: message });
      }
    }),
  ];
}
