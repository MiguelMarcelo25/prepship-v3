import {
  parseAnalysisDailySalesQuery,
  parseAnalysisSkuQuery,
} from "../../../../../../packages/contracts/src/analysis/contracts.ts";
import type { AnalysisServices } from "../application/analysis-services.ts";

export class AnalysisHttpHandler {
  private readonly services: AnalysisServices;

  constructor(services: AnalysisServices) {
    this.services = services;
  }

  async handleSkus(url: URL) {
    return await this.services.getSkuAnalysis(parseAnalysisSkuQuery(url));
  }

  async handleDailySales(url: URL) {
    return await this.services.getDailySales(parseAnalysisDailySalesQuery(url));
  }
}
