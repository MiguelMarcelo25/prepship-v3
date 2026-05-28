import { amazonShippingCarrierConnector } from './amazon-shipping';
import { easyPostCarrierConnector } from './easypost';
import { ebayShippingCarrierConnector } from './ebay-shipping';
import { fedexCarrierConnector } from './fedex';
import { shipEngineCarrierConnector } from './shipengine';
import { shippCarrierConnector } from './shipp';
import { shipStationCarrierConnector } from './shipstation';
import { upsCarrierConnector } from './ups';
import { uspsCarrierConnector } from './usps';
import { walmartShippingCarrierConnector } from './walmart-shipping';
import type {
  CarrierConnector,
  CarrierRateInput,
  ConnectorProvider,
  NormalizedCarrierRateQuoteResult,
} from '../types';

const directRateProviderAliases: Record<string, ConnectorProvider> = {
  shipstation: 'shipstation',
  shipp: 'shipp',
  easypost: 'easypost',
  easy_post: 'easypost',
  walmart_shipping: 'walmart_shipping',
  walmartshipping: 'walmart_shipping',
  ups: 'ups',
  fedex: 'fedex',
  usps: 'usps',
  shipengine: 'shipengine',
  ebay_shipping: 'ebay_shipping',
  ebayshipping: 'ebay_shipping',
  amazon_shipping: 'amazon_shipping',
  amazonshipping: 'amazon_shipping',
};

const directRateConnectors: Partial<Record<ConnectorProvider, CarrierConnector>> = {
  shipstation: shipStationCarrierConnector,
  shipp: shippCarrierConnector,
  easypost: easyPostCarrierConnector,
  walmart_shipping: walmartShippingCarrierConnector,
  ups: upsCarrierConnector,
  fedex: fedexCarrierConnector,
  usps: uspsCarrierConnector,
  shipengine: shipEngineCarrierConnector,
  ebay_shipping: ebayShippingCarrierConnector,
  amazon_shipping: amazonShippingCarrierConnector,
};

export function normalizeDirectRateProvider(provider: string | null | undefined): ConnectorProvider | null {
  const key = String(provider ?? '').trim().toLowerCase();
  return directRateProviderAliases[key] ?? null;
}

export async function quoteCarrierRates(
  provider: string | null | undefined,
  input: CarrierRateInput,
): Promise<NormalizedCarrierRateQuoteResult> {
  const normalized = normalizeDirectRateProvider(provider);
  const connector = normalized ? directRateConnectors[normalized] : null;
  if (!normalized || !connector?.getRates) {
    throw new Error(`No direct carrier rate connector registered for ${provider ?? '(missing)'}`);
  }

  const rates = await connector.getRates(input);
  return {
    provider: normalized,
    rates,
  };
}
