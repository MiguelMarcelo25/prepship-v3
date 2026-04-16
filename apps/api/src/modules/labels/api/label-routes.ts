import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { route, type RouteDef } from "../../../app/router.js";
import type { LabelsHttpHandler } from "./labels-handler.js";

function parseShipmentId(rawShipmentId: string): number {
  return Number.parseInt(rawShipmentId, 10);
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

export function createLabelRoutes(handler: LabelsHttpHandler): RouteDef[] {
  return [
    route("POST", "/api/labels/create-batch", async ({ readJson }) => {
      try {
        return jsonResponse(200, await handler.handleCreateBatch(await readJson()));
      } catch (error) {
        const err = error as Error & { rateLimited?: boolean; retryAfterMs?: number };
        const message = err instanceof Error ? err.message : "Unknown error";
        if (err.rateLimited) {
          const retryAfter = Math.ceil((err.retryAfterMs ?? 60000) / 1000);
          return jsonResponse(429, {
            error: message,
            retryAfter,
            rateLimited: true,
          });
        }
        const status = inputErrorStatusWithMessages(["orderIds must be a non-empty array", "serviceCode is required", "shippingProviderId is required"])(error);
        return jsonResponse(status, { error: message });
      }
    }),
    route("POST", "/api/labels/create", async ({ readJson }) => {
      try {
        const requestBody = await readJson();
        console.log("[DEBUG] /api/labels/create request body:", JSON.stringify(requestBody, null, 2));
        const response = await handler.handleCreate(requestBody as never);
        console.log("[DEBUG] /api/labels/create succeeded:", JSON.stringify(response, null, 2));
        return jsonResponse(200, response);
      } catch (error) {
        const err = error as Error & { details?: Record<string, unknown>; rateLimited?: boolean; retryAfterMs?: number };
        const message = err instanceof Error ? err.message : "Unknown error";
        const invalidCreateMessages = [
          "orderId and serviceCode required",
          "shippingProviderId required for v2 label creation",
          "Order weight required to create label",
        ];
        console.error("[DEBUG] /api/labels/create error:", message, err.details ? JSON.stringify(err.details) : "");
        if (err.rateLimited) {
          const retryAfter = Math.ceil((err.retryAfterMs ?? 60000) / 1000);
          return jsonResponse(429, {
            error: message,
            retryAfter,
            rateLimited: true,
            ...(err.details ?? {}),
          });
        }
        const status = (error instanceof InputValidationError || invalidCreateMessages.includes(message))
          ? 400
          : message === "Order not found"
            ? 404
            : message.startsWith("Cannot create label for") || message === "Label already exists for this order"
              ? 400
              : 500;
        return jsonResponse(status, { error: message, ...(err.details ?? {}) });
      }
    }),
    route("GET", "/api/labels/mock/:shipmentId", ({ params }) => {
      if (!/^-?\d+$/.test(params.shipmentId ?? "")) {
        return jsonResponse(404, { error: "Not found" });
      }
      return handler.handleMockLabel(parseShipmentId(params.shipmentId ?? "0"));
    }),
    route("POST", "/api/labels/:shipmentId(int)/void", async ({ params }) => {
      try {
        return jsonResponse(200, await handler.handleVoid(parseShipmentId(params.shipmentId ?? "0")));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message === "Shipment not found" ? 404 : message === "Label already voided" ? 400 : 500;
        return jsonResponse(status, { error: message });
      }
    }),
    route("POST", "/api/labels/:shipmentId(int)/return", async ({ params, readJson }) => {
      try {
        return jsonResponse(200, await handler.handleReturn(parseShipmentId(params.shipmentId ?? "0"), await readJson() as never));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = error instanceof InputValidationError ? 400 : message === "Shipment not found" ? 404 : 500;
        return jsonResponse(status, { error: message });
      }
    }),
    route("GET", "/api/labels/:lookup/retrieve", async ({ params, url }) => {
      try {
        const rawLookup = params.lookup ?? "";
        const numericLookup = Number.parseInt(rawLookup, 10);
        const orderLookup = Number.isFinite(numericLookup) && String(numericLookup) === rawLookup ? numericLookup : rawLookup;
        return jsonResponse(200, await handler.handleRetrieve(orderLookup, url.searchParams.get("fresh") === "true"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message.startsWith("No active label found")
          || message.startsWith("Label was created")
          || message === "Label URL not available. The label may have been voided or deleted."
          ? 404
          : 500;
        return jsonResponse(status, { error: message });
      }
    }),
  ];
}
