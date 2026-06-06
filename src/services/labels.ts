import { and, eq, or, desc, sql } from 'drizzle-orm';
import { performance } from 'node:perf_hooks';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { orders, orderOverrides } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import {
  extractShipstationLabelUrl,
  ssCreateReturnLabel,
  ssGetShipmentV1,
  ssListRecentLabels,
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
import { deductInventoryForOrder, deductPackageForShipment } from './fulfillment-deductions';
import { packages } from '../db/schema/packages';
import { createCarrierLabel, listCarrierAccounts } from './carrier-connector-orchestrator';
import {
  enqueueShipmentConfirmation,
  ensureFulfillmentSchema,
  inferStoreProvider,
  processFulfillmentOutboxOnce,
} from './fulfillment/outbox';
import { addMockLabelSignature } from '../lib/mock-label-access';
import {
  type SelectedRateProofInput,
} from './shipping-workflow/rate-fingerprint';
import { assertLabelPurchaseRateSelection } from './shipping-workflow/rate-quote-snapshot-store';
import { assertCarrierFamilyEligibleForPurchase } from './shipping-workflow/carrier-eligibility-policy';
import { normalizeShippingOptions } from '../lib/shipping-options';
import {
  assertShippingServiceEligible,
  resolveEffectiveInsurance,
  type ShippingServiceDescriptor,
} from '../lib/shipping-service-eligibility';
import { loadShippingAutomationRules } from './shipping-automation';

// Batch-label callers don't carry a panel-selected package, so customPackageId
// is often null. When dims are present, fall back to the same ±0.1" tolerance
// that /packages/auto-create uses to find an existing package — without this,
// the package's stock_qty never decrements for batch-issued labels and the
// PACKAGES section count stays flat regardless of how many labels go out.
async function resolveLabelPackageId(args: {
  customPackageId?: number | string | null;
  length: number | null;
  width: number | null;
  height: number | null;
}): Promise<number | null> {
  if (args.customPackageId != null && args.customPackageId !== '') {
    const id = Number(args.customPackageId);
    if (Number.isFinite(id) && id > 0) return id;
  }
  if (args.length && args.width && args.height) {
    const tol = 0.1;
    const [match] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          sql`abs(${packages.length} - ${args.length}) <= ${tol}`,
          sql`abs(${packages.width} - ${args.width}) <= ${tol}`,
          sql`abs(${packages.height} - ${args.height}) <= ${tol}`
        )
      )
      .limit(1);
    if (match) return match.id;
  }
  return null;
}

// Optional local throttle. Disabled by default so batch queue jobs are not capped.
// Set LABEL_RATE_LIMIT to a positive value to re-enable a per-minute client cap.

const LABEL_RATE_LIMIT = Number(process.env.LABEL_RATE_LIMIT ?? 0);
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

type LabelTimer = ReturnType<typeof createLabelTimer>;

function createLabelTimer(orderId: number | string) {
  const started = performance.now();
  const prefix = `[label-create] orderId=${orderId}`;

  const elapsed = () => Math.round(performance.now() - started);

  return {
    async task<T>(step: string, fn: () => Promise<T>): Promise<T> {
      const stepStarted = performance.now();
      try {
        return await fn();
      } finally {
        console.info(`${prefix} ${step} ${Math.round(performance.now() - stepStarted)}ms total=${elapsed()}ms`);
      }
    },
    background(step: string, fn: () => Promise<void>): void {
      void (async () => {
        const stepStarted = performance.now();
        try {
          await fn();
          console.info(`${prefix} ${step} ${Math.round(performance.now() - stepStarted)}ms total=${elapsed()}ms background=ok`);
        } catch (err) {
          console.warn(
            `${prefix} ${step} failed after ${Math.round(performance.now() - stepStarted)}ms total=${elapsed()}ms:`,
            err instanceof Error ? err.message : err
          );
        }
      })();
    },
    done(step: string): void {
      console.info(`${prefix} ${step} total=${elapsed()}ms`);
    },
  };
}

