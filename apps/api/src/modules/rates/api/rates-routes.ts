import { InputValidationError, parseOptionalIntegerParam } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { RatesHttpHandler } from "./rates-handler.js";

function parseOptionalNumberQuery(value: string | null, name: string): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InputValidationError(`${name} must be a number`);
  }
  return parsed;
}

function parseBooleanQuery(value: string | null, name: string, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new InputValidationError(`${name} must be true/false or 1/0`);
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createRateRoutes(handler: RatesHttpHandler): RouteDef[] {
  return [
    jsonRoute(
      "GET",
      "/api/carriers-for-store",
      ({ url }) => {
        const storeId = parseOptionalIntegerParam(url.searchParams.get("storeId"), "storeId") ?? null;
        return handler.handleCarriersForStore(storeId);
      },
      { getErrorStatus: inputErrorStatus },
    ),
    jsonRoute(
      "GET",
      "/api/rates/cached",
      ({ url }) => {
        const weight = Math.round(parseOptionalNumberQuery(url.searchParams.get("wt"), "wt") ?? 0);
        const length = parseOptionalNumberQuery(url.searchParams.get("l"), "l") ?? 0;
        const width = parseOptionalNumberQuery(url.searchParams.get("w"), "w") ?? 0;
        const height = parseOptionalNumberQuery(url.searchParams.get("h"), "h") ?? 0;
        const dims = length > 0 && width > 0 && height > 0 ? { length, width, height } : null;
        return handler.handleCached({
          wt: weight,
          zip: url.searchParams.get("zip") ?? "",
          dims,
          residential: parseBooleanQuery(url.searchParams.get("residential"), "residential", true),
          storeId: parseOptionalIntegerParam(url.searchParams.get("storeId"), "storeId") ?? null,
          signature: url.searchParams.get("signature") ?? null,
        });
      },
      { getErrorStatus: inputErrorStatus },
    ),
    route("POST", "/api/rates/cached/bulk", async ({ request }) => {
      try {
        const text = await request.text();
        const body = text ? JSON.parse(text) : [];
        return jsonResponse(200, handler.handleCachedBulk(body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = inputErrorStatusWithMessages(["Expected array"])(error);
        return jsonResponse(status, { error: message });
      }
    }),
    jsonRoute("POST", "/api/rates", async ({ readJson }) => handler.handleLiveRates(await readJson() as never)),
    jsonRoute("POST", "/api/rates/browse", async ({ readJson }) => handler.handleBrowseRates(await readJson() as never), {
      getErrorStatus: inputErrorStatusWithMessages(["shippingProviderId required"]),
    }),
    route("POST", "/api/rates/prefetch", () => jsonResponse(200, handler.handlePrefetchDisabled())),
  ];
}
