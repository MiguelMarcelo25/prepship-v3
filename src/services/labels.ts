import { eq, or, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { orders } from '../db/schema/orders';
import { ssRequest } from '../lib/shipstation';
import type {
  Address,
  Label,
  Parcel,
  Shipment as SSShipment,
} from '../lib/shipstation/types';
import { getDefaultShipFrom } from '../lib/ship-from';

export type CreateFromRateInput = {
  rateId: string;
  orderId: number;
  clientId?: number;
};

export type CreateFromShipmentInput = {
  orderId: number;
  clientId?: number;
  weightOz: number;
  dimensions?: { length: number; width: number; height: number };
  shipTo: Address;
  shipFrom?: Address;
  serviceCode: string;
  residential?: boolean;
};

async function persistLabel(
  label: Label,
  orderId: number,
  clientId?: number
) {
  const shipDate = label.ship_date ? new Date(label.ship_date) : null;
  const createdAt = label.created_at ? new Date(label.created_at) : new Date();
  const [row] = await db
    .insert(shipments)
    .values({
      orderId,
      clientId: clientId ?? null,
      carrierCode: label.carrier_code,
      serviceCode: label.service_code,
      trackingNumber: label.tracking_number,
      shipDate,
      createDate: createdAt,
      labelUrl: label.label_download?.href ?? null,
      labelCreatedAt: createdAt,
      labelFormat: label.label_format ?? null,
      labelCarrier: label.carrier_code,
      labelService: label.service_code,
      labelTracking: label.tracking_number,
      labelCost: label.shipment_cost.amount.toFixed(2),
      labelShipDate: shipDate,
      labelShipmentId: null,
      voided: !!label.voided,
      source: 'v4',
      isReturn: !!label.is_return_label,
    })
    .returning();
  if (!row) throw new Error('Failed to persist shipment row');
  return row;
}

export async function createLabelFromRate(input: CreateFromRateInput) {
  const label = await ssRequest<Label>(`/v2/labels/rates/${input.rateId}`, {
    method: 'POST',
    body: { validate_address: 'no_validation' },
    dedupeKey: `label:rate:${input.rateId}`,
  });
  return persistLabel(label, input.orderId, input.clientId);
}

export async function createLabelFromShipment(input: CreateFromShipmentInput) {
  const shipFrom = input.shipFrom ?? (await getDefaultShipFrom());
  const parcel: Parcel = {
    weight: { value: input.weightOz, unit: 'ounce' },
  };
  if (input.dimensions) {
    parcel.dimensions = {
      unit: 'inch',
      length: input.dimensions.length,
      width: input.dimensions.width,
      height: input.dimensions.height,
    };
  }

  const shipment: SSShipment = {
    validate_address: 'no_validation',
    ship_to: {
      ...input.shipTo,
      address_residential_indicator:
        input.residential === true
          ? 'yes'
          : input.residential === false
            ? 'no'
            : 'unknown',
    },
    ship_from: shipFrom,
    packages: [parcel],
  };

  const label = await ssRequest<Label>('/v2/labels', {
    method: 'POST',
    body: { shipment, service_code: input.serviceCode },
  });
  return persistLabel(label, input.orderId, input.clientId);
}

export async function voidLabel(shipmentId: number) {
  const [row] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  if (!row) throw new Error('Shipment not found');
  if (row.voided) return row;

  // We don't have ShipStation's label_id stored — for now, mark locally.
  // TODO: when we persist label_id from the purchase response, also call
  //   PUT /v2/labels/:label_id/void to void at ShipStation.
  const [updated] = await db
    .update(shipments)
    .set({ voided: true, updatedAt: new Date() })
    .where(eq(shipments.id, shipmentId))
    .returning();
  return updated;
}

// Buy a label by orderId — pulls the order's weight + ship-to from the
// DB (set during ShipStation sync) and posts to ShipStation v2 with the
// caller-supplied service code.
export async function createLabelFromOrderId(args: {
  orderId: number;
  serviceCode: string;
  clientId?: number;
}) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .limit(1);
  if (!order) throw new Error(`Order ${args.orderId} not found`);
  if (!order.weightOz || order.weightOz <= 0) {
    throw new Error(`Order ${order.orderNumber} has no weight set`);
  }

  const raw = (order.raw as { shipTo?: { street1?: string; street2?: string | null; city?: string; state?: string; postalCode?: string; country?: string; phone?: string | null } } | null) ?? {};
  const shipToRaw = raw.shipTo ?? {};
  const street1 = shipToRaw.street1 ?? '';
  const city = shipToRaw.city ?? order.shipToCity ?? '';
  const state = shipToRaw.state ?? order.shipToState ?? '';
  const postal = shipToRaw.postalCode ?? order.shipToPostalCode ?? '';
  const missing: string[] = [];
  if (!street1) missing.push('street');
  if (!city) missing.push('city');
  if (!state) missing.push('state');
  if (!postal) missing.push('postal code');
  if (missing.length) {
    const hasAnyShipTo = Object.keys(shipToRaw).length > 0;
    throw new Error(
      `Order ${order.orderNumber}: ship-to ${
        hasAnyShipTo
          ? `missing ${missing.join(', ')}`
          : 'is empty (likely an auto-generated order with no recipient address)'
      }`
    );
  }

  return createLabelFromShipment({
    orderId: args.orderId,
    clientId: args.clientId ?? order.clientId ?? undefined,
    weightOz: order.weightOz,
    serviceCode: args.serviceCode,
    shipTo: {
      name: order.shipToName ?? undefined,
      address_line1: street1,
      address_line2: shipToRaw.street2 ?? undefined,
      city_locality: city,
      state_province: state,
      postal_code: postal,
      country_code: shipToRaw.country ?? 'US',
      phone: shipToRaw.phone ?? undefined,
    },
  });
}

export type BatchResultItem = {
  orderId: number;
  success: boolean;
  shipmentId?: number;
  trackingNumber?: string | null;
  cost?: string | null;
  error?: string;
};

export async function createLabelBatch(
  orderIds: number[],
  serviceCode: string
): Promise<{
  created: BatchResultItem[];
  failed: BatchResultItem[];
  summary: { total: number; created: number; failed: number };
}> {
  const created: BatchResultItem[] = [];
  const failed: BatchResultItem[] = [];
  const concurrency = 5;

  for (let i = 0; i < orderIds.length; i += concurrency) {
    const chunk = orderIds.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (orderId) => {
        try {
          const shipment = await createLabelFromOrderId({ orderId, serviceCode });
          created.push({
            orderId,
            success: true,
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
            cost: shipment.labelCost,
          });
        } catch (err) {
          failed.push({
            orderId,
            success: false,
            error: (err as Error).message,
          });
        }
      })
    );
  }

  return {
    created,
    failed,
    summary: {
      total: orderIds.length,
      created: created.length,
      failed: failed.length,
    },
  };
}

export async function lookupLabel(lookup: string) {
  const asNum = Number(lookup);
  const rows = await db
    .select()
    .from(shipments)
    .where(
      Number.isFinite(asNum)
        ? or(eq(shipments.orderId, asNum), eq(shipments.id, asNum))
        : eq(shipments.trackingNumber, lookup)
    )
    .orderBy(desc(shipments.createdAt))
    .limit(10);
  return rows;
}
