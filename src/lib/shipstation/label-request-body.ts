import { normalizeShippingOptions } from '../shipping-options.js';
import type { Address } from './types.js';
import type { CanonicalHazmatPurchaseFacts } from '../../services/shipping-workflow/hazmat-declaration.js';
import { applyShipStationHazmatToShipment } from './hazmat.js';

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
  residential?: boolean | null;
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
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  ssOrderId: number | null;
  orderNumber: string | null;
  externalShipmentId?: string;
  signal?: AbortSignal;
  testLabel?: boolean;
  /** Backend-sealed facts only; request callers may not construct provider hazmat fields. */
  hazmat?: CanonicalHazmatPurchaseFacts | null;
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
    address_residential_indicator:
      input.residential === true ? 'yes' : input.residential === false ? 'no' : 'unknown',
  };
}

const SS_SYNTHETIC_CARRIER_ID_FLOOR = 10_000_000;

export function assertSsCarrierIdIsNotSynthetic(carrierId: unknown): void {
  const match = String(carrierId ?? '').trim().match(/^se-(\d+)$/i);
  const numeric = match ? Number(match[1]) : NaN;
  if (Number.isFinite(numeric) && numeric >= SS_SYNTHETIC_CARRIER_ID_FLOOR) {
    const err = new Error(
      `Direct-carrier account id ${numeric} cannot be sent to ShipStation (carrier_id ${String(carrierId)} is a PrepShip-internal synthetic id). Re-rate/select the matching account or route through the direct-carrier label path. No postage was purchased.`,
    ) as Error & { code?: string };
    err.code = 'DIRECT_CARRIER_ON_SHIPSTATION_PATH';
    throw err;
  }
}

/**
 * Pure source of truth for the ShipStation v2 label POST body.
 * Per user override unlock shipped data on 2026-07-22: operation hashing and
 * provider dispatch now consume this same money-affecting payload shape.
 */
export function buildSsLabelRequestBody(input: CreateExternalLabelInput) {
  assertSsCarrierIdIsNotSynthetic(input.carrierId);
  const options = normalizeShippingOptions(input);
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
  const hasInsurance = options.insuranceProvider !== 'none' && options.insuredValue != null;
  if (hasInsurance) {
    pkg.insured_value = { amount: options.insuredValue, currency: 'usd' };
  }
  const shipment = applyShipStationHazmatToShipment({
      carrier_id: input.carrierId,
      service_code: input.serviceCode,
      ship_date: new Date().toISOString().slice(0, 10),
      ship_from: toAddress(input.shipFrom),
      ship_to: toAddress(input.shipTo),
      packages: [pkg],
      confirmation: options.confirmation,
      ...(hasInsurance ? { insurance_provider: options.insuranceProvider } : {}),
      external_order_id: input.orderNumber ?? undefined,
      external_shipment_id: normalizeShipStationExternalShipmentId(input.externalShipmentId) ?? undefined,
    }, input.hazmat);
  return {
    shipment,
    is_return_label: false,
    label_layout: '4x6',
    label_format: 'pdf',
    label_download_type: 'url',
  };
}

export function normalizeShipStationExternalShipmentId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, 50) : null;
}
