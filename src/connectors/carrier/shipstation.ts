import {
  ssCreateLabel,
  ssVoidLabel,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels.js';
import { ssRequest, ShipStationError } from '../../lib/shipstation/client.js';
import type { CarriersResponse, Label } from '../../lib/shipstation/types.js';
import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { shipStationTrackingConnector } from '../tracking/shipstation.js';

type ShipStationRateEstimateInput = {
  body?: Record<string, unknown>;
  apiKeyV2?: string;
  apiKey?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  priority?: 'interactive' | 'batch' | 'background';
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
  timeoutMs?: number;
  signal?: AbortSignal;
  priority?: 'interactive' | 'batch' | 'background';
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
  // Per user override unlock shipped data on 2026-07-14: V2 enrichment is
  // best-effort read-side work and must stop with its owning shipment sync.
  return ssRequest<TList>(`/v2/shipments?${query.toString()}`, {
    apiKey: input.apiKeyV2 ?? input.apiKey,
    dedupeKey: input.dedupeKey,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    priority: input.priority ?? 'background',
  });
}

export async function listShipStationV2Labels<TList>(
  query: URLSearchParams,
  input: ShipStationV2ListInput = {},
): Promise<TList> {
  return ssRequest<TList>(`/v2/labels?${query.toString()}`, {
    apiKey: input.apiKeyV2 ?? input.apiKey,
    dedupeKey: input.dedupeKey,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    priority: input.priority ?? 'background',
  });
}

export async function getShipStationV2LabelTracking<TTracking>(
  labelId: string,
  input: ShipStationV2ListInput = {},
): Promise<TTracking | null> {
  try {
    return await ssRequest<TTracking>(
      `/v2/labels/${encodeURIComponent(labelId)}/track`,
      {
        apiKey: input.apiKeyV2 ?? input.apiKey,
        dedupeKey: input.dedupeKey ?? `labels:track:${labelId}`,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        priority: input.priority ?? 'background',
      },
    );
  } catch (error) {
    if (error instanceof ShipStationError && (error.status === 400 || error.status === 404)) {
      return null;
    }
    throw error;
  }
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
          // Audit R-4 (2026-07-13): the estimate budget + abort signal now reach
          // the HTTP layer. Before this, the 15s cap was a Promise.race at the
          // caller — the losing request kept running (and retrying inside
          // ssRequest, re-consuming limiter budget) for up to ~7.5 min as a
          // zombie. ssRequest composes the signal with its own timeout.
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          priority: input.priority,
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
      const raw = String(input.labelId ?? '').trim();
      if (!raw) {
        throw new Error('ShipStation void requires a stored ShipStation label id.');
      }
      // Per user override unlock shipped data on 2026-07-06 (PS-399): ShipStation
      // voids are provider-confirmed only through /v2/labels/{label_id}/void.
      await ssVoidLabel(
        raw,
        (input as { apiKeyV2?: string }).apiKeyV2,
        input.signal,
      );
    },
    // Tracking-driven queue retirement: delegate to the TrackingConnector
    // implementation (src/connectors/tracking/shipstation.ts) so the
    // trackCarrierShipment orchestrator works for 'shipstation'. Read-only.
    trackShipment: (input) => shipStationTrackingConnector.trackShipment(input),
    listCarrierAccounts: async (input) => {
      const row = input as {
        apiKeyV2?: string;
        apiKey?: string;
        dedupeKey?: string;
        signal?: AbortSignal;
        priority?: 'interactive' | 'batch' | 'background';
      };
      return ssRequest<CarriersResponse>('/v2/carriers', {
        apiKey: row.apiKeyV2 ?? row.apiKey,
        dedupeKey: row.dedupeKey ?? 'carriers:list',
        signal: row.signal,
        priority: row.priority,
      });
    },
  };
}

export const shipStationCarrierConnector = createShipStationCarrierConnector();
