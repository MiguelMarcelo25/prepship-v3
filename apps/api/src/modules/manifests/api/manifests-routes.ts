import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { route, type RouteDef } from "../../../app/router.js";
import type { ManifestsHttpHandler } from "./manifests-handler.js";

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

function buildManifestResponse(manifest: Awaited<ReturnType<ManifestsHttpHandler["handleGenerate"]>>) {
  return new Response(manifest.body, {
    status: 200,
    headers: {
      "content-type": manifest.contentType,
      "content-disposition": `attachment; filename="${manifest.filename}"`,
    },
  });
}

export function createManifestRoutes(handler: ManifestsHttpHandler): RouteDef[] {
  const getErrorStatus = inputErrorStatusWithMessages(["startDate and endDate required (YYYY-MM-DD format)"]);

  return [
    route("POST", "/api/manifests/generate", async ({ readJson }) => {
      try {
        return buildManifestResponse(await handler.handleGenerate(await readJson() as never));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(getErrorStatus(error), { error: message });
      }
    }),
    route("GET", "/api/manifests/generate", async ({ url }) => {
      try {
        const startDate = url.searchParams.get("startDate") ?? "";
        const endDate = url.searchParams.get("endDate") ?? "";
        const carrierId = url.searchParams.get("carrierId") ?? null;
        const clientIdRaw = url.searchParams.get("clientId");
        const clientId = clientIdRaw ? Number.parseInt(clientIdRaw, 10) : null;
        return buildManifestResponse(await handler.handleGenerate({ startDate, endDate, carrierId, clientId }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse(getErrorStatus(error), { error: message });
      }
    }),
  ];
}
