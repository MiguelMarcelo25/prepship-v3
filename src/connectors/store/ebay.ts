import type {
  ConfirmationResult,
  ShipmentConfirmationInput,
  StoreConnector,
} from '../../domain/fulfillment/types';

export function createEbayStoreConnector(): StoreConnector {
  return {
    provider: 'ebay',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'products.import'],
    async confirmShipment(_input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      return {
        ok: false,
        provider: 'ebay',
        retryable: false,
        message: 'eBay shipment confirmation connector is registered but not implemented yet',
      };
    },
  };
}

export const ebayStoreConnector = createEbayStoreConnector();
