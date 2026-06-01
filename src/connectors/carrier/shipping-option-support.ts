import {
  type NormalizedShippingOptions,
  normalizeShippingOptions,
} from '../../lib/shipping-options.js';

export function carrierShippingOptions(input: Record<string, unknown>): NormalizedShippingOptions {
  return normalizeShippingOptions(input.shippingOptions as Record<string, unknown> | undefined ?? input);
}

export function assertUnsupportedShippingOptions(
  providerLabel: string,
  input: Record<string, unknown>,
  support: {
    confirmation?: boolean | Array<NormalizedShippingOptions['confirmation']>;
    insurance?: boolean;
  } = {},
) {
  const options = carrierShippingOptions(input);
  const confirmationSupport = support.confirmation ?? false;
  const confirmationAllowed = Array.isArray(confirmationSupport)
    ? confirmationSupport.includes(options.confirmation)
    : confirmationSupport === true || options.confirmation === 'delivery' || options.confirmation === 'none';
  if (!confirmationAllowed) {
    throw new Error(`${options.confirmation} is not supported by ${providerLabel} for this order/carrier`);
  }
  if (options.insuranceProvider !== 'none' && support.insurance !== true) {
    throw new Error('insurance is not supported by ' + providerLabel + ' for this order/carrier');
  }
  return options;
}
