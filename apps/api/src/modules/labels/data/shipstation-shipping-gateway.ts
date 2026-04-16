import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.js";
import type {
  CreateExternalLabelInput,
  CreatedExternalLabel,
  ExternalOrderShipmentRecord,
  MarkOrderShippedInput,
  ReturnLabelResult,
  ShipmentPageResult,
  ShippingGateway,
  ShipstationLabelRecord,
  ShipstationShipmentDetails,
  ShipstationV1Credentials,
} from "../application/shipping-gateway.js";
import { getShipStationClient } from "../../../common/shipstation/client.js";

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWeightOz(weight: Record<string, unknown> | null | undefined): number | null {
  if (!weight) return null;
  const value = parseNumber(weight.value);
  if (value == null) return null;
  const units = String(weight.units ?? "ounces").toLowerCase();
  if (units === "pounds") return value * 16;
  if (units === "grams") return value * 0.035274;
  return value;
}

function parseDims(dimensions: Record<string, unknown> | null | undefined): { length: number | null; width: number | null; height: number | null } {
  if (!dimensions) return { length: null, width: null, height: null };
  const factor = String(dimensions.units ?? "inches").toLowerCase().startsWith("c") ? 0.393701 : 1;
  return {
    length: parseNumber(dimensions.length) != null ? Number((Number(dimensions.length) * factor).toFixed(2)) : null,
    width: parseNumber(dimensions.width) != null ? Number((Number(dimensions.width) * factor).toFixed(2)) : null,
    height: parseNumber(dimensions.height) != null ? Number((Number(dimensions.height) * factor).toFixed(2)) : null,
  };
}

function mapShipmentPayload(payload: Record<string, unknown>): ExternalOrderShipmentRecord {
  const dims = parseDims(payload.dimensions as Record<string, unknown> | undefined);
  return {
    shipmentId: Number(payload.shipmentId),
    orderId: Number(payload.orderId),
    orderNumber: payload.orderNumber ? String(payload.orderNumber) : null,
    shipmentCost: Number(payload.shipmentCost ?? 0),
    otherCost: Number(payload.otherCost ?? 0),
    carrierCode: payload.carrierCode ? String(payload.carrierCode) : null,
    serviceCode: payload.serviceCode ? String(payload.serviceCode) : null,
    trackingNumber: payload.trackingNumber ? String(payload.trackingNumber) : null,
    shipDate: payload.shipDate ? String(payload.shipDate) : null,
    voided: Boolean(payload.voided),
    createDate: payload.createDate ? String(payload.createDate) : null,
    weightOz: parseWeightOz(payload.weight as Record<string, unknown> | undefined),
    dimsLength: dims.length,
    dimsWidth: dims.width,
    dimsHeight: dims.height,
  };
}

function v1Creds(credentials: ShipstationV1Credentials) {
  return { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret };
}

export class ShipstationShippingGateway implements ShippingGateway {
  private readonly secrets: TransitionalSecrets;

  constructor(secrets: TransitionalSecrets) {
    this.secrets = secrets;
  }

