import {
  ssCreateLabel,
  ssVoidShipment,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels';
import { ssRequest } from '../../lib/shipstation';
import type { CarriersResponse } from '../../lib/shipstation/types';
import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createShipStationCarrierConnector(): CarrierConnector<
  unknown,
  unknown,
  CreateExternalLabelInput,
  CreatedExternalLabel
> {
  return {
    provider: 'shipstation',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: async () => {
      throw new Error('ShipStation connector rates are handled by the existing rate service');
    },
    createLabel: ssCreateLabel,
    voidLabel: async (input) => {
      await ssVoidShipment(input.labelId, (input as { apiKeyV2?: string }).apiKeyV2);
    },
    listCarrierAccounts: async (input) => {
      const row = input as { apiKeyV2?: string; apiKey?: string; dedupeKey?: string };
      return ssRequest<CarriersResponse>('/v2/carriers', {
        apiKey: row.apiKeyV2 ?? row.apiKey,
        dedupeKey: row.dedupeKey ?? 'carriers:list',
      });
    },
  };
}

export const shipStationCarrierConnector = createShipStationCarrierConnector();
