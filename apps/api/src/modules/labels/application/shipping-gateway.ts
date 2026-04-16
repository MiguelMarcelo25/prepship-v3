import type { AddressRecord } from "../domain/label.js";
import type { OrderSelectedRateDto } from "../../../../../../packages/contracts/src/orders/contracts.js";

export interface ShipstationV1Credentials {
  apiKey: string;
  apiSecret: string;
}

export interface CreateExternalLabelInput {
  apiKeyV2: string;
  carrierId: string;
  serviceCode: string;
  packageCode: string;
  weightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  shipTo: AddressRecord;
  shipFrom: AddressRecord;
  confirmation: string | null;
  ssOrderId: number;
  orderNumber: string | null;
  testLabel?: boolean;
}

export interface CreatedExternalLabel {
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string | null;
  cost: number;
  voided: boolean;
  carrierCode: string | null;
  serviceCode: string | null;
  shipDate: string | null;
  providerAccountId: number | null;
  selectedRate: OrderSelectedRateDto | null;
}

export interface ShipstationShipmentDetails {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  otherCost: number;
  shipDate: string | null;
  confirmation: string | null;
  voided: boolean;
  labelUrl: string | null;
  createDate: string | null;
  weightOz: number | null;
  dimsLength: number | null;
  dimsWidth: number | null;
  dimsHeight: number | null;
  providerAccountId: number | null;
}

export interface ExternalOrderShipmentRecord {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  shipmentCost: number;
  otherCost: number;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  voided: boolean;
  createDate: string | null;
  weightOz: number | null;
  dimsLength: number | null;
  dimsWidth: number | null;
  dimsHeight: number | null;
}

export interface ShipstationLabelRecord {
  labelId: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
}

export interface MarkOrderShippedInput {
  orderId: number;
  carrierCode: string | null;
  shipDate: string | null;
  trackingNumber: string;
}

export interface ReturnLabelResult {
  returnTrackingNumber: string;
  returnShipmentId: number | null;
  cost: number;
}

export interface ShipmentPageResult {
  shipments: ExternalOrderShipmentRecord[];
  page: number;
  pages: number;
  total: number;
  raw: unknown;
}

export interface ShippingGateway {
  createLabel(input: CreateExternalLabelInput): Promise<CreatedExternalLabel>;
  getShipment(credentials: ShipstationV1Credentials, shipmentId: number): Promise<ShipstationShipmentDetails | null>;
  markOrderShipped(credentials: ShipstationV1Credentials, input: MarkOrderShippedInput): Promise<boolean>;
  voidShipment(apiKeyV2: string, shipmentId: number): Promise<void>;
  createReturnLabel(apiKeyV2: string, shipmentId: number, reason: string): Promise<ReturnLabelResult>;
  listRecentLabels(apiKeyV2: string): Promise<ShipstationLabelRecord[]>;
  listOrderShipments(credentials: ShipstationV1Credentials, orderId: number): Promise<ExternalOrderShipmentRecord[]>;
  listShipments(credentials: ShipstationV1Credentials, searchParams: URLSearchParams): Promise<ShipmentPageResult>;
  listShipmentsV2(apiKeyV2: string, page: number, createdAtStart?: string): Promise<Array<{ orderNumber: string | null; orderId: number | null; carrierId: string | null }>>;
}
