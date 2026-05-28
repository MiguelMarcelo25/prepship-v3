import {
  ssCreateLabel,
  ssVoidShipment,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels.js';
import { ssRequest } from '../../lib/shipstation/client.js';
import type { CarriersResponse, Label } from '../../lib/shipstation/types.js';
import type { CarrierConnector } from '../../domain/fulfillment/types';

type ShipStationRateEstimateInput = {
  body?: Record<string, unknown>;
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
};

type ShipStationCreateLabelFromRateInput = {
  rateId: string;
  body?: Record<string, unknown>;
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
};

type ShipStationCreateLabelFromShipmentInput = {
  shipment: Record<string, unknown>;
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
};

type ShipStationCreateLabelInput =
  | CreateExternalLabelInput
  | ShipStationCreateLabelFromRateInput
  | ShipStationCreateLabelFromShipmentInput;

type ShipStationV2ListInput = {
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
};

function isRateLabelInput(input: ShipStationCreateLabelInput): input is ShipStationCreateLabelFromRateInput {
  return 'rateId' in input;
}

function isShipmentLabelInput(input: ShipStationCreateLabelInput): input is ShipStationCreateLabelFromShipmentInput {
  return 'shipment' in input;
}

export async function listShipStationV2Shipments<TList>(
  query: URLSearchParams,
  input: ShipStationV2ListInput = {},
): Promise<TList> {
  return ssRequest<TList>(`/v2/shipments?${query.toString()}`, {
    apiKey: input.apiKeyV2 ?? input.apiKey,
    dedupeKey: input.dedupeKey,
  });
}

export async function listShipStationV2Labels<TList>(
  query: URLSearchParams,
  input: ShipStationV2ListInput = {},
): Promise<TList> {
  return ssRequest<TList>(`/v2/labels?${query.toString()}`, {
    apiKey: input.apiKeyV2 ?? input.apiKey,
    dedupeKey: input.dedupeKey,
  });
}

export function createShipStationCarrierConnector(): CarrierConnector<
  ShipStationRateEstimateInput,
  Record<string, unknown>,
  ShipStationCreateLabelInput,
  CreatedExternalLabel | Label
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
    createLabel: async (input) => {
      if (isRateLabelInput(input)) {
        return ssRequest<Label>(`/v2/labels/rates/${input.rateId}`, {
          method: 'POST',
          body: input.body ?? { validate_address: 'no_validation' },
          apiKey: input.apiKeyV2 ?? input.apiKey,
          dedupeKey: input.dedupeKey ?? `label:rate:${input.rateId}`,
        });
      }
      if (isShipmentLabelInput(input)) {
        return ssRequest<Label>('/v2/labels', {
          method: 'POST',
          body: { shipment: input.shipment },
          apiKey: input.apiKeyV2 ?? input.apiKey,
          dedupeKey: input.dedupeKey,
        });
      }
      return ssCreateLabel(input);
    },
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
