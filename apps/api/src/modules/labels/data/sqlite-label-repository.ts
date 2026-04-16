import type { DatabaseSync } from "node:sqlite";
import type { LabelRepository } from "../application/label-repository.ts";
import type { MockLabelData } from "../application/mock-label-generator.ts";
import type {
  ExistingLabelRecord,
  LabelOrderRecord,
  LabelShipmentRecord,
  PersistedShipmentInput,
  ResolvedPackageDimensions,
  ReturnLabelRecord,
  ShipmentEnrichmentInput,
  ShippingAccountContext,
} from "../domain/label.ts";

interface ShippingContextRow {
  clientId: number | null;
  ss_api_key: string | null;
  ss_api_secret: string | null;
  ss_api_key_v2: string | null;
  rate_source_client_id: number | null;
}

interface ShipmentLookupRow {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number | null;
  label_created_at: number | null;
  voided: number;
  source: string | null;
  storeId: number | null;
}

export class SqliteLabelRepository implements LabelRepository {
  private readonly db: DatabaseSync;
  private readonly mainApiKeyV2: string | null;
  // In-memory store for mock label data — ephemeral, no DB needed
  private readonly mockLabelStore = new Map<number, MockLabelData>();

  constructor(db: DatabaseSync, mainApiKeyV2: string | null) {
    this.db = db;
    this.mainApiKeyV2 = mainApiKeyV2;
  }

  async getOrder(orderId: number): Promise<LabelOrderRecord | null> {
    const row = this.db.prepare(`
      SELECT orderId, orderNumber, orderStatus, storeId, clientId, weightValue, shipToName, raw
      FROM orders
      WHERE orderId = ?
      LIMIT 1
    `).get(orderId) as LabelOrderRecord | undefined;
    return row ?? null;
  }

  async findActiveLabelForOrder(orderId: number): Promise<ExistingLabelRecord | null> {
    const row = this.db.prepare(`
      SELECT shipmentId, trackingNumber, labelUrl
      FROM shipments
      WHERE orderId = ? AND voided = 0
      ORDER BY COALESCE(label_created_at, updatedAt, shipmentId) DESC
      LIMIT 1
    `).get(orderId) as ExistingLabelRecord | undefined;
    return row ?? null;
  }

  async resolvePackageDimensions(orderId: number): Promise<ResolvedPackageDimensions | null> {
    const row = this.db.prepare(`
      SELECT ol.selected_pid AS packageId, inv.length, inv.width, inv.height
      FROM order_local ol
      LEFT JOIN inventory_skus inv ON inv.packageId = ol.selected_pid
      WHERE ol.orderId = ?
      LIMIT 1
    `).get(orderId) as ResolvedPackageDimensions | undefined;
    return row ?? null;
  }

  async getShippingAccountContext(storeId: number | null): Promise<ShippingAccountContext> {
    if (storeId == null) {
      return { clientId: null, storeId: null, v1ApiKey: null, v1ApiSecret: null, v2ApiKey: this.mainApiKeyV2, rateSourceClientId: null };
    }

    const client = this.db.prepare(`
      SELECT clientId, ss_api_key, ss_api_secret, ss_api_key_v2, rate_source_client_id
      FROM clients
      WHERE EXISTS (
        SELECT 1
        FROM json_each(clients.storeIds)
        WHERE CAST(json_each.value AS INTEGER) = ?
      )
      LIMIT 1
    `).get(storeId) as ShippingContextRow | undefined;

    if (!client) {
      return { clientId: null, storeId, v1ApiKey: null, v1ApiSecret: null, v2ApiKey: this.mainApiKeyV2, rateSourceClientId: null };
    }

    let v2ApiKey = client.ss_api_key_v2 ?? this.mainApiKeyV2;
    if (client.rate_source_client_id != null) {
      const source = this.db.prepare(`
        SELECT ss_api_key_v2
        FROM clients
        WHERE clientId = ?
        LIMIT 1
      `).get(client.rate_source_client_id) as { ss_api_key_v2: string | null } | undefined;
      if (source?.ss_api_key_v2) v2ApiKey = source.ss_api_key_v2;
    }

    return {
      clientId: client.clientId,
      storeId,
      v1ApiKey: client.ss_api_key,
      v1ApiSecret: client.ss_api_secret,
      v2ApiKey,
      rateSourceClientId: client.rate_source_client_id,
    };
  }

