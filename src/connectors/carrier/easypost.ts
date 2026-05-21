import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createEasyPostCarrierConnector(): CarrierConnector {
  return {
    provider: 'easypost',
    getRates: async () => {
      throw new Error('EasyPost rates are handled by api/carriers/rates.ts');
    },
    createLabel: async () => {
      throw new Error('EasyPost labels are handled by api/carriers/labels.ts');
    },
  };
}

export const easyPostCarrierConnector = createEasyPostCarrierConnector();
