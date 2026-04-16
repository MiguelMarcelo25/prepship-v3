import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type { LabelRepository } from "../application/label-repository.js";
import type { MockLabelData } from "../application/mock-label-generator.js";
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

export class PgLabelRepository implements LabelRepository {
  private readonly sql: PgClient;
  private readonly mainApiKeyV2: string | null;
  private readonly mockLabelStore = new Map<number, MockLabelData>();

  constructor(sql: PgClient, mainApiKeyV2: string | null) {
    this.sql = sql;
    this.mainApiKeyV2 = mainApiKeyV2;
  }

  async getOrder(orderId: number): Promise<LabelOrderRecord | null> {
    const rows = await this.sql`
      SELECT "orderId", "orderNumber", "orderStatus", "storeId", "clientId", "weightValue", "shipToName", raw
      FROM orders
      WHERE "orderId" = ${orderId}
      LIMIT 1
    `;
    return (rows[0] as LabelOrderRecord | undefined) ?? null;
  }

  async findActiveLabelForOrder(orderId: number): Promise<ExistingLabelRecord | null> {
    const rows = await this.sql`
      SELECT "shipmentId", "trackingNumber", "labelUrl"
      FROM shipments
      WHERE "orderId" = ${orderId} AND voided = 0
      ORDER BY COALESCE(label_created_at, "updatedAt", "shipmentId") DESC
      LIMIT 1
    `;
    return (rows[0] as ExistingLabelRecord | undefined) ?? null;
  }

  async resolvePackageDimensions(orderId: number): Promise<ResolvedPackageDimensions | null> {
    const rows = await this.sql`
      SELECT ol.selected_pid AS "packageId", inv.length, inv.width, inv.height
      FROM order_local ol
      LEFT JOIN inventory_skus inv ON inv."packageId" = ol.selected_pid
      WHERE ol."orderId" = ${orderId}
      LIMIT 1
    `;
    return (rows[0] as ResolvedPackageDimensions | undefined) ?? null;
  }

