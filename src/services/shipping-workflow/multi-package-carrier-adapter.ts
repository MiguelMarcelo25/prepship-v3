/**
 * PS-289 - injected multi-package carrier label adapter boundary.
 *
 * Shapes one carrier label request per planned package and delegates the actual label creation to an injected dependency.
 * No provider module imports, default provider calls, live postage, print queue writes, marketplace API calls, or shipped/cancelled mutation happens here.
 */
import type {
  MultiPackageLabelPurchaseRequest,
  MultiPackageLabelPurchaseResult,
  MultiPackageLabelPurchaser,
} from './multi-package-label-purchase-boundary';

export type MultiPackageCarrierLabelAddress = {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode: string;
  country: string;
  phone?: string | null;
  email?: string | null;
  residential?: boolean | null;
};

export type MultiPackageCarrierLabelCreateRequest = MultiPackageLabelPurchaseRequest & {
  provider: string;
  carrierAccountId: string;
  shipFrom: MultiPackageCarrierLabelAddress;
  shipTo: MultiPackageCarrierLabelAddress;
};

export type MultiPackageCarrierLabelCreator = (
  request: MultiPackageCarrierLabelCreateRequest,
) => Promise<MultiPackageLabelPurchaseResult>;

export type MultiPackageCarrierLabelPurchaserOptions = {
  provider: string;
  carrierAccountId: string;
  shipFrom: MultiPackageCarrierLabelAddress;
  shipTo: MultiPackageCarrierLabelAddress;
  createLabel: MultiPackageCarrierLabelCreator;
};

function requiredText(value: string | null | undefined, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required for multi-package carrier label adapter`);
  return text;
}

function optionalText(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeAddress(
  address: MultiPackageCarrierLabelAddress | undefined,
  field: string,
): MultiPackageCarrierLabelAddress {
  if (!address) throw new Error(`${field} is required for multi-package carrier label adapter`);

  return {
    name: optionalText(address.name),
    company: optionalText(address.company),
    address1: optionalText(address.address1),
    address2: optionalText(address.address2),
    city: optionalText(address.city),
    state: optionalText(address.state),
    postalCode: requiredText(address.postalCode, `${field}.postalCode`),
    country: requiredText(address.country, `${field}.country`),
    phone: optionalText(address.phone),
    email: optionalText(address.email),
    residential: address.residential ?? null,
  };
}

export function createMultiPackageCarrierLabelPurchaser(
  options: MultiPackageCarrierLabelPurchaserOptions,
): MultiPackageLabelPurchaser {
  if (typeof options.createLabel !== 'function') {
    throw new Error('Multi-package carrier label adapter requires an injected carrier label creator');
  }

  const provider = requiredText(options.provider, 'provider');
  const carrierAccountId = requiredText(options.carrierAccountId, 'carrierAccountId');
  const shipFrom = normalizeAddress(options.shipFrom, 'shipFrom');
  const shipTo = normalizeAddress(options.shipTo, 'shipTo');

  return async (request: MultiPackageLabelPurchaseRequest) => options.createLabel({
    ...request,
    provider,
    carrierAccountId,
    shipFrom,
    shipTo,
  });
}
