import type { ConnectorProvider } from './types';

export type ConnectorImplementationStatus = 'live' | 'registered_stub' | 'blocked_external_contract';

export type ConnectorImplementationInfo = {
  status: ConnectorImplementationStatus;
  notes: string;
};

export const connectorImplementationStatus: Record<ConnectorProvider, ConnectorImplementationInfo> = {
  shipstation: {
    status: 'live',
    notes: 'Live order import, label creation, voids, and shipment confirmation paths exist.',
  },
  walmart: {
    status: 'live',
    notes: 'Live Walmart store confirmation and supporting marketplace-order paths exist.',
  },
  walmart_shipping: {
    status: 'live',
    notes: 'Live Walmart Shipping rate and label behavior is handled through direct carrier endpoints.',
  },
  shipp: {
    status: 'live',
    notes: 'Live Shipp rate and label behavior is handled through direct carrier endpoints.',
  },
  easypost: {
    status: 'live',
    notes: 'Live EasyPost rate and label behavior is handled through direct carrier endpoints.',
  },
  ups: {
    status: 'live',
    notes: 'Live UPS rate and label behavior is handled through direct carrier endpoints.',
  },
  fedex: {
    status: 'live',
    notes: 'Live FedEx rate behavior is handled through the carrier connector; labels remain a registered connector capability stub.',
  },
  ebay: {
    status: 'live',
    notes: 'Live order import and shipment confirmation paths exist; production execution requires valid eBay OAuth store credentials.',
  },
  shopify: {
    status: 'registered_stub',
    notes: 'Connector slot is registered; live import/confirmation requires Shopify OAuth/app contract.',
  },
  amazon: {
    status: 'registered_stub',
    notes: 'Connector slot is registered; live import/confirmation requires Amazon SP-API credentials and workflow contract.',
  },
  tiktok_shop: {
    status: 'blocked_external_contract',
    notes: 'Capability matrix slot exists; implementation requires TikTok Shop API contract and credentials.',
  },
  woocommerce: {
    status: 'blocked_external_contract',
    notes: 'Capability matrix slot exists; implementation requires WooCommerce API contract and credentials.',
  },
};

export function getConnectorImplementationStatus(provider: ConnectorProvider): ConnectorImplementationInfo {
  return connectorImplementationStatus[provider];
}
