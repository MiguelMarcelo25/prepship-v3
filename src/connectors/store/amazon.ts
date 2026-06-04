import type {
  ConfirmationResult,
  ShipmentConfirmationInput,
  StoreConnector,
} from '../../domain/fulfillment/types.js';

export function createAmazonStoreConnector(): StoreConnector {
  return {
    provider: 'amazon',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    async confirmShipment(_input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      return {
        ok: false,
        provider: 'amazon',
        retryable: false,
        message: 'Amazon shipment confirmation connector is registered but not implemented yet',
      };
    },
  };
}

export const amazonStoreConnector = createAmazonStoreConnector();
