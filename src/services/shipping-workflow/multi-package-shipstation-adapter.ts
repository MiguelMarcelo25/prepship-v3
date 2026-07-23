/**
 * PS-289 - ShipStation-shaped multi-package label adapter.
 *
 * Converts each package purchase request into the existing ShipStation v2 label request shape.
 * No ShipStation network call, default live postage, print queue writes, marketplace API calls, or shipped/cancelled mutation happens here.
 */
import {
  buildSsLabelRequestBody,
  type CreateExternalLabelInput,
} from '../../lib/shipstation/labels.js';
import {
  createMultiPackageCarrierLabelPurchaser,
  type MultiPackageCarrierLabelAddress,
  type MultiPackageCarrierLabelCreateRequest,
} from './multi-package-carrier-adapter';
import type {
  MultiPackageLabelPurchaseResult,
  MultiPackageLabelPurchaser,
} from './multi-package-label-purchase-boundary';
import { roundMoney } from '../../lib/money.js';

export type ShipStationMultiPackageLabelRequestPackage = {
  weight: { value: number; unit: 'ounce' };
  package_code: string;
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: 'inch';
  };
  insured_value?: {
    amount: number;
    currency: 'usd';
  };
};

export type ShipStationMultiPackageLabelRequestBody = {
  shipment: {
    carrier_id: string;
    service_code: string;
    ship_date: string;
    ship_from: Record<string, unknown>;
    ship_to: Record<string, unknown> & {
      address_residential_indicator: 'yes' | 'no' | 'unknown';
    };
    packages: ShipStationMultiPackageLabelRequestPackage[];
    confirmation: string | null;
    insurance_provider?: string | null;
    external_order_id?: string;
  };
  is_return_label: false;
  label_layout: '4x6';
  label_format: 'pdf';
  label_download_type: 'url';
};

export type ShipStationMultiPackageLabelCreateContext = {
  request: MultiPackageCarrierLabelCreateRequest;
  labelInput: CreateExternalLabelInput;
  requestBody: ShipStationMultiPackageLabelRequestBody;
};

export type ShipStationMultiPackageLabelCreateResult = {
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string | null;
  cost: number;
  insuranceCost?: number | null;
  isLivePostage: boolean;
  provider?: string | null;
};

export type ShipStationMultiPackageLabelCreator = (
  context: ShipStationMultiPackageLabelCreateContext,
) => Promise<ShipStationMultiPackageLabelCreateResult>;

export type ShipStationMultiPackageLabelPurchaserOptions = {
  apiKeyV2?: string;
  carrierId: string;
  carrierAccountId?: string | null;
  serviceCode: string;
  packageCode: string;
  shipFrom: MultiPackageCarrierLabelAddress;
  shipTo: MultiPackageCarrierLabelAddress;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  ssOrderId?: number | null;
  testLabel?: boolean;
  createLabel: ShipStationMultiPackageLabelCreator;
};

function requiredText(value: string | null | undefined, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required for multi-package ShipStation label adapter`);
  return text;
}

function positiveNumberOrNull(value: number | null | undefined): number | null {
  return Number.isFinite(value) && value != null && value > 0 ? value : null;
}

function requiredPositiveNumber(value: number | null | undefined, field: string, packageKey: string): number {
  const normalized = positiveNumberOrNull(value);
  if (normalized == null) {
    throw new Error(`${field} is required for ShipStation package ${packageKey}`);
  }
  return normalized;
}

function toShipStationAddress(input: MultiPackageCarrierLabelAddress) {
  return {
    name: input.name,
    company: input.company,
    street1: input.address1,
    street2: input.address2,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country,
    phone: input.phone,
    residential: input.residential,
  };
}

export function buildShipStationMultiPackageLabelInput(
  request: MultiPackageCarrierLabelCreateRequest,
  options: ShipStationMultiPackageLabelPurchaserOptions,
): CreateExternalLabelInput {
  return {
    apiKeyV2: options.apiKeyV2,
    carrierId: requiredText(options.carrierId, 'carrierId'),
    serviceCode: requiredText(options.serviceCode, 'serviceCode'),
    packageCode: requiredText(options.packageCode, 'packageCode'),
    weightOz: requiredPositiveNumber(request.weightOz, 'weightOz', request.packageKey),
    length: positiveNumberOrNull(request.dimensions.length),
    width: positiveNumberOrNull(request.dimensions.width),
    height: positiveNumberOrNull(request.dimensions.height),
    shipTo: toShipStationAddress(request.shipTo),
    shipFrom: toShipStationAddress(request.shipFrom),
    confirmation: options.confirmation ?? null,
    insuranceProvider: options.insuranceProvider ?? null,
    insuredValue: options.insuredValue ?? null,
    ssOrderId: options.ssOrderId ?? null,
    orderNumber: request.orderNumber,
    testLabel: options.testLabel,
  };
}

function toPurchaseResult(
  request: MultiPackageCarrierLabelCreateRequest,
  result: ShipStationMultiPackageLabelCreateResult,
): MultiPackageLabelPurchaseResult {
  return {
    labelIdempotencyKey: request.labelIdempotencyKey,
    shipmentId: result.shipmentId,
    trackingNumber: String(result.trackingNumber ?? '').trim(),
    labelUrl: String(result.labelUrl ?? '').trim(),
    provider: String(result.provider ?? 'shipstation').trim() || 'shipstation',
    postageCost: roundMoney(Number(result.cost ?? 0)),
    isLivePostage: result.isLivePostage === true,
  };
}

export function createShipStationMultiPackageLabelPurchaser(
  options: ShipStationMultiPackageLabelPurchaserOptions,
): MultiPackageLabelPurchaser {
  if (typeof options.createLabel !== 'function') {
    throw new Error('Multi-package ShipStation adapter requires an injected ShipStation label creator');
  }

  return createMultiPackageCarrierLabelPurchaser({
    provider: 'shipstation',
    carrierAccountId: options.carrierAccountId?.trim() || requiredText(options.carrierId, 'carrierId'),
    shipFrom: options.shipFrom,
    shipTo: options.shipTo,
    createLabel: async (request) => {
      const labelInput = buildShipStationMultiPackageLabelInput(request, options);
      const requestBody = buildSsLabelRequestBody(labelInput) as unknown as ShipStationMultiPackageLabelRequestBody;
      const result = await options.createLabel({ request, labelInput, requestBody });
      return toPurchaseResult(request, result);
    },
  });
}
