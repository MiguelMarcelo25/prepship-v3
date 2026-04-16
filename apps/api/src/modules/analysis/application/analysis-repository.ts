import type {
  AnalysisDailySalesQuery,
  AnalysisSkuQuery,
} from "../../../../../../packages/contracts/src/analysis/contracts.js";
import type { AnalysisDailySalesRow, AnalysisOrderRow } from "../domain/analysis.js";

export interface AnalysisRepository {
  listOrderRows(query: AnalysisSkuQuery): Promise<AnalysisOrderRow[]>;
  listDailySalesRows(query: AnalysisDailySalesQuery, since: string, until: string): Promise<AnalysisDailySalesRow[]>;
  getStoreClientNameMap(): Promise<Record<number, string>>;
  getInventorySkuMap(): Promise<Map<string, number>>;
  getClientStoreIds(clientId: number): Promise<number[]>;
}
