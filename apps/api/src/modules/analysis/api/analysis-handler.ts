import {
  parseAnalysisDailySalesQuery,
  parseAnalysisSkuQuery,
} from "../../../../../../packages/contracts/src/analysis/contracts.js";
import type { AnalysisServices } from "../application/analysis-services.js";

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
