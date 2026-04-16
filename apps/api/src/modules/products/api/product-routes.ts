import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { ProductsHttpHandler } from "./products-handler.js";

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createProductRoutes(handler: ProductsHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/products/bulk", ({ url }) => handler.handleBulk(url)),
    route("GET", "/api/products/by-sku/:sku", async ({ params }) => {
      try {
        const payload = await handler.handleBySku(params.sku ?? "");
        if (!payload) return jsonResponse(404, { error: "Not found" });
        return jsonResponse(200, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(500, { error: message });
      }
    }),
    jsonRoute("POST", "/api/products/save-defaults", async ({ readJson }) => handler.handleSaveDefaults(await readJson() as never), {
      getErrorStatus: (error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        return error instanceof InputValidationError || message === "productId or sku required" || message === "Nothing to save"
          ? 400
          : message === "Product not found"
            ? 404
            : 500;
      },
    }),
    jsonRoute(
      "POST",
      "/api/products/:sku/defaults",
      async ({ params, readJson }) => handler.handleSaveSkuDefaults(params.sku ?? "", await readJson()),
      {
        getErrorStatus: (error) => {
          const message = error instanceof Error ? error.message : "Unknown error";
          return error instanceof InputValidationError || message === "productId or sku required" || message === "Nothing to save"
            ? 400
            : message === "Product not found"
              ? 404
              : 500;
        },
      },
    ),
  ];
}
