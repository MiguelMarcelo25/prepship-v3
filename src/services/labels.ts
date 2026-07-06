import { and, eq, or, desc, inArray, sql } from 'drizzle-orm';
import { performance } from 'node:perf_hooks';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { ensureShipmentsSelectedRateCostColumn } from '../db/ensure-shipments-selected-rate-cost';
import { orders, orderOverrides } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
// PS-233 (Per user override unlock shipped data on 2026-06-13): caller-scope
// enforcement on label/shipment operations. The label services are the attack
// surface (routes pass them only an id/body); they now require the caller's scope.
import type { ClientStoreScope } from '../lib/client-store-scope';
import { isResourceInScope, assertResourceInScope, ResourceScopeError } from '../lib/scope-predicates';
// PS-248: per-order advisory lock so concurrent buys can't double-purchase postage for one order.
import { acquireLabelPurchaseLock } from '../lib/label-purchase-lock';
import { captureRealizedHouseMargin } from './shipping-workflow/house-margin-capture';
import { linkBundleShipment } from './shipment-bundles/create-bundle';
import { getBundleForOrder } from './shipment-bundles/bundle-read-model';
import { deductBundleMembersOnce } from './shipment-bundles/deduct-bundle-members';
import { env } from '../lib/env';
// PS-221 (slice 2): unified label-time package resolver (canonical-source precedence).
import { resolveOrderLabelPackageId } from './package-resolution';
// PS-262a: single canonical owner of the per-marketplace confirmation identity.
import { buildMarketplaceConfirmationIdentity } from './fulfillment/confirmation-payload';
import {
  extractShipstationLabelUrl,
  ssCreateReturnLabel,
  ssGetShipmentV1,
  ssListRecentLabels,
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
import {
  carrierConnectorSupportsVoid,
  createCarrierLabel,
  listCarrierAccounts,
  voidCarrierLabel,
} from './carrier-connector-orchestrator';
import {
  resolveLabelVoidDispatch,
  voidNotSupportedMessage,
  type LabelVoidOutcomeStatus,
} from './label-void-policy';
import {
  createDirectCarrierLabelForOrder,
  directLabelAccountRefFromProviderId,
  loadDirectAccountForLabel,
} from './labels-direct';
import { resolveCarrierRecipientName } from './carrier-recipient-name';
import { normalizeProviderKey } from '../lib/direct-carrier-scope';
import {
  cancelShipmentConfirmationsForVoid,
  enqueueShipmentConfirmation,
  ensureFulfillmentSchema,
  inferStoreProvider,
  processFulfillmentOutboxOnce,
} from './fulfillment/outbox';
import { assertOrderSafeToShip } from './fulfillment/shipping-safety';
import { loadClientIsTest, resolveEffectiveTestLabel } from './fulfillment/test-label-policy';
import { addMockLabelSignature } from '../lib/mock-label-access';
import {
  type SelectedRateProofInput,
  residentialFromRequestFingerprint,
  selectedRateRequestFingerprint,
} from './shipping-workflow/rate-fingerprint';
import {
  classifyShippingAddress,
  residentialForShipping,
} from './shipping-workflow/address-classification';
import { assertLabelPurchaseRateSelection } from './shipping-workflow/rate-quote-snapshot-store';
import { assertCarrierFamilyEligibleForPurchase } from './shipping-workflow/carrier-eligibility-policy';
// PS-261 (Per user override unlock shipped data on 2026-06-18): backend-owned HUGRAB
// label-purchase preflight. Consumes the PS-290 coverage verdict + PS-274 certainty and
// BLOCKS before any postage is bought when the mandatory $100 coverage is not proven
// (unknown / not_included / unsupported). Pure decision; never alters a successful buy.
import {
  resolveHugrabLabelPurchasePreflight,
  resolveShippCustomsValueProofSource,
} from './shipping-workflow/hugrab-label-purchase-preflight';
import {
  ensureOrderRecipientOverrideSchema,
  recipientOverrideFromRecord,
  resolveRecipientForShipping,
} from './order-recipient-override';

// PS-261: the HUGRAB coverage label-purchase BLOCK is a money-path change, so it ships behind a
// default-OFF canary (HUGRAB_PURCHASE_GATE), per the project norm that money-path features ship OFF
// and DJ flips them on after a canary (never auto-active). OFF (default) => byte-identical to
// pre-PS-261 (no block); 'on' => the coverage block is enforced before any postage is purchased.
function hugrabPurchaseGateEnabled(): boolean {
  return process.env.HUGRAB_PURCHASE_GATE === 'on';
}

function hugrabShippCustomsValueProofEnabled(): boolean {
  return process.env.HUGRAB_SHIPP_CUSTOMS_VALUE_PROOF === 'on';
}
import { normalizeShippingOptions } from '../lib/shipping-options';
import {
  assertShippingServiceEligible,
  isHugrabShippingContext,
  isUpsGroundSaverOrSurePostService,
  resolveEffectiveInsurance,
  type ShippingServiceDescriptor,
} from '../lib/shipping-service-eligibility';
// PS-214: direct labels persist the PS-171 schedule premium when the
// connector reports none (ParcelGuard is third-party — carriers don't bill it).
import { parcelGuardScheduledPremium } from './shipping-workflow/insurance-cost';
// PS-274 / PS-261 (Per user override unlock shipped data on 2026-06-17): the backend-owned
// insurance-CERTAINTY resolver. Used at persist time so a Shipp-brokered label NEVER records
// insuranceProvenance='carrier_declared_value' (we cannot prove the carrier applied declared
// value), and so the honest certainty state is persisted into selected_rate_json.
import { resolveInsuranceCertainty, isShippBrokered } from './shipping-workflow/insurance-certainty';
import { loadShippingAutomationRules } from './shipping-automation';

// Batch-label callers don't carry a panel-selected package, so customPackageId
// is often null. When dims are present, fall back to the same ±0.1" tolerance
// that /packages/auto-create uses to find an existing package — without this,
// the package's stock_qty never decrements for batch-issued labels and the
// PACKAGES section count stays flat regardless of how many labels go out.
async function resolveLabelPackageId(args: {
  orderId: number | null;
  customPackageId?: number | string | null;
  length: number | null;
  width: number | null;
  height: number | null;
}): Promise<number | null> {
  // PS-221 (slice 2, Per user override unlock shipped data on 2026-06-13): delegate
  // to the unified resolver so label-time package selection follows the SAME
  // precedence as billing (PS-207) + import (PS-205): operator pick → the order's
  // canonical selected_package_id → dims ±0.1" match. Previously this dims-guessed
  // in isolation, ignoring the order's already-resolved box (e.g. on batch labels).
  return resolveOrderLabelPackageId(args);
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

// PS-211: void outcomes are structured statuses, not throw-strings. 'voided'
// and 'already_voided' are success-shaped (idempotent); 'not_supported',
// 'not_voidable', and 'provider_failed' leave the LOCAL record untouched on
// purpose — local void state is applied only after the provider void succeeds.
export type VoidLabelResponseDto = {
  success: boolean;
  status: LabelVoidOutcomeStatus;
  provider: string;
  message: string;
  shipmentId: number;
  orderNumber: string | null;
  voided: boolean;
  voidedAt: string | null;
  trackingNumber: string | null;
  refundAmount: number | null;
  refundInitiated: boolean;
  refundEstimate: string | null;
  note: string | null;
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
}, recipientOverride?: unknown | null): ShipstationAddressInput {
  const raw = rawOrder.raw ?? {};
  const shipTo = (raw.shipTo as Record<string, unknown> | undefined) ?? {};
  const resolved = resolveRecipientForShipping({
    override: recipientOverride,
    rawShipTo: shipTo,
    fallback: {
      name: rawOrder.shipToName,
      city: rawOrder.shipToCity,
      state: rawOrder.shipToState,
      postalCode: rawOrder.shipToPostalCode,
    },
  });
  const address = resolved.address;
  return {
    name: address.name,
    company: address.company ?? undefined,
    street1: address.street1,
    street2: address.street2 ?? undefined,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? undefined,
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

// PS-136 (Per user override unlock shipped data on 2026-06-09): removed the dead
// createLabelFromRate() + CreateFromRateInput — 0 callers repo-wide, not under any keep-decision.
// persistLabelFromRate (below) is RETAINED: it is still reachable from createLabelFromShipment /
// createLabelFromOrderId, which carry recorded keep-decisions (parity/_v4-only.md:1227), so the
// shipstation-label-url-guard still finds its asserted normalization string there. No behavior
// change to any live path.

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
  await ensureShipmentsSelectedRateCostColumn();
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
      // Per user override unlock shipped data on 2026-07-06: PS-381 stamps the
      // selected/purchased shipment cost SOT on new legacy ShipStation label rows.
      selectedRateCost: label.shipment_cost.amount.toFixed(2),
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
// PS-261 (2026-06-19): it ALSO does not run the HUGRAB label-purchase preflight
// (resolveHugrabLabelPurchasePreflight). Confirmed NO active caller (only the
// commented-out createLabelBatch). If revived, add the PS-261 preflight gate here too,
// or a HUGRAB order could buy a real label bypassing the $100-coverage block.
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

export async function lookupLabel(lookup: string, scope: ClientStoreScope) {
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
  // PS-233: a restricted caller only sees shipments within its scope. Resolve the
  // owning orders' client/store once and filter (shipment.clientId is the primary
  // axis; the order's store covers store-scoped principals + legacy null clientId).
  if (!scope.isRestricted) return rows;
  const orderIds = Array.from(
    new Set(rows.map((r) => r.orderId).filter((x): x is number => x != null)),
  );
  const owners = orderIds.length
    ? await db
        .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
        .from(orders)
        .where(inArray(orders.id, orderIds))
    : [];
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  return rows.filter((r) => {
    const owner = r.orderId != null ? ownerById.get(r.orderId) : undefined;
    return isResourceInScope(scope, {
      clientId: r.clientId ?? owner?.clientId ?? null,
      storeId: owner?.storeId ?? null,
    });
  });
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

// PS-233 (Per user override unlock shipped data on 2026-06-13): enforce caller
// scope on a shipment-keyed label operation. A restricted principal may only act
// on a shipment whose owning client/store is in its scope; otherwise we throw the
// SAME not-found message the route maps to 404, so a cross-tenant probe is
// indistinguishable from a missing record. Read-only — no shipped/cancelled
// mutation happens here; this gates the existing void/return/retrieve paths.
async function assertShipmentInScope(
  row: { clientId: number | null; orderId: number | null },
  scope: ClientStoreScope,
  notFoundMessage = 'Shipment not found',
): Promise<void> {
  if (!scope.isRestricted) return;
  if (row.clientId != null && scope.clientIds.includes(Number(row.clientId))) return;
  // Resolve the owning order's client/store (covers store-scoped principals and
  // legacy shipments whose clientId was never backfilled).
  if (row.orderId != null) {
    const [owner] = await db
      .select({ clientId: orders.clientId, storeId: orders.storeId })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .limit(1);
    if (owner && isResourceInScope(scope, { clientId: owner.clientId, storeId: owner.storeId })) {
      return;
    }
  }
  throw new ResourceScopeError(notFoundMessage);
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
  const payload: Record<string, unknown> = {
    carrierProvider: 'shipstation',
    carrierAccountId: created.providerAccountId,
    shipStationShipmentId: created.shipmentId,
    notifyCustomer: false,
    notifyMarketplace: true,
    // PS-262a: the per-marketplace IDENTITY (storeAccountId, purchaseOrderId/
    // ebayOrderId, rawOrder, lineItems) now comes from the single canonical owner so
    // the label path and the direct/recovery paths build it identically.
    ...buildMarketplaceConfirmationIdentity(provider, order),
  };

  // Label-derived fields stay here (they need `created`, which only the label path has).
  if (provider === 'walmart') {
    payload.carrierName = carrierNameForMarketplace(created.carrierCode);
    payload.trackingUrl = trackingUrlForCarrier(created.carrierCode, created.trackingNumber) || undefined;
    payload.serviceCode = created.serviceCode;
  }
  if (provider === 'ebay') {
    payload.shippingCarrierCode = carrierNameForMarketplace(created.carrierCode);
    payload.serviceCode = created.serviceCode;
  }

  return payload;
}

async function loadOrderDimsOverride(orderId: number) {
  await ensureOrderRecipientOverrideSchema();
  const [row] = await db
    .select()
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, orderId))
    .limit(1);
  return row ?? null;
}

async function loadOrderRecipientOverride(orderId: number) {
  const row = await loadOrderDimsOverride(orderId);
  return recipientOverrideFromRecord(row?.recipientOverride);
}

function serviceCodeFitsPackage(_: string): string {
  return 'package';
}

// PS-248 (Per user override unlock shipped data on 2026-06-16): a drizzle transaction handle so
// persistCreatedLabel + markOrderShipped can COMMIT ATOMICALLY — a crash between them must not leave an
// orphan shipment row with the order still not-shipped (torn state, broken invariant). Falls back to
// the pool (db) when no tx is supplied, so existing non-transactional callers are unchanged.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  tx?: DbTx;
}): Promise<number> {
  const { created } = args;
  const exec = (args.tx ?? db) as DbTx;
  const createdAt = new Date();
  const shipDate = created.shipDate ? new Date(created.shipDate) : createdAt;
  // PS-108: ShipStation bills the ParcelGuard premium separately (created.insuranceCost,
  // from the v2 label `insurance_cost`). Persist it in `otherCost` and record the full
  // breakdown in `selectedRateJson` so the insured total is recoverable and auditable.
  // `cost`/`labelCost` stay postage-only so existing billing semantics are unchanged;
  // the billed total is cost + otherCost (mirrors ShipStation v1 shipmentCost+otherCost).
  const insuranceProvider = String(args.insuranceProvider ?? 'none').trim().toLowerCase();
  const insuredValue = Number(args.insuredValue ?? 0) || null;
  // PS-214: direct-carrier connectors do not bill/report a ParcelGuard premium
  // (it is third-party coverage) — a parcelguard-insured direct label persists
  // the PS-171 schedule premium so the shipment's audit trail and billed total
  // carry the real coverage cost instead of $0 (the order-#1476 class:
  // otherCost=0.00 and no insurance fields on a "insured" Shipp/FedEx label).
  // Carrier declared value within the free tier is genuinely $0 (confirmed).
  const reportedInsuranceCost = Number(created.insuranceCost ?? 0);
  const scheduledPremium =
    insuranceProvider === 'parcelguard' && reportedInsuranceCost <= 0 && insuredValue != null
      ? parcelGuardScheduledPremium(insuredValue, {
          carrier_code: created.carrierCode ?? null,
          service_code: created.serviceCode ?? null,
        }) ?? 0
      : 0;
  const insuranceCost = reportedInsuranceCost > 0 ? reportedInsuranceCost : scheduledPremium;
  // PS-274 (Per user override unlock shipped data on 2026-06-17): identity FIRST. A Shipp-brokered
  // label (provider 'shipp' / "Shipp" nickname / `shipp_` service code) is NEVER a direct verified
  // carrier — its declared value is requested-but-unproven. Resolve the honest certainty so it is
  // persisted AND so the provenance below can never claim carrier_declared_value for a brokered Shipp.
  const insuranceCertainty = resolveInsuranceCertainty({
    provider: insuranceProvider === 'carrier' ? 'carrier' : created.carrierCode ?? null,
    accountIdentity: created.providerAccountNickname ?? null,
    serviceCode: created.serviceCode ?? null,
    insuredValue,
    insuranceCost,
    isDirectVerifiedAccount: insuranceProvider === 'carrier' && !isShippBrokered({
      provider: created.carrierCode ?? null,
      accountIdentity: created.providerAccountNickname ?? null,
      serviceCode: created.serviceCode ?? null,
    }),
  });
  // PS-261 (Per user override unlock shipped data on 2026-06-17): consume the REAL EasyPost
  // insurance fee. createLabelEasyPost emits the billed fee (parseEasyPostInsuranceCost) onto
  // created.insuranceCost via the direct path; bill it as otherCost with provenance 'easypost'
  // instead of 0/shipstation. Detected identity-first by the EasyPost carrier code. The parser
  // returns null/0 when unpriced, so reportedInsuranceCost>0 already gates "only when present".
  const isEasyPostBilled =
    reportedInsuranceCost > 0 && String(created.carrierCode ?? '').trim().toLowerCase() === 'easypost';
  // PS-274: a Shipp-brokered label can NEVER be carrier_declared_value (the #1502 dishonesty class).
  const shippBrokered = isShippBrokered({
    provider: created.carrierCode ?? null,
    accountIdentity: created.providerAccountNickname ?? null,
    serviceCode: created.serviceCode ?? null,
  });
  const insuranceProvenance =
    isEasyPostBilled
      ? 'easypost'
      : reportedInsuranceCost > 0
        ? 'shipstation_v2_label'
        : scheduledPremium > 0
          ? 'parcelguard_schedule'
          : insuranceProvider === 'carrier' && !shippBrokered
            ? 'carrier_declared_value'
            : 'none';
  const [row] = await exec
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
      otherCost: insuranceCost.toFixed(2),
      // PS-370: the persisted normalized selected/label total = postage + other,
      // identical to selectedRateJson.totalCost below and to what every reader
      // derives for this row (byte-consistent by construction).
      selectedRateCost: Number((created.cost + insuranceCost).toFixed(2)).toFixed(2),
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
      // Per user override unlock shipped data on 2026-06-17 (PS-273): persist the
      // REAL account nickname captured at purchase (direct: the loaded account's
      // label or "Shipp" for Shipp-brokered; ShipStation: resolveCarrierNickname).
      // This is the stored source of truth the DTO/readers consume FIRST
      // (orders.ts ship.provider_account_nickname), so a Shipp label can no longer
      // fall through to a fabricated direct UPS account (GG6381). Falls back to
      // null when a producer didn't set it (existing behavior unchanged).
      providerAccountNickname: created.providerAccountNickname ?? null,
      selectedPackageId: args.selectedPackageId,
      selectedRateJson: {
        providerAccountId: created.providerAccountId,
        shippingProviderId: created.providerAccountId,
        providerAccountNickname: created.providerAccountNickname ?? null,
        carrierCode: created.carrierCode,
        serviceCode: created.serviceCode,
        serviceName: created.serviceCode,
        cost: created.cost,
        shipmentCost: created.cost,
        otherCost: insuranceCost,
        // PS-108/PS-214 insured-total audit: postage + premium = billed total,
        // persisted even when valid carrier declared value costs $0.00.
        insuranceProvider,
        insuredValue,
        insuranceCost,
        insuranceProvenance,
        // PS-274: persist the honest certainty state into the audit JSON so a Shipp-brokered
        // label's "requested_application_uncertain" coverage is recoverable downstream (never a
        // fabricated carrier_declared_value). Display/audit only — does not affect billed totals.
        insuranceCertainty: insuranceCertainty.certainty,
        insuranceCertaintyProofSource: insuranceCertainty.proofSource,
        totalCost: Number((created.cost + insuranceCost).toFixed(2)),
        // PS-211: the provider-NATIVE label id (string — direct carriers don't
        // use ShipStation's numeric id space). This is the identity a future
        // provider void dispatches on; labelShipmentId can be a locally
        // synthesized number for direct labels and must not be sent to a
        // provider.
        providerLabelId: created.labelId ?? null,
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
  options: { cleanupQueue?: boolean; tx?: DbTx } = {}
): Promise<void> {
  // PS-248: run on the caller's transaction when supplied so the order-status flip + tracking
  // override commit ATOMICALLY with the shipment insert (and atomically with each other).
  const exec = (options.tx ?? db) as DbTx;
  await exec
    .update(orders)
    .set({ orderStatus: 'shipped', updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  if (trackingNumber) {
    await exec
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
    // NOTE: the bundle MEMBER deduct-once fan-out (PS-312 S6) is NOT here — it is chained AFTER the
    // link keystone in createLabelV2Impl, so it can never race the bundle stamp into a silent
    // under-deduct. This trigger only deducts the primary's own inventory.
  } catch (err) {
    console.warn('[labels] fulfillment deduction failed:', err);
  }
}

/**
 * Create a label (v2-parity). Supports offline testLabel mode (generates a
 * mock PDF with no ShipStation interaction) and real ShipStation creation.
 */
// PS-248 (Per user override unlock shipped data on 2026-06-16): serialize concurrent label PURCHASES
// per order so a double-click / double-request can't buy two labels (double postage) for the same
// order. The per-order advisory lock is NON-BLOCKING — a second in-flight buy for the same order is
// rejected immediately with LABEL_PURCHASE_IN_PROGRESS, not queued. Every existing guard (PS-233
// scope, editable, PS-128/129 safe-to-ship) + the buy + persist run UNCHANGED inside the impl; this
// is pure serialization with no shipped/cancelled mutation. The concurrent behavior is verified by a
// live canary — offline cert cannot simulate two simultaneous buys.
export async function createLabelV2(
  body: CreateLabelInputDto,
  scope: ClientStoreScope,
): Promise<CreateLabelResponseDto> {
  // No orderId → let the impl throw the canonical validation error (nothing to lock on).
  if (!body.orderId) return createLabelV2Impl(body, scope);
  const purchaseLock = await acquireLabelPurchaseLock(body.orderId);
  try {
    return await createLabelV2Impl(body, scope);
  } finally {
    await purchaseLock.release();
  }
}

async function createLabelV2Impl(
  body: CreateLabelInputDto,
  scope: ClientStoreScope,
): Promise<CreateLabelResponseDto> {
  if (!body.orderId || !body.serviceCode) {
    throw new Error('orderId and serviceCode required');
  }

  const timer = createLabelTimer(body.orderId);
  await timer.task('fulfillment schema readiness', () => ensureFulfillmentSchema());
  const order = await timer.task('order load', () => loadOrderRecord(body.orderId));
  if (!order) throw new Error('Order not found');
  // PS-233 (Per user override unlock shipped data on 2026-06-13): a restricted
  // caller may only buy postage on an order within its scope. Out-of-scope → the
  // same "Order not found" 404 (no cross-tenant existence leak). Runs before any
  // postage/label side effect. No shipped/cancelled mutation.
  assertResourceInScope(scope, { clientId: order.clientId, storeId: order.storeId }, 'Order not found');
  if (order.orderStatus === 'shipped' || order.orderStatus === 'cancelled') {
    // PS-190: structured conflict code — the FE branches on `code`, not the message.
    const err = new Error(`Cannot create label for ${order.orderStatus} order`) as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    err.code = 'ORDER_NOT_EDITABLE';
    err.details = { orderStatus: order.orderStatus };
    throw err;
  }
  // PS-128 + PS-129: backend-owned shipping-safety guard. Hard-blocks BEFORE any label or
  // postage side effect when the order was already shipped externally/upstream (PS-128
  // duplicate) or cancelled upstream (PS-129) — even if local sync, the webhook, or the
  // frontend is stale. Runs for BOTH the offline test path and the real-postage path (a
  // test label still marks the order shipped, which must not happen on a cancelled/
  // externally-shipped order). Definite signals always block; the unverifiable-high-risk
  // case is audit-only by default (SHIPPING_SAFETY_UNVERIFIED_POLICY).
  // Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): reads
  // shipped/cancelled signals to block; does not mutate shipped/cancelled rows.
  await assertOrderSafeToShip(order, { entryPoint: 'createLabelV2' });

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
  // PS-214 belt-and-braces: a HUGRAB label may NEVER buy uninsured. With the
  // widened resolveEffectiveInsurance this is unreachable for purchasable
  // services (Ground Saver/SurePost is blocked by eligibility below), but if
  // a future resolver edit narrows coverage again this throws BEFORE postage
  // instead of silently shipping bare (the order-#1476 class).
  if (
    isHugrabShippingContext({ clientId, storeId: order.storeId ?? null }) &&
    options.insuranceProvider === 'none' &&
    body.testLabel !== true &&
    !isUpsGroundSaverOrSurePostService(serviceDescriptor)
  ) {
    const err = new Error(
      'HUGRAB orders require $100 coverage on every label — the resolved insurance came back none, so no postage was purchased. Re-rate the order; if this repeats, the insurance resolver is misconfigured.'
    ) as Error & { code?: string };
    err.code = 'HUGRAB_INSURANCE_REQUIRED';
    throw err;
  }
  await assertLabelServiceEligibleForOrder(order, clientId, serviceDescriptor, options);
  // PS-186 — canonical test-label authority (test-label-policy.ts). isTest clients are
  // FORCED into offline-mock (a test row never spends real postage); a `testLabel: true`
  // request for a REAL client is REJECTED with a structured 409 (TEST_LABEL_REJECTED)
  // instead of silently minting a fake label/tracking on a real customer order. Runs
  // BEFORE every consumption of the flag (rate-limit skip, weight default, mock branch).
  body = {
    ...body,
    testLabel: await resolveEffectiveTestLabel({
      clientId,
      requestedTestLabel: body.testLabel === true,
      orderId: order.id,
      entryPoint: 'createLabelV2',
    }),
  };
  if (clientId && !body.testLabel) checkLabelRateLimit(clientId);

  const existing = await timer.task('existing-label check', () => findActiveLabelForOrder(order.id));
  if (existing) {
    // PS-190: structured conflict code — the FE branches on `code`, not the message.
    const err = new Error('Label already exists for this order') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    err.code = 'LABEL_EXISTS';
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

  const fallbackShipTo = orderShipToFromRaw(order, overrides?.recipientOverride);
  const shipTo = mergeAddress(body.shipTo, fallbackShipTo);
  // PS-127: the label is the authoritative rate↔label parity point. Classify
  // residential/commercial from the order's OWN evidence (operator override >
  // ShipStation source flag > weak company heuristic) — never a frontend-sent value —
  // then apply the shipping consumption policy and stamp the indicator so the label is
  // billed under the SAME classification the rate was quoted under. `overrides` (with the
  // manual residential override) and `order.raw.shipTo` are already loaded above, so this
  // adds no DB round-trip.
  const rawShipTo = ((order.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
  const labelClassification = classifyShippingAddress({
    orderId: order.id,
    clientId,
    storeId: order.storeId ?? null,
    shipTo: {
      name: shipTo.name,
      company: shipTo.company,
      city: shipTo.city,
      state: shipTo.state,
      postalCode: shipTo.postalCode,
      country: shipTo.country,
    },
    manualOverrideResidential:
      typeof overrides?.residential === 'boolean' ? overrides.residential : null,
    sourceResidential:
      typeof rawShipTo.residential === 'boolean' ? (rawShipTo.residential as boolean) : null,
  });
  const labelResidential = residentialForShipping(labelClassification);
  shipTo.residential = labelResidential;
  const carrierRecipient = resolveCarrierRecipientName({
    name: shipTo.name,
    company: shipTo.company,
    customerEmail: order.customerEmail,
  });
  const carrierShipTo: ShipstationAddressInput = {
    ...shipTo,
    name: carrierRecipient.name,
    company: carrierRecipient.company,
  };
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
    orderId: body.orderId ?? null,
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
    await ensureShipmentsSelectedRateCostColumn();
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
        // Per user override unlock shipped data on 2026-07-06: PS-381 stamps
        // the selected-rate SOT even for offline/test shipment rows with $0 proof.
        selectedRateCost: '0.00',
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
    // PS-204: bind the proof to the account being CHARGED. A payload naming a
    // direct synthetic id while the proof rate belongs to ShipStation (or any
    // cross-account pair) is blocked here, before either family's provider
    // call — this gate runs ahead of BOTH the direct branch and the
    // ShipStation branch.
    purchaseShippingProviderId: body.shippingProviderId,
  });
  // PS-261 (Per user override unlock shipped data on 2026-06-18): HUGRAB label-purchase
  // coverage preflight — a backend-owned BLOCK that runs BEFORE either provider purchase
  // call (direct or ShipStation). It DELEGATES to the PS-290 coverage owner + PS-274
  // certainty + the pure PS-261 gate: a HUGRAB rate whose mandatory $100 coverage is
  // unproven/missing/unsupported (e.g. a Shipp-brokered declared value with no direct
  // proof) is blocked here, so no postage is bought on uncovered coverage. ALLOWs verbatim
  // on a proven-included rate or a non-HUGRAB row — it NEVER alters a successful buy.
  //
  // The ParcelGuard premium is only billed AFTER purchase, but the rate-time SCHEDULE premium
  // (the same one persisted on a bought ParcelGuard label) is knowable now — it is the positive
  // premium proof PS-290 reads for 'included'. A direct-carrier-declared-value account resolves to
  // provider 'carrier' (PS-170) and earns 'included' via certainty instead.
  const preflightInsuredValue = Number(options.insuredValue ?? 0) || 0;
  const preflightScheduledPremium =
    options.insuranceProvider === 'parcelguard' && preflightInsuredValue > 0
      ? parcelGuardScheduledPremium(preflightInsuredValue, {
          carrier_code: body.carrierCode ?? null,
          service_code: body.serviceCode,
        }) ?? 0
      : 0;
  const preflightProvider = body.carrierCode ?? serviceDescriptor.provider ?? null;
  const preflightAccountIdentity = body.carrierName ?? null;
  const preflightServiceCode = body.serviceCode;
  const hugrabCoveragePreflight = resolveHugrabLabelPurchasePreflight({
    isHugrab: isHugrabShippingContext({ clientId, storeId: order.storeId ?? null }),
    insuranceProvider: options.insuranceProvider,
    insuredValue: options.insuredValue,
    insuranceCost: preflightScheduledPremium,
    insuranceProvenance: preflightScheduledPremium > 0 ? 'parcelguard_schedule' : null,
    provider: preflightProvider,
    accountIdentity: preflightAccountIdentity,
    serviceCode: preflightServiceCode,
    isDirectVerifiedAccount: options.insuranceProvider === 'carrier',
    insuranceCoverageProofSource: resolveShippCustomsValueProofSource({
      enabled: hugrabShippCustomsValueProofEnabled(),
      provider: preflightProvider,
      accountIdentity: preflightAccountIdentity,
      serviceCode: preflightServiceCode,
      insuredValue: options.insuredValue,
    }),
  });
  if (hugrabPurchaseGateEnabled() && !hugrabCoveragePreflight.allow) {
    const err = new Error(
      `HUGRAB $100 insurance coverage is not proven on this rate (${hugrabCoveragePreflight.status}) — ` +
        `${hugrabCoveragePreflight.reason} No postage was purchased. Re-rate the order on an account that ` +
        `proves the $100 coverage, then buy the label.`,
    ) as Error & { code?: string; details?: Record<string, unknown> };
    err.code = 'HUGRAB_INSURANCE_COVERAGE_UNPROVEN';
    err.details = {
      coverageStatus: hugrabCoveragePreflight.status,
      insuranceCoverageProofSource: hugrabCoveragePreflight.insuranceCoverageProofSource,
    };
    throw err;
  }
  // PS-127 rate↔label parity guard: if the order classifies as TRUSTED residential/commercial
  // (operator override, provider/source flag, or validated business) but the selected rate
  // was quoted under the OPPOSITE residential bit, the quote won't match the bill — block
  // before spending postage and force a re-rate. Weak/auto/unknown cases align silently to
  // the classification (no false blocks on the common residential path). Only the legacy
  // carried proof exposes the per-rate fingerprint; the snapshot path is coherence-checked
  // above and skipped here when no selectedRate fingerprint is present.
  const quotedResidential = residentialFromRequestFingerprint(
    selectedRateRequestFingerprint(body.selectedRateProof?.selectedRate),
  );
  const labelTrusted =
    labelClassification.confidence === 'manual' ||
    labelClassification.confidence === 'source' ||
    labelClassification.confidence === 'validated';
  if (labelTrusted && quotedResidential !== null && quotedResidential !== labelResidential) {
    const err = new Error(
      `Rate/label residential mismatch: address classifies ${labelClassification.classification} ` +
        `(${labelClassification.source}) but the selected rate was quoted ` +
        `${quotedResidential ? 'residential' : 'commercial'}. Re-rate this order before buying the label.`,
    ) as Error & { code?: string };
    err.code = 'RATE_LABEL_RESIDENTIAL_MISMATCH';
    throw err;
  }
  if (!body.shippingProviderId) {
    throw new Error('shippingProviderId required for v2 label creation');
  }
  // PS-202: direct carrier-account purchases (synthetic 10M+/20M+ provider ids:
  // Shipp, Walmart Shipping, direct UPS, EasyPost) are now v4-owned. The SAME
  // proof gate, shipping-safety, residential parity, and eligibility asserts
  // above already ran; the SAME persistence/deduction/confirmation tail below
  // runs unchanged — only the connector call differs. This retires the legacy
  // Vercel api/carriers/labels path (deleted by PS-200), which skipped
  // inventory/package deduction entirely.
  const directRef = directLabelAccountRefFromProviderId(body.shippingProviderId);
  let created: CreatedExternalLabel;
  let directWalmartContext: Awaited<ReturnType<typeof createDirectCarrierLabelForOrder>>['walmartContext'] = null;
  let directProviderKey: string | null = null;
  if (directRef) {
    // PS-106: this is the DIRECT family purchase boundary.
    await assertCarrierFamilyEligibleForPurchase({
      carrierFamily: 'direct',
      order,
      orderId: order.id,
    });
    const account = await loadDirectAccountForLabel(directRef, {
      clientId: clientId ?? null,
      storeId: order.storeId ?? null,
    });
    directProviderKey = normalizeProviderKey(account.provider);
    const direct = await timer.task(`direct ${directProviderKey} createLabel connector`, () =>
      createDirectCarrierLabelForOrder({
        account,
        providerAccountId: Number(body.shippingProviderId),
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        externalOrderId: order.externalOrderId ?? null,
        clientId: clientId ?? null,
        storeId: order.storeId ?? null,
        serviceCode: body.serviceCode,
        serviceName: body.serviceName ?? null,
        weightOz: effectiveWeightOz,
        length,
        width,
        height,
        shipTo: carrierShipTo,
        shipFrom,
        shippingOptions: options,
        rawOrder: order.raw ?? null,
        // PS-202 verification seam, double-gated: this flag only has an effect
        // when CARRIER_TEST_MODE is ALSO set in the process env (see
        // carrier-test-mode.ts) — production never arms the env, so a stray
        // client-sent flag is inert. With both gates armed, the orchestrator
        // routes the connector call through the $0 sandbox/replay path
        // (assertNoLivePostageOrMarketplace enforced) while THIS pipeline —
        // proof gate, PS-204 account binding, family/scope asserts, persist
        // tail — runs exactly as production.
        carrierTestMode: (body as Record<string, unknown>).__carrierTestMode === true,
      }),
    );
    created = direct.created;
    directWalmartContext = direct.walmartContext;
  } else {
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
    created = await timer.task('ShipStation createLabel connector', async () => {
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
        shipTo: carrierShipTo,
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
    // Per user override unlock shipped data on 2026-06-17 (PS-273): stamp the
    // ShipStation account's REAL nickname at purchase time so the shipment row
    // records account identity. resolveCarrierNickname resolves the synthetic
    // provider id / 1Z tracking against the live SS carriers list; persisting it
    // here means readers consume stored truth instead of re-deriving (and
    // mis-deriving) account identity from carrier family.
    created.providerAccountNickname =
      (await resolveCarrierNickname(
        created.providerAccountId,
        created.carrierCode,
        created.trackingNumber,
        clientId ?? null,
      )) ?? created.providerAccountNickname ?? null;
  }

  // PS-370: ensure the additive selected_rate_cost column exists BEFORE the
  // shipment-insert transaction opens. Running the ADD COLUMN (ACCESS EXCLUSIVE)
  // here — outside the tx, on the raw connection — avoids a lock/deadlock against
  // the tx's shipments INSERT. Memoized: real DDL only on the first label after a
  // deploy, then a no-op (and a no-op once migration 0054 is applied).
  await ensureShipmentsSelectedRateCostColumn();
  // PS-248 (Per user override unlock shipped data on 2026-06-16): persist the shipment AND flip the
  // order to 'shipped' in ONE transaction, so a crash between them can't orphan a shipment row while
  // the order stays awaiting (torn state / broken invariant). The external label buy already happened
  // above; this txn is DB-only + short. recordFulfillmentDeductions (below) stays its own unit.
  const localShipmentId = await db.transaction(async (tx) => {
    const shipmentId = await timer.task('persistCreatedLabel', () => persistCreatedLabel({
      created,
      orderId: order.id,
      orderNumber: order.orderNumber ?? null,
      clientId: clientId ?? null,
      effectiveWeightOz,
      length,
      width,
      height,
      // PS-221 (Per user override unlock shipped data on 2026-06-13): persist the
      // package that was actually RESOLVED + deducted (resolvedPackageId, line ~1482),
      // not the raw body.customPackageId. Previously the real path dropped the
      // dims-matched package (selected_package_id NULL on ~99.5% of shipments), so the
      // box deducted ≠ billed ≠ displayed. The test path (above) already did this.
      // Forward-only: no backfill of historical NULLs.
      selectedPackageId: resolvedPackageId != null ? String(resolvedPackageId) : null,
      // PS-202: direct purchases keep the legacy source attribution (shipments
      // rows showed source='shipp'/'walmart_shipping') so billing/queries match.
      source: directProviderKey ?? 'prepship_v2',
      insuranceProvider: options.insuranceProvider,
      insuredValue: options.insuredValue,
      tx,
    }));
    await timer.task('markOrderShipped', () => markOrderShipped(order.id, created.trackingNumber, { cleanupQueue: false, tx }));
    return shipmentId;
  });
  timer.background('inventory/package deduction', () => recordFulfillmentDeductions({
    order,
    shipmentId: localShipmentId,
    packageId: resolvedPackageId,
    source: 'label',
    timer,
  }));
  // PS-220 (realized house-margin): SHIPP is DRP's house carrier. After the committed ship txn, freeze
  // the captured margin into the order_competitive_rate sidecar — it READS the projected next-best stamp
  // (best_rate_json), never re-fetches. Best-effort + a SEPARATE write OUTSIDE the locked ship txn —
  // reads order.id/localShipmentId only, never UPDATEs shipments / shipped rows (lockdown-safe).
  if (directProviderKey === 'shipp') {
    timer.background('house-margin capture', () => captureRealizedHouseMargin({
      orderId: order.id,
      shipmentId: localShipmentId,
      clientId: clientId ?? null,
      drpCost: Number(created.cost ?? 0),
    }).catch((err) => console.warn('[labels] house-margin capture skipped:', err instanceof Error ? err.message : err)));
  }
  // PS-312 combined-shipment KEYSTONE (Per user override unlock shipped data on 2026-06-24): when the
  // bought order is a bundle PRIMARY, stamp the shared label facts onto the bundle so its child orders
  // resolve to the primary's real tracking (not "Shipment sync error") and the downstream bundle
  // policies (bill/deduct/confirm) can fire. Behind BUNDLE_LINK_ON_LABEL (default OFF -> byte-identical:
  // no query, no write). Best-effort + a SEPARATE write OUTSIDE the locked ship txn — reads order.id +
  // the already-bought label facts, advances only draft/labeled (linkBundleShipment's no-regression
  // guard), writes ONLY the additive shipment_bundles sidecar (never shipments / shipped order rows).
  // Buys no postage. Mirrors the house-margin capture above.
  if (env.BUNDLE_LINK_ON_LABEL) {
    timer.background('bundle link-on-label', () =>
      getBundleForOrder(order.id)
        .then(async (bundle) => {
          if (!bundle || bundle.role !== 'primary') return;
          await linkBundleShipment(bundle.bundleId, {
            primaryShipmentId: localShipmentId,
            trackingNumber: created.trackingNumber,
            carrierCode: created.carrierCode ?? null,
            serviceCode: created.serviceCode ?? null,
            labelUrl: created.labelUrl,
            labelShipmentId: created.shipmentId != null ? String(created.shipmentId) : null,
            packageId: resolvedPackageId,
          });
          // PS-312 S6 deduct-once: now that the bundle is stamped 'labeled' (the await above committed
          // it), deduct every OTHER member exactly once — CHAINED after the stamp in this SAME task so
          // it can never race the link into a silent under-deduct. Co-dependent on this keystone (it
          // requires BUNDLE_DEDUCT_ONCE too). Reuses the locked deductInventoryForOrder owner unchanged
          // (still INVENTORY_AUTO_DEDUCT-gated + ship-ledger idempotent). Buys no postage; never marks
          // orders shipped.
          if (env.BUNDLE_DEDUCT_ONCE) {
            await deductBundleMembersOnce(
              order.id,
              localShipmentId,
              (ids) => db.select().from(orders).where(inArray(orders.id, ids)),
              deductInventoryForOrder,
            );
          }
        })
        .catch((err) => console.warn('[labels] bundle link-on-label/deduct skipped:', err instanceof Error ? err.message : err)));
  }
  // Queue marketplace confirmation separately from label purchase. The label
  // response stays fast, while fulfillment_outbox owns retries and failure state.
  const confirmationProvider = confirmationProviderForOrder(order);
  let confirmationPayload = confirmationProvider
    ? marketplaceConfirmationPayload(order, created, confirmationProvider)
    : baseConfirmationPayload(created);
  // PS-202/PS-199: ShipStation-pulled Walmart orders have no purchaseOrderId in
  // order.raw — the live-verified PO from the labels-mode resolver feeds the
  // confirmation payload so the ship-confirm cannot fail like the PS-201 burst.
  if (directWalmartContext && confirmationProvider === 'walmart') {
    confirmationPayload = {
      ...confirmationPayload,
      ...(directWalmartContext.purchaseOrderId ? { purchaseOrderId: directWalmartContext.purchaseOrderId } : {}),
      ...(directWalmartContext.rawOrder != null ? { rawOrder: directWalmartContext.rawOrder } : {}),
      ...(directWalmartContext.storeAccountId != null ? { storeAccountId: String(directWalmartContext.storeAccountId) } : {}),
    };
  }
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

export async function createBatchV2(
  body: CreateBatchLabelInputDto,
  scope: ClientStoreScope,
): Promise<CreateBatchLabelResponseDto> {
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
          // PS-233: every order in the batch is scope-checked individually inside
          // createLabelV2 — an out-of-scope orderId fails as "Order not found".
        }, scope);
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
          // PS-186/PS-190: surface structured codes (e.g. TEST_LABEL_REJECTED) so batch
          // failures are machine-readable, not message-string sniffed.
          ...(err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
            ? { code: (err as { code: string }).code }
            : {}),
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
  recipientOverride?: unknown | null;
}) {
  const { order, clientId, serviceCode, recipientOverride } = args;
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
  const shipTo = resolveRecipientForShipping({
    override: recipientOverride,
    rawShipTo: shipToRaw,
    fallback: {
      name: order.shipToName,
      city: order.shipToCity,
      state: order.shipToState,
      postalCode: order.shipToPostalCode,
    },
  }).address;

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
      name: shipTo.name,
      street1: shipTo.street1,
      city: shipTo.city,
      state: shipTo.state,
      postalCode: shipTo.postalCode,
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

  await ensureShipmentsSelectedRateCostColumn();
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
      // Per user override unlock shipped data on 2026-07-06: PS-381 stamps
      // the selected-rate SOT even for offline/test shipment rows with $0 proof.
      selectedRateCost: '0.00',
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
  const recipientOverride = await loadOrderRecipientOverride(order.id);
  const shipTo = resolveRecipientForShipping({
    override: recipientOverride,
    rawShipTo: shipToRaw,
    fallback: {
      name: order.shipToName,
      city: order.shipToCity,
      state: order.shipToState,
      postalCode: order.shipToPostalCode,
    },
  }).address;
  const street1 = shipTo.street1;
  const city = shipTo.city;
  const state = shipTo.state;
  const postal = shipTo.postalCode;

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
  if (await loadClientIsTest(effectiveClientId)) {
    return await createMockShipmentForOrder({
      order,
      clientId: effectiveClientId!,
      serviceCode: args.serviceCode,
      recipientOverride,
    });
  }

  return createLabelFromShipment({
    orderId: args.orderId,
    clientId: args.clientId ?? order.clientId ?? undefined,
    weightOz: order.weightOz,
    serviceCode: args.serviceCode,
    shipTo: {
      name: shipTo.name,
      company_name: shipTo.company ?? undefined,
      address_line1: street1,
      address_line2: shipTo.street2 ?? undefined,
      city_locality: city,
      state_province: state,
      postal_code: postal,
      country_code: shipTo.country,
      phone: shipTo.phone ?? undefined,
    },
  });
}

// ── Void / Return / Retrieve ──────────────────────────────────────────────────

/**
 * PS-211 — universal, provider-aware label void.
 *
 * The previous implementation hardcoded ShipStation's void API for EVERY
 * label: a direct-carrier shipment (Shipp/Walmart Shipping/direct UPS/
 * EasyPost) would have its locally-synthesized labelShipmentId sent to
 * ShipStation as if it were an SS shipment id — and a row with NO
 * labelShipmentId skipped the provider entirely and was voided locally while
 * the postage stayed purchased at the provider.
 *
 * Now: resolveLabelVoidDispatch routes by the row's owning provider
 * (source column — the same attribution persistCreatedLabel writes), the
 * orchestrator's capability check classifies honest 'not_supported', and the
 * LOCAL void state is applied ONLY after the provider void succeeds (or for
 * test/local rows that have no provider label). Provider failure leaves the
 * row active and reports 'provider_failed' — never a silent local void.
 */
export async function voidLabelV2(
  shipmentId: number,
  scope: ClientStoreScope,
): Promise<VoidLabelResponseDto> {
  const [row] = await db
    .select()
    .from(shipments)
    .where(or(eq(shipments.id, shipmentId), eq(shipments.labelShipmentId, shipmentId)))
    .limit(1);
  if (!row) throw new Error('Shipment not found');
  // PS-233: a restricted caller may not void another tenant's label.
  await assertShipmentInScope(row, scope);

  // Double guard: honor the explicit test_offline source marker AND verify
  // the shipment's client isn't flagged is_test (in case a test row was
  // somehow persisted with a real labelShipmentId).
  const clientIsTest = await loadClientIsTest(row.clientId);
  const selectedRate = (row.selectedRateJson ?? null) as Record<string, unknown> | null;
  const dispatch = resolveLabelVoidDispatch({
    source: row.source ?? null,
    labelShipmentId: row.labelShipmentId ?? null,
    voided: !!row.voided,
    trackingNumber: row.trackingNumber ?? null,
    providerLabelId:
      selectedRate && typeof selectedRate.providerLabelId === 'string' ? selectedRate.providerLabelId : null,
    clientIsTest,
  });

  const baseResponse = {
    shipmentId: row.id,
    orderNumber: row.orderNumber,
    trackingNumber: row.trackingNumber,
  };
  const failureShape = (status: LabelVoidOutcomeStatus, provider: string, message: string): VoidLabelResponseDto => ({
    success: false,
    status,
    provider,
    message,
    ...baseResponse,
    voided: false,
    voidedAt: null,
    refundAmount: null,
    refundInitiated: false,
    refundEstimate: null,
    note: null,
  });

  if (dispatch.kind === 'already_voided') {
    return {
      success: true,
      status: 'already_voided',
      provider: String(row.source ?? 'shipstation'),
      message: 'Label was already voided — nothing to do.',
      ...baseResponse,
      voided: true,
      voidedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      refundAmount: null,
      refundInitiated: false,
      refundEstimate: null,
      note: null,
    };
  }

  if (dispatch.kind === 'not_voidable') {
    return failureShape('not_voidable', String(row.source ?? 'unknown'), dispatch.reason);
  }

  let provider = 'test_offline';
  if (dispatch.kind === 'provider') {
    provider = dispatch.provider;
    if (!carrierConnectorSupportsVoid(dispatch.provider)) {
      return failureShape('not_supported', dispatch.provider, voidNotSupportedMessage(dispatch.provider));
    }
    try {
      const creds =
        dispatch.provider === 'shipstation' ? await loadClientCredentials(row.clientId) : null;
      await voidCarrierLabel(dispatch.provider, {
        labelId: dispatch.voidKey,
        trackingNumber: row.trackingNumber ?? null,
        ...(creds?.apiKeyV2 ? { apiKeyV2: creds.apiKeyV2 } : {}),
      } as Parameters<typeof voidCarrierLabel>[1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      // The provider refused or errored — the label is still purchased there,
      // so the local record stays ACTIVE (no silent local void).
      return failureShape(
        'provider_failed',
        dispatch.provider,
        `${dispatch.provider} void failed: ${message}. The label remains active locally — retry once the provider issue is resolved.`,
      );
    }
  }

  // Provider void succeeded (or this is a test/local row with no provider
  // label) — NOW record the local void state and free the order for a new label.
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

  // PS-263 (Per user override unlock shipped data on 2026-06-14): a void must retract the
  // marketplace confirmation. Cancel every not-yet-sent confirmation for this order so it
  // can't fire with the now-dead tracking, and stamp the shipment's confirmation lifecycle.
  // Best-effort: the single local void write above already succeeded (PS-211 invariant) and
  // must not be undone if this retract misses.
  try {
    await cancelShipmentConfirmationsForVoid({ orderId: row.orderId ?? null, shipmentId: row.id });
  } catch (retractErr) {
    console.warn(
      `[voidLabelV2] confirmation retract failed shipmentId=${row.id} orderId=${row.orderId ?? 'null'}:`,
      retractErr,
    );
  }

  return {
    success: true,
    status: 'voided',
    provider,
    message:
      dispatch.kind === 'local_test'
        ? 'Test label voided locally (no provider label exists).'
        : `Label voided at ${provider}.`,
    ...baseResponse,
    voided: true,
    voidedAt: now.toISOString(),
    refundAmount: row.labelCost ? Number(row.labelCost) : null,
    refundInitiated: dispatch.kind === 'provider',
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
  body: { reason?: string } = {},
  scope: ClientStoreScope,
): Promise<ReturnLabelResponseDto> {
  const [row] = await db
    .select()
    .from(shipments)
    .where(or(eq(shipments.id, shipmentId), eq(shipments.labelShipmentId, shipmentId)))
    .limit(1);
  if (!row) throw new Error('Shipment not found');
  // PS-233: a restricted caller may not create a return on another tenant's shipment.
  await assertShipmentInScope(row, scope);
  if (!row.labelShipmentId) throw new Error('Cannot create return — no ShipStation shipment id on record');

  // Block real-postage returns for test-client shipments. createLabelV2
  // forces testLabel=true for isTest clients, but returns go through a
  // separate SS endpoint — without this check a test shipment with a real
  // labelShipmentId (edge case) would burn real postage.
  if (await loadClientIsTest(row.clientId)) {
    throw new Error('Cannot create return label for a test-client shipment');
  }

  const creds = await loadClientCredentials(row.clientId);
  const reason = body.reason || 'Customer Return';
  // PS-261 GATE SCOPE — return labels are EXEMPT from the HUGRAB $100 forward-coverage
  // gate BY DESIGN (DJ-confirmed 2026-06-19): the mandate applies to FORWARD shipping
  // labels (createLabelV2 + batch + print-queue), not to inbound return postage, which
  // carries no rate/insurance selection. So resolveHugrabLabelPurchasePreflight is NOT
  // run here. If HUGRAB returns ever require $100 coverage, gate this path on its OWN
  // flag (NOT the forward HUGRAB_PURCHASE_GATE) + add return-insurance handling.
  const result = await ssCreateReturnLabel(row.labelShipmentId, reason, creds.apiKeyV2 ?? undefined);
  const now = new Date();

  await ensureShipmentsSelectedRateCostColumn();
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
      // Per user override unlock shipped data on 2026-07-06: PS-381 stamps the
      // selected/purchased cost SOT on return shipment rows when postage proof exists.
      selectedRateCost: result.cost.toFixed(2),
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
  fresh = false,
  scope: ClientStoreScope,
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
  // PS-233: out-of-scope label URL/tracking → same "No active label found" 404
  // (label URLs + tracking are cross-tenant PII; never leak another tenant's).
  await assertShipmentInScope(row, scope, 'No active label found for this order');

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
