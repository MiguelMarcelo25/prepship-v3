import { carrierConnectors } from './registry';
import { connectorCapabilityMatrix } from './matrix';
import { getConnectorImplementationStatus, type ConnectorImplementationInfo } from './implementation-status';
import type { CarrierConnector, ConnectorCapability, ConnectorProvider } from './types';

const providerAliases: Record<string, ConnectorProvider> = {
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

export type ResolvedCarrierConnector = {
  provider: ConnectorProvider;
  connector: CarrierConnector;
  connectorCapabilities: ConnectorCapability[];
  implementation: ConnectorImplementationInfo;
};

export function normalizeCarrierProviderKey(provider: string | null | undefined): ConnectorProvider | null {
  const key = String(provider ?? '').trim().toLowerCase();
  return providerAliases[key] ?? null;
}

export function resolveCarrierConnector(
  provider: string | null | undefined,
  requiredCapability?: ConnectorCapability,
): ResolvedCarrierConnector | null {
  const normalized = normalizeCarrierProviderKey(provider);
  if (!normalized) return null;

  const connector = carrierConnectors[normalized as keyof typeof carrierConnectors] as CarrierConnector | undefined;
  if (!connector) return null;

  const connectorCapabilities = connectorCapabilityMatrix[normalized] ?? [];
  if (requiredCapability && !connectorCapabilities.includes(requiredCapability)) return null;

  return {
    provider: normalized,
    connector,
    connectorCapabilities,
    implementation: getConnectorImplementationStatus(normalized),
  };
}
