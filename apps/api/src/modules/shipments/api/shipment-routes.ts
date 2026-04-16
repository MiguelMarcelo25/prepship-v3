import { jsonResponse } from "../../../common/http/json.js";
import { jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { ShipmentsHttpHandler } from "./shipments-handler.js";

export function createShipmentRoutes(handler: ShipmentsHttpHandler): RouteDef[] {
  return [
    jsonRoute("POST", "/api/shipments/sync", () => handler.handleSync()),
    jsonRoute("GET", "/api/shipments/status", () => handler.handleStatus()),
    jsonRoute("GET", "/api/sync/status", () => handler.handleLegacySyncStatus()),
    route("POST", "/api/sync/trigger", async ({ request, url, readJson }) => {
      try {
        const body = request.headers.get("content-type")?.includes("application/json") ? await readJson() as { full?: boolean } : {};
        const full = url.searchParams.get("full") === "1" || body.full === true;
        return jsonResponse(200, handler.handleLegacySyncTrigger(full));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(500, { error: message });
      }
    }),
    jsonRoute("GET", "/api/shipments", ({ url }) => handler.handleList(url)),
  ];
}