  async saveShipment(input: PersistedShipmentInput): Promise<void> {
    this.db.prepare(`
      INSERT INTO shipments (
        shipmentId, orderId, orderNumber, carrierCode, serviceCode,
        trackingNumber, shipDate, labelUrl, shipmentCost, otherCost, voided, updatedAt,
        weight_oz, dims_l, dims_w, dims_h, createDate, clientId, providerAccountId,
        provider_account_nickname, source, label_created_at, label_format, selected_rate_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shipmentId) DO UPDATE SET
        orderId = excluded.orderId,
        orderNumber = excluded.orderNumber,
        carrierCode = excluded.carrierCode,
        serviceCode = excluded.serviceCode,
        trackingNumber = excluded.trackingNumber,
        shipDate = excluded.shipDate,
        labelUrl = COALESCE(excluded.labelUrl, shipments.labelUrl),
        shipmentCost = excluded.shipmentCost,
        otherCost = excluded.otherCost,
        voided = excluded.voided,
        updatedAt = excluded.updatedAt,
        weight_oz = excluded.weight_oz,
        dims_l = excluded.dims_l,
        dims_w = excluded.dims_w,
        dims_h = excluded.dims_h,
        createDate = COALESCE(excluded.createDate, shipments.createDate),
        clientId = excluded.clientId,
        providerAccountId = COALESCE(excluded.providerAccountId, shipments.providerAccountId),
        provider_account_nickname = COALESCE(shipments.provider_account_nickname, excluded.provider_account_nickname),
        source = excluded.source,
        label_created_at = COALESCE(excluded.label_created_at, shipments.label_created_at),
        label_format = COALESCE(excluded.label_format, shipments.label_format),
        selected_rate_json = COALESCE(excluded.selected_rate_json, shipments.selected_rate_json)
    `).run(
      input.shipmentId,
      input.orderId,
      input.orderNumber,
      input.carrierCode,
      input.serviceCode,
      input.trackingNumber,
      input.shipDate,
      input.labelUrl,
      input.shipmentCost,
      input.otherCost,
      input.voided ? 1 : 0,
      input.updatedAt,
      input.weightOz,
      input.dimsLength,
      input.dimsWidth,
      input.dimsHeight,
      input.createDate,
      input.clientId,
      input.providerAccountId,
      input.providerAccountNickname,
      input.source,
      input.labelCreatedAt,
      input.labelFormat,
      input.selectedRateJson,
    );
  }

  async markOrderShipped(orderId: number, updatedAt: number): Promise<void> {
    this.db.prepare(`
      UPDATE orders
      SET orderStatus = 'shipped', updatedAt = ?
      WHERE orderId = ?
    `).run(updatedAt, orderId);
  }

  async markShipmentVoided(shipmentId: number, orderId: number, updatedAt: number): Promise<void> {
    this.db.prepare(`
      UPDATE shipments
      SET voided = 1, updatedAt = ?
      WHERE shipmentId = ?
    `).run(updatedAt, shipmentId);

    this.db.prepare(`
      UPDATE orders
      SET orderStatus = 'awaiting_shipment', updatedAt = ?
      WHERE orderId = ?
    `).run(updatedAt, orderId);
  }

