import { ssRequest } from './client.js';
import { ssV1Request } from './v1-client.js';
import { normalizeShippingOptions } from '../shipping-options.js';
import type { Address } from './types.js';

export type ShipstationAddressInput = {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  // PS-127: residential/commercial for the LABEL must match what the rate was quoted
  // under. true=residential, false=commercial, null/undefined=unknown (carrier decides).
  // Previously omitted entirely, so labels silently let the carrier reclassify and could
  // be billed differently than the residential-quoted rate.
  residential?: boolean | null;
};

export type CreateExternalLabelInput = {
  apiKeyV2?: string;
  carrierId: string;
  serviceCode: string;
  packageCode: string;
  weightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  shipTo: ShipstationAddressInput;
  shipFrom: ShipstationAddressInput;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  ssOrderId: number | null;
  orderNumber: string | null;
  testLabel?: boolean;
};

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

function toAddress(input: ShipstationAddressInput, fallbackPhone = '000-000-0000'): Address {
  return {
    name: input.name ?? undefined,
    company_name: input.company ?? undefined,
    phone: input.phone || fallbackPhone,
    address_line1: input.street1 ?? '',
    address_line2: input.street2 ?? undefined,
    city_locality: input.city ?? '',
    state_province: input.state ?? '',
    postal_code: input.postalCode ?? '',
    country_code: input.country ?? 'US',
    // PS-127: send the SAME residential indicator the rate was quoted under so ShipStation
    // bills the label exactly as quoted. Omit (carrier decides) only when truly unknown.
    address_residential_indicator:
      input.residential === true ? 'yes' : input.residential === false ? 'no' : 'unknown',
  };
}

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

// PS-204 defense-in-depth: synthetic direct-account ids (se-1xxxxxxx
// carrier_accounts / se-2xxxxxxx store_accounts) are PrepShip-internal — they
// do not exist at ShipStation, which rejects them ("carrier_id 10000025 not
// found"... after the request was already sent). This last-mile check makes it
// structurally impossible for PrepShip to EMIT such a request body, whatever
// upstream routing bug produced the id. Pure + offline-testable.
const SS_SYNTHETIC_CARRIER_ID_FLOOR = 10_000_000;

export function assertSsCarrierIdIsNotSynthetic(carrierId: unknown): void {
  const match = String(carrierId ?? '').trim().match(/^se-(\d+)$/i);
  const numeric = match ? Number(match[1]) : NaN;
  if (Number.isFinite(numeric) && numeric >= SS_SYNTHETIC_CARRIER_ID_FLOOR) {
    const err = new Error(
      `Direct-carrier account id ${numeric} cannot be sent to ShipStation (carrier_id ${String(carrierId)} is a PrepShip-internal synthetic id). Re-rate/select the matching account or route through the direct-carrier label path. No postage was purchased.`,
    ) as Error & { code?: string };
    err.code = 'DIRECT_CARRIER_ON_SHIPSTATION_PATH';
    throw err;
  }
}

/**
 * Build the ShipStation v2 POST /v2/labels request body. Pure (no network) so
 * the payload SHAPE — especially PS-072's package-level insured_value vs
 * shipment-level insurance_provider — is unit-testable offline without buying
 * postage. ssCreateLabel uses this.
 */
export function buildSsLabelRequestBody(input: CreateExternalLabelInput) {
  assertSsCarrierIdIsNotSynthetic(input.carrierId);
  const options = normalizeShippingOptions(input);
  const pkg: Record<string, unknown> = {
    weight: { value: Number(input.weightOz.toFixed(2)), unit: 'ounce' },
    package_code: input.packageCode || 'package',
  };
  if (input.length && input.width && input.height) {
    pkg.dimensions = {
      length: Number(input.length.toFixed(2)),
      width: Number(input.width.toFixed(2)),
      height: Number(input.height.toFixed(2)),
      unit: 'inch',
    };
  }
  const hasInsurance = options.insuranceProvider !== 'none' && options.insuredValue != null;
  if (hasInsurance) {
    // PS-072: ShipStation v2 schema requires insured_value at the PACKAGE level
    // (insurance_provider stays shipment-level). This was previously emitted as a
    // shipment-level sibling, where v2 may ignore it — leaving labels uninsured.
    pkg.insured_value = { amount: options.insuredValue, currency: 'usd' };
  }

  return {
    shipment: {
      carrier_id: input.carrierId,
      service_code: input.serviceCode,
      ship_date: new Date().toISOString().slice(0, 10),
      ship_from: toAddress(input.shipFrom),
      ship_to: toAddress(input.shipTo),
      packages: [pkg],
      confirmation: options.confirmation,
      ...(hasInsurance ? { insurance_provider: options.insuranceProvider } : {}),
      external_order_id: input.orderNumber ?? undefined,
    },
    is_return_label: false,
    label_layout: '4x6',
    label_format: 'pdf',
    label_download_type: 'url',
  };
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

export async function ssVoidLabel(labelId: string, apiKeyV2?: string): Promise<void> {
  await ssRequest(`/v2/labels/${labelId}/void`, {
    method: 'PUT',
    body: {},
    apiKey: apiKeyV2,
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
  apiKeyV2?: string
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
  opts: { apiKey?: string; apiSecret?: string } = {}
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
  opts: { apiKey?: string; apiSecret?: string } = {}
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
  });
}
