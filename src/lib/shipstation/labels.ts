import { ssRequest } from './client';
import { ssV1Request } from './v1-client';
import type { Address } from './types';

export type ShipstationAddressInput = {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
};

export type CreateExternalLabelInput = {
  apiKeyV2?: string;
  carrierId: string;
  serviceCode: string;
  packageCode: string;
  weightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  shipTo: ShipstationAddressInput;
  shipFrom: ShipstationAddressInput;
  confirmation?: string | null;
  ssOrderId: number | null;
  orderNumber: string | null;
  testLabel?: boolean;
};

export type CreatedExternalLabel = {
  labelId: string | null;
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string | null;
  labelFormat: string | null;
  cost: number;
  voided: boolean;
  carrierCode: string | null;
  serviceCode: string;
  shipDate: string;
  providerAccountId: number | null;
};

export type ShipstationLabelRecord = {
  labelId: string | null;
  shipmentId: number | null;
  trackingNumber: string | null;
  labelUrl: string | null;
};

export type ShipstationShipmentDetailsV1 = {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  otherCost: number;
  shipDate: string | null;
  voided: boolean;
  labelUrl: string | null;
  createDate: string | null;
  weightOz: number | null;
  dimsLength: number | null;
  dimsWidth: number | null;
  dimsHeight: number | null;
};

export type ReturnLabelResult = {
  returnShipmentId: number | null;
  returnTrackingNumber: string;
  cost: number;
  labelUrl: string | null;
};

function toAddress(input: ShipstationAddressInput, fallbackPhone = '000-000-0000'): Address {
  return {
    name: input.name ?? undefined,
    company_name: input.company ?? undefined,
    phone: input.phone || fallbackPhone,
    address_line1: input.street1 ?? '',
    address_line2: input.street2 ?? undefined,
    city_locality: input.city ?? '',
    state_province: input.state ?? '',
    postal_code: input.postalCode ?? '',
    country_code: input.country ?? 'US',
  };
}

function stripSePrefix(value: unknown): number | null {
  if (value == null) return null;
  const stripped = String(value).replace(/^se-/, '');
  const num = Number(stripped);
  return Number.isFinite(num) ? num : null;
}

function parseWeightOz(weight: Record<string, unknown> | null | undefined): number | null {
  if (!weight) return null;
  const value = Number(weight.value);
  if (!Number.isFinite(value)) return null;
  const units = String(weight.units ?? weight.unit ?? 'ounces').toLowerCase();
  if (units === 'pound' || units === 'pounds') return value * 16;
  if (units === 'gram' || units === 'grams') return value * 0.035274;
  return value;
}

function parseDims(
  dimensions: Record<string, unknown> | null | undefined
): { length: number | null; width: number | null; height: number | null } {
  if (!dimensions) return { length: null, width: null, height: null };
  const factor = String(dimensions.units ?? dimensions.unit ?? 'inches').toLowerCase().startsWith('c')
    ? 0.393701
    : 1;
  const coerce = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Number((n * factor).toFixed(2)) : null;
  };
  return {
    length: coerce(dimensions.length),
    width: coerce(dimensions.width),
    height: coerce(dimensions.height),
  };
}

export async function ssCreateLabel(input: CreateExternalLabelInput): Promise<CreatedExternalLabel> {
  const pkg: Record<string, unknown> = {
    weight: { value: Number(input.weightOz.toFixed(2)), unit: 'ounce' },
    package_code: input.packageCode || 'package',
  };
  if (input.length && input.width && input.height) {
    pkg.dimensions = {
      length: Number(input.length.toFixed(2)),
      width: Number(input.width.toFixed(2)),
      height: Number(input.height.toFixed(2)),
      unit: 'inch',
    };
  }

  const body = {
    shipment: {
      carrier_id: input.carrierId,
      service_code: input.serviceCode,
      ship_date: new Date().toISOString().slice(0, 10),
      ship_from: toAddress(input.shipFrom),
      ship_to: toAddress(input.shipTo),
      packages: [pkg],
      confirmation: input.confirmation || 'none',
      external_order_id: input.orderNumber ?? undefined,
    },
    is_return_label: false,
    label_layout: '4x6',
    label_format: 'pdf',
    label_download_type: 'url',
  };

  const payload = await ssRequest<Record<string, unknown>>('/v2/labels', {
    method: 'POST',
    body,
    apiKey: input.apiKeyV2,
  });

  const labelDownload = (payload.label_download as Record<string, unknown> | undefined) ?? {};
  const shipmentCost = payload.shipment_cost as Record<string, unknown> | undefined;
  const providerAccountId = stripSePrefix(input.carrierId);
  const shipmentId = stripSePrefix(payload.shipment_id) ?? 0;

  return {
    labelId: payload.label_id ? String(payload.label_id) : null,
    shipmentId,
    trackingNumber: payload.tracking_number ? String(payload.tracking_number) : null,
    labelUrl: ((labelDownload.pdf ?? labelDownload.href) as string | undefined) ?? null,
    labelFormat: payload.label_format ? String(payload.label_format) : 'pdf',
    cost: Number(shipmentCost?.amount ?? 0),
    voided: Boolean(payload.voided),
    carrierCode: payload.carrier_code ? String(payload.carrier_code) : null,
    serviceCode: payload.service_code ? String(payload.service_code) : input.serviceCode,
    shipDate: payload.ship_date ? String(payload.ship_date) : new Date().toISOString().slice(0, 10),
    providerAccountId,
  };
}

