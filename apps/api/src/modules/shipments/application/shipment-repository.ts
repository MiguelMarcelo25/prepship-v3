import type { ShipmentSyncAccountRecord, ShipmentSyncRecord } from "../domain/shipment.js";

export interface ShipmentRepository {
  countActiveShipments(): Promise<number>;
  getLastShipmentSync(): Promise<number | null>;
  setLastShipmentSync(timestamp: number): Promise<void>;
  listSyncAccounts(): Promise<ShipmentSyncAccountRecord[]>;
  resolveOrderIdByOrderNumber(orderNumber: string): Promise<number | null>;
  orderExists(orderId: number): Promise<boolean>;
  getOrderClientId(orderId: number): Promise<number | null>;
  upsertShipmentBatch(shipments: ShipmentSyncRecord[]): Promise<void>;
  backfillOrderLocalFromShipments(shipments: ShipmentSyncRecord[]): Promise<void>;
}
