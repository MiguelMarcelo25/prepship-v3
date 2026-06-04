import type {
  ConfirmationResult,
  ShipmentConfirmationInput,
  StoreConnector,
} from '../../domain/fulfillment/types.js';

export function createShopifyStoreConnector(): StoreConnector {
  return {
    provider: 'shopify',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    async confirmShipment(_input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      return {
        ok: false,
        provider: 'shopify',
        retryable: false,
        message: 'Shopify shipment confirmation connector is registered but not implemented yet',
      };
    },
  };
}

export const shopifyStoreConnector = createShopifyStoreConnector();