  async createLabel(input: CreateExternalLabelInput): Promise<CreatedExternalLabel> {
    const client = getShipStationClient();
    const pkg: Record<string, unknown> = {
      weight: { value: Number(input.weightOz.toFixed(2)), unit: "ounce" },
      package_code: input.packageCode || "package",
    };
    if (input.length && input.width && input.height) {
      pkg.dimensions = {
        length: Number(input.length.toFixed(2)),
        width: Number(input.width.toFixed(2)),
        height: Number(input.height.toFixed(2)),
        unit: "inch",
      };
    }

    const body = {
      shipment: {
        carrier_id: input.carrierId,
        service_code: input.serviceCode,
        ship_date: new Date().toISOString().slice(0, 10),
        ship_from: {
          name: input.shipFrom.name,
          company_name: input.shipFrom.company,
          address_line1: input.shipFrom.street1,
          address_line2: input.shipFrom.street2,
          city_locality: input.shipFrom.city,
          state_province: input.shipFrom.state,
          postal_code: input.shipFrom.postalCode,
          country_code: input.shipFrom.country,
          phone: input.shipFrom.phone || "000-000-0000",
        },
        ship_to: {
          name: input.shipTo.name,
          company_name: input.shipTo.company,
          address_line1: input.shipTo.street1,
          address_line2: input.shipTo.street2,
          city_locality: input.shipTo.city,
          state_province: input.shipTo.state,
          postal_code: input.shipTo.postalCode,
          country_code: input.shipTo.country,
          phone: input.shipTo.phone || "000-000-0000",
        },
        packages: [pkg],
        confirmation: input.confirmation || "none",
        external_order_id: input.orderNumber ?? undefined,
      },
      is_return_label: false,
      label_layout: "4x6",
      label_format: "pdf",
      label_download_type: "url",
    };

    // Debug: log request body
    console.log("[ShipStation] Creating label with body:", JSON.stringify(body, null, 2));

    const payload = await client.v2<Record<string, unknown>>(
      { apiKeyV2: input.apiKeyV2 },
      "/labels",
      { method: "POST", body },
    );

    const shipmentId = Number(String(payload.shipment_id ?? "").replace(/^se-/, ""));
    const providerAccountId = Number(String(input.carrierId).replace(/^se-/, ""));

    return {
      shipmentId,
      trackingNumber: payload.tracking_number ? String(payload.tracking_number) : null,
      labelUrl: ((payload.label_download as Record<string, unknown> | undefined)?.pdf ?? (payload.label_download as Record<string, unknown> | undefined)?.href ?? null) as string | null,
      cost: Number((payload.shipment_cost as Record<string, unknown> | undefined)?.amount ?? 0),
      voided: Boolean(payload.voided),
      carrierCode: payload.carrier_code ? String(payload.carrier_code) : null,
      serviceCode: payload.service_code ? String(payload.service_code) : input.serviceCode,
      shipDate: payload.ship_date ? String(payload.ship_date) : new Date().toISOString().slice(0, 10),
      providerAccountId: Number.isFinite(providerAccountId) ? providerAccountId : null,
      selectedRate: {
        providerAccountId: Number.isFinite(providerAccountId) ? providerAccountId : null,
        providerAccountNickname: null,
        shippingProviderId: Number.isFinite(providerAccountId) ? providerAccountId : null,
        serviceName: payload.service_code ? String(payload.service_code) : input.serviceCode,
        serviceCode: payload.service_code ? String(payload.service_code) : input.serviceCode,
        carrierCode: payload.carrier_code ? String(payload.carrier_code) : null,
        cost: Number((payload.shipment_cost as Record<string, unknown> | undefined)?.amount ?? 0),
        shipmentCost: Number((payload.shipment_cost as Record<string, unknown> | undefined)?.amount ?? 0),
        otherCost: 0,
      },
    };
  }

  async getShipment(credentials: ShipstationV1Credentials, shipmentId: number): Promise<ShipstationShipmentDetails | null> {
    const client = getShipStationClient();
    try {
      const data = await client.v1<Record<string, unknown>>(
        v1Creds(credentials),
        `/shipments/${shipmentId}`,
      );
      const shipment = ((data.shipment as Record<string, unknown> | undefined) ?? data);
      const dims = parseDims(shipment.dimensions as Record<string, unknown> | undefined);
      return {
        shipmentId: Number(shipment.shipmentId ?? shipmentId),
        orderId: Number(shipment.orderId ?? 0),
        orderNumber: shipment.orderNumber ? String(shipment.orderNumber) : null,
        trackingNumber: shipment.trackingNumber ? String(shipment.trackingNumber) : null,
        carrierCode: shipment.carrierCode ? String(shipment.carrierCode) : null,
        serviceCode: shipment.serviceCode ? String(shipment.serviceCode) : null,
        shipmentCost: Number(shipment.shipmentCost ?? 0),
        otherCost: Number(shipment.otherCost ?? 0),
        shipDate: shipment.shipDate ? String(shipment.shipDate) : null,
        confirmation: shipment.confirmation ? String(shipment.confirmation) : null,
        voided: Boolean(shipment.voided),
        labelUrl: ((shipment.labelDownload as Record<string, unknown> | undefined)?.pdf ?? (shipment.labelDownload as Record<string, unknown> | undefined)?.href ?? (shipment.label_download as Record<string, unknown> | undefined)?.pdf ?? null) as string | null,
        createDate: shipment.createDate ? String(shipment.createDate) : null,
        weightOz: parseWeightOz(shipment.weight as Record<string, unknown> | undefined),
        dimsLength: dims.length,
        dimsWidth: dims.width,
        dimsHeight: dims.height,
        providerAccountId: parseNumber((shipment.advancedOptions as Record<string, unknown> | undefined)?.billToMyOtherAccount ?? null),
      };
    } catch {
      return null;
    }
  }

