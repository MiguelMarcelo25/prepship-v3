import { ShipStationError, ssRequest } from './client.js';
import { ssV1Request } from './v1-client.js';
import {
  buildSsLabelRequestBody,
  normalizeShipStationExternalShipmentId,
  type CreateExternalLabelInput,
} from './label-request-body.js';
// Per user override unlock shipped data on 2026-07-22: the network connector
// and durable-operation hash share the pure request-body source of truth.
export {
  assertSsCarrierIdIsNotSynthetic,
  buildSsLabelRequestBody,
  normalizeShipStationExternalShipmentId,
} from './label-request-body.js';
export type { CreateExternalLabelInput, ShipstationAddressInput } from './label-request-body.js';

export type CreatedExternalLabel = {
  labelId: string | null;
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string | null;
  labelFormat: string | null;
  /** Postage component only (ShipStation v2 `shipment_cost.amount`). */
  cost: number;
  /** PS-108: ParcelGuard/insurance premium ShipStation billed for this label
   *  (v2 `insurance_cost.amount`). Previously discarded, leaving stored cost
   *  postage-only. Kept separate from `cost` so billing semantics are unchanged. */
  insuranceCost: number;
  voided: boolean;
  carrierCode: string | null;
  serviceCode: string;
  shipDate: string;
  providerAccountId: number | null;
  // Per user override unlock shipped data on 2026-06-17 (PS-273): carry the REAL
  // account nickname the label was bought on (e.g. "ORION", or the literal
  // "Shipp" for Shipp-brokered labels) so the shipment write records account
  // identity at purchase time. Without it, readers fall back to carrier-family
  // and fabricate a direct UPS account (GG6381) the label was never bought on.
  // Optional so existing producers that don't set it are unchanged.
  providerAccountNickname?: string | null;
};

export type ShipstationLabelRecord = {
  labelId: string | null;
  shipmentId: number | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  // PS-288 — the label's own format ('pdf'|'png'|'zpl'), so label-url recovery can backfill the
  // real format of the already-purchased label rather than the stale local default.
  labelFormat?: string | null;
};

export type ShipstationShipmentDetailsV1 = {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  otherCost: number;
  shipDate: string | null;
  voided: boolean;
  labelUrl: string | null;
  createDate: string | null;
  weightOz: number | null;
  dimsLength: number | null;
  dimsWidth: number | null;
  dimsHeight: number | null;
};

export type ReturnLabelResult = {
  returnShipmentId: number | null;
  returnTrackingNumber: string;
  cost: number;
  labelUrl: string | null;
};

function stripSePrefix(value: unknown): number | null {
  if (value == null) return null;
  const stripped = String(value).replace(/^se-/, '');
  const num = Number(stripped);
  return Number.isFinite(num) ? num : null;
}

function parseWeightOz(weight: Record<string, unknown> | null | undefined): number | null {
  if (!weight) return null;
  const value = Number(weight.value);
  if (!Number.isFinite(value)) return null;
  const units = String(weight.units ?? weight.unit ?? 'ounces').toLowerCase();
  if (units === 'pound' || units === 'pounds') return value * 16;
  if (units === 'gram' || units === 'grams') return value * 0.035274;
  return value;
}

function parseDims(
  dimensions: Record<string, unknown> | null | undefined
): { length: number | null; width: number | null; height: number | null } {
  if (!dimensions) return { length: null, width: null, height: null };
  const factor = String(dimensions.units ?? dimensions.unit ?? 'inches').toLowerCase().startsWith('c')
    ? 0.393701
    : 1;
  const coerce = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Number((n * factor).toFixed(2)) : null;
  };
  return {
    length: coerce(dimensions.length),
    width: coerce(dimensions.width),
    height: coerce(dimensions.height),
  };
}

export function extractShipstationLabelUrl(labelDownload: unknown): string | null {
  const seen = new Set<unknown>();
  const pick = (value: unknown, depth = 0): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null;
    seen.add(value);

    const record = value as Record<string, unknown>;
    return (
      pick(record.pdf, depth + 1) ??
      pick(record.href, depth + 1) ??
      pick(record.url, depth + 1) ??
      pick(record.downloadUrl, depth + 1) ??
      pick(record.download_url, depth + 1) ??
      pick(record.labelUrl, depth + 1) ??
      pick(record.label_url, depth + 1)
    );
  };

  return pick(labelDownload);
}

