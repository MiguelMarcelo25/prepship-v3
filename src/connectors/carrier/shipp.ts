import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createShippCarrierConnector(): CarrierConnector {
  return {
    provider: 'shipp',
    getRates: async () => {
      throw new Error('Shipp rates are handled by api/carriers/rates.ts');
    },
    createLabel: async () => {
      throw new Error('Shipp labels are handled by api/carriers/labels.ts');
    },
  };
}

export const shippCarrierConnector = createShippCarrierConnector();
