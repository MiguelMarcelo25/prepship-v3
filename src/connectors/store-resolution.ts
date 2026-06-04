import { connectorCapabilityMatrix } from './matrix.js';
import { getConnectorImplementationStatus, type ConnectorImplementationInfo } from './implementation-status.js';
import { storeConnectors } from './registry.js';
import type { ConnectorCapability, ConnectorProvider, StoreConnector } from './types.js';

const providerAliases: Record<string, ConnectorProvider> = {
  shipstation: 'shipstation',
  walmart: 'walmart',
  ebay: 'ebay',
  shopify: 'shopify',
  amazon: 'amazon',
};

export type ResolvedStoreConnector = {
  provider: ConnectorProvider;
  connector: StoreConnector;
  connectorCapabilities: ConnectorCapability[];
  implementation: ConnectorImplementationInfo;
};

export function normalizeStoreProviderKey(provider: string | null | undefined): ConnectorProvider | null {
  const key = String(provider ?? '').trim().toLowerCase();
  return providerAliases[key] ?? null;
}

export function resolveStoreConnector(
  provider: string | null | undefined,
  requiredCapability?: ConnectorCapability,
): ResolvedStoreConnector | null {
  const normalized = normalizeStoreProviderKey(provider);
  if (!normalized) return null;

  const connector = storeConnectors[normalized as keyof typeof storeConnectors] as StoreConnector | undefined;
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