function checkLabelRateLimit(clientId: number): void {
  if (!Number.isFinite(LABEL_RATE_LIMIT) || LABEL_RATE_LIMIT <= 0) return;

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

// ── Mock label store (DB-backed, with in-memory fast path) ────────────────────
// v2-parity: mock labels persist to the `mock_labels` table so dev labels
// survive server restarts. Keep a Map as a read-through cache so /mock/:id
// doesn't hit the DB on every render in dev.

const mockLabelStore = new Map<number, MockLabelData>();

export function getMockLabel(shipmentId: number): MockLabelData | null {
  return mockLabelStore.get(shipmentId) ?? null;
}

export async function getMockLabelAsync(shipmentId: number): Promise<MockLabelData | null> {
  const cached = mockLabelStore.get(shipmentId);
  if (cached) return cached;
  try {
    const { mockLabels } = await import('../db/schema/mock-labels');
    const [row] = await db
      .select()
      .from(mockLabels)
      .where(eq(mockLabels.shipmentId, shipmentId))
      .limit(1);
    if (!row) return null;
    const parse = <T>(v: string | null, fallback: T): T => {
      if (v == null) return fallback;
      try { return JSON.parse(v) as T; } catch { return fallback; }
    };
    const empty = { name: '', street1: '', city: '', state: '', postalCode: '' };
    const hydrated: MockLabelData = {
      shipmentId: row.shipmentId,
      orderNumber: row.orderNumber,
      trackingNumber: row.trackingNumber,
      serviceLabel: row.serviceLabel ?? '',
      weightOz: row.weightOz ? Number(row.weightOz) : 0,
      shipFrom: parse(row.shipFrom, empty),
      shipTo: parse(row.shipTo, empty),
      shipDate: row.shipDate ?? '',
      pdfBase64: row.pdfBase64 ?? undefined,
    };
    mockLabelStore.set(shipmentId, hydrated);
    return hydrated;
  } catch (err) {
    console.warn('[labels] getMockLabelAsync DB fetch failed:', err);
    return null;
  }
}

export function saveMockLabel(shipmentId: number, data: MockLabelData): void {
  mockLabelStore.set(shipmentId, data);
  // Fire-and-forget: persist to DB for restart-survival. The in-memory map
  // is authoritative for the current process; DB is the durable mirror.
  void (async () => {
    try {
      const { mockLabels } = await import('../db/schema/mock-labels');
      await db
        .insert(mockLabels)
        .values({
          shipmentId,
          orderNumber: data.orderNumber,
          trackingNumber: data.trackingNumber,
          serviceLabel: data.serviceLabel,
          weightOz: String(data.weightOz),
          shipFrom: JSON.stringify(data.shipFrom),
          shipTo: JSON.stringify(data.shipTo),
          shipDate: data.shipDate,
          pdfBase64: data.pdfBase64 ?? null,
        })
        .onConflictDoUpdate({
          target: mockLabels.shipmentId,
          set: {
            orderNumber: data.orderNumber,
            trackingNumber: data.trackingNumber,
            serviceLabel: data.serviceLabel,
            weightOz: String(data.weightOz),
            shipFrom: JSON.stringify(data.shipFrom),
            shipTo: JSON.stringify(data.shipTo),
            shipDate: data.shipDate,
            pdfBase64: data.pdfBase64 ?? null,
          },
        });
    } catch (err) {
      console.warn('[labels] saveMockLabel DB persist failed:', err);
    }
  })();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type AddressInputDto = ShipstationAddressInput;

export type CreateLabelInputDto = {
  orderId: number;
  orderNumber?: string;
  carrierCode?: string;
  carrierName?: string;
  serviceCode: string;
  serviceName?: string;
  serviceType?: string;
  packageCode?: string;
  customPackageId?: number | null;
  shippingProviderId?: number | null;
  weightOz?: number;
  length?: number;
  width?: number;
  height?: number;
  confirmation?: string;
  insuranceProvider?: string;
  insurance?: string;
  insuredValue?: number | null;
  insuranceValue?: number | string | null;
  testLabel?: boolean;
  shipTo?: AddressInputDto;
  shipFrom?: AddressInputDto;
  selectedRateProof?: SelectedRateProofInput;
  // PS-105: backend-owned rate quote snapshot id + the chosen rate's authority
  // key. Preferred over selectedRateProof at the purchase boundary; selectedRateProof
  // remains a compatibility fallback during migration.
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
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
  insuranceProvider?: string;
  insurance?: string;
  insuredValue?: number | null;
  insuranceValue?: number | string | null;
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

// v2-parity: credential resolution now lives in src/lib/shipstation/credentials.ts
// and includes the rate_source_client_id fallback from v2 (which the previous
// inline helper ignored — keyed clients with a rate-source fallback would
// silently fail).
import { loadClientCredentials as loadClientCredentialsImpl } from '../lib/shipstation/credentials';

async function loadClientCredentials(clientId: number | null | undefined): Promise<{
  apiKeyV2: string | null;
  apiKey: string | null;
  apiSecret: string | null;
}> {
  return loadClientCredentialsImpl(clientId);
}

// ── Legacy helpers kept for any internal callers ──────────────────────────────

export type CreateFromRateInput = {
  rateId: string;
  orderId: number;
  clientId?: number;
};

export async function createLabelFromRate(input: CreateFromRateInput) {
  const label = await createCarrierLabel('shipstation', {
    rateId: input.rateId,
    body: { validate_address: 'no_validation' },
    dedupeKey: `label:rate:${input.rateId}`,
  }) as Label;
  return persistLabelFromRate(label, input.orderId, input.clientId);
}

async function assertLabelServiceEligibleForOrder(
  order: Pick<typeof orders.$inferSelect, 'clientId' | 'storeId'>,
  clientId: number | null | undefined,
  service: ShippingServiceDescriptor,
  shippingOptions?: ReturnType<typeof normalizeShippingOptions>,
): Promise<void> {
  const automationRules = await loadShippingAutomationRules();
  assertShippingServiceEligible(
    {
      clientId: clientId ?? order.clientId ?? null,
      storeId: order.storeId ?? null,
    },
    service,
    shippingOptions,
    automationRules,
  );
}

async function persistLabelFromRate(label: Label, orderId: number, clientId?: number) {
  const shipDate = label.ship_date ? new Date(label.ship_date) : null;
  const createdAt = label.created_at ? new Date(label.created_at) : new Date();
  const ssShipmentId = Number(String(label.shipment_id ?? '').replace(/^se-/, ''));
  // Per user override unlock shipped data on 2026-05-23: normalize nested ShipStation label downloads before shipment persistence so queue recovery receives a plain URL string.
  const labelUrl = extractShipstationLabelUrl(label.label_download);
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
      labelUrl,
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

// PS-072 / dead-code note: this is a legacy batch helper with NO active server
// callers (adjudicated in parity/_v4-only.md — all live single/batch/print-queue
// label creation funnels through createLabelV2, which applies the HUGRAB default
// insurance via resolveEffectiveInsurance). This path does NOT apply PS-072
// insurance. If it is ever revived for real label creation, route it through
// createLabelV2 (or call resolveEffectiveInsurance here) or HUGRAB ground labels
// would ship uninsured.
export async function createLabelFromShipment(input: CreateFromShipmentInput) {
  const automationRules = await loadShippingAutomationRules();
  assertShippingServiceEligible(
    {
      clientId: input.clientId ?? null,
    },
    {
      serviceCode: input.serviceCode,
      serviceName: input.serviceCode,
    },
    null,
    automationRules,
  );
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

  const label = await createCarrierLabel('shipstation', {
    shipment,
    clientId: input.clientId ?? null,
    serviceCode: input.serviceCode,
  }) as Label;
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

type MarketplaceConfirmationProvider = 'shipstation' | 'walmart' | 'ebay';

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function normalizeConfirmationProvider(value: unknown): MarketplaceConfirmationProvider | null {
  const text = firstText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return null;
  if (text.includes('walmart')) return 'walmart';
  if (text.includes('ebay')) return 'ebay';
  if (text.includes('shipstation')) return 'shipstation';
  return null;
}

function isNoMarketplaceSource(value: unknown): boolean {
  const text = firstText(value).toLowerCase().replace(/[\s-]+/g, '_');
  return ['manual', 'manual_orders', 'internal', 'none', 'no_marketplace'].includes(text);
}

function stripProviderPrefix(externalOrderId: string | null | undefined, provider: string): string {
  const text = firstText(externalOrderId);
  const prefix = `${provider}-`;
  return text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length) : '';
}

function confirmationProviderForOrder(order: typeof orders.$inferSelect): MarketplaceConfirmationProvider | null {
  if (isNoMarketplaceSource(order.sourceProvider)) return null;
  const fromSourceProvider = normalizeConfirmationProvider(order.sourceProvider);
  if (fromSourceProvider) return fromSourceProvider;

  const raw = order.raw ?? {};
  if (isNoMarketplaceSource(raw.source_provider ?? raw.sourceProvider ?? raw.source ?? raw.provider)) return null;
  const fromRaw = normalizeConfirmationProvider(
    raw.source_provider ??
    raw.sourceProvider ??
    raw.source ??
    raw.provider ??
    raw.marketplace ??
    raw.platform
  );
  if (fromRaw) return fromRaw;

  if (!firstText(order.externalOrderId)) return null;
  const fromExternalId = normalizeConfirmationProvider(inferStoreProvider(order.externalOrderId));
  return fromExternalId ?? 'shipstation';
}

function baseConfirmationPayload(created: CreatedExternalLabel): Record<string, unknown> {
  return {
    carrierProvider: 'shipstation',
    carrierAccountId: created.providerAccountId,
    shipStationShipmentId: created.shipmentId,
    notifyCustomer: false,
    notifyMarketplace: false,
  };
}

function carrierNameForMarketplace(carrierCode: string | null | undefined): string {
  const code = firstText(carrierCode).toLowerCase();
  if (code.includes('fedex')) return 'FedEx';
  if (code.includes('ups')) return 'UPS';
  if (code.includes('usps') || code.includes('stamps')) return 'USPS';
  return firstText(carrierCode, 'Other');
}

function trackingUrlForCarrier(carrierCode: string | null | undefined, trackingNumber: string | null | undefined): string {
  const tracking = firstText(trackingNumber);
  if (!tracking) return '';
  const carrier = carrierNameForMarketplace(carrierCode).toLowerCase();
  if (carrier === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
  if (carrier === 'ups') return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (carrier === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  return '';
}

function marketplaceConfirmationPayload(
  order: typeof orders.$inferSelect,
  created: CreatedExternalLabel,
  provider: MarketplaceConfirmationProvider,
): Record<string, unknown> {
  const raw = order.raw ?? {};
  const payload: Record<string, unknown> = {
    carrierProvider: 'shipstation',
    carrierAccountId: created.providerAccountId,
    shipStationShipmentId: created.shipmentId,
    notifyCustomer: false,
    notifyMarketplace: true,
  };

  if (provider === 'walmart') {
    payload.storeAccountId = firstText(
      raw.accountId,
      raw.storeAccountId,
      raw.sourceAccountId,
      raw.marketplaceAccountId
    ) || undefined;
    payload.purchaseOrderId = firstText(
      raw.purchaseOrderId,
      stripProviderPrefix(order.externalOrderId, 'walmart'),
      raw.orderId,
      raw.id
    ) || undefined;
    payload.rawOrder = raw;
    payload.carrierName = carrierNameForMarketplace(created.carrierCode);
    payload.trackingUrl = trackingUrlForCarrier(created.carrierCode, created.trackingNumber) || undefined;
    payload.serviceCode = created.serviceCode;
  }

  if (provider === 'ebay') {
    payload.storeAccountId = firstText(
      raw.accountId,
      raw.storeAccountId,
      raw.sourceAccountId,
      raw.marketplaceAccountId
    ) || undefined;
    payload.ebayOrderId = firstText(
      raw.orderId,
      stripProviderPrefix(order.externalOrderId, 'ebay'),
      raw.id
    ) || undefined;
    payload.rawOrder = raw;
    payload.lineItems = Array.isArray(raw.lineItems)
      ? raw.lineItems.map((line: any) => ({
          lineItemId: firstText(line?.lineItemId, line?.line_item_id),
          quantity: Number(line?.quantity ?? 1) || 1,
        })).filter((line: any) => line.lineItemId)
      : undefined;
    payload.shippingCarrierCode = carrierNameForMarketplace(created.carrierCode);
    payload.serviceCode = created.serviceCode;
  }

  return payload;
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

async function markOrderShipped(
  orderId: number,
  trackingNumber: string | null,
  options: { cleanupQueue?: boolean } = {}
): Promise<void> {
  void options;
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

  // Print Queue persistence: shipped status means a label exists, not that an
  // operator physically printed it. Queue entries persist until explicit
  // operator action confirms printed or removes them.

}

async function recordFulfillmentDeductions(args: {
  order: typeof orders.$inferSelect;
  shipmentId: number;
  packageId?: number | string | null;
  source: string;
  timer?: LabelTimer;
}) {
  try {
    const deductPackage = () => deductPackageForShipment({
      packageId: args.packageId ?? null,
      shipmentId: args.shipmentId,
      orderId: args.order.id,
      orderNumber: args.order.orderNumber,
    });
    const deductInventory = () => deductInventoryForOrder(args.order, {
      shipmentId: args.shipmentId,
      source: args.source,
    });

    if (args.timer) {
      await args.timer.task('package stock deduction', deductPackage);
      await args.timer.task('inventory ledger writes', deductInventory);
    } else {
      await deductPackage();
      await deductInventory();
    }
  } catch (err) {
    console.warn('[labels] fulfillment deduction failed:', err);
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

  const timer = createLabelTimer(body.orderId);
  await timer.task('fulfillment schema readiness', () => ensureFulfillmentSchema());
  const order = await timer.task('order load', () => loadOrderRecord(body.orderId));
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
  const serviceDescriptor: ShippingServiceDescriptor = {
    carrierCode: body.carrierCode ?? null,
    carrierName: body.carrierName ?? null,
    provider: body.carrierCode ?? null,
    serviceCode: body.serviceCode,
    serviceName: body.serviceName ?? body.serviceCode,
    serviceType: body.serviceType ?? null,
  };
  // PS-072: backend source of truth for effective insurance. Applies the HUGRAB
  // default (ParcelGuard/$100 for UPS Ground and USPS Ground),
  // preserves an operator-selected higher value, and NEVER touches Ground
  // Saver/SurePost (PS-057). The UI cannot bypass this — single, batch, and
  // print-queue label creation all funnel through createLabelV2. Run BEFORE the
  // eligibility assert so the assert sees the defaulted values.
  const baseOptions = normalizeShippingOptions(body);
  const effectiveInsurance = resolveEffectiveInsurance(
    { clientId, storeId: order.storeId ?? null },
    serviceDescriptor,
    baseOptions,
  );
  const options = {
    ...baseOptions,
    insuranceProvider: effectiveInsurance.insuranceProvider,
    insuredValue: effectiveInsurance.insuredValue,
  };
  await assertLabelServiceEligibleForOrder(order, clientId, serviceDescriptor, options);
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
  if (clientId && !body.testLabel) checkLabelRateLimit(clientId);

  const existing = await timer.task('existing-label check', () => findActiveLabelForOrder(order.id));
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
  const effectiveWeightOz = Number(body.weightOz ?? overrides?.rateWeightOz ?? order.weightOz ?? (body.testLabel ? 1 : 0));
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

  // Resolve which package this shipment is consuming so its stock_qty is
  // decremented correctly. Used for both the test-mode and real-postage paths.
  const resolvedPackageId = await resolveLabelPackageId({
    customPackageId: body.customPackageId,
    length,
    width,
    height,
  });

  // ── Offline test mode ───────────────────────────────────────────────────────
  if (body.testLabel === true) {
    const fakeShipmentId = generateFakeShipmentId();
    const fakeTracking = generateFakeTrackingNumber();
    const shipDate = new Date().toISOString().slice(0, 10);
    // Absolute URL so window.open from the Vercel-hosted UI resolves to the
    // API host, not the frontend origin. Falls back to relative path in dev
    // when PUBLIC_API_URL isn't set (Vite proxies /labels/ to localhost:3000).
    const apiBase = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
    const mockLabelUrlBase = apiBase
      ? `${apiBase}/labels/mock/${fakeShipmentId}`
      : `/labels/mock/${fakeShipmentId}`;
    const mockLabelUrl = addMockLabelSignature(mockLabelUrlBase, fakeShipmentId);

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
        labelFormat: 'html',
        labelCarrier: body.carrierCode ?? 'stamps_com',
        labelService: body.serviceCode,
        labelTracking: fakeTracking,
        labelCost: '0.00',
        labelShipDate: createdAt,
        labelShipmentId: fakeShipmentId,
        selectedPackageId: resolvedPackageId != null ? String(resolvedPackageId) : null,
        source: 'test_offline',
        voided: false,
        isReturn: false,
      });

    await timer.task('markOrderShipped', () => markOrderShipped(order.id, fakeTracking, { cleanupQueue: false }));
    timer.background('inventory/package deduction', () => recordFulfillmentDeductions({
      order,
      shipmentId: fakeShipmentId,
      packageId: resolvedPackageId,
      source: 'test_label',
      timer,
    }));

    timer.done('response ready');
    return {
      shipmentId: fakeShipmentId,
      trackingNumber: fakeTracking,
      labelUrl: mockLabelUrl,
      cost: 0,
      voided: false,
      orderStatus: 'shipped',
      apiVersion: 'v2',
    };
  }

  // ── Real ShipStation flow ───────────────────────────────────────────────────
  // Per user override unlock shipped data on 2026-06-05: enforce the
  // selected-rate proof/fingerprint boundary before any real ShipStation
  // postage call. Test labels returned above remain offline-only.
  // Per user override unlock shipped data on 2026-06-06 (PS-105): prefer the
  // backend-owned rate quote snapshot id; fall back to the carried proof. Both run
  // the SAME strict validator — identical to legacy when no rateQuoteId is sent.
  await assertLabelPurchaseRateSelection({
    rateQuoteId: body.rateQuoteId,
    selectedRateKey: body.selectedRateKey,
    selectedRateProof: body.selectedRateProof,
  });
  // Per user override unlock shipped data on 2026-06-06 (PS-106): carrier-family
  // eligibility — a direct-store order must not buy postage through a ShipStation
  // carrier account. This IS the ShipStation flow, so family = 'shipstation'. The
  // policy defaults to audit_only (logs a would-block, never blocks); only when an
  // operator sets the policy to `enforce` does this throw before the provider call.
  await assertCarrierFamilyEligibleForPurchase({
    carrierFamily: 'shipstation',
    order,
    orderId: order.id,
  });
  const creds = await loadClientCredentials(clientId);
  const apiKeyV2 = creds.apiKeyV2 ?? undefined;
  if (!body.shippingProviderId) {
    throw new Error('shippingProviderId required for v2 label creation');
  }
  const created = await timer.task('ShipStation createLabel connector', async () => {
    const label = await createCarrierLabel('shipstation', {
      apiKeyV2,
      clientId,
      storeId: order.storeId ?? null,
      carrierId: `se-${body.shippingProviderId}`,
      carrierCode: body.carrierCode ?? null,
      serviceCode: body.serviceCode,
      packageCode: body.packageCode || serviceCodeFitsPackage(body.serviceCode),
      weightOz: effectiveWeightOz,
      length,
      width,
      height,
      shipTo,
      shipFrom,
      confirmation: options.confirmation,
      insuranceProvider: options.insuranceProvider,
      insuredValue: options.insuredValue,
      ssOrderId: order.id,
      orderNumber: order.orderNumber ?? null,
      testLabel: false,
    });
    return label as CreatedExternalLabel;
  });

  const localShipmentId = await timer.task('persistCreatedLabel', () => persistCreatedLabel({
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
  }));

  await timer.task('markOrderShipped', () => markOrderShipped(order.id, created.trackingNumber, { cleanupQueue: false }));
  timer.background('inventory/package deduction', () => recordFulfillmentDeductions({
    order,
    shipmentId: localShipmentId,
    packageId: resolvedPackageId,
    source: 'label',
    timer,
  }));
  // Queue marketplace confirmation separately from label purchase. The label
  // response stays fast, while fulfillment_outbox owns retries and failure state.
  const confirmationProvider = confirmationProviderForOrder(order);
  const confirmationPayload = confirmationProvider
    ? marketplaceConfirmationPayload(order, created, confirmationProvider)
    : baseConfirmationPayload(created);
  try {
    // Per user override unlock shipped data on 2026-06-01: marketplace
    // confirmation enqueue failures must not block shipped-label queue recovery.
    await timer.task('enqueue marketplace confirmation', () => enqueueShipmentConfirmation({
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        sourceProvider: order.sourceProvider,
        clientId,
        orderNumber: order.orderNumber ?? null,
      },
      shipmentId: localShipmentId,
      trackingNumber: created.trackingNumber,
      carrierCode: created.carrierCode,
      shipDate: created.shipDate,
      confirmationProvider,
      payload: confirmationPayload,
    }));
  } catch (err) {
    console.warn('[labels] marketplace confirmation enqueue failed:', err instanceof Error ? err.message : err);
  }

  timer.background('marketplace confirmation outbox', () =>
    processFulfillmentOutboxOnce({ orderId: order.id, limit: 5 }).then(() => undefined)
  );

  timer.done('response ready');
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
          insuranceProvider: body.insuranceProvider ?? body.insurance,
          insuredValue: typeof body.insuranceValue === 'string' ? Number(body.insuranceValue) : body.insuredValue ?? body.insuranceValue,
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

// export async function createLabelBatch(
//   orderIds: number[],
//   serviceCode: string
// ): Promise<{
//   created: BatchResultItem[];
//   failed: BatchResultItem[];
//   summary: { total: number; created: number; failed: number };
// }> {
//   const created: BatchResultItem[] = [];
//   const failed: BatchResultItem[] = [];
//   const concurrency = 5;
//   for (let i = 0; i < orderIds.length; i += concurrency) {
//     const chunk = orderIds.slice(i, i + concurrency);
//     await Promise.all(
//       chunk.map(async (orderId) => {
//         try {
//           const shipment = await createLabelFromOrderId({ orderId, serviceCode });
//           created.push({
//             orderId,
//             success: true,
//             shipmentId: shipment.id,
//             trackingNumber: shipment.trackingNumber,
//             cost: shipment.labelCost,
//           });
//         } catch (err) {
//           failed.push({ orderId, success: false, error: (err as Error).message });
//         }
//       })
//     );
//   }
//   return {
//     created,
//     failed,
//     summary: { total: orderIds.length, created: created.length, failed: failed.length },
//   };
// }

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
  const mockLabelUrlBase = apiBase
    ? `${apiBase}/labels/mock/${fakeShipmentId}`
    : `/labels/mock/${fakeShipmentId}`;
  const mockLabelUrl = addMockLabelSignature(mockLabelUrlBase, fakeShipmentId);

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
      labelFormat: 'html',
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

  await markOrderShipped(order.id, fakeTracking);

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
  await assertLabelServiceEligibleForOrder(order, effectiveClientId, {
    serviceCode: args.serviceCode,
    serviceName: args.serviceCode,
  });
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

  // Double guard: honor the explicit test_offline source marker AND verify
  // the shipment's client isn't flagged is_test (in case a test row was
  // somehow persisted with a real labelShipmentId).
  let clientIsTest = false;
  if (row.clientId) {
    const [cli] = await db
      .select({ isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    clientIsTest = Boolean(cli?.isTest);
  }
  if (row.source !== 'test_offline' && !clientIsTest && row.labelShipmentId) {
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
// export async function voidLabel(shipmentId: number) {
//   return voidLabelV2(shipmentId);
// }

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

  // Block real-postage returns for test-client shipments. createLabelV2
  // forces testLabel=true for isTest clients, but returns go through a
  // separate SS endpoint — without this check a test shipment with a real
  // labelShipmentId (edge case) would burn real postage.
  if (row.clientId) {
    const [cli] = await db
      .select({ isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    if (cli?.isTest) {
      throw new Error('Cannot create return label for a test-client shipment');
    }
  }

  const creds = await loadClientCredentials(row.clientId);
  const reason = body.reason || 'Customer Return';
  const result = await ssCreateReturnLabel(row.labelShipmentId, reason, creds.apiKeyV2 ?? undefined);
  const now = new Date();

  const [newShipment] = await db
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
    })
    .returning({ id: shipments.id });

  // v2-parity: also record the return in the dedicated return_labels table.
  // Best-effort — failures here don't roll back the shipments insert since
  // the canonical source is shipments.isReturn + returnForShipmentId.
  try {
    const { returnLabels } = await import('../db/schema/return-labels');
    await db.insert(returnLabels).values({
      shipmentId: row.id,
      returnShipmentId: newShipment?.id ?? null,
      returnTrackingNumber: result.returnTrackingNumber,
      reason,
    });
  } catch (err) {
    console.warn('[labels] return_labels mirror insert failed:', err);
  }

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

// ── Carrier nickname resolver ─────────────────────────────────────────────────
// Ported from v2's apps/api/src/modules/orders/application/carrier-resolver.ts.
// v2 resolves against a hardcoded CARRIER_ACCOUNTS_V2 map. v4 doesn't have that
// map — we resolve against:
//   1. shipments.providerAccountNickname (set when PrepShip creates the label)
//   2. ShipStation's dynamic /v2/carriers response (providerAccountId match,
//      UPS 1Z tracking decode, single-carrier fallback)
//   3. Human-readable fallback from CARRIER_DISPLAY_NAMES below.

import type { Carrier, CarriersResponse } from '../lib/shipstation/types';

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx One Balance',
  dhl_express: 'DHL Express',
  amazon_buy_shipping: 'Amazon',
  amazon_shipping_us: 'Amazon',
  sendle: 'Sendle',
  tusk: 'Tusk',
};

// In-process TTL cache for /v2/carriers — ShipStation rate limits and the
// list rarely changes. 5 minute TTL is plenty for nickname resolution.
const CARRIERS_CACHE_TTL_MS = 5 * 60 * 1000;
let carriersCache: { at: number; data: Carrier[] } | null = null;

async function loadCarriersList(): Promise<Carrier[]> {
  const now = Date.now();
  if (carriersCache && now - carriersCache.at < CARRIERS_CACHE_TTL_MS) {
    return carriersCache.data;
  }
  try {
    const res = await listCarrierAccounts('shipstation', {
      dedupeKey: 'carriers:list',
    }) as CarriersResponse;
    carriersCache = { at: now, data: res.carriers };
    return res.carriers;
  } catch {
    // Stale cache > no data: if SS is down, keep returning what we had.
    return carriersCache?.data ?? [];
  }
}

function carrierIdToProviderAccountId(carrierId: string | null | undefined): number | null {
  if (!carrierId) return null;
  const num = Number(String(carrierId).replace(/^se-/, ''));
  return Number.isFinite(num) ? num : null;
}

/**
 * Resolve a human-readable carrier label (e.g. "ORION", "USPS Chase x7439")
 * for a shipment. Mirrors v2's resolveCarrierNickname() resolution order:
 *
 *   1. providerAccountId exact match — first against any DB-persisted
 *      shipments.providerAccountNickname for this account, then against
 *      ShipStation's /v2/carriers response.
 *   2. UPS 1Z tracking decode: chars 3-8 = UPS account code → match
 *      Carrier.account_number.
 *   3. Only one carrier for carrierCode → use that carrier's nickname.
 *   4. Human-readable fallback from CARRIER_DISPLAY_NAMES.
 *
 * The clientId arg is accepted for v2 signature parity — v4 has no client-
 * scoped carrier accounts in the dynamic SS list, so it's currently unused
 * beyond logging context.
 */
export async function resolveCarrierNickname(
  providerAccountId: number | null,
  carrierCode: string | null,
  trackingNumber?: string | null,
  _clientId?: number | null,
): Promise<string | null> {
  if (!carrierCode) return null;

  // 1a. DB-persisted per-shipment nickname (set when PrepShip creates the label)
  if (providerAccountId) {
    try {
      const [row] = await db
        .select({ nickname: shipments.providerAccountNickname })
        .from(shipments)
        .where(eq(shipments.providerAccountId, providerAccountId))
        .limit(1);
      if (row?.nickname) return row.nickname;
    } catch {
      // non-fatal; fall through to SS-dynamic resolution
    }
  }

  const carriers = await loadCarriersList();

  // 1b. Exact match by providerAccountId against SS's carriers list
  if (providerAccountId) {
    const exact = carriers.find((c) => carrierIdToProviderAccountId(c.carrier_id) === providerAccountId);
    if (exact) return exact.nickname || exact.friendly_name || exact.carrier_code;
  }

  // 2. UPS: decode account code from tracking number
  //    Format: 1Z [acct:6] [service:2] [seq:8] [check:1]
  if ((carrierCode === 'ups' || carrierCode === 'ups_walleted') && trackingNumber) {
    const tn = trackingNumber.replace(/\s/g, '').toUpperCase();
    if (tn.startsWith('1Z') && tn.length >= 8) {
      const acctCode = tn.slice(2, 8);
      const matched = carriers.find(
        (c) =>
          (c.carrier_code === 'ups' || c.carrier_code === 'ups_walleted') &&
          c.account_number?.toUpperCase() === acctCode,
      );
      if (matched) return matched.nickname || matched.friendly_name || matched.carrier_code;
    }
  }

  // 3. Single-match fallback by carrierCode
  const matching = carriers.filter((c) => c.carrier_code === carrierCode);
  if (matching.length === 1) {
    const m = matching[0]!;
    return m.nickname || m.friendly_name || m.carrier_code;
  }

  // 4. Human-readable fallback
  return CARRIER_DISPLAY_NAMES[carrierCode] ?? carrierCode.replace(/_/g, ' ').toUpperCase();
}
