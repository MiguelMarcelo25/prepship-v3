import type { DatabaseSync } from "node:sqlite";
import type { ShipmentRepository } from "../application/shipment-repository.ts";
import type { ShipmentSyncAccountRecord, ShipmentSyncRecord } from "../domain/shipment.ts";

export class SqliteShipmentRepository implements ShipmentRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async countActiveShipments(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM shipments WHERE voided = 0`).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async getLastShipmentSync(): Promise<number | null> {
    const row = this.db.prepare(`SELECT value FROM sync_meta WHERE key = 'lastShipmentSync' LIMIT 1`).get() as { value: string | null } | undefined;
    const value = row?.value ? Number.parseInt(row.value, 10) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  async setLastShipmentSync(timestamp: number): Promise<void> {
    this.db.prepare(`
      INSERT INTO sync_meta (key, value)
      VALUES ('lastShipmentSync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(timestamp));
  }

  async listSyncAccounts(): Promise<ShipmentSyncAccountRecord[]> {
    const rows = this.db.prepare(`
      SELECT clientId, ss_api_key, ss_api_secret, ss_api_key_v2
      FROM clients
      WHERE active = 1
      ORDER BY clientId
    `).all() as Array<{
      clientId: number;
      ss_api_key: string | null;
      ss_api_secret: string | null;
      ss_api_key_v2: string | null;
    }>;

    return rows
      .filter((row) => row.ss_api_key || row.ss_api_secret || row.ss_api_key_v2)
      .map((row) => ({
        clientId: row.clientId,
        accountName: row.clientId === 1 ? "main" : `client-${row.clientId}`,
        v1ApiKey: row.ss_api_key,
        v1ApiSecret: row.ss_api_secret,
        v2ApiKey: row.ss_api_key_v2,
      }));
  }

  async resolveOrderIdByOrderNumber(orderNumber: string): Promise<number | null> {
    const row = this.db.prepare(`SELECT orderId FROM orders WHERE orderNumber = ? LIMIT 1`).get(orderNumber) as { orderId: number } | undefined;
    return row?.orderId ?? null;
  }

  async orderExists(orderId: number): Promise<boolean> {
    const row = this.db.prepare(`SELECT 1 AS present FROM orders WHERE orderId = ? LIMIT 1`).get(orderId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  async getOrderClientId(orderId: number): Promise<number | null> {
    const row = this.db.prepare(`SELECT clientId FROM orders WHERE orderId = ? LIMIT 1`).get(orderId) as { clientId: number | null } | undefined;
    return row?.clientId ?? null;
  }

  async upsertShipmentBatch(shipments: ShipmentSyncRecord[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO shipments (
        shipmentId, orderId, orderNumber, carrierCode, serviceCode, trackingNumber,
        shipDate, shipmentCost, otherCost, voided, updatedAt, clientId, source,
        createDate, providerAccountId, weight_oz, dims_l, dims_w, dims_h
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shipmentId) DO UPDATE SET
        orderId = excluded.orderId,
        orderNumber = excluded.orderNumber,
        carrierCode = excluded.carrierCode,
        serviceCode = excluded.serviceCode,
        trackingNumber = excluded.trackingNumber,
        shipDate = excluded.shipDate,
        shipmentCost = excluded.shipmentCost,
        otherCost = excluded.otherCost,
        voided = excluded.voided,
        updatedAt = excluded.updatedAt,
        clientId = excluded.clientId,
        source = excluded.source,
        createDate = COALESCE(excluded.createDate, shipments.createDate),
        providerAccountId = COALESCE(excluded.providerAccountId, shipments.providerAccountId),
        weight_oz = excluded.weight_oz,
        dims_l = excluded.dims_l,
        dims_w = excluded.dims_w,
        dims_h = excluded.dims_h
    `);

    for (const shipment of shipments) {
      stmt.run(
        shipment.shipmentId,
        shipment.orderId,
        shipment.orderNumber,
        shipment.carrierCode,
        shipment.serviceCode,
        shipment.trackingNumber,
        shipment.shipDate,
        shipment.shipmentCost,
        shipment.otherCost,
        shipment.voided ? 1 : 0,
        shipment.updatedAt,
        shipment.clientId,
        shipment.source,
        shipment.createDate,
        shipment.providerAccountId,
        shipment.weightOz,
        shipment.dimsLength,
        shipment.dimsWidth,
        shipment.dimsHeight,
      );
    }
  }

  async backfillOrderLocalFromShipments(shipments: ShipmentSyncRecord[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO order_local (orderId, tracking_number, shipping_account, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        tracking_number = CASE WHEN tracking_number IS NULL THEN excluded.tracking_number ELSE tracking_number END,
        shipping_account = CASE WHEN shipping_account IS NULL THEN excluded.shipping_account ELSE shipping_account END,
        updatedAt = excluded.updatedAt
    `);

    const now = Math.floor(Date.now() / 1000);
    for (const shipment of shipments) {
      if (!shipment.voided && shipment.trackingNumber) {
        stmt.run(shipment.orderId, shipment.trackingNumber, shipment.providerAccountId, now);
      }
    }
  }
}
