import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createWalmartShippingCarrierConnector(): CarrierConnector {
  return {
    provider: 'walmart_shipping',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: async () => {
      throw new Error('Walmart Shipping rates are handled by api/carriers/rates.ts');
    },
    createLabel: async () => {
      throw new Error('Walmart Shipping labels are handled by api/carriers/labels.ts');
    },
  };
}

export const walmartShippingCarrierConnector = createWalmartShippingCarrierConnector();
