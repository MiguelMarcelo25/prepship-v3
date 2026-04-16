import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { PackagesHttpHandler } from "./packages-handler.js";

function parsePackageId(rawPackageId: string): number {
  return Number.parseInt(rawPackageId, 10);
}

function parseOptionalNumberQuery(value: string | null, name: string): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InputValidationError(`${name} must be a number`);
  }
  return parsed;
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createPackageRoutes(handler: PackagesHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/packages", ({ url }) => handler.handleList(url.searchParams.get("source") ?? undefined)),
    jsonRoute("POST", "/api/packages", async ({ readJson }) => handler.handleCreate(await readJson()), {
      getErrorStatus: inputErrorStatusWithMessages(["name is required"]),
    }),
    jsonRoute("GET", "/api/packages/low-stock", () => handler.handleLowStock()),
    jsonRoute(
      "GET",
      "/api/packages/find-by-dims",
      ({ url }) => {
        const length = parseOptionalNumberQuery(url.searchParams.get("length"), "length") ?? 0;
        const width = parseOptionalNumberQuery(url.searchParams.get("width"), "width") ?? 0;
        const height = parseOptionalNumberQuery(url.searchParams.get("height"), "height") ?? 0;
        return handler.handleFindByDims(length, width, height);
      },
      { getErrorStatus: inputErrorStatus },
    ),
    jsonRoute("POST", "/api/packages/auto-create", async ({ readJson }) => handler.handleAutoCreate(await readJson()), {
      getErrorStatus: inputErrorStatusWithMessages(["length, width, height are required"]),
    }),
    jsonRoute("POST", "/api/packages/sync", () => handler.handleSync(), { getErrorStatus: inputErrorStatus }),
    jsonRoute("GET", "/api/packages/:packageId(int)/ledger", ({ params }) => handler.handleLedger(parsePackageId(params.packageId ?? "0"))),
    jsonRoute(
      "POST",
      "/api/packages/:packageId(int)/receive",
      async ({ params, readJson }) => handler.handleReceive(parsePackageId(params.packageId ?? "0"), await readJson()),
      { getErrorStatus: inputErrorStatusWithMessages(["qty must be > 0"]) },
    ),
    jsonRoute(
      "POST",
      "/api/packages/:packageId(int)/adjust",
      async ({ params, readJson }) => handler.handleAdjust(parsePackageId(params.packageId ?? "0"), await readJson()),
      { getErrorStatus: inputErrorStatusWithMessages(["qty is required"]) },
    ),
    jsonRoute(
      "PATCH",
      "/api/packages/:packageId(int)/reorder-level",
      async ({ params, readJson }) => {
        const body = await readJson();
        return handler.handleSetReorderLevel(parsePackageId(params.packageId ?? "0"), Number(String(body.reorderLevel)));
      },
      { getErrorStatus: inputErrorStatusWithMessages(["reorderLevel must be a number"]) },
    ),
    route("GET", "/api/packages/:packageId(int)", ({ params }) => {
      const payload = handler.handleGetById(parsePackageId(params.packageId ?? "0"));
      if (!payload) {
        return jsonResponse(404, { error: "Package not found" });
      }
      return jsonResponse(200, payload);
    }),
    jsonRoute(
      "PUT",
      "/api/packages/:packageId(int)",
      async ({ params, readJson }) => handler.handleUpdate(parsePackageId(params.packageId ?? "0"), await readJson()),
      { getErrorStatus: inputErrorStatus },
    ),
    jsonRoute("DELETE", "/api/packages/:packageId(int)", ({ params }) => handler.handleDelete(parsePackageId(params.packageId ?? "0"))),
  ];
}
