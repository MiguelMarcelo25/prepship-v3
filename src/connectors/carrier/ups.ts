import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createUpsCarrierConnector(): CarrierConnector {
  return {
    provider: 'ups',
    getRates: async () => {
      throw new Error('UPS rates are handled by api/carriers/rates.ts');
    },
    createLabel: async () => {
      throw new Error('UPS labels are handled by api/carriers/labels.ts');
    },
  };
}

export const upsCarrierConnector = createUpsCarrierConnector();
