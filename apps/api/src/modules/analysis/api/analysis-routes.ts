import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonRoute, type RouteDef } from "../../../app/router.js";
import type { AnalysisHttpHandler } from "./analysis-handler.js";

function getErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

export function createAnalysisRoutes(handler: AnalysisHttpHandler): RouteDef[] {
  return [
    jsonRoute("GET", "/api/analysis/skus", ({ url }) => handler.handleSkus(url), { getErrorStatus }),
    jsonRoute("GET", "/api/analysis/daily-sales", ({ url }) => handler.handleDailySales(url), { getErrorStatus }),
  ];
}
