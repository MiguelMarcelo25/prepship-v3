import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.ts";
import { jsonResponse } from "../../../common/http/json.ts";
import { route, type RouteDef } from "../../../app/router.ts";
import type { QueueHttpHandler } from "./queue-handler.ts";

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

export function createQueueRoutes(handler: QueueHttpHandler): RouteDef[] {
  return [
    route("GET", "/api/queue", async ({ url }) => {
      try {
        return jsonResponse(200, await handler.handleGet(url));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(inputErrorStatus(error), { error: message });
      }
    }),
    route("POST", "/api/queue/add", async ({ readJson }) => {
      try {
        return jsonResponse(200, await handler.handleAdd(await readJson()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(inputErrorStatus(error), { error: message });
      }
    }),
    route("POST", "/api/queue/clear", async ({ readJson }) => {
      try {
        return jsonResponse(200, await handler.handleClear(await readJson()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(inputErrorStatus(error), { error: message });
      }
    }),
    route("POST", "/api/queue/print", async ({ readJson }) => {
      try {
        return jsonResponse(200, await handler.handleStartPrint(await readJson()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(inputErrorStatus(error), { error: message });
      }
    }),
    route("GET", "/api/queue/print/status/:jobId", ({ params }) => {
      const status = handler.handleJobStatus(params.jobId ?? "");
      if (!status) return jsonResponse(404, { error: "Job not found" });
      return jsonResponse(200, status);
    }),
    route("GET", "/api/queue/print/download/:jobId", ({ params }) => {
      const download = handler.handleJobDownload(params.jobId ?? "");
      if (!download) return jsonResponse(404, { error: "Job not found or not ready" });
      const pdfBytes = Buffer.from(download.base64, "base64");
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${download.fileName}"`,
          "content-length": String(pdfBytes.byteLength),
        },
      });
    }),
    route("DELETE", "/api/queue/:entryId", async ({ params, readJson, url }) => {
      try {
        const body = await readJson();
        const clientIdFromQuery = url.searchParams.get("client_id");
        if (!body.client_id && clientIdFromQuery) body.client_id = Number(clientIdFromQuery);
        return jsonResponse(200, await handler.handleRemove(params.entryId ?? "", body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message.includes("not found") ? 404 : inputErrorStatus(error);
        return jsonResponse(status, { error: message });
      }
    }),
  ];
}
