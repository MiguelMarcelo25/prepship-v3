import type { CreatedExternalLabel } from '../lib/shipstation/labels';
import {
  buildSsLabelRequestBody,
  type ShipstationAddressInput,
} from '../lib/shipstation/label-request-body';
import { normalizeShippingOptions } from '../lib/shipping-options';
import { EXACT_SHIPSTATION_RECONCILER_ACTOR } from './fulfillment-operation-provenance';

// Per user override unlock shipped data on 2026-07-22: these versioned facts
// bind post-purchase recovery to backend-authorized shipment/package truth.
export const SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR =
  EXACT_SHIPSTATION_RECONCILER_ACTOR;

type NullableDimensions = {
  length: number | null;
  width: number | null;
  height: number | null;
};

export type ShipStationForwardLabelPersistenceFacts = {
  version: 1;
  authority: 'canonical_shipping_quote';
  provider: 'shipstation';
  source: 'prepship_v2';
  orderId: number;
  clientId: number | null;
  effectiveWeightOz: number;
  dimensions: NullableDimensions;
  selectedPackageId: number | null;
  insuranceProvider: string;
  insuredValue: number | null;
};

type PersistenceFactsInput = Omit<
  ShipStationForwardLabelPersistenceFacts,
  'version' | 'authority' | 'provider' | 'source' | 'insuranceProvider' | 'insuredValue'
> & {
  insuranceProvider?: unknown;
  insuredValue?: unknown;
};

function positiveNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`ShipStation forward-label receipt has invalid ${field}`);
  }
  return number;
}

function nullablePositiveNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  return positiveNumber(value, field);
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`ShipStation forward-label receipt has invalid ${field}`);
  }
  return number;
}

export function buildShipStationForwardLabelOperationRequest(input: {
  shippingProviderId: number;
  carrierCode: string | null;
  serviceCode: string;
  packageCode: string;
  weightOz: number;
  dimensions: NullableDimensions;
  packageId: number | null;
  shippingOptions: {
    confirmation: string;
    insuranceProvider: string;
    insuredValue: number | null;
  };
  shipTo: ShipstationAddressInput;
  shipFrom: ShipstationAddressInput;
  orderNumber: string | null;
}): Record<string, unknown> {
  const providerRequest = buildSsLabelRequestBody({
    carrierId: `se-${input.shippingProviderId}`,
    serviceCode: input.serviceCode,
    packageCode: input.packageCode,
    weightOz: input.weightOz,
    length: input.dimensions.length,
    width: input.dimensions.width,
    height: input.dimensions.height,
    shipTo: input.shipTo,
    shipFrom: input.shipFrom,
    confirmation: input.shippingOptions.confirmation,
    insuranceProvider: input.shippingOptions.insuranceProvider,
    insuredValue: input.shippingOptions.insuredValue,
    ssOrderId: null,
    orderNumber: input.orderNumber,
  });
  const shipment = providerRequest.shipment as Record<string, unknown>;
  return {
    requestVersion: 2,
    shippingProviderId: input.shippingProviderId,
    carrierCode: input.carrierCode,
    packageId: input.packageId,
    // The date and external shipment id are generated at dispatch. Everything
    // else mirrors the exact ShipStation body, including residential, address,
    // package, confirmation, and insurance fields that can affect postage.
    providerRequest: {
      ...providerRequest,
      shipment: Object.fromEntries(
        Object.entries(shipment).filter(([key]) => key !== 'ship_date'),
      ),
    },
  };
}

export function buildShipStationForwardLabelReceipt(
  created: CreatedExternalLabel,
  input: PersistenceFactsInput,
): Record<string, unknown> {
  const shippingOptions = normalizeShippingOptions(input);
  return {
    created,
    persistenceFacts: {
      version: 1,
      authority: 'canonical_shipping_quote',
      provider: 'shipstation',
      source: 'prepship_v2',
      orderId: positiveNumber(input.orderId, 'orderId'),
      clientId: nullablePositiveInteger(input.clientId, 'clientId'),
      effectiveWeightOz: positiveNumber(input.effectiveWeightOz, 'effectiveWeightOz'),
      dimensions: {
        length: nullablePositiveNumber(input.dimensions.length, 'dimensions.length'),
        width: nullablePositiveNumber(input.dimensions.width, 'dimensions.width'),
        height: nullablePositiveNumber(input.dimensions.height, 'dimensions.height'),
      },
      selectedPackageId: nullablePositiveInteger(input.selectedPackageId, 'selectedPackageId'),
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
    } satisfies ShipStationForwardLabelPersistenceFacts,
  };
}

export function readShipStationForwardLabelPersistenceFacts(
  receipt: Record<string, unknown>,
  expected: { orderId: number; clientId: number | null },
): ShipStationForwardLabelPersistenceFacts {
  const raw = receipt.persistenceFacts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ShipStation forward-label receipt is missing canonical persistence facts');
  }
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1
    || value.authority !== 'canonical_shipping_quote'
    || value.provider !== 'shipstation'
    || value.source !== 'prepship_v2'
  ) {
    throw new Error('ShipStation forward-label receipt persistence authority is invalid');
  }
  const orderId = positiveNumber(value.orderId, 'orderId');
  const clientId = nullablePositiveInteger(value.clientId, 'clientId');
  if (orderId !== expected.orderId || clientId !== expected.clientId) {
    throw new Error('ShipStation forward-label receipt persistence scope does not match the order');
  }
  const dimensions = value.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new Error('ShipStation forward-label receipt dimensions are invalid');
  }
  const rawDimensions = dimensions as Record<string, unknown>;
  const rawInsuranceProvider = value.insuranceProvider;
  const rawInsuredValue = value.insuredValue;
  const shippingOptions = normalizeShippingOptions({
    insuranceProvider: rawInsuranceProvider,
    insuredValue: rawInsuredValue,
  });
  if (
    typeof rawInsuranceProvider !== 'string'
    || shippingOptions.insuranceProvider !== rawInsuranceProvider
    || shippingOptions.insuredValue !== rawInsuredValue
  ) {
    throw new Error('ShipStation forward-label receipt insurance facts are invalid');
  }
  return {
    version: 1,
    authority: 'canonical_shipping_quote',
    provider: 'shipstation',
    source: 'prepship_v2',
    orderId,
    clientId,
    effectiveWeightOz: positiveNumber(value.effectiveWeightOz, 'effectiveWeightOz'),
    dimensions: {
      length: nullablePositiveNumber(rawDimensions.length, 'dimensions.length'),
      width: nullablePositiveNumber(rawDimensions.width, 'dimensions.width'),
      height: nullablePositiveNumber(rawDimensions.height, 'dimensions.height'),
    },
    selectedPackageId: nullablePositiveInteger(value.selectedPackageId, 'selectedPackageId'),
    insuranceProvider: shippingOptions.insuranceProvider,
    insuredValue: shippingOptions.insuredValue,
  };
}

export function canAutomaticallyConsumeShipStationForwardLabelReceipt(input: {
  providerReceipt: Record<string, unknown> | null;
  resolvedBy: string | null;
}): boolean {
  if (!input.providerReceipt) return false;
  if (
    input.resolvedBy != null
    && input.resolvedBy !== SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR
  ) return false;
  const facts = input.providerReceipt.persistenceFacts;
  return !!facts && typeof facts === 'object' && !Array.isArray(facts);
}