export async function ssGetLabelByExternalShipmentId(
  externalShipmentId: string,
  options: { apiKeyV2?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: string | null; label: CreatedExternalLabel } | null> {
  const normalizedId = normalizeShipStationExternalShipmentId(externalShipmentId);
  if (!normalizedId) throw new Error('ShipStation external shipment id is required');
  try {
    const payload = await ssRequest<Record<string, unknown>>(
      `/v2/labels/external_shipment_id/${encodeURIComponent(normalizedId)}`,
      {
        apiKey: options.apiKeyV2,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        dedupeKey: `label:external-shipment:${normalizedId}`,
      },
    );
    const labelDownload = (payload.label_download as Record<string, unknown> | undefined) ?? {};
    const shipmentCost = payload.shipment_cost as Record<string, unknown> | undefined;
    const insuranceCost = payload.insurance_cost as Record<string, unknown> | undefined;
    return {
      status: payload.status ? String(payload.status) : null,
      label: {
        labelId: payload.label_id ? String(payload.label_id) : null,
        shipmentId: stripSePrefix(payload.shipment_id) ?? 0,
        trackingNumber: payload.tracking_number ? String(payload.tracking_number) : null,
        labelUrl: extractShipstationLabelUrl(labelDownload),
        labelFormat: payload.label_format ? String(payload.label_format) : null,
        cost: Number(shipmentCost?.amount ?? 0),
        insuranceCost: Number(insuranceCost?.amount ?? 0),
        voided: Boolean(payload.voided),
        carrierCode: payload.carrier_code ? String(payload.carrier_code) : null,
        serviceCode: payload.service_code ? String(payload.service_code) : '',
        shipDate: payload.ship_date ? String(payload.ship_date) : '',
        providerAccountId: stripSePrefix(payload.carrier_id),
      },
    };
  } catch (error) {
    if (error instanceof ShipStationError && error.status === 404) return null;
    throw error;
  }
}

export async function ssCreateLabel(input: CreateExternalLabelInput): Promise<CreatedExternalLabel> {
  const body = buildSsLabelRequestBody(input);

  // Per user override unlock shipped data on 2026-07-13 (audit C1): this POST
  // buys postage and is NOT idempotent (no idempotency key; external_order_id is
  // not deduped by ShipStation). A 5xx after the label was actually created must
  // not be re-sent — it becomes an unknown outcome surfaced to the caller instead
  // of a silent second purchase. 429s (never processed) still retry inside ssRequest.
  const payload = await ssRequest<Record<string, unknown>>('/v2/labels', {
    method: 'POST',
    body,
    apiKey: input.apiKeyV2,
    retryOn5xx: false,
    signal: input.signal,
  });

  const labelDownload = (payload.label_download as Record<string, unknown> | undefined) ?? {};
  const shipmentCost = payload.shipment_cost as Record<string, unknown> | undefined;
  // PS-108: ShipStation v2 returns the ParcelGuard premium as a separate
  // `insurance_cost` field. Capture it (it was previously dropped, which left the
  // persisted shipment cost postage-only even for insured HUGRAB labels).
  const insuranceCost = payload.insurance_cost as Record<string, unknown> | undefined;
  const providerAccountId = stripSePrefix(input.carrierId);
  const shipmentId = stripSePrefix(payload.shipment_id) ?? 0;
  // Per user override `unlock shipped data` on 2026-05-22:
  // ShipStation can nest Walmart label URLs under object-shaped fields.
  // Normalize before shipment persistence so text columns never receive objects.
  const labelUrl = extractShipstationLabelUrl(labelDownload);

  return {
    labelId: payload.label_id ? String(payload.label_id) : null,
    shipmentId,
    trackingNumber: payload.tracking_number ? String(payload.tracking_number) : null,
    labelUrl,
    labelFormat: payload.label_format ? String(payload.label_format) : 'pdf',
    cost: Number(shipmentCost?.amount ?? 0),
    insuranceCost: Number(insuranceCost?.amount ?? 0),
    voided: Boolean(payload.voided),
    carrierCode: payload.carrier_code ? String(payload.carrier_code) : null,
    serviceCode: payload.service_code ? String(payload.service_code) : input.serviceCode,
    shipDate: payload.ship_date ? String(payload.ship_date) : new Date().toISOString().slice(0, 10),
    providerAccountId,
  };
}

export async function ssVoidLabel(labelId: string, apiKeyV2?: string, signal?: AbortSignal): Promise<void> {
  await ssRequest(`/v2/labels/${labelId}/void`, {
    method: 'PUT',
    body: {},
    apiKey: apiKeyV2,
    signal,
  });
}

export async function ssVoidShipment(shipmentId: number | string, apiKeyV2?: string): Promise<void> {
  const id = typeof shipmentId === 'number' ? `se-${shipmentId}` : shipmentId;
  await ssRequest(`/v2/shipments/${id}/void`, {
    method: 'POST',
    body: {},
    apiKey: apiKeyV2,
  });
}

export async function ssCreateReturnLabel(
  shipmentId: number,
  reason: string,
  apiKeyV2?: string,
  signal?: AbortSignal,
): Promise<ReturnLabelResult> {
  // v2-parity: ShipStation's documented return-label endpoint is
  // POST /v2/shipments/{shipmentId}/returnlabel — singular, lowercase, no
  // se- prefix on the numeric id. v4 previously used `/return-labels`
  // (plural hyphenated) with an se- prefix which isn't a real ShipStation
  // endpoint. Matches apps/api/src/modules/labels/data/shipstation-shipping-gateway.ts:228-240.
  const payload = await ssRequest<Record<string, unknown>>(
    `/v2/shipments/${shipmentId}/returnlabel`,
    {
      method: 'POST',
      body: { reason },
      apiKey: apiKeyV2,
      // Audit C1 (see ssCreateLabel): return-label creation also buys postage —
      // never blind-retry a 5xx on it.
      retryOn5xx: false,
      signal,
    }
  );
  const shipmentCost = payload.shipment_cost as Record<string, unknown> | undefined;
  const labelDownload = (payload.label_download as Record<string, unknown> | undefined) ?? {};
  return {
    returnShipmentId: stripSePrefix(payload.shipment_id),
    returnTrackingNumber: String(payload.tracking_number ?? ''),
    cost: Number(shipmentCost?.amount ?? 0),
    labelUrl: extractShipstationLabelUrl(labelDownload),
  };
}

export async function ssListRecentLabels(
  apiKeyV2?: string,
  // PS-286: optional 1-based `page` so a backfill can walk past the first page of recent
  // labels, and `pageSize` so a slow caller can use smaller, faster responses. Omitted →
  // page 1, size 500 (unchanged behavior for existing callers).
  opts: { page?: number; pageSize?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ShipstationLabelRecord[]> {
  try {
    const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : 500;
    const pageParam = opts.page && opts.page > 1 ? `&page=${opts.page}` : '';
    const payload = await ssRequest<{ labels?: Array<Record<string, unknown>> }>(
      `/v2/labels?page_size=${pageSize}&sort_dir=desc${pageParam}`,
      {
        apiKey: apiKeyV2,
        dedupeKey: `labels:list:${pageSize}:${opts.page ?? 1}`,
        timeoutMs: opts.timeoutMs,
        // Per user override unlock shipped data on 2026-07-14: do not let
        // label enrichment swallow the owning shipment-sync cancellation.
        signal: opts.signal,
        priority: 'background',
      }
    );
    return (payload.labels ?? []).map((label) => {
      const labelDownload = (label.label_download as Record<string, unknown> | undefined) ?? {};
      return {
        labelId: label.label_id ? String(label.label_id) : null,
        shipmentId: stripSePrefix(label.shipment_id),
        trackingNumber: label.tracking_number ? String(label.tracking_number) : null,
        labelUrl: extractShipstationLabelUrl(labelDownload),
        labelFormat: label.label_format ? String(label.label_format) : null,
      };
    });
  } catch (error) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : error;
    }
    return [];
  }
}

export async function ssGetShipmentV1(
  shipmentId: number,
  opts: { apiKey?: string; apiSecret?: string; signal?: AbortSignal } = {}
): Promise<ShipstationShipmentDetailsV1 | null> {
  try {
    const data = await ssV1Request<Record<string, unknown>>(`/shipments/${shipmentId}`, {
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
    });
    const shipment = (data.shipment as Record<string, unknown> | undefined) ?? data;
    const dims = parseDims(shipment.dimensions as Record<string, unknown> | undefined);
    const labelDownload =
      (shipment.labelDownload as Record<string, unknown> | undefined) ??
      (shipment.label_download as Record<string, unknown> | undefined) ??
      {};
    return {
      shipmentId: Number(shipment.shipmentId ?? shipmentId),
      orderId: Number(shipment.orderId ?? 0),
      orderNumber: shipment.orderNumber ? String(shipment.orderNumber) : null,
      trackingNumber: shipment.trackingNumber ? String(shipment.trackingNumber) : null,
      carrierCode: shipment.carrierCode ? String(shipment.carrierCode) : null,
      serviceCode: shipment.serviceCode ? String(shipment.serviceCode) : null,
      shipmentCost: Number(shipment.shipmentCost ?? 0),
      otherCost: Number(shipment.otherCost ?? 0),
      shipDate: shipment.shipDate ? String(shipment.shipDate) : null,
      voided: Boolean(shipment.voided),
      labelUrl: extractShipstationLabelUrl(labelDownload),
      createDate: shipment.createDate ? String(shipment.createDate) : null,
      weightOz: parseWeightOz(shipment.weight as Record<string, unknown> | undefined),
      dimsLength: dims.length,
      dimsWidth: dims.width,
      dimsHeight: dims.height,
    };
  } catch {
    return null;
  }
}

/**
 * SSUpstreamOrderId — a branded number that represents a ShipStation
 * upstream orderId (the numeric ID ShipStation assigns when ingesting
 * an order from a marketplace).
 *
 * Why brand it: Our `orders` table has TWO numeric IDs:
 *   - `orders.id`            — local Postgres serial PK (small numbers)
 *   - `orders.externalOrderId` — SS upstream orderId stored as text (large numbers)
 *
 * ShipStation's v1 API endpoints (markasshipped, holds, etc.) require
 * the UPSTREAM orderId. Passing the local PK results in 404. Before
 * this brand existed, both were `number` to TS, so the wrong one
 * could be passed silently. With the brand, the only way to produce
 * a valid `SSUpstreamOrderId` is via `asSSUpstreamOrderId()` below
 * — passing `order.id` directly will fail to compile.
 *
 * This regression caused the marketplace-notification bug discovered
 * 2026-05-07: every label created since v4 launch passed `order.id`
 * to v1 markasshipped → 404 → silently swallowed → marketplace never
 * notified. The brand makes that bug uncompilable forever.
 */
declare const __ssUpstreamOrderIdBrand: unique symbol;
export type SSUpstreamOrderId = number & { readonly [__ssUpstreamOrderIdBrand]: never };

/**
 * Convert an `orders.externalOrderId` (text column) into a branded
 * `SSUpstreamOrderId`. Returns `null` if the input is missing or
 * not a valid positive integer string.
 *
 * Use this at the call site of any ShipStation v1 API that needs an
 * orderId. NEVER cast `order.id` (the local PK) with `as SSUpstreamOrderId`
 * — that defeats the entire point of the brand. If you find yourself
 * wanting to do that, you've located a bug.
 */
export function asSSUpstreamOrderId(
  externalOrderId: string | null | undefined,
): SSUpstreamOrderId | null {
  if (!externalOrderId) return null;
  const n = Number(externalOrderId);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n as SSUpstreamOrderId;
}

/**
 * Marks an order as shipped on ShipStation v1 with notifySalesChannel:true,
 * which triggers ShipStation's downstream marketplace notification
 * (Amazon Confirm-Shipment, eBay Order-Update, Walmart Acknowledge, etc.).
 *
 * orderId is typed as `SSUpstreamOrderId` so the only way to call this
 * is by first converting via `asSSUpstreamOrderId(order.externalOrderId)`.
 * Passing `order.id` directly is a TypeScript compile error — see the
 * SSUpstreamOrderId docstring for why.
 *
 * Errors are RE-THROWN, not swallowed — the previous swallow-and-return-false
 * design hid 404s caused by passing the wrong orderId, leaving operators
 * blind to "labels created but marketplace never notified" failures. The
 * single caller (services/labels.ts) wraps this in a retry+log block.
 *
 * Per user override `unlock shipped data` on 2026-05-07: rethrow on error.
 */
export async function ssMarkOrderShippedV1(
  args: {
    orderId: SSUpstreamOrderId;
    carrierCode: string | null;
    trackingNumber: string;
    shipDate: string;
    /** Whether ShipStation should email the customer with the tracking
     *  link. Default: false — historical PrepShip behavior; the
     *  marketplace's own notification email usually beats us to it. */
    notifyCustomer?: boolean;
    /** Whether ShipStation should push the shipped status back to the
     *  originating marketplace (Amazon / eBay / Walmart / etc.).
     *  Default: true — almost always desired; this is what closes the
     *  loop with the upstream sales channel. */
    notifySalesChannel?: boolean;
  },
  opts: { apiKey?: string; apiSecret?: string; signal?: AbortSignal } = {}
): Promise<void> {
  await ssV1Request('/orders/markasshipped', {
    method: 'POST',
    body: {
      orderId: args.orderId,
      carrierCode: args.carrierCode,
      shipDate: args.shipDate,
      trackingNumber: args.trackingNumber,
      notifyCustomer: args.notifyCustomer ?? false,
      notifySalesChannel: args.notifySalesChannel ?? true,
    },
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    signal: opts.signal,
  });
}
