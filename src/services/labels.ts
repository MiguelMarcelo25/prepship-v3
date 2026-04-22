import { and, eq, or, desc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { orders, orderOverrides } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { ssRequest } from '../lib/shipstation/client';
import {
  ssCreateLabel,
  ssCreateReturnLabel,
  ssGetShipmentV1,
  ssListRecentLabels,
  ssMarkOrderShippedV1,
  ssVoidShipment,
  type CreatedExternalLabel,
  type ShipstationAddressInput,
} from '../lib/shipstation/labels';
import type { Address, Label, Parcel, Shipment as SSShipment } from '../lib/shipstation/types';
import { getDefaultShipFrom } from '../lib/ship-from';
import {
  generateFakeShipmentId,
  generateFakeTrackingNumber,
  generateMockLabelHtml,
  generateMockLabelPdf,
  serviceCodeToLabel,
  type MockLabelData,
} from './mock-label-generator';

// ── Rate limiting ─────────────────────────────────────────────────────────────

const LABEL_RATE_LIMIT = 10;
const LABEL_RATE_WINDOW_MS = 60_000;
const labelRateLimitMap = new Map<number, { count: number; windowStart: number }>();

export class LabelRateLimitError extends Error {
  rateLimited = true;
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'LabelRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

function checkLabelRateLimit(clientId: number): void {
  const now = Date.now();
  const bucket = labelRateLimitMap.get(clientId);
  if (!bucket) {
    labelRateLimitMap.set(clientId, { count: 1, windowStart: now });
    return;
  }
  const elapsed = now - bucket.windowStart;
  if (elapsed >= LABEL_RATE_WINDOW_MS) {
    labelRateLimitMap.set(clientId, { count: 1, windowStart: now });
    return;
  }
  if (bucket.count >= LABEL_RATE_LIMIT) {
    throw new LabelRateLimitError(
      `Label rate limit exceeded (${LABEL_RATE_LIMIT}/min per client). Retry after ${Math.ceil((LABEL_RATE_WINDOW_MS - elapsed) / 1000)}s`,
      LABEL_RATE_WINDOW_MS - elapsed
    );
  }
  bucket.count += 1;
}

async function withConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  maxConcurrent = 5
): Promise<void> {
  const queue = [...items];
  const running = new Set<Promise<void>>();
  while (queue.length > 0 || running.size > 0) {
    while (running.size < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        const task = fn(item).finally(() => running.delete(task));
        running.add(task);
      }
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

// ── Mock label store (in-memory) ──────────────────────────────────────────────

const mockLabelStore = new Map<number, MockLabelData>();

export function getMockLabel(shipmentId: number): MockLabelData | null {
  return mockLabelStore.get(shipmentId) ?? null;
}

export function saveMockLabel(shipmentId: number, data: MockLabelData): void {
  mockLabelStore.set(shipmentId, data);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type AddressInputDto = ShipstationAddressInput;

export type CreateLabelInputDto = {
  orderId: number;
  orderNumber?: string;
  carrierCode?: string;
  serviceCode: string;
  packageCode?: string;
  customPackageId?: number | null;
  shippingProviderId?: number | null;
  weightOz?: number;
  length?: number;
  width?: number;
  height?: number;
  confirmation?: string;
  testLabel?: boolean;
  shipTo?: AddressInputDto;
  shipFrom?: AddressInputDto;
};

export type CreateLabelResponseDto = {
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string | null;
  cost: number;
  voided: boolean;
  orderStatus: string;
  apiVersion: 'v2';
};

export type VoidLabelResponseDto = {
  success: true;
  shipmentId: number;
  orderNumber: string | null;
  voided: true;
  voidedAt: string;
  trackingNumber: string | null;
  refundAmount: number | null;
  refundInitiated: true;
  refundEstimate: string;
  note: string;
};

export type ReturnLabelResponseDto = {
  success: true;
  shipmentId: number;
  orderNumber: string | null;
  returnTrackingNumber: string;
  returnShipmentId: number | null;
  cost: number;
  reason: string;
  createdAt: string;
};

export type RetrieveLabelResponseDto = {
  orderId: number | null;
  orderNumber: string | null;
  shipmentId: number;
  trackingNumber: string | null;
  labelUrl: string;
  createdAt: string | null;
  carrier: string;
  service: string;
  cost: number;
};

export type BatchLabelResultItem = {
  orderId: number;
  success: boolean;
  shipmentId?: number;
  trackingNumber?: string | null;
  cost?: number;
  error?: string;
};

export type CreateBatchLabelInputDto = {
  orderIds: number[];
  carrierCode?: string;
  serviceCode: string;
  packageCode?: string;
  confirmation?: string;
  testLabel?: boolean;
  shippingProviderId: number;
};

export type CreateBatchLabelResponseDto = {
  created: BatchLabelResultItem[];
  failed: BatchLabelResultItem[];
  summary: { total: number; created: number; failed: number };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultShipFromAddress(): ShipstationAddressInput {
  return {
    name: 'DR Prepper Fulfillment',
    street1: '14924 S Figueroa St',
    city: 'Gardena',
    state: 'CA',
    postalCode: '90248',
    country: 'US',
    phone: '3103295555',
  };
}

function orderShipToFromRaw(rawOrder: {
  raw: Record<string, unknown>;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
}): ShipstationAddressInput {
  const raw = rawOrder.raw ?? {};
  const shipTo = (raw.shipTo as Record<string, unknown> | undefined) ?? {};
  return {
    name: (shipTo.name as string | undefined) ?? rawOrder.shipToName ?? 'Customer',
    company: (shipTo.company as string | undefined) ?? undefined,
    street1: (shipTo.street1 as string | undefined) ?? '',
    street2: (shipTo.street2 as string | undefined) ?? undefined,
    city: (shipTo.city as string | undefined) ?? rawOrder.shipToCity ?? '',
    state: (shipTo.state as string | undefined) ?? rawOrder.shipToState ?? '',
    postalCode: (shipTo.postalCode as string | undefined) ?? rawOrder.shipToPostalCode ?? '',
    country: (shipTo.country as string | undefined) ?? 'US',
    phone: (shipTo.phone as string | undefined) ?? undefined,
  };
}

function mergeAddress(
  input: AddressInputDto | undefined,
  fallback: ShipstationAddressInput
): ShipstationAddressInput {
  if (!input?.street1) return fallback;
  return {
    name: input.name || fallback.name,
    company: input.company || undefined,
    street1: input.street1 || '',
    street2: input.street2 || undefined,
    city: input.city || '',
    state: input.state || '',
    postalCode: input.postalCode || '',
    country: input.country || 'US',
    phone: input.phone || undefined,
  };
}

function toSSAddress(input: ShipstationAddressInput): Address {
  return {
    name: input.name ?? undefined,
    company_name: input.company ?? undefined,
    phone: input.phone ?? undefined,
    address_line1: input.street1 ?? '',
    address_line2: input.street2 ?? undefined,
    city_locality: input.city ?? '',
    state_province: input.state ?? '',
    postal_code: input.postalCode ?? '',
    country_code: input.country ?? 'US',
  };
}

function getRefundEstimate(carrierCode: string | null): string {
  if (carrierCode === 'stamps_com' || carrierCode === 'usps') return '2-5 days (USPS)';
  if (carrierCode === 'fedex') return '3-7 days (FedEx)';
  if (carrierCode === 'ups') return '3-7 days (UPS)';
  return '2-7 days';
}

async function loadClientCredentials(clientId: number | null | undefined): Promise<{
  apiKeyV2: string | null;
  apiKey: string | null;
  apiSecret: string | null;
}> {
  if (!clientId) return { apiKeyV2: null, apiKey: null, apiSecret: null };
  const [row] = await db
    .select({
      apiKeyV2: clients.ssApiKeyV2,
      apiKey: clients.ssApiKey,
      apiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return {
    apiKeyV2: row?.apiKeyV2 ?? null,
    apiKey: row?.apiKey ?? null,
    apiSecret: row?.apiSecret ?? null,
  };
}

// ── Legacy helpers kept for any internal callers ──────────────────────────────

export type CreateFromRateInput = {
  rateId: string;
  orderId: number;
  clientId?: number;
};

export async function createLabelFromRate(input: CreateFromRateInput) {
  const label = await ssRequest<Label>(`/v2/labels/rates/${input.rateId}`, {
    method: 'POST',
    body: { validate_address: 'no_validation' },
    dedupeKey: `label:rate:${input.rateId}`,
  });
  return persistLabelFromRate(label, input.orderId, input.clientId);
}

async function persistLabelFromRate(label: Label, orderId: number, clientId?: number) {
  const shipDate = label.ship_date ? new Date(label.ship_date) : null;
  const createdAt = label.created_at ? new Date(label.created_at) : new Date();
  const ssShipmentId = Number(String(label.shipment_id ?? '').replace(/^se-/, ''));
  const [row] = await db
    .insert(shipments)
    .values({
      orderId,
      clientId: clientId ?? null,
      carrierCode: label.carrier_code,
      serviceCode: label.service_code,
      trackingNumber: label.tracking_number,
      shipDate,
      createDate: createdAt,
      labelUrl: label.label_download?.pdf ?? label.label_download?.href ?? null,
      labelCreatedAt: createdAt,
      labelFormat: label.label_format ?? 'pdf',
      labelCarrier: label.carrier_code,
      labelService: label.service_code,
      labelTracking: label.tracking_number,
      labelCost: label.shipment_cost.amount.toFixed(2),
      labelShipDate: shipDate,
      labelShipmentId: Number.isFinite(ssShipmentId) ? ssShipmentId : null,
      voided: !!label.voided,
      source: 'v4',
      isReturn: !!label.is_return_label,
    })
    .returning();
  if (!row) throw new Error('Failed to persist shipment row');
  return row;
}

export type CreateFromShipmentInput = {
  orderId: number;
  clientId?: number;
  weightOz: number;
  dimensions?: { length: number; width: number; height: number };
  shipTo: Address;
  shipFrom?: Address;
  serviceCode: string;
  residential?: boolean;
};

export async function createLabelFromShipment(input: CreateFromShipmentInput) {
  const shipFrom = input.shipFrom ?? (await getDefaultShipFrom());
  const parcel: Parcel = { weight: { value: input.weightOz, unit: 'ounce' } };
  if (input.dimensions) {
    parcel.dimensions = {
      unit: 'inch',
      length: input.dimensions.length,
      width: input.dimensions.width,
      height: input.dimensions.height,
    };
  }

  const shipment: SSShipment & { service_code: string } = {
    service_code: input.serviceCode,
    validate_address: 'no_validation',
    ship_to: {
      ...input.shipTo,
      address_residential_indicator:
        input.residential === true ? 'yes' : input.residential === false ? 'no' : 'unknown',
    },
    ship_from: shipFrom,
    packages: [parcel],
  };

  const label = await ssRequest<Label>('/v2/labels', {
    method: 'POST',
    body: { shipment },
  });
  return persistLabelFromRate(label, input.orderId, input.clientId);
}

export async function lookupLabel(lookup: string) {
  const asNum = Number(lookup);
  const rows = await db
    .select()
    .from(shipments)
    .where(
      Number.isFinite(asNum)
        ? or(eq(shipments.orderId, asNum), eq(shipments.id, asNum))
        : eq(shipments.trackingNumber, lookup)
    )
    .orderBy(desc(shipments.createdAt))
    .limit(10);
  return rows;
}

// ── V2-parity label orchestration ─────────────────────────────────────────────

async function findActiveLabelForOrder(orderId: number) {
  const [row] = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), eq(shipments.voided, false), eq(shipments.isReturn, false)))
    .orderBy(desc(shipments.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadOrderRecord(orderId: number) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return order ?? null;
}

async function loadOrderDimsOverride(orderId: number) {
  const [row] = await db
    .select()
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, orderId))
    .limit(1);
  return row ?? null;
}

function serviceCodeFitsPackage(_: string): string {
  return 'package';
}

async function persistCreatedLabel(args: {
  created: CreatedExternalLabel;
  orderId: number;
  orderNumber: string | null;
  clientId: number | null;
  effectiveWeightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  selectedPackageId: string | null;
  source: string;
}): Promise<number> {
  const { created } = args;
  const createdAt = new Date();
  const shipDate = created.shipDate ? new Date(created.shipDate) : createdAt;
  const [row] = await db
    .insert(shipments)
    .values({
      orderId: args.orderId,
      clientId: args.clientId,
      orderNumber: args.orderNumber,
      carrierCode: created.carrierCode,
      serviceCode: created.serviceCode,
      trackingNumber: created.trackingNumber,
      shipDate,
      createDate: createdAt,
      weightOz: args.effectiveWeightOz,
      dimsL: args.length,
      dimsW: args.width,
      dimsH: args.height,
      cost: created.cost.toFixed(2),
      labelUrl: created.labelUrl,
      labelCreatedAt: createdAt,
      labelFormat: created.labelFormat ?? 'pdf',
      labelCarrier: created.carrierCode,
      labelService: created.serviceCode,
      labelTracking: created.trackingNumber,
      labelCost: created.cost.toFixed(2),
      labelShipDate: shipDate,
      labelShipmentId: created.shipmentId || null,
      labelProvider: created.providerAccountId,
      providerAccountId: created.providerAccountId,
      selectedPackageId: args.selectedPackageId,
      selectedRateJson: {
        providerAccountId: created.providerAccountId,
        shippingProviderId: created.providerAccountId,
        carrierCode: created.carrierCode,
        serviceCode: created.serviceCode,
        serviceName: created.serviceCode,
        cost: created.cost,
        shipmentCost: created.cost,
        otherCost: 0,
      },
      voided: created.voided,
      source: args.source,
      isReturn: false,
    })
    .returning({ id: shipments.id });
  if (!row) throw new Error('Failed to persist shipment row');
  return row.id;
}

async function markOrderShipped(orderId: number, trackingNumber: string | null): Promise<void> {
  await db
    .update(orders)
    .set({ orderStatus: 'shipped', updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  if (trackingNumber) {
    await db
      .insert(orderOverrides)
      .values({ orderId, trackingNumber, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: orderOverrides.orderId,
        set: { trackingNumber, updatedAt: new Date() },
      });
  }
}

/**
 * Create a label (v2-parity). Supports offline testLabel mode (generates a
 * mock PDF with no ShipStation interaction) and real ShipStation creation.
 */
export async function createLabelV2(body: CreateLabelInputDto): Promise<CreateLabelResponseDto> {
  if (!body.orderId || !body.serviceCode) {
    throw new Error('orderId and serviceCode required');
  }

  const order = await loadOrderRecord(body.orderId);
  if (!order) throw new Error('Order not found');
  if (order.orderStatus === 'shipped' || order.orderStatus === 'cancelled') {
    throw new Error(`Cannot create label for ${order.orderStatus} order`);
  }

  // Resolve clientId — prefer order.clientId, fall back to mapping order.storeId
  // through the clients.storeIds array (v2 parity for legacy orders whose
  // clientId was never backfilled).
  let clientId = order.clientId;
  if (!clientId && order.storeId != null) {
    const [match] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(sql`${clients.storeIds} @> ${[order.storeId]}::integer[]`)
      .limit(1);
    clientId = match?.id ?? null;
  }
  if (clientId) checkLabelRateLimit(clientId);

  // Hard guard: any order under an isTest client is forced into offline-mock
  // mode regardless of what the UI sent. Prevents a test row from ever
  // spending real postage.
  if (clientId) {
    const [cli] = await db
      .select({ isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (cli?.isTest) {
      body = { ...body, testLabel: true };
    }
  }

  const existing = await findActiveLabelForOrder(order.id);
  if (existing) {
    const err = new Error('Label already exists for this order') as Error & {
      details?: Record<string, unknown>;
    };
    err.details = {
      shipmentId: existing.id,
      trackingNumber: existing.trackingNumber,
      labelUrl: existing.labelUrl,
    };
    throw err;
  }

  const overrides = await loadOrderDimsOverride(order.id);
  const effectiveWeightOz = Number(body.weightOz ?? overrides?.rateWeightOz ?? order.weightOz ?? 0);
  if (!effectiveWeightOz) throw new Error('Order weight required to create label');

  const length = Number(body.length ?? overrides?.rateDimsL ?? 0) || null;
  const width = Number(body.width ?? overrides?.rateDimsW ?? 0) || null;
  const height = Number(body.height ?? overrides?.rateDimsH ?? 0) || null;

  const fallbackShipTo = orderShipToFromRaw(order);
  const shipTo = mergeAddress(body.shipTo, fallbackShipTo);
  let shipFrom: ShipstationAddressInput;
  if (body.shipFrom?.street1) {
    shipFrom = mergeAddress(body.shipFrom, defaultShipFromAddress());
  } else {
    try {
      const fromLoc = await getDefaultShipFrom();
      shipFrom = {
        name: fromLoc.name,
        company: fromLoc.company_name,
        street1: fromLoc.address_line1,
        street2: fromLoc.address_line2,
        city: fromLoc.city_locality,
        state: fromLoc.state_province,
        postalCode: fromLoc.postal_code,
        country: fromLoc.country_code,
        phone: fromLoc.phone,
      };
    } catch {
      shipFrom = defaultShipFromAddress();
    }
  }

  // ── Offline test mode ───────────────────────────────────────────────────────
  if (body.testLabel === true) {
    const fakeShipmentId = generateFakeShipmentId();
    const fakeTracking = generateFakeTrackingNumber();
    const shipDate = new Date().toISOString().slice(0, 10);
    // Absolute URL so window.open from the Vercel-hosted UI resolves to the
    // API host, not the frontend origin. Falls back to relative path in dev
    // when PUBLIC_API_URL isn't set (Vite proxies /labels/ to localhost:3000).
    const apiBase = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
    const mockLabelUrl = apiBase
      ? `${apiBase}/labels/mock/${fakeShipmentId}`
      : `/labels/mock/${fakeShipmentId}`;

    const mockData: MockLabelData = {
      shipmentId: fakeShipmentId,
      orderNumber: order.orderNumber ?? null,
      trackingNumber: fakeTracking,
      serviceLabel: serviceCodeToLabel(body.serviceCode),
      weightOz: effectiveWeightOz,
      shipFrom: {
        name: shipFrom.name ?? 'Ship From',
        street1: shipFrom.street1 ?? '',
        city: shipFrom.city ?? '',
        state: shipFrom.state ?? '',
        postalCode: shipFrom.postalCode ?? '',
      },
      shipTo: {
        name: shipTo.name ?? 'Ship To',
        street1: shipTo.street1 ?? '',
        city: shipTo.city ?? '',
        state: shipTo.state ?? '',
        postalCode: shipTo.postalCode ?? '',
      },
      shipDate,
    };

    let pdfBase64: string | undefined;
    try {
      pdfBase64 = await generateMockLabelPdf(mockData);
    } catch (err) {
      console.error('[mock-label] PDF generation failed:', (err as Error).message);
    }
    saveMockLabel(fakeShipmentId, { ...mockData, pdfBase64 });

    const createdAt = new Date();
    await db
      .insert(shipments)
      .values({
        orderId: order.id,
        clientId,
        orderNumber: order.orderNumber,
        carrierCode: body.carrierCode ?? 'stamps_com',
        serviceCode: body.serviceCode,
        trackingNumber: fakeTracking,
        shipDate: createdAt,
        createDate: createdAt,
        weightOz: effectiveWeightOz,
        dimsL: length,
        dimsW: width,
        dimsH: height,
        cost: '0.00',
        labelUrl: mockLabelUrl,
        labelCreatedAt: createdAt,
        labelFormat: 'pdf',
        labelCarrier: body.carrierCode ?? 'stamps_com',
        labelService: body.serviceCode,
        labelTracking: fakeTracking,
        labelCost: '0.00',
        labelShipDate: createdAt,
        labelShipmentId: fakeShipmentId,
        source: 'test_offline',
        voided: false,
        isReturn: false,
      });

    return {
      shipmentId: fakeShipmentId,
      trackingNumber: fakeTracking,
      labelUrl: mockLabelUrl,
      cost: 0,
      voided: false,
      orderStatus: order.orderStatus,
      apiVersion: 'v2',
    };
  }

  // ── Real ShipStation flow ───────────────────────────────────────────────────
  const creds = await loadClientCredentials(clientId);
  const apiKeyV2 = creds.apiKeyV2 ?? undefined;
  if (!body.shippingProviderId) {
    throw new Error('shippingProviderId required for v2 label creation');
  }

  const created = await ssCreateLabel({
    apiKeyV2,
    carrierId: `se-${body.shippingProviderId}`,
    serviceCode: body.serviceCode,
    packageCode: body.packageCode || serviceCodeFitsPackage(body.serviceCode),
    weightOz: effectiveWeightOz,
    length,
    width,
    height,
    shipTo,
    shipFrom,
    confirmation: body.confirmation ?? null,
    ssOrderId: order.id,
    orderNumber: order.orderNumber ?? null,
    testLabel: false,
  });

  const localShipmentId = await persistCreatedLabel({
    created,
    orderId: order.id,
    orderNumber: order.orderNumber ?? null,
    clientId: clientId ?? null,
    effectiveWeightOz,
    length,
    width,
    height,
    selectedPackageId: body.customPackageId ? String(body.customPackageId) : null,
    source: 'prepship_v2',
  });

  await markOrderShipped(order.id, created.trackingNumber);

  // Background: v1 enrichment (non-fatal)
  if (creds.apiKey && creds.apiSecret && created.shipmentId && created.trackingNumber) {
    void (async () => {
      try {
        await ssMarkOrderShippedV1(
          {
            orderId: order.id,
            carrierCode: created.carrierCode,
            trackingNumber: created.trackingNumber!,
            shipDate: created.shipDate,
          },
          { apiKey: creds.apiKey!, apiSecret: creds.apiSecret! }
        );
      } catch (err) {
        console.warn('[labels] v1 mark-shipped failed:', (err as Error).message);
      }
    })();
  }

  return {
    shipmentId: localShipmentId,
    trackingNumber: created.trackingNumber,
    labelUrl: created.labelUrl,
    cost: created.cost,
    voided: created.voided,
    orderStatus: 'shipped',
    apiVersion: 'v2',
  };
}

export async function createBatchV2(body: CreateBatchLabelInputDto): Promise<CreateBatchLabelResponseDto> {
  const created: BatchLabelResultItem[] = [];
  const failed: BatchLabelResultItem[] = [];

  await withConcurrency(
    body.orderIds,
    async (orderId) => {
      try {
        const result = await createLabelV2({
          orderId,
          serviceCode: body.serviceCode,
          carrierCode: body.carrierCode,
          packageCode: body.packageCode,
          confirmation: body.confirmation,
          testLabel: body.testLabel,
          shippingProviderId: body.shippingProviderId,
        });
        created.push({
          orderId,
          success: true,
          shipmentId: result.shipmentId,
          trackingNumber: result.trackingNumber,
          cost: result.cost,
        });
      } catch (err) {
        failed.push({
          orderId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    },
    5
  );

  return {
    created,
    failed,
    summary: {
      total: body.orderIds.length,
      created: created.length,
      failed: failed.length,
    },
  };
}

// Legacy batch (kept; different input shape)
export type BatchResultItem = {
  orderId: number;
  success: boolean;
  shipmentId?: number;
  trackingNumber?: string | null;
  cost?: string | null;
  error?: string;
};

export async function createLabelBatch(
  orderIds: number[],
  serviceCode: string
): Promise<{
  created: BatchResultItem[];
  failed: BatchResultItem[];
  summary: { total: number; created: number; failed: number };
}> {
  const created: BatchResultItem[] = [];
  const failed: BatchResultItem[] = [];
  const concurrency = 5;
  for (let i = 0; i < orderIds.length; i += concurrency) {
    const chunk = orderIds.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (orderId) => {
        try {
          const shipment = await createLabelFromOrderId({ orderId, serviceCode });
          created.push({
            orderId,
            success: true,
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
            cost: shipment.labelCost,
          });
        } catch (err) {
          failed.push({ orderId, success: false, error: (err as Error).message });
        }
      })
    );
  }
  return {
    created,
    failed,
    summary: { total: orderIds.length, created: created.length, failed: failed.length },
  };
}

// Persist a VOID/TEST shipment for an is_test client — reused by both the
// single-order (createLabelV2) and batch (createLabelFromOrderId) paths so
// every entry point into label creation is safe for sandbox orders.
async function createMockShipmentForOrder(args: {
  order: typeof orders.$inferSelect;
  clientId: number | null;
  serviceCode: string;
}) {
  const { order, clientId, serviceCode } = args;
  const fakeShipmentId = generateFakeShipmentId();
  const fakeTracking = generateFakeTrackingNumber();
  const createdAt = new Date();
  const apiBase = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  const mockLabelUrl = apiBase
    ? `${apiBase}/labels/mock/${fakeShipmentId}`
    : `/labels/mock/${fakeShipmentId}`;

  const raw = (order.raw as { shipTo?: Record<string, unknown> } | null) ?? {};
  const shipToRaw = (raw.shipTo ?? {}) as Record<string, unknown>;

  const mockData: MockLabelData = {
    shipmentId: fakeShipmentId,
    orderNumber: order.orderNumber ?? null,
    trackingNumber: fakeTracking,
    serviceLabel: serviceCodeToLabel(serviceCode),
    weightOz: order.weightOz ?? 0,
    shipFrom: {
      name: 'TEST Ship From',
      street1: '',
      city: '',
      state: '',
      postalCode: '',
    },
    shipTo: {
      name: order.shipToName ?? 'Ship To',
      street1: (shipToRaw.street1 as string | undefined) ?? '',
      city: order.shipToCity ?? '',
      state: order.shipToState ?? '',
      postalCode: order.shipToPostalCode ?? '',
    },
    shipDate: createdAt.toISOString().slice(0, 10),
  };

  let pdfBase64: string | undefined;
  try {
    pdfBase64 = await generateMockLabelPdf(mockData);
  } catch (err) {
    console.error('[mock-label] PDF generation failed:', (err as Error).message);
  }
  saveMockLabel(fakeShipmentId, { ...mockData, pdfBase64 });

  const [row] = await db
    .insert(shipments)
    .values({
      orderId: order.id,
      clientId,
      orderNumber: order.orderNumber,
      carrierCode: 'stamps_com',
      serviceCode,
      trackingNumber: fakeTracking,
      shipDate: createdAt,
      createDate: createdAt,
      weightOz: order.weightOz,
      cost: '0.00',
      labelUrl: mockLabelUrl,
      labelCreatedAt: createdAt,
      labelFormat: 'pdf',
      labelCarrier: 'stamps_com',
      labelService: serviceCode,
      labelTracking: fakeTracking,
      labelCost: '0.00',
      labelShipDate: createdAt,
      labelShipmentId: fakeShipmentId,
      source: 'test_offline',
      voided: false,
      isReturn: false,
    })
    .returning();
  if (!row) throw new Error('Failed to persist mock shipment');
  return row;
}

async function createLabelFromOrderId(args: {
  orderId: number;
  serviceCode: string;
  clientId?: number;
}) {
  const order = await loadOrderRecord(args.orderId);
  if (!order) throw new Error(`Order ${args.orderId} not found`);
  if (!order.weightOz || order.weightOz <= 0) {
    throw new Error(`Order ${order.orderNumber} has no weight set`);
  }

  const raw = (order.raw as { shipTo?: Record<string, unknown> } | null) ?? {};
  const shipToRaw = (raw.shipTo ?? {}) as Record<string, unknown>;
  const street1 = (shipToRaw.street1 as string | undefined) ?? '';
  const city = (shipToRaw.city as string | undefined) ?? order.shipToCity ?? '';
  const state = (shipToRaw.state as string | undefined) ?? order.shipToState ?? '';
  const postal = (shipToRaw.postalCode as string | undefined) ?? order.shipToPostalCode ?? '';

  const missing: string[] = [];
  if (!street1) missing.push('street');
  if (!city) missing.push('city');
  if (!state) missing.push('state');
  if (!postal) missing.push('postal code');
  if (missing.length) {
    throw new Error(`Order ${order.orderNumber}: ship-to missing ${missing.join(', ')}`);
  }

  // Hard guard on the batch path too — if this order belongs to a test
  // client, create a mock shipment instead of calling ShipStation. Mirrors
  // the forced-testLabel guard in createLabelV2 so any entry point into
  // label creation is safe.
  const effectiveClientId = args.clientId ?? order.clientId ?? null;
  if (effectiveClientId) {
    const [cli] = await db
      .select({ isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, effectiveClientId))
      .limit(1);
    if (cli?.isTest) {
      return await createMockShipmentForOrder({
        order,
        clientId: effectiveClientId,
        serviceCode: args.serviceCode,
      });
    }
  }

  return createLabelFromShipment({
    orderId: args.orderId,
    clientId: args.clientId ?? order.clientId ?? undefined,
    weightOz: order.weightOz,
    serviceCode: args.serviceCode,
    shipTo: {
      name: order.shipToName ?? undefined,
      address_line1: street1,
      address_line2: (shipToRaw.street2 as string | undefined) ?? undefined,
      city_locality: city,
      state_province: state,
      postal_code: postal,
      country_code: (shipToRaw.country as string | undefined) ?? 'US',
      phone: (shipToRaw.phone as string | undefined) ?? undefined,
    },
  });
}

// ── Void / Return / Retrieve ──────────────────────────────────────────────────

export async function voidLabelV2(shipmentId: number): Promise<VoidLabelResponseDto> {
  const [row] = await db
    .select()
    .from(shipments)
    .where(or(eq(shipments.id, shipmentId), eq(shipments.labelShipmentId, shipmentId)))
    .limit(1);
  if (!row) throw new Error('Shipment not found');
  if (row.voided) throw new Error('Label already voided');

  if (row.source !== 'test_offline' && row.labelShipmentId) {
    const creds = await loadClientCredentials(row.clientId);
    try {
      await ssVoidShipment(row.labelShipmentId, creds.apiKeyV2 ?? undefined);
    } catch (err) {
      // Surface the SS error but still record the local void — parity with v2 is to fail hard.
      throw err;
    }
  }

  const now = new Date();
  await db
    .update(shipments)
    .set({ voided: true, updatedAt: now })
    .where(eq(shipments.id, row.id));

  // Reset the order back to awaiting_shipment so a new label can be created.
  if (row.orderId) {
    await db
      .update(orders)
      .set({ orderStatus: 'awaiting_shipment', updatedAt: now })
      .where(eq(orders.id, row.orderId));
  }

  return {
    success: true,
    shipmentId: row.id,
    orderNumber: row.orderNumber,
    voided: true,
    voidedAt: now.toISOString(),
    trackingNumber: row.trackingNumber,
    refundAmount: row.labelCost ? Number(row.labelCost) : null,
    refundInitiated: true,
    refundEstimate: getRefundEstimate(row.carrierCode),
    note: 'Order status reset to "Awaiting Shipment"; you can create a new label.',
  };
}

// Kept for backwards compatibility with earlier callers.
export async function voidLabel(shipmentId: number) {
  return voidLabelV2(shipmentId);
}

export async function createReturnLabelV2(
  shipmentId: number,
  body: { reason?: string } = {}
): Promise<ReturnLabelResponseDto> {
  const [row] = await db
    .select()
    .from(shipments)
    .where(or(eq(shipments.id, shipmentId), eq(shipments.labelShipmentId, shipmentId)))
    .limit(1);
  if (!row) throw new Error('Shipment not found');
  if (!row.labelShipmentId) throw new Error('Cannot create return — no ShipStation shipment id on record');

  const creds = await loadClientCredentials(row.clientId);
  const reason = body.reason || 'Customer Return';
  const result = await ssCreateReturnLabel(row.labelShipmentId, reason, creds.apiKeyV2 ?? undefined);
  const now = new Date();

  await db
    .insert(shipments)
    .values({
      orderId: row.orderId,
      clientId: row.clientId,
      orderNumber: row.orderNumber,
      carrierCode: row.carrierCode,
      serviceCode: row.serviceCode,
      trackingNumber: result.returnTrackingNumber,
      shipDate: now,
      createDate: now,
      cost: result.cost.toFixed(2),
      labelUrl: result.labelUrl,
      labelCreatedAt: now,
      labelFormat: 'pdf',
      labelCarrier: row.carrierCode,
      labelService: row.serviceCode,
      labelTracking: result.returnTrackingNumber,
      labelCost: result.cost.toFixed(2),
      labelShipDate: now,
      labelShipmentId: result.returnShipmentId,
      source: 'prepship_v2',
      voided: false,
      isReturn: true,
      returnForShipmentId: row.id,
      returnReason: reason,
    });

  return {
    success: true,
    shipmentId: row.id,
    orderNumber: row.orderNumber,
    returnTrackingNumber: result.returnTrackingNumber,
    returnShipmentId: result.returnShipmentId,
    cost: result.cost,
    reason,
    createdAt: now.toISOString(),
  };
}

export async function retrieveLabelV2(
  lookup: number | string,
  fresh = false
): Promise<RetrieveLabelResponseDto> {
  const asNum = typeof lookup === 'number' ? lookup : Number(lookup);
  const isNumeric = Number.isFinite(asNum);

  const [row] = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.voided, false),
        isNumeric
          ? or(
              eq(shipments.orderId, asNum),
              eq(shipments.id, asNum),
              eq(shipments.labelShipmentId, asNum)
            )
          : eq(shipments.trackingNumber, String(lookup))
      )
    )
    .orderBy(desc(shipments.createdAt))
    .limit(1);

  if (!row) throw new Error('No active label found for this order');

  let labelUrl = row.labelUrl;
  if (fresh || !labelUrl) {
    const freshUrl = await findFreshLabelUrl(row);
    if (freshUrl && freshUrl !== labelUrl) {
      await db.update(shipments).set({ labelUrl: freshUrl, updatedAt: new Date() }).where(eq(shipments.id, row.id));
      labelUrl = freshUrl;
    }
  }

  if (!labelUrl) {
    if (row.source === 'shipstation') {
      throw new Error(
        `Label was created in ShipStation before label tracking was enabled. Access it directly in ShipStation or use tracking number ${row.trackingNumber || 'N/A'}`
      );
    }
    throw new Error('Label URL not available. The label may have been voided or deleted.');
  }

  return {
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    shipmentId: row.id,
    trackingNumber: row.trackingNumber,
    labelUrl,
    createdAt: row.labelCreatedAt ? row.labelCreatedAt.toISOString() : null,
    carrier: row.carrierCode || 'unknown',
    service: row.serviceCode || 'unknown',
    cost: row.labelCost ? Number(row.labelCost) : 0,
  };
}

async function findFreshLabelUrl(row: {
  clientId: number | null;
  labelShipmentId: number | null;
  trackingNumber: string | null;
  source: string | null;
}): Promise<string | null> {
  const creds = await loadClientCredentials(row.clientId);
  const labels = await ssListRecentLabels(creds.apiKeyV2 ?? undefined);
  if (row.labelShipmentId) {
    const byShipment = labels.find((entry) => entry.shipmentId === row.labelShipmentId);
    if (byShipment?.labelUrl) return byShipment.labelUrl;
  }
  if (row.trackingNumber) {
    const byTracking = labels.find((entry) => entry.trackingNumber === row.trackingNumber);
    if (byTracking?.labelUrl) return byTracking.labelUrl;
  }
  if (creds.apiKey && creds.apiSecret && row.labelShipmentId) {
    const details = await ssGetShipmentV1(row.labelShipmentId, {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
    });
    if (details?.labelUrl) return details.labelUrl;
  }
  return null;
}

export { generateMockLabelHtml } from './mock-label-generator';
export type { MockLabelData } from './mock-label-generator';
