import type {
  ExistingLabelRecord,
  LabelOrderRecord,
  LabelShipmentRecord,
  PersistedShipmentInput,
  ResolvedPackageDimensions,
  ReturnLabelRecord,
  ShipmentEnrichmentInput,
  ShippingAccountContext,
} from "../domain/label.js";
import type { MockLabelData } from "./mock-label-generator.js";

export interface LabelRepository {
  getOrder(orderId: number): Promise<LabelOrderRecord | null>;
  findActiveLabelForOrder(orderId: number): Promise<ExistingLabelRecord | null>;
  resolvePackageDimensions(orderId: number): Promise<ResolvedPackageDimensions | null>;
  getShippingAccountContext(storeId: number | null): Promise<ShippingAccountContext>;
  saveShipment(input: PersistedShipmentInput): Promise<void>;
  markOrderShipped(orderId: number, updatedAt: number): Promise<void>;
  markShipmentVoided(shipmentId: number, orderId: number, updatedAt: number): Promise<void>;
  saveReturnLabel(record: ReturnLabelRecord): Promise<void>;
  getShipmentForVoidOrReturn(shipmentId: number): Promise<LabelShipmentRecord | null>;
  getLatestShipmentForOrderLookup(orderLookup: number | string): Promise<LabelShipmentRecord | null>;
  updateShipmentLabelUrl(shipmentId: number, labelUrl: string): Promise<void>;
  backfillOrderLocalTracking(orderId: number, trackingNumber: string, providerAccountId: number | null, updatedAtSeconds: number): Promise<void>;
  enrichShipment(input: ShipmentEnrichmentInput): Promise<void>;
  saveMockLabelData(shipmentId: number, data: MockLabelData): Promise<void>;
  getMockLabelData(shipmentId: number): Promise<MockLabelData | null>;
}
