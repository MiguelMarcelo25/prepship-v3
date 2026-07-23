/**
 * ShipStation v2 TrackingConnector — the FIRST implementation of the existing
 * TrackingConnector interface (src/connectors/types.ts). Read-only: one
 * GET /v2/tracking?carrier_code&tracking_number per call through the shared
 * ssRequest client, which already owns the global v2 rate limiter, circuit
 * breaker, and retry/backoff — no new limiter here.
 *
 * Normalization + the retirement decision live in the pure policy module
 * (src/services/shipment-tracking-policy.ts) so the offline guard can test the
 * full matrix without network. This connector is the documented seam for the
 * direct-carrier follow-up: ups.ts / fedex.ts later implement the same
 * interface for labels not purchased through ShipStation.
 */
import { ssRequest, ShipStationError } from '../../lib/shipstation/client.js';
import type { NormalizedTrackingStatus, TrackingConnector } from '../types.js';
import {
  normalizeShipStationTrackingPayload,
  type NormalizedTrackingPayload,
} from '../../services/shipment-tracking-policy.js';

/**
 * ShipStation's tracking endpoint wants the BASE carrier code. EVERY carrier
 * connected to the ShipStation account is supported by construction: the code
 * stored on the shipment passes through verbatim (stamps_com, fedex, dhl_express,
 * ups, …), and ANY `_walleted` variant — a ShipStation-side billing distinction
 * of the same carrier network — is normalized by stripping the suffix, so new
 * walleted connections never need a code change here.
 */
export function normalizeTrackingCarrierCode(carrierCode: string | null | undefined): string | null {
  const code = typeof carrierCode === 'string' && carrierCode.trim() ? carrierCode.trim() : null;
  if (!code) return null;
  return code.endsWith('_walleted') ? code.slice(0, -'_walleted'.length) : code;
}

function toNormalizedStatus(payload: NormalizedTrackingPayload): NormalizedTrackingStatus {
  return {
    trackingNumber: payload.trackingNumber,
    status: payload.status,
    statusDescription: payload.statusDescription,
    deliveredAt: payload.deliveredAt,
  };
}

export function createShipStationTrackingConnector(): TrackingConnector {
  return {
    provider: 'shipstation',
    capabilities: ['tracking.read'],
    trackShipment: async ({ trackingNumber, carrierCode }) => {
      const params = new URLSearchParams({ tracking_number: trackingNumber });
      const normalizedCarrier = normalizeTrackingCarrierCode(carrierCode);
      if (normalizedCarrier) params.set('carrier_code', normalizedCarrier);
      try {
        const payload = await ssRequest<Record<string, unknown>>(`/v2/tracking?${params.toString()}`, {
          dedupeKey: `tracking:${normalizedCarrier ?? 'any'}:${trackingNumber}`,
          maxRetries: 3,
          priority: 'background',
        });
        return toNormalizedStatus(normalizeShipStationTrackingPayload(payload, trackingNumber));
      } catch (err) {
        // Not trackable through this account (label bought elsewhere, carrier
        // not connected, malformed number) → 'unknown', which never retires
        // anything. Transient 5xx/429 (retries exhausted) propagate so the
        // poller logs + retries next tick.
        if (err instanceof ShipStationError && (err.status === 404 || err.status === 400)) {
          return { trackingNumber, status: 'unknown' };
        }
        throw err;
      }
    },
    normalizeTrackingStatus: (raw) => toNormalizedStatus(normalizeShipStationTrackingPayload(raw)),
    detectDelivered: (status) => status.status === 'delivered',
    detectException: (status) => status.status === 'exception',
    detectReturnToSender: (status) => status.status === 'return_to_sender',
  };
}

export const shipStationTrackingConnector = createShipStationTrackingConnector();
