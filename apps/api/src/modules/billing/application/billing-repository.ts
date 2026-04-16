import type {
  BackfillBillingReferenceRatesInput,
  BillingDetailsQuery,
  GenerateBillingInput,
  GenerateBillingResult,
  SaveBillingPackagePricesInput,
  SetDefaultBillingPackagePriceResult,
  BillingSummaryQuery,
  UpdateBillingConfigInput,
} from "../../../../../../../packages/contracts/src/billing/contracts.js";
import type {
  BillingClientRecord,
  BillingBackfillReferenceRateOrderRecord,
  BillingConfigRecord,
  BillingDetailRecord,
  BillingFetchReferenceRateOrderRecord,
  BillingInvoiceRecord,
  BillingPackagePriceRecord,
  BillingSummaryRecord,
} from "../domain/billing.js";
import type { RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";

export interface BillingRepository {
  listBillableClients(): Promise<BillingClientRecord[]>;
  listReferenceRateStoreIds(): Promise<number[]>;
  listConfigRecords(): Promise<BillingConfigRecord[]>;
  upsertConfig(clientId: number, input: UpdateBillingConfigInput): Promise<void>;
  generate(input: Required<Pick<GenerateBillingInput, "from" | "to">> & Pick<GenerateBillingInput, "clientId">): Promise<GenerateBillingResult>;
  listSummary(query: BillingSummaryQuery): Promise<BillingSummaryRecord[]>;
  listDetails(query: Required<BillingDetailsQuery>): Promise<BillingDetailRecord[]>;
  getInvoice(clientId: number, from: string, to: string): Promise<BillingInvoiceRecord | null>;
  listPackagePrices(clientId: number): Promise<BillingPackagePriceRecord[]>;
  savePackagePrices(input: { clientId: number; prices: SaveBillingPackagePricesInput["prices"] }): Promise<void>;
  setDefaultPackagePrice(packageId: number, price: number): Promise<SetDefaultBillingPackagePriceResult>;
  listOrdersMissingReferenceRatesForFetch(storeIds: number[]): Promise<BillingFetchReferenceRateOrderRecord[]>;
  listOrdersMissingReferenceRatesForBackfill(input: BackfillBillingReferenceRatesInput): Promise<BillingBackfillReferenceRateOrderRecord[]>;
  findCachedReferenceRateCandidates(weightOz: number, zip5: string): Promise<RateDto[] | null>;
  saveBackfilledReferenceRates(orderId: number, refUspsRate: number | null, refUpsRate: number | null): Promise<void>;
}