  async getShippingAccountContext(storeId: number | null): Promise<ShippingAccountContext> {
    if (storeId == null) {
      return { clientId: null, storeId: null, v1ApiKey: null, v1ApiSecret: null, v2ApiKey: this.mainApiKeyV2, rateSourceClientId: null };
    }

    const clientRows = await this.sql`
      SELECT "clientId", ss_api_key, ss_api_secret, ss_api_key_v2, rate_source_client_id
      FROM clients
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements("storeIds"::jsonb) AS elem
        WHERE elem::text::integer = ${storeId}
      )
      LIMIT 1
    `;
    const client = clientRows[0] as {
      clientId: number | null;
      ss_api_key: string | null;
      ss_api_secret: string | null;
      ss_api_key_v2: string | null;
      rate_source_client_id: number | null;
    } | undefined;

    if (!client) {
      return { clientId: null, storeId, v1ApiKey: null, v1ApiSecret: null, v2ApiKey: this.mainApiKeyV2, rateSourceClientId: null };
    }

    let v2ApiKey = client.ss_api_key_v2 ?? this.mainApiKeyV2;
    if (client.rate_source_client_id != null) {
      const sourceRows = await this.sql`
        SELECT ss_api_key_v2
        FROM clients
        WHERE "clientId" = ${client.rate_source_client_id}
        LIMIT 1
      `;
      const source = sourceRows[0] as { ss_api_key_v2: string | null } | undefined;
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
    await this.sql`
      INSERT INTO shipments (
        "shipmentId", "orderId", "orderNumber", "carrierCode", "serviceCode",
        "trackingNumber", "shipDate", "labelUrl", "shipmentCost", "otherCost", voided, "updatedAt",
        weight_oz, dims_l, dims_w, dims_h, "createDate", "clientId", "providerAccountId",
        provider_account_nickname, source, label_created_at, label_format, selected_rate_json
      ) VALUES (
        ${input.shipmentId}, ${input.orderId}, ${input.orderNumber}, ${input.carrierCode}, ${input.serviceCode},
        ${input.trackingNumber}, ${input.shipDate}, ${input.labelUrl}, ${input.shipmentCost}, ${input.otherCost},
        ${input.voided ? 1 : 0}, ${input.updatedAt},
        ${input.weightOz}, ${input.dimsLength}, ${input.dimsWidth}, ${input.dimsHeight},
        ${input.createDate}, ${input.clientId}, ${input.providerAccountId},
        ${input.providerAccountNickname}, ${input.source}, ${input.labelCreatedAt},
        ${input.labelFormat}, ${input.selectedRateJson}
      )
      ON CONFLICT("shipmentId") DO UPDATE SET
        "orderId" = EXCLUDED."orderId",
        "orderNumber" = EXCLUDED."orderNumber",
        "carrierCode" = EXCLUDED."carrierCode",
        "serviceCode" = EXCLUDED."serviceCode",
        "trackingNumber" = EXCLUDED."trackingNumber",
        "shipDate" = EXCLUDED."shipDate",
        "labelUrl" = COALESCE(EXCLUDED."labelUrl", shipments."labelUrl"),
        "shipmentCost" = EXCLUDED."shipmentCost",
        "otherCost" = EXCLUDED."otherCost",
        voided = EXCLUDED.voided,
        "updatedAt" = EXCLUDED."updatedAt",
        weight_oz = EXCLUDED.weight_oz,
        dims_l = EXCLUDED.dims_l,
        dims_w = EXCLUDED.dims_w,
        dims_h = EXCLUDED.dims_h,
        "createDate" = COALESCE(EXCLUDED."createDate", shipments."createDate"),
        "clientId" = EXCLUDED."clientId",
        "providerAccountId" = COALESCE(EXCLUDED."providerAccountId", shipments."providerAccountId"),
        provider_account_nickname = COALESCE(shipments.provider_account_nickname, EXCLUDED.provider_account_nickname),
        source = EXCLUDED.source,
        label_created_at = COALESCE(EXCLUDED.label_created_at, shipments.label_created_at),
        label_format = COALESCE(EXCLUDED.label_format, shipments.label_format),
        selected_rate_json = COALESCE(EXCLUDED.selected_rate_json, shipments.selected_rate_json)
    `;
  }

  async markOrderShipped(orderId: number, updatedAt: number): Promise<void> {
    await this.sql`
      UPDATE orders
      SET "orderStatus" = 'shipped', "updatedAt" = ${updatedAt}
      WHERE "orderId" = ${orderId}
    `;
  }

  async markShipmentVoided(shipmentId: number, orderId: number, updatedAt: number): Promise<void> {
    await this.sql`
      UPDATE shipments
      SET voided = 1, "updatedAt" = ${updatedAt}
      WHERE "shipmentId" = ${shipmentId}
    `;

    await this.sql`
      UPDATE orders
      SET "orderStatus" = 'awaiting_shipment', "updatedAt" = ${updatedAt}
      WHERE "orderId" = ${orderId}
    `;
  }

  async saveReturnLabel(record: ReturnLabelRecord): Promise<void> {
    await this.sql`
      INSERT INTO return_labels ("shipmentId", "returnShipmentId", "returnTrackingNumber", reason, "createdAt")
      VALUES (${record.shipmentId}, ${record.returnShipmentId}, ${record.returnTrackingNumber}, ${record.reason}, ${record.createdAt})
      ON CONFLICT("shipmentId") DO UPDATE SET
        "returnShipmentId" = EXCLUDED."returnShipmentId",
        "returnTrackingNumber" = EXCLUDED."returnTrackingNumber",
        reason = EXCLUDED.reason,
        "createdAt" = EXCLUDED."createdAt"
    `;
  }

  async getShipmentForVoidOrReturn(shipmentId: number): Promise<LabelShipmentRecord | null> {
    const rows = await this.sql`
      SELECT s."shipmentId", s."orderId", s."orderNumber", s."trackingNumber", s."labelUrl",
             s."carrierCode", s."serviceCode", s."shipmentCost", s.label_created_at,
             s.voided, s.source, o."storeId"
      FROM shipments s
      JOIN orders o ON o."orderId" = s."orderId"
      WHERE s."shipmentId" = ${shipmentId}
      LIMIT 1
    `;
    const row = rows[0] as ShipmentLookupRow | undefined;
    return row ? this.mapShipment(row) : null;
  }

  async getLatestShipmentForOrderLookup(orderLookup: number | string): Promise<LabelShipmentRecord | null> {
    let rows: Array<Record<string, unknown>>;
    if (typeof orderLookup === "number") {
      rows = await this.sql`
        SELECT s."shipmentId", s."orderId", s."orderNumber", s."trackingNumber", s."labelUrl",
               s."carrierCode", s."serviceCode", s."shipmentCost", s.label_created_at,
               s.voided, s.source, o."storeId"
        FROM shipments s
        JOIN orders o ON o."orderId" = s."orderId"
        WHERE s."orderId" = ${orderLookup} AND s.voided = 0
        ORDER BY COALESCE(s.label_created_at, s."updatedAt", s."shipmentId") DESC
        LIMIT 1
      `;
    } else {
      rows = await this.sql`
        SELECT s."shipmentId", s."orderId", s."orderNumber", s."trackingNumber", s."labelUrl",
               s."carrierCode", s."serviceCode", s."shipmentCost", s.label_created_at,
               s.voided, s.source, o."storeId"
        FROM shipments s
        JOIN orders o ON o."orderId" = s."orderId"
        WHERE s."orderNumber" = ${orderLookup} AND s.voided = 0
        ORDER BY COALESCE(s.label_created_at, s."updatedAt", s."shipmentId") DESC
        LIMIT 1
      `;
    }
    const row = rows[0] as ShipmentLookupRow | undefined;
    return row ? this.mapShipment(row) : null;
  }

  async updateShipmentLabelUrl(shipmentId: number, labelUrl: string): Promise<void> {
    await this.sql`UPDATE shipments SET "labelUrl" = ${labelUrl} WHERE "shipmentId" = ${shipmentId}`;
  }

  async enrichShipment(input: ShipmentEnrichmentInput): Promise<void> {
    await this.sql`
      UPDATE shipments SET
        "otherCost" = ${input.otherCost},
        "createDate" = COALESCE(${input.createDate}, "createDate"),
        weight_oz  = COALESCE(${input.weightOz}, weight_oz),
        dims_l     = COALESCE(${input.dimsLength}, dims_l),
        dims_w     = COALESCE(${input.dimsWidth}, dims_w),
        dims_h     = COALESCE(${input.dimsHeight}, dims_h),
        "updatedAt"  = ${input.updatedAt}
      WHERE "shipmentId" = ${input.shipmentId}
    `;
  }

  async backfillOrderLocalTracking(orderId: number, trackingNumber: string, providerAccountId: number | null, updatedAtSeconds: number): Promise<void> {
    await this.sql`
      INSERT INTO order_local ("orderId", tracking_number, shipping_account, "updatedAt")
      VALUES (${orderId}, ${trackingNumber}, ${providerAccountId}, ${updatedAtSeconds})
      ON CONFLICT("orderId") DO UPDATE SET
        tracking_number = CASE WHEN order_local.tracking_number IS NULL THEN EXCLUDED.tracking_number ELSE order_local.tracking_number END,
        shipping_account = CASE WHEN order_local.shipping_account IS NULL THEN EXCLUDED.shipping_account ELSE order_local.shipping_account END,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async saveMockLabelData(shipmentId: number, data: MockLabelData): Promise<void> {
    await this.sql`
      INSERT INTO mock_labels
        (shipment_id, order_number, tracking_number, service_label, weight_oz, ship_from, ship_to, ship_date, pdf_base64)
      VALUES (
        ${shipmentId},
        ${data.orderNumber ?? null},
        ${data.trackingNumber},
        ${data.serviceLabel},
        ${data.weightOz},
        ${JSON.stringify(data.shipFrom)},
        ${JSON.stringify(data.shipTo)},
        ${data.shipDate},
        ${data.pdfBase64 ?? null}
      )
      ON CONFLICT(shipment_id) DO UPDATE SET
        order_number = EXCLUDED.order_number,
        tracking_number = EXCLUDED.tracking_number,
        service_label = EXCLUDED.service_label,
        weight_oz = EXCLUDED.weight_oz,
        ship_from = EXCLUDED.ship_from,
        ship_to = EXCLUDED.ship_to,
        ship_date = EXCLUDED.ship_date,
        pdf_base64 = EXCLUDED.pdf_base64
    `;
    this.mockLabelStore.set(shipmentId, data);
  }

  async getMockLabelData(shipmentId: number): Promise<MockLabelData | null> {
    const cached = this.mockLabelStore.get(shipmentId);
    if (cached) return cached;

    const rows = await this.sql`
      SELECT * FROM mock_labels WHERE shipment_id = ${shipmentId} LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
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