  async saveReturnLabel(record: ReturnLabelRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO return_labels (shipmentId, returnShipmentId, returnTrackingNumber, reason, createdAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shipmentId) DO UPDATE SET
        returnShipmentId = excluded.returnShipmentId,
        returnTrackingNumber = excluded.returnTrackingNumber,
        reason = excluded.reason,
        createdAt = excluded.createdAt
    `).run(record.shipmentId, record.returnShipmentId, record.returnTrackingNumber, record.reason, record.createdAt);
  }

  async getShipmentForVoidOrReturn(shipmentId: number): Promise<LabelShipmentRecord | null> {
    const row = this.db.prepare(`
      SELECT s.shipmentId, s.orderId, s.orderNumber, s.trackingNumber, s.labelUrl,
             s.carrierCode, s.serviceCode, s.shipmentCost, s.label_created_at,
             s.voided, s.source, o.storeId
      FROM shipments s
      JOIN orders o ON o.orderId = s.orderId
      WHERE s.shipmentId = ?
      LIMIT 1
    `).get(shipmentId) as ShipmentLookupRow | undefined;
    return row ? this.mapShipment(row) : null;
  }

  async getLatestShipmentForOrderLookup(orderLookup: number | string): Promise<LabelShipmentRecord | null> {
    let row: ShipmentLookupRow | undefined;
    if (typeof orderLookup === "number") {
      row = this.db.prepare(`
        SELECT s.shipmentId, s.orderId, s.orderNumber, s.trackingNumber, s.labelUrl,
               s.carrierCode, s.serviceCode, s.shipmentCost, s.label_created_at,
               s.voided, s.source, o.storeId
        FROM shipments s
        JOIN orders o ON o.orderId = s.orderId
        WHERE s.orderId = ? AND s.voided = 0
        ORDER BY COALESCE(s.label_created_at, s.updatedAt, s.shipmentId) DESC
        LIMIT 1
      `).get(orderLookup) as ShipmentLookupRow | undefined;
    } else {
      row = this.db.prepare(`
        SELECT s.shipmentId, s.orderId, s.orderNumber, s.trackingNumber, s.labelUrl,
               s.carrierCode, s.serviceCode, s.shipmentCost, s.label_created_at,
               s.voided, s.source, o.storeId
        FROM shipments s
        JOIN orders o ON o.orderId = s.orderId
        WHERE s.orderNumber = ? AND s.voided = 0
        ORDER BY COALESCE(s.label_created_at, s.updatedAt, s.shipmentId) DESC
        LIMIT 1
      `).get(orderLookup) as ShipmentLookupRow | undefined;
    }
    return row ? this.mapShipment(row) : null;
  }

  async updateShipmentLabelUrl(shipmentId: number, labelUrl: string): Promise<void> {
    this.db.prepare(`UPDATE shipments SET labelUrl = ? WHERE shipmentId = ?`).run(labelUrl, shipmentId);
  }

  async enrichShipment(input: ShipmentEnrichmentInput): Promise<void> {
    this.db.prepare(`
      UPDATE shipments SET
        otherCost = ?,
        createDate = COALESCE(?, createDate),
        weight_oz  = COALESCE(?, weight_oz),
        dims_l     = COALESCE(?, dims_l),
        dims_w     = COALESCE(?, dims_w),
        dims_h     = COALESCE(?, dims_h),
        updatedAt  = ?
      WHERE shipmentId = ?
    `).run(
      input.otherCost,
      input.createDate,
      input.weightOz,
      input.dimsLength,
      input.dimsWidth,
      input.dimsHeight,
      input.updatedAt,
      input.shipmentId,
    );
  }

  async backfillOrderLocalTracking(orderId: number, trackingNumber: string, providerAccountId: number | null, updatedAtSeconds: number): Promise<void> {
    this.db.prepare(`
      INSERT INTO order_local (orderId, tracking_number, shipping_account, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        tracking_number = CASE WHEN tracking_number IS NULL THEN excluded.tracking_number ELSE tracking_number END,
        shipping_account = CASE WHEN shipping_account IS NULL THEN excluded.shipping_account ELSE shipping_account END,
        updatedAt = excluded.updatedAt
    `).run(orderId, trackingNumber, providerAccountId, updatedAtSeconds);
  }

  async saveMockLabelData(shipmentId: number, data: MockLabelData): Promise<void> {
    // Persist to DB so mock labels survive server restarts
    this.db.prepare(`
      INSERT OR REPLACE INTO mock_labels
        (shipment_id, order_number, tracking_number, service_label, weight_oz, ship_from, ship_to, ship_date, pdf_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shipmentId,
      data.orderNumber ?? null,
      data.trackingNumber,
      data.serviceLabel,
      data.weightOz,
      JSON.stringify(data.shipFrom),
      JSON.stringify(data.shipTo),
      data.shipDate,
      data.pdfBase64 ?? null,
    );
    // Also keep in memory for fast access
    this.mockLabelStore.set(shipmentId, data);
  }

  async getMockLabelData(shipmentId: number): Promise<MockLabelData | null> {
    // Check memory first
    const cached = this.mockLabelStore.get(shipmentId);
    if (cached) return cached;
    // Fall back to DB (survives restarts)
    const row = this.db.prepare(`
      SELECT * FROM mock_labels WHERE shipment_id = ? LIMIT 1
    `).get(shipmentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const data: MockLabelData = {
      shipmentId: row.shipment_id as number,
      orderNumber: row.order_number as string | null,
      trackingNumber: row.tracking_number as string,
      serviceLabel: row.service_label as string,
      weightOz: row.weight_oz as number,
      shipFrom: JSON.parse(row.ship_from as string),
      shipTo: JSON.parse(row.ship_to as string),
      shipDate: row.ship_date as string,
      pdfBase64: row.pdf_base64 as string | undefined,
    };
    this.mockLabelStore.set(shipmentId, data);
    return data;
  }

  private mapShipment(row: ShipmentLookupRow): LabelShipmentRecord {
    return {
      shipmentId: row.shipmentId,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      trackingNumber: row.trackingNumber,
      labelUrl: row.labelUrl,
      carrierCode: row.carrierCode,
      serviceCode: row.serviceCode,
      shipmentCost: row.shipmentCost,
      labelCreatedAt: row.label_created_at,
      voided: Boolean(row.voided),
      source: row.source,
      storeId: row.storeId,
    };
  }
}
