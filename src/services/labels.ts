import { and, eq, or, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
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
