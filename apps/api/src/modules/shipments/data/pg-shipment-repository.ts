import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.ts";
import type { ShipmentRepository } from "../application/shipment-repository.ts";
import type { ShipmentSyncAccountRecord, ShipmentSyncRecord } from "../domain/shipment.ts";

export class PgShipmentRepository implements ShipmentRepository {
  constructor(private readonly sql: PgClient) {}

  async countActiveShipments(): Promise<number> {
    const rows = await this.sql`SELECT COUNT(*) AS count FROM shipments WHERE voided = 0`;
    const row = rows[0] as { count: string | number } | undefined;
    return Number(row?.count ?? 0);
  }

  async getLastShipmentSync(): Promise<number | null> {
    const rows = await this.sql`SELECT value FROM sync_meta WHERE key = 'lastShipmentSync' LIMIT 1`;
    const row = rows[0] as { value: string | null } | undefined;
    const value = row?.value ? Number.parseInt(row.value, 10) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  async setLastShipmentSync(timestamp: number): Promise<void> {
    await this.sql`
      INSERT INTO sync_meta (key, value)
      VALUES ('lastShipmentSync', ${String(timestamp)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async listSyncAccounts(): Promise<ShipmentSyncAccountRecord[]> {
    const rows = await this.sql`
      SELECT clientId, ss_api_key, ss_api_secret, ss_api_key_v2
      FROM clients
      WHERE active = 1
      ORDER BY clientId
    ` as Array<{
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
    const rows = await this.sql`SELECT orderId FROM orders WHERE "orderNumber" = ${orderNumber} LIMIT 1`;
    const row = rows[0] as { orderId: number } | undefined;
    return row?.orderId ?? null;
  }

  async orderExists(orderId: number): Promise<boolean> {
    const rows = await this.sql`SELECT 1 AS present FROM orders WHERE orderId = ${orderId} LIMIT 1`;
    const row = rows[0] as { present: number } | undefined;
    return Boolean(row?.present);
  }

  async getOrderClientId(orderId: number): Promise<number | null> {
    const rows = await this.sql`SELECT clientId FROM orders WHERE orderId = ${orderId} LIMIT 1`;
    const row = rows[0] as { clientId: number | null } | undefined;
    return row?.clientId ?? null;
  }

  async upsertShipmentBatch(shipments: ShipmentSyncRecord[]): Promise<void> {
    for (const shipment of shipments) {
      await this.sql`
        INSERT INTO shipments (
          "shipmentId", orderId, "orderNumber", "carrierCode", "serviceCode", "trackingNumber",
          "shipDate", "shipmentCost", "otherCost", voided, "updatedAt", clientId, source,
          "createDate", "providerAccountId", weight_oz, dims_l, dims_w, dims_h
        ) VALUES (
          ${shipment.shipmentId}, ${shipment.orderId}, ${shipment.orderNumber},
          ${shipment.carrierCode}, ${shipment.serviceCode}, ${shipment.trackingNumber},
          ${shipment.shipDate}, ${shipment.shipmentCost}, ${shipment.otherCost},
          ${shipment.voided ? 1 : 0}, ${shipment.updatedAt}, ${shipment.clientId},
          ${shipment.source}, ${shipment.createDate}, ${shipment.providerAccountId},
          ${shipment.weightOz}, ${shipment.dimsLength}, ${shipment.dimsWidth}, ${shipment.dimsHeight}
        )
        ON CONFLICT ("shipmentId") DO UPDATE SET
          orderId = EXCLUDED.orderId,
          "orderNumber" = EXCLUDED."orderNumber",
          "carrierCode" = EXCLUDED."carrierCode",
          "serviceCode" = EXCLUDED."serviceCode",
          "trackingNumber" = EXCLUDED."trackingNumber",
          "shipDate" = EXCLUDED."shipDate",
          "shipmentCost" = EXCLUDED."shipmentCost",
          "otherCost" = EXCLUDED."otherCost",
          voided = EXCLUDED.voided,
          "updatedAt" = EXCLUDED."updatedAt",
          clientId = EXCLUDED.clientId,
          source = EXCLUDED.source,
          "createDate" = COALESCE(EXCLUDED."createDate", shipments."createDate"),
          "providerAccountId" = COALESCE(EXCLUDED."providerAccountId", shipments."providerAccountId"),
          weight_oz = EXCLUDED.weight_oz,
          dims_l = EXCLUDED.dims_l,
          dims_w = EXCLUDED.dims_w,
          dims_h = EXCLUDED.dims_h
      `;
    }
  }

  async backfillOrderLocalFromShipments(shipments: ShipmentSyncRecord[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const shipment of shipments) {
      if (!shipment.voided && shipment.trackingNumber) {
        await this.sql`
          INSERT INTO order_local (orderId, tracking_number, shipping_account, "updatedAt")
          VALUES (${shipment.orderId}, ${shipment.trackingNumber}, ${shipment.providerAccountId}, ${now})
          ON CONFLICT (orderId) DO UPDATE SET
            tracking_number = CASE WHEN order_local.tracking_number IS NULL THEN EXCLUDED.tracking_number ELSE order_local.tracking_number END,
            shipping_account = CASE WHEN order_local.shipping_account IS NULL THEN EXCLUDED.shipping_account ELSE order_local.shipping_account END,
            "updatedAt" = EXCLUDED."updatedAt"
        `;
      }
    }
  }
}