  async markOrderShipped(credentials: ShipstationV1Credentials, input: MarkOrderShippedInput): Promise<boolean> {
    const client = getShipStationClient();
    try {
      await client.v1(
        v1Creds(credentials),
        "/orders/markasshipped",
        {
          method: "POST",
          body: {
            orderId: input.orderId,
            carrierCode: input.carrierCode,
            shipDate: input.shipDate,
            trackingNumber: input.trackingNumber,
            notifyCustomer: false,
            notifySalesChannel: true,
          },
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  async voidShipment(apiKeyV2: string, shipmentId: number): Promise<void> {
    const client = getShipStationClient();
    await client.v2(
      { apiKeyV2 },
      `/shipments/${shipmentId}/void`,
      { method: "POST", body: {} },
    );
  }

  async createReturnLabel(apiKeyV2: string, shipmentId: number, reason: string): Promise<ReturnLabelResult> {
    const client = getShipStationClient();
    const payload = await client.v2<Record<string, unknown>>(
      { apiKeyV2 },
      `/shipments/${shipmentId}/returnlabel`,
      { method: "POST", body: { reason } },
    );
    return {
      returnTrackingNumber: String(payload.trackingNumber ?? payload.tracking_number ?? ""),
      returnShipmentId: parseNumber(payload.shipmentId ?? payload.shipment_id),
      cost: Number(payload.shipmentCost ?? payload.shipment_cost ?? 0),
    };
  }

  async listRecentLabels(apiKeyV2: string): Promise<ShipstationLabelRecord[]> {
    const client = getShipStationClient();
    try {
      const payload = await client.v2<{ labels?: Array<Record<string, unknown>> }>(
        { apiKeyV2 },
        "/labels?limit=1000&sort=-created_at",
        { deduplicate: true },
      );
      return (payload.labels ?? []).map((label) => ({
        labelId: label.label_id ? String(label.label_id) : null,
        trackingNumber: label.tracking_number ? String(label.tracking_number) : null,
        labelUrl: ((label.label_download as Record<string, unknown> | undefined)?.pdf ?? (label.label_download as Record<string, unknown> | undefined)?.href ?? null) as string | null,
      }));
    } catch {
      return [];
    }
  }

  async listOrderShipments(credentials: ShipstationV1Credentials, orderId: number): Promise<ExternalOrderShipmentRecord[]> {
    const client = getShipStationClient();
    try {
      const payload = await client.v1<{ shipments?: Array<Record<string, unknown>> }>(
        v1Creds(credentials),
        `/orders/${orderId}`,
      );
      return (payload.shipments ?? []).map(mapShipmentPayload);
    } catch {
      return [];
    }
  }

  async listShipments(credentials: ShipstationV1Credentials, searchParams: URLSearchParams): Promise<ShipmentPageResult> {
    const client = getShipStationClient();
    const payload = await client.v1<{
      shipments?: Array<Record<string, unknown>>;
      page?: number;
      pages?: number;
      total?: number;
    }>(
      v1Creds(credentials),
      `/shipments?${searchParams.toString()}`,
    );
    return {
      shipments: (payload.shipments ?? []).map(mapShipmentPayload),
      page: payload.page ?? 1,
      pages: payload.pages ?? 1,
      total: payload.total ?? ((payload.shipments ?? []).length),
      raw: payload,
    };
  }

  async listShipmentsV2(apiKeyV2: string, page: number, createdAtStart?: string) {
    const client = getShipStationClient();
    const params = new URLSearchParams({
      page_size: "500",
      page: String(page),
      sort_dir: "DESC",
    });
    if (createdAtStart) params.set("created_at_start", createdAtStart);
    try {
      const payload = await client.v2<{ shipments?: Array<Record<string, unknown>> }>(
        { apiKeyV2 },
        `/shipments?${params.toString()}`,
      );
      return (payload.shipments ?? []).map((shipment) => ({
        orderNumber: shipment.shipment_number ? String(shipment.shipment_number) : null,
        orderId: parseNumber(shipment.order_id),
        carrierId: shipment.carrier_id ? String(shipment.carrier_id) : null,
      }));
    } catch {
      return [];
    }
  }
}
