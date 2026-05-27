import {
  ssCreateLabel,
  ssVoidShipment,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels';
import { ssRequest } from '../../lib/shipstation';
import type { CarriersResponse } from '../../lib/shipstation/types';
import type { CarrierConnector } from '../../domain/fulfillment/types';

type ShipStationRateEstimateInput = {
  body?: Record<string, unknown>;
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
};

export function createShipStationCarrierConnector(): CarrierConnector<
  ShipStationRateEstimateInput,
  Record<string, unknown>,
  CreateExternalLabelInput,
  CreatedExternalLabel
> {
  return {
    provider: 'shipstation',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: async (input) => {
      const payload = await ssRequest<Array<Record<string, unknown>> | { rates?: Array<Record<string, unknown>> }>(
        '/v2/rates/estimate',
        {
          method: 'POST',
          body: input.body ?? {},
          apiKey: input.apiKeyV2 ?? input.apiKey,
          dedupeKey: input.dedupeKey,
        },
      );
      return Array.isArray(payload) ? payload : (payload.rates ?? []);
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
