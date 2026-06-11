/**
 * shipment-tracking-policy.ts — pure tracking policy (zero imports).
 *
 * Canonical owner of two decisions:
 *   1. How a raw ShipStation v2 tracking payload normalizes into the project's
 *      NormalizedTrackingStatus vocabulary (unknown | pre_transit | in_transit |
 *      delivered | exception | return_to_sender).
 *   2. Whether a print-queue entry retires when its package's tracking status is
 *      known: ONLY normalized 'delivered' + entry status 'queued' retires. Every
 *      other combination keeps the entry (exceptions and returns may still need
 *      the label; 'printed' history is never touched; unknown never retires).
 *
 * Pure by design — no DB, no network, no Date.now — so the offline guard
 * (scripts/shipment-tracking-retirement-guard.ts) can exercise the full matrix.
 * Redaction lives here too: normalization keeps a TRUNCATED status line and the
 * delivery date only — never the carrier's events[] checkpoints (city/state) or
 * the raw payload.
 */

export type TrackingPolicyStatus =
  | 'unknown'
  | 'pre_transit'
  | 'in_transit'
  | 'delivered'
  | 'exception'
  | 'return_to_sender';

export const TRACKING_STATUS_DESCRIPTION_MAX = 160;

/**
 * ShipStation/ShipEngine v2 status codes → normalized status.
 * AT = delivery ATTEMPT (not delivered). SP = delivered to a collection point
 * (terminal — the package left the carrier network; flagged in the plan for ops
 * review if pickup-point flows ever matter).
 */
export const SHIPSTATION_TRACKING_STATUS_CODE_MAP: Record<string, TrackingPolicyStatus> = {
  DE: 'delivered',
  SP: 'delivered',
  IT: 'in_transit',
  AT: 'in_transit',
  AC: 'pre_transit',
  NY: 'pre_transit',
  EX: 'exception',
  UN: 'unknown',
};

export type NormalizedTrackingPayload = {
  trackingNumber: string;
  status: TrackingPolicyStatus;
  statusDescription: string | null;
  deliveredAt: string | null;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Normalize a raw GET /v2/tracking payload. Garbage in → 'unknown' out (which
 * never retires anything). The fallback tracking number lets callers key the
 * result even when the carrier echoes nothing back.
 */
export function normalizeShipStationTrackingPayload(
  raw: unknown,
  fallbackTrackingNumber = '',
): NormalizedTrackingPayload {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const trackingNumber = readString(record.tracking_number) ?? fallbackTrackingNumber;
  const statusCode = (readString(record.status_code) ?? '').toUpperCase();
  const statusDescriptionRaw =
    readString(record.status_description) ?? readString(record.carrier_status_description);
  const exceptionDescription = readString(record.exception_description);

  let status: TrackingPolicyStatus = SHIPSTATION_TRACKING_STATUS_CODE_MAP[statusCode] ?? 'unknown';
  // Return-to-sender is signalled in prose, not a dedicated code.
  const prose = `${statusDescriptionRaw ?? ''} ${exceptionDescription ?? ''}`.toLowerCase();
  if (/return(ed)?[\s-]*to[\s-]*sender/.test(prose)) status = 'return_to_sender';

  const statusDescription = statusDescriptionRaw
    ? statusDescriptionRaw.slice(0, TRACKING_STATUS_DESCRIPTION_MAX)
    : null;
  const deliveredAt = status === 'delivered'
    ? (readString(record.actual_delivery_date) ?? readString(record.estimated_delivery_date))
    : null;

  return { trackingNumber, status, statusDescription, deliveredAt };
}

/**
 * THE retirement decision. 'retire' exactly when the package is delivered and
 * the entry is still actively queued. Printed/delivered entries are immutable
 * here; exception / return_to_sender / in-flight / unknown all keep the entry
 * (the operator may still need that label).
 */
export function decidePrintQueueRetirement(input: {
  trackingStatus: TrackingPolicyStatus | string | null | undefined;
  entryStatus: string | null | undefined;
}): 'retire' | 'keep' {
  return input.trackingStatus === 'delivered' && input.entryStatus === 'queued'
    ? 'retire'
    : 'keep';
}