export async function ssVoidLabel(labelId: string, apiKeyV2?: string): Promise<void> {
  await ssRequest(`/v2/labels/${labelId}/void`, {
    method: 'PUT',
    body: {},
    apiKey: apiKeyV2,
  });
}

export async function ssVoidShipment(shipmentId: number | string, apiKeyV2?: string): Promise<void> {
  const id = typeof shipmentId === 'number' ? `se-${shipmentId}` : shipmentId;
  await ssRequest(`/v2/shipments/${id}/void`, {
    method: 'POST',
    body: {},
    apiKey: apiKeyV2,
  });
}

export async function ssCreateReturnLabel(
  shipmentId: number,
  reason: string,
  apiKeyV2?: string
): Promise<ReturnLabelResult> {
  const id = `se-${shipmentId}`;
  const payload = await ssRequest<Record<string, unknown>>(`/v2/shipments/${id}/return-labels`, {
    method: 'POST',
    body: { reason },
    apiKey: apiKeyV2,
  });
  const shipmentCost = payload.shipment_cost as Record<string, unknown> | undefined;
  const labelDownload = (payload.label_download as Record<string, unknown> | undefined) ?? {};
  return {
    returnShipmentId: stripSePrefix(payload.shipment_id),
    returnTrackingNumber: String(payload.tracking_number ?? ''),
    cost: Number(shipmentCost?.amount ?? 0),
    labelUrl: ((labelDownload.pdf ?? labelDownload.href) as string | undefined) ?? null,
  };
}

export async function ssListRecentLabels(apiKeyV2?: string): Promise<ShipstationLabelRecord[]> {
  try {
    const payload = await ssRequest<{ labels?: Array<Record<string, unknown>> }>(
      '/v2/labels?page_size=500&sort_dir=desc',
      { apiKey: apiKeyV2, dedupeKey: 'labels:list' }
    );
    return (payload.labels ?? []).map((label) => {
      const labelDownload = (label.label_download as Record<string, unknown> | undefined) ?? {};
      return {
        labelId: label.label_id ? String(label.label_id) : null,
        shipmentId: stripSePrefix(label.shipment_id),
        trackingNumber: label.tracking_number ? String(label.tracking_number) : null,
        labelUrl: ((labelDownload.pdf ?? labelDownload.href) as string | undefined) ?? null,
      };
    });
  } catch {
    return [];
  }
}

export async function ssGetShipmentV1(
  shipmentId: number,
  opts: { apiKey?: string; apiSecret?: string } = {}
): Promise<ShipstationShipmentDetailsV1 | null> {
  try {
    const data = await ssV1Request<Record<string, unknown>>(`/shipments/${shipmentId}`, {
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
    });
    const shipment = (data.shipment as Record<string, unknown> | undefined) ?? data;
    const dims = parseDims(shipment.dimensions as Record<string, unknown> | undefined);
    const labelDownload =
      (shipment.labelDownload as Record<string, unknown> | undefined) ??
      (shipment.label_download as Record<string, unknown> | undefined) ??
      {};
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
      voided: Boolean(shipment.voided),
      labelUrl: ((labelDownload.pdf ?? labelDownload.href) as string | undefined) ?? null,
      createDate: shipment.createDate ? String(shipment.createDate) : null,
      weightOz: parseWeightOz(shipment.weight as Record<string, unknown> | undefined),
      dimsLength: dims.length,
      dimsWidth: dims.width,
      dimsHeight: dims.height,
    };
  } catch {
    return null;
  }
}

export async function ssMarkOrderShippedV1(
  args: {
    orderId: number;
    carrierCode: string | null;
    trackingNumber: string;
    shipDate: string;
  },
  opts: { apiKey?: string; apiSecret?: string } = {}
): Promise<boolean> {
  try {
    await ssV1Request('/orders/markasshipped', {
      method: 'POST',
      body: {
        orderId: args.orderId,
        carrierCode: args.carrierCode,
        shipDate: args.shipDate,
        trackingNumber: args.trackingNumber,
        notifyCustomer: false,
        notifySalesChannel: true,
      },
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
    });
    return true;
  } catch {
    return false;
  }
}
