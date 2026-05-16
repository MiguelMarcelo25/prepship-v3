import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orderOverrides, orders } from '../db/schema/orders';
import { rateCache } from '../db/schema/rates';
import { shipments } from '../db/schema/shipments';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import { getSyncStatus, syncOrders } from '../services/order-sync';
import { getActiveBackfillJob, getLatestBackfillJob, startBackfillBestRates } from '../services/rates-backfill';
import { deductInventoryForOrder } from '../services/fulfillment-deductions';
import { ssMarkOrderShippedV1, asSSUpstreamOrderId } from '../lib/shipstation/labels';
import { loadClientCredentials } from '../lib/shipstation/credentials';
import {
  InputValidationError,
  assertPersistedOrderBestRateDto,
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
} from '../services/order-rate-dto';
import { EXCLUDED_STORE_IDS, EXCLUDED_STORE_IDS_SQL } from '../config/prepship';
import { isAdminEmail } from '../lib/admin-emails';

const app = new Hono();

type OrdersListTimings = Record<string, number>;

function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function timedOrdersStep<T>(
  timings: OrdersListTimings,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = msSince(startedAt);
  }
}

function orderListRequestMeta(q: z.infer<typeof listQuery>) {
  return {
    status: q.status ?? 'all',
    page: q.page,
    pageSize: q.pageSize,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    hasSearch: Boolean(q.search?.trim()),
    hasSku: Boolean(q.sku),
    dateFrom: q.dateFrom ?? null,
    dateTo: q.dateTo ?? null,
  };
}

function logSlowOrdersList(
  q: z.infer<typeof listQuery>,
  timings: OrdersListTimings,
  totalMs: number,
  extra: Record<string, unknown>,
): void {
  const slowestStepMs = Math.max(0, ...Object.values(timings));
  if (totalMs < 750 && slowestStepMs < 500) return;
  console.info('[orders:list] completed', {
    ...orderListRequestMeta(q),
    ...extra,
    totalMs,
    timings,
  });
}

function isLikelyDbTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|statement timeout|canceling statement|connection terminated|pool/i.test(msg);
}

function dbErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

// ════════════════════════════════════════════════════════════════════
// SHIPPED / CANCELLED LOCKDOWN — backend route guard
// ────────────────────────────────────────────────────────────────────
// Once an order's status is 'shipped' or 'cancelled', it's a historical
// record and must be immutable. Every modification route below calls
// this guard at the top of its handler — if the target order is locked,
// the route returns 403 Forbidden BEFORE running any update logic.
//
// This protects against:
//   - Accidental UI edits via the OrderDetailDrawer
//   - Direct API calls (curl, Postman, third-party clients)
//   - Future code paths that might forget to add their own UI guard
//
// Bypass: an explicit ?force=1 query param + admin email allows the
// operation to proceed. Designed for one-off corrections; logs a
// warning so unintended use is visible in monitoring. Non-admins
// always get 403 regardless of force flag.
//
// Returns:
//   - { ok: true } when the order can be modified
//   - { ok: false, response } when the order is locked (caller must
//     return the response immediately to short-circuit the handler)
// ════════════════════════════════════════════════════════════════════
const LOCKED_STATUSES = new Set(['shipped', 'cancelled']);

async function assertOrderEditable(
  c: Context<any, any, any>,
  orderId: number,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const [row] = await db
    .select({ id: orders.id, status: orders.orderStatus })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) {
    return { ok: false, response: c.json({ error: 'Order not found' }, 404) };
  }
  const status = String(row.status ?? '').toLowerCase();
  if (!LOCKED_STATUSES.has(status)) {
    return { ok: true };
  }
  // Optional admin override: ?force=1 + admin email lets the operation
  // through with a warning logged. Use sparingly; the standard answer
  // is "create a new order or correction record" rather than mutating
  // historical data.
  const forceFlag = c.req.query('force');
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  if (forceFlag === '1' && callerIsAdmin) {
    console.warn(
      `[orders] LOCKDOWN BYPASS — admin ${callerEmail} forced modification of ${status} order ${orderId}`
    );
    return { ok: true };
  }
  return {
    ok: false,
    response: c.json(
      {
        error: `Cannot modify a ${status} order — historical records are locked.`,
        status,
        orderId,
        locked: true,
        hint: 'Shipped and cancelled orders are immutable. Admins can pass ?force=1 to override (logged).',
      },
      403,
    ),
  };
}

// Active-client filter (added 2026-05-07): orders belonging to clients
// flagged inactive (Inventory > Clients > Active toggle off) are hidden
// from the main orders list, matching the sidebar's behavior. Without
// this, the sidebar's per-store badge would drop disabled clients while
// the main /orders list still returned their rows — desync between the
// parent count and the visible list. coalesce(active, true) defaults
// legacy null rows to visible.
const visibleStoreBasePredicate = sql`(
  (${orders.storeId} is not null and ${orders.storeId} not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
  or exists (
    select 1 from ${clients} test_client
    where test_client.id = ${orders.clientId}
      and test_client.is_test = true
  )
)`;

const activeOrderClientPredicate = sql`(
  ${orders.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${orders.clientId}
      and coalesce(owner_client.active, true) = true
  )
)`;

const visibleStorePredicate = sql`${visibleStoreBasePredicate} and ${activeOrderClientPredicate}`;

const testOrderPredicate = sql`(
  exists (
    select 1 from ${clients} test_client
    where test_client.id = ${orders.clientId}
      and test_client.is_test = true
  )
  or coalesce(${orders.orderNumber}, '') ilike 'TESTING-%'
  or ${orders.raw} @> '{"test": true}'::jsonb
  or ${orders.raw} @> '{"testing": true}'::jsonb
 )`;


const LEGACY_CLIENT_ID_BY_STORE_ID = new Map<number, number>([
  [367706, 7],
  [363392, 8],
  [376661, 9],
  [277422, 10],
  [376827, 10],
]);

const LEGACY_CLIENT_ID_BY_CURRENT_ID = new Map<number, number>([
  [8, 7],
  [9, 8],
  [10, 9],
  [11, 10],
  [12, 11],
]);

type V2CarrierAccountRef = {
  carrierCode: string;
  shippingProviderId: number;
  nickname: string;
  clientId: number | null;
  accountNumber: string | null;
};

type CanonicalSourceVersion = 'v1' | 'v2' | 'local' | 'derived';

type CanonicalFieldSource = {
  version: CanonicalSourceVersion;
  source: string;
  via: string;
  note?: string;
};

const V2_CARRIER_ACCOUNT_REFS: V2CarrierAccountRef[] = [
  { carrierCode: 'stamps_com', shippingProviderId: 433542, nickname: 'USPS Chase x7439', clientId: null, accountNumber: 'djeon-952w77' },
  { carrierCode: 'ups_walleted', shippingProviderId: 433543, nickname: 'UPS by SS - Chase x7439', clientId: null, accountNumber: 'ups_433543' },
  { carrierCode: 'ups', shippingProviderId: 565326, nickname: 'GG6381', clientId: null, accountNumber: 'GG6381' },
  { carrierCode: 'ups', shippingProviderId: 565377, nickname: 'G19Y32', clientId: null, accountNumber: 'G19Y32' },
  { carrierCode: 'ups', shippingProviderId: 596001, nickname: 'ORION', clientId: null, accountNumber: 'R05H19' },
  { carrierCode: 'ups', shippingProviderId: 604209, nickname: 'ROCEL', clientId: null, accountNumber: null },
  { carrierCode: 'ups', shippingProviderId: 607855, nickname: 'ROCEL C81F70', clientId: null, accountNumber: 'C81F70' },
  { carrierCode: 'fedex', shippingProviderId: 598840, nickname: 'FedEx', clientId: null, accountNumber: '208481048' },
  { carrierCode: 'fedex_walleted', shippingProviderId: 585004, nickname: 'FedEx One Balance', clientId: null, accountNumber: null },
  { carrierCode: 'stamps_com', shippingProviderId: 442006, nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { carrierCode: 'ups', shippingProviderId: 461890, nickname: 'ROCEL C81F70', clientId: 10, accountNumber: 'C81F70' },
  { carrierCode: 'ups', shippingProviderId: 565317, nickname: 'GG6381', clientId: 10, accountNumber: 'GG6381' },
  { carrierCode: 'ups', shippingProviderId: 595995, nickname: 'ORI Account', clientId: 10, accountNumber: 'R05H19' },
  { carrierCode: 'ups', shippingProviderId: 442007, nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { carrierCode: 'fedex', shippingProviderId: 442013, nickname: 'FedEx', clientId: 10, accountNumber: '208481048' },
  { carrierCode: 'fedex_walleted', shippingProviderId: 585334, nickname: 'FedEx One Balance', clientId: 10, accountNumber: null },
];

function resolveLegacyClientId(
  clientId: number | null | undefined,
  storeId: number | null | undefined,
) {
  if (typeof storeId === 'number') {
    const byStore = LEGACY_CLIENT_ID_BY_STORE_ID.get(storeId);
    if (byStore != null) return byStore;
  }
  if (typeof clientId === 'number') {
    const byCurrentId = LEGACY_CLIENT_ID_BY_CURRENT_ID.get(clientId);
    if (byCurrentId != null) return byCurrentId;
  }
  return clientId ?? null;
}

function resolveV2CarrierAccountRef(
  providerAccountId: number | null | undefined,
  carrierCode: string | null | undefined,
  trackingNumber: string | null | undefined,
  clientId: number | null,
): V2CarrierAccountRef | null {
  if (providerAccountId != null) {
    const exact = V2_CARRIER_ACCOUNT_REFS.find((account) => account.shippingProviderId === providerAccountId);
    if (exact) return exact;
  }

  if ((carrierCode === 'ups' || carrierCode === 'ups_walleted') && trackingNumber) {
    const tracking = trackingNumber.replace(/\s/g, '').toUpperCase();
    if (tracking.startsWith('1Z') && tracking.length >= 8) {
      const accountNumber = tracking.slice(2, 8);
      const matches = V2_CARRIER_ACCOUNT_REFS.filter(
        (account) =>
          (account.carrierCode === 'ups' || account.carrierCode === 'ups_walleted') &&
          account.accountNumber?.toUpperCase() === accountNumber,
      );
      const clientMatch = clientId != null ? matches.find((account) => account.clientId === clientId) : null;
      const sharedMatch = matches.find((account) => account.clientId === null);
      return clientMatch ?? sharedMatch ?? matches[0] ?? null;
    }
  }

  const matching = V2_CARRIER_ACCOUNT_REFS.filter((account) => account.carrierCode === carrierCode);
  if (matching.length === 1) return matching[0] ?? null;
  if (matching.length > 1) {
    const clientMatch = clientId != null ? matching.find((account) => account.clientId === clientId) : null;
    const sharedMatch = matching.find((account) => account.clientId === null);
    return clientMatch ?? sharedMatch ?? null;
  }

  return null;
}

function normalizeListBestRate(value: unknown) {
  try {
    const bestRate = normalizeOrderBestRateDto(value);
    if (!bestRate) return null;
    const amount = bestRate.shipmentCost + bestRate.otherCost;
    if (!(amount > 0) && !(bestRate.carrierCode && bestRate.serviceCode)) return null;
    return {
      ...bestRate,
      amount,
      cost: amount,
      providerAccountId: bestRate.shippingProviderId,
      providerAccountNickname: bestRate.carrierNickname,
    };
  } catch {
    return null;
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function providerIdOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function rateAmount(value: unknown): number | null {
  const rate = recordOrNull(value);
  if (!rate) return null;
  const shippingAmount = recordOrNull(rate.shipping_amount);
  const otherAmount = recordOrNull(rate.other_amount);
  const shipmentCost =
    finiteNumberOrNull(rate.shipmentCost) ??
    finiteNumberOrNull(shippingAmount?.amount) ??
    finiteNumberOrNull(rate.cost) ??
    finiteNumberOrNull(rate.amount);
  const otherCost = finiteNumberOrNull(rate.otherCost) ?? finiteNumberOrNull(otherAmount?.amount) ?? 0;
  return shipmentCost != null ? shipmentCost + otherCost : null;
}

function sourceOf(
  version: CanonicalSourceVersion,
  source: string,
  via: string,
  note?: string,
): CanonicalFieldSource {
  return note ? { version, source, via, note } : { version, source, via };
}

function pickStringSource(
  candidates: Array<{ value: unknown; source: CanonicalFieldSource }>,
): { value: string | null; source: CanonicalFieldSource } {
  for (const candidate of candidates) {
    const value = stringOrNull(candidate.value);
    if (value != null) return { value, source: candidate.source };
  }
  return {
    value: null,
    source: sourceOf('local', 'null', 'no populated source field'),
  };
}

function pickNumberSource(
  candidates: Array<{ value: unknown; source: CanonicalFieldSource }>,
): { value: number | null; source: CanonicalFieldSource } {
  for (const candidate of candidates) {
    const value = finiteNumberOrNull(candidate.value);
    if (value != null) return { value, source: candidate.source };
  }
  return {
    value: null,
    source: sourceOf('local', 'null', 'no populated source field'),
  };
}

function dateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

function buildCanonicalOrderModel(
  order: Record<string, unknown>,
  overrides: Record<string, unknown> | null,
  legacyClientId: number | null,
  shipping: Record<string, unknown>,
) {
  const raw = recordOrNull(order.raw) ?? {};
  const rawShipTo = recordOrNull(raw.shipTo) ?? {};
  const rawDimensions = recordOrNull(raw.dimensions) ?? {};
  const overrideDimensionLength = finiteNumberOrNull(overrides?.rateDimsL);
  const overrideDimensionWidth = finiteNumberOrNull(overrides?.rateDimsW);
  const overrideDimensionHeight = finiteNumberOrNull(overrides?.rateDimsH);
  const rawDimensionLength = finiteNumberOrNull(rawDimensions.length);
  const rawDimensionWidth = finiteNumberOrNull(rawDimensions.width);
  const rawDimensionHeight = finiteNumberOrNull(rawDimensions.height);
  const hasOverrideDimensions =
    overrideDimensionLength != null ||
    overrideDimensionWidth != null ||
    overrideDimensionHeight != null;

  const dimensionLength = overrideDimensionLength ?? rawDimensionLength;
  const dimensionWidth = overrideDimensionWidth ?? rawDimensionWidth;
  const dimensionHeight = overrideDimensionHeight ?? rawDimensionHeight;
  const dimensionSource =
    hasOverrideDimensions
      ? sourceOf('local', 'order_overrides.rateDims*', 'PrepShip dimension override')
      : dimensionLength != null && dimensionWidth != null && dimensionHeight != null && rawDimensions.length != null
      ? sourceOf('v1', 'orders.raw.dimensions', 'ShipStation v1 /orders.dimensions')
      : sourceOf('local', 'order_overrides.rateDims*', 'PrepShip dimension override fallback');
  const dimensionUnitsSource = stringOrNull(rawDimensions.units)
    ? sourceOf('v1', 'orders.raw.dimensions.units', 'ShipStation v1 /orders.dimensions.units')
    : sourceOf('derived', 'default dimensions.units', 'Defaulted to inches when ShipStation did not send units');
  const dimensions =
    dimensionLength != null && dimensionWidth != null && dimensionHeight != null
      ? {
          length: dimensionLength,
          width: dimensionWidth,
          height: dimensionHeight,
          units: stringOrNull(rawDimensions.units) ?? 'inches',
        }
      : null;
  const overrideWeightOz = finiteNumberOrNull(overrides?.rateWeightOz);
  const weightOz = overrideWeightOz ?? finiteNumberOrNull(order.weightOz);
  const orderId = finiteNumberOrNull(order.id);
  const clientId = finiteNumberOrNull(order.clientId);
  const storeId = finiteNumberOrNull(order.storeId);
  const sourceMap: Record<string, CanonicalFieldSource> = {
    id: sourceOf('local', 'orders.id', 'Postgres canonical order id'),
    orderId: sourceOf('local', 'orders.id', 'Postgres canonical order id'),
    externalOrderId: sourceOf('v1', 'orders.external_order_id', 'ShipStation v1 /orders.orderId'),
    orderNumber: sourceOf('v1', 'orders.order_number', 'ShipStation v1 /orders.orderNumber'),
    orderStatus: sourceOf('v1', 'orders.order_status', 'ShipStation v1 /orders.orderStatus'),
    orderDate: sourceOf('v1', 'orders.order_date', 'ShipStation v1 /orders.orderDate'),
    createdAt: sourceOf('local', 'orders.created_at', 'PrepShip order row create timestamp'),
    updatedAt: sourceOf('local', 'orders.updated_at', 'PrepShip order row update timestamp'),
    clientId: sourceOf('local', 'orders.client_id', 'PrepShip client/store mapping'),
    legacyClientId: sourceOf('derived', 'LEGACY_CLIENT_ID_BY_*', 'Derived from store/client id parity map'),
    storeId: sourceOf('v1', 'orders.store_id', 'ShipStation v1 /orders.advancedOptions.storeId'),
    'client.id': sourceOf('local', 'orders.client_id', 'PrepShip client/store mapping'),
    'client.legacyId': sourceOf('derived', 'LEGACY_CLIENT_ID_BY_*', 'Derived from store/client id parity map'),
    'client.storeId': sourceOf('v1', 'orders.store_id', 'ShipStation v1 /orders.advancedOptions.storeId'),
    'customer.email': sourceOf('v1', 'orders.customer_email', 'ShipStation v1 /orders.customerEmail'),
    'customer.username': sourceOf('v1', 'orders.raw.customerUsername', 'ShipStation v1 /orders.customerUsername'),
    'recipient.name': stringOrNull(rawShipTo.name)
      ? sourceOf('v1', 'orders.raw.shipTo.name', 'ShipStation v1 /orders.shipTo.name')
      : sourceOf('local', 'orders.ship_to_name', 'Synced fallback column from ShipStation v1 shipTo.name'),
    'recipient.company': sourceOf('v1', 'orders.raw.shipTo.company', 'ShipStation v1 /orders.shipTo.company'),
    'recipient.street1': sourceOf('v1', 'orders.raw.shipTo.street1', 'ShipStation v1 /orders.shipTo.street1'),
    'recipient.street2': sourceOf('v1', 'orders.raw.shipTo.street2', 'ShipStation v1 /orders.shipTo.street2'),
    'recipient.city': stringOrNull(rawShipTo.city)
      ? sourceOf('v1', 'orders.raw.shipTo.city', 'ShipStation v1 /orders.shipTo.city')
      : sourceOf('local', 'orders.ship_to_city', 'Synced fallback column from ShipStation v1 shipTo.city'),
    'recipient.state': stringOrNull(rawShipTo.state)
      ? sourceOf('v1', 'orders.raw.shipTo.state', 'ShipStation v1 /orders.shipTo.state')
      : sourceOf('local', 'orders.ship_to_state', 'Synced fallback column from ShipStation v1 shipTo.state'),
    'recipient.postalCode': stringOrNull(rawShipTo.postalCode)
      ? sourceOf('v1', 'orders.raw.shipTo.postalCode', 'ShipStation v1 /orders.shipTo.postalCode')
      : sourceOf('local', 'orders.ship_to_postal_code', 'Synced fallback column from ShipStation v1 shipTo.postalCode'),
    'recipient.country': stringOrNull(rawShipTo.country)
      ? sourceOf('v1', 'orders.raw.shipTo.country', 'ShipStation v1 /orders.shipTo.country')
      : sourceOf('derived', 'default recipient.country', 'Defaulted to US when ShipStation did not send a country'),
    'recipient.phone': sourceOf('v1', 'orders.raw.shipTo.phone', 'ShipStation v1 /orders.shipTo.phone'),
    'recipient.residential': overrides?.residential != null
      ? sourceOf('local', 'order_overrides.residential', 'PrepShip user override')
      : sourceOf('v1', 'orders.raw.shipTo.residential', 'ShipStation v1 /orders.shipTo.residential'),
    'recipient.addressVerified': sourceOf('v1', 'orders.raw.shipTo.addressVerified', 'ShipStation v1 /orders.shipTo.addressVerified'),
    weight: overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    weightOz: overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    'weight.value': overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    'weight.units': sourceOf('derived', 'canonical weight.units', 'Normalized to ounces for canonical rows'),
    dimensions: dimensionSource,
    'dimensions.length': dimensionSource,
    'dimensions.width': dimensionSource,
    'dimensions.height': dimensionSource,
    'dimensions.units': dimensionUnitsSource,
    packageCode: sourceOf('v1', 'orders.raw.packageCode', 'ShipStation v1 /orders.packageCode'),
    requestedShippingService: sourceOf('v1', 'orders.raw.requestedShippingService', 'ShipStation v1 /orders.requestedShippingService'),
    requestedServiceCode: stringOrNull(raw.serviceCode)
      ? sourceOf('v1', 'orders.raw.serviceCode', 'ShipStation v1 /orders.serviceCode')
      : sourceOf('local', 'orders.service_code', 'Synced fallback service column'),
    'totals.orderTotal': sourceOf('v1', 'orders.order_total', 'ShipStation v1 /orders.orderTotal'),
    'totals.shippingAmount': sourceOf('v1', 'orders.shipping_amount', 'ShipStation v1 /orders.shippingAmount'),
    items: sourceOf('v1', 'orders.items', 'ShipStation v1 /orders.items[]'),
    'flags.externallyShipped': sourceOf('local', 'orders.externally_shipped', 'PrepShip external-shipped override'),
    'flags.externallyFulfilled': sourceOf('v1', 'orders.raw.externallyFulfilled', 'ShipStation v1 /orders.externallyFulfilled'),
    'flags.externallyFulfilledVerified': sourceOf('local', 'orders.externally_fulfilled_verified', 'PrepShip verification flag'),
  };

  return {
    id: orderId,
    orderId,
    externalOrderId: stringOrNull(order.externalOrderId),
    orderNumber: stringOrNull(order.orderNumber),
    orderStatus: stringOrNull(order.orderStatus),
    orderDate: dateToIso(order.orderDate),
    createdAt: dateToIso(order.createdAt),
    updatedAt: dateToIso(order.updatedAt),
    clientId,
    legacyClientId,
    storeId,
    client: {
      id: clientId,
      legacyId: legacyClientId,
      storeId,
    },
    customer: {
      email: stringOrNull(order.customerEmail),
      username: stringOrNull(raw.customerUsername),
    },
    recipient: {
      name: stringOrNull(rawShipTo.name) ?? stringOrNull(order.shipToName),
      company: stringOrNull(rawShipTo.company),
      street1: stringOrNull(rawShipTo.street1),
      street2: stringOrNull(rawShipTo.street2),
      city: stringOrNull(rawShipTo.city) ?? stringOrNull(order.shipToCity),
      state: stringOrNull(rawShipTo.state) ?? stringOrNull(order.shipToState),
      postalCode: stringOrNull(rawShipTo.postalCode) ?? stringOrNull(order.shipToPostalCode),
      country: stringOrNull(rawShipTo.country) ?? 'US',
      phone: stringOrNull(rawShipTo.phone),
      residential: booleanOrNull(overrides?.residential) ?? booleanOrNull(rawShipTo.residential),
      addressVerified: stringOrNull(rawShipTo.addressVerified),
    },
    weight: weightOz != null ? { value: weightOz, units: 'ounces' } : null,
    weightOz,
    dimensions,
    packageCode: stringOrNull(raw.packageCode),
    requestedShippingService: stringOrNull(raw.requestedShippingService),
    requestedServiceCode: stringOrNull(raw.serviceCode) ?? stringOrNull(order.serviceCode),
    totals: {
      orderTotal: finiteNumberOrNull(order.orderTotal) ?? 0,
      shippingAmount: finiteNumberOrNull(order.shippingAmount) ?? 0,
    },
    items: Array.isArray(order.items) ? order.items : [],
    flags: {
      externallyShipped: Boolean(order.externallyShipped),
      externallyFulfilled: booleanOrNull(raw.externallyFulfilled),
      externallyFulfilledVerified: Boolean(order.externallyFulfilledVerified),
    },
    shipping,
    sourceMap: {
      ...sourceMap,
      ...recordOrNull(shipping.sourceMap),
    },
  };
}

// User-initiated sync + status. Sits behind requireAuth (mounted at main.ts).
// /cron/sync-orders is the cron-secret equivalent for schedulers.
//
// v2 parity: the response shape extends v4's native `{lastSyncedAt,
// orderCount}` with v2's `LegacySyncStatusDto` fields (status, mode, error,
// page, ratesCached, ratePrefetchRunning) so the ported progress UIs can
// render without a second round-trip. v4 doesn't track a live sync state
// machine (the CLI-style `syncOrders()` is synchronous from the caller's POV
// and returns before responding), so `status`/`mode`/`error`/`page` carry
// safe defaults while `lastSyncAt` is kept as an alias for back-compat.
app.get('/sync/status', async (c) => {
  const status = await getSyncStatus();
  const activeRateJob = getActiveBackfillJob();
  const latestRateJob = getLatestBackfillJob();
  const rateJob =
    activeRateJob ??
    (latestRateJob?.finishedAt &&
    Date.now() - latestRateJob.finishedAt < 5 * 60 * 1000
      ? latestRateJob
      : null);
  const [rateCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  const lastSync =
    status.lastSyncedAt && Number.isFinite(Date.parse(status.lastSyncedAt))
      ? Date.parse(status.lastSyncedAt)
      : null;
  return c.json({
    // v4 native fields
    lastSyncedAt: status.lastSyncedAt,
    orderCount: status.orderCount,
    // 2026-05-13: surface the scheduler cadence so the dashboard
    // can show operators / bosses "data refreshes every N minutes."
    // Source-of-truth values come from src/services/sync-scheduler.ts
    // — kept in sync with the *_INTERVAL_MS constants there. If you
    // change a cadence, change it here too so the displayed number
    // doesn't drift from reality.
    cadenceMinutes: {
      orders: 3,
      shipments: 3,
      rateBackfill: 3,
      inventoryFromOrders: 30,
      productCatalog: 60,
    },
    // v2 LegacySyncStatusDto parity fields
    status: lastSync ? 'done' : 'idle',
    mode: lastSync ? 'incremental' : 'idle',
    error: null as string | null,
    page: 0,
    total: 0,
    count: 0,
    lastSync,
    ratesCached: rateCount?.count ?? 0,
    ratePrefetchRunning: rateJob?.status === 'running',
    ratePrefetchJob: rateJob
      ? {
          jobId: rateJob.jobId,
          status: rateJob.status,
          total: rateJob.total,
          processed: rateJob.processed,
          updated: rateJob.updated,
          skipped: rateJob.skipped,
          failed: rateJob.failed,
          message: rateJob.message,
          failureSamples: rateJob.failureSamples,
        }
      : null,
    // Back-compat alias: some v2 callers read `lastSyncAt` (no "ed").
    lastSyncAt: status.lastSyncedAt,
  });
});

// GET /orders/daily-counts?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns one row per day in the range with order counts split by status:
//   [{ day: '2026-04-15', awaiting: 12, shipped: 34, cancelled: 1, total: 47 }, …]
//
// Built specifically for the Dashboard "Orders per Day" chart, which
// previously paginated through up to 5000 individual order rows just to
// bucket them client-side — a single GROUP BY here returns ~30 rows
// (typical 30-day window) instead of megabytes of order JSON. The
// dashboard load drops from seconds to milliseconds.
//
// Honors the same visibility predicates as the list endpoint (excluded
// stores, test-order opt-out, optional client/store filter, assignee
// scoping for non-admin callers) so the chart matches what users see in
// the Orders view.
const dailyCountsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  hideTestOrders: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  includeInactiveClients: z.coerce.boolean().optional(),
});

app.get('/daily-counts', zValidator('query', dailyCountsQuery), async (c) => {
  const q = c.req.valid('query');

  // Same assignee-scoping rules as GET / (admins see all; workers see only
  // their assigned orders).
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  const assigneeFilter = !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;

  // Inclusive date range: to-date covers through 23:59:59.999 of that day so
  // orders created at the very end of the window aren't dropped.
  const fromDate = new Date(`${q.from}T00:00:00.000Z`);
  const toDate = new Date(`${q.to}T23:59:59.999Z`);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;

  const where = and(
    ...[
      assigneeFilter,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      includeInactiveClients ? visibleStoreBasePredicate : visibleStorePredicate,
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      gte(orders.orderDate, fromDate),
      lte(orders.orderDate, toDate),
    ].filter((p): p is NonNullable<typeof p> => p !== undefined)
  );

  // Group by day (UTC) then pivot statuses into named columns. FILTER
  // clauses are the cleanest pivot in Postgres — one pass over the rows.
  const rows = await db.execute<{
    day: string;
    awaiting: number;
    shipped: number;
    cancelled: number;
    total: number;
  }>(sql`
    select
      to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD') as day,
      count(*) filter (where ${orders.orderStatus} = 'awaiting_shipment')::int as awaiting,
      count(*) filter (where ${orders.orderStatus} = 'shipped')::int as shipped,
      count(*) filter (where ${orders.orderStatus} = 'cancelled')::int as cancelled,
      count(*)::int as total
    from ${orders}
    where ${where}
    group by date_trunc('day', ${orders.orderDate} at time zone 'UTC')
    order by date_trunc('day', ${orders.orderDate} at time zone 'UTC') asc
  `);

  return c.json({ data: rows });
});

const dashboardSalesQuery = dailyCountsQuery.extend({
  sevenFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sevenFrom must be YYYY-MM-DD').optional(),
});

app.get('/dashboard-sales', zValidator('query', dashboardSalesQuery), async (c) => {
  const q = c.req.valid('query');
  const startedAt = performance.now();

  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  const assigneeFilter = !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;

  const fromDate = new Date(`${q.from}T00:00:00.000Z`);
  const toDate = new Date(`${q.to}T23:59:59.999Z`);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const sevenFrom = q.sevenFrom ?? q.from;

  const where = and(
    ...[
      assigneeFilter,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      includeInactiveClients ? visibleStoreBasePredicate : visibleStorePredicate,
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      gte(orders.orderDate, fromDate),
      lte(orders.orderDate, toDate),
      sql`lower(coalesce(${orders.orderStatus}, '')) <> 'cancelled'`,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined)
  );

  const [row] = await db.execute<{
    revenue: number | string | null;
    units: number | string | null;
    bySku: Array<{ sku: string; revenue: number | string; units30: number | string; units7: number | string }> | null;
    dailyRevenue: Array<{ day: string; revenue: number | string }> | null;
  }>(sql`
    with item_rows as (
      select
        ${orders.id} as order_id,
        coalesce(${orders.orderTotal}, 0)::numeric as order_total,
        to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD') as day,
        trim(coalesce(item->>'sku', '')) as sku,
        case
          when nullif(item->>'quantity', '') ~ '^-?[0-9]+([.][0-9]+)?$'
            then greatest(0, (item->>'quantity')::numeric)
          else 1
        end as qty
      from ${orders}
      cross join lateral jsonb_array_elements(coalesce(${orders.items}, '[]'::jsonb)) as item
      where ${where}
        and trim(coalesce(item->>'sku', '')) <> ''
        and not (lower(coalesce(item->>'adjustment', 'false')) in ('true', 't', '1', 'yes'))
    ),
    valid_items as (
      select *
      from item_rows
      where qty > 0
    ),
    order_totals as (
      select
        order_id,
        max(order_total) as order_total,
        sum(qty) as order_qty
      from valid_items
      group by order_id
    ),
    allocated as (
      select
        vi.order_id,
        vi.day,
        vi.sku,
        vi.qty,
        case
          when ot.order_qty > 0 then ot.order_total * vi.qty / ot.order_qty
          else 0
        end as allocated_revenue
      from valid_items vi
      join order_totals ot on ot.order_id = vi.order_id
    ),
    sku_totals as (
      select
        sku,
        coalesce(sum(allocated_revenue), 0) as revenue,
        coalesce(sum(qty), 0) as units30,
        coalesce(sum(qty) filter (where day >= ${sevenFrom}), 0) as units7
      from allocated
      group by sku
    ),
    daily_totals as (
      select
        day,
        coalesce(sum(order_total), 0) as revenue
      from (
        select distinct vi.order_id, vi.day, ot.order_total
        from valid_items vi
        join order_totals ot on ot.order_id = vi.order_id
      ) distinct_orders
      group by day
    )
    select
      coalesce((select sum(order_total) from order_totals), 0)::float8 as "revenue",
      coalesce((select sum(order_qty) from order_totals), 0)::float8 as "units",
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'sku', sku,
              'revenue', revenue,
              'units30', units30,
              'units7', units7
            )
            order by units30 desc, sku asc
          )
          from sku_totals
        ),
        '[]'::jsonb
      ) as "bySku",
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'day', day,
              'revenue', revenue
            )
            order by day asc
          )
          from daily_totals
        ),
        '[]'::jsonb
      ) as "dailyRevenue"
  `);

  const totalMs = msSince(startedAt);
  if (totalMs >= 500) {
    console.info('[orders:dashboard-sales] completed', {
      from: q.from,
      to: q.to,
      clientId: q.clientId ?? null,
      storeId: q.storeId ?? null,
      totalMs,
      skuRows: Array.isArray(row?.bySku) ? row.bySku.length : 0,
      dayRows: Array.isArray(row?.dailyRevenue) ? row.dailyRevenue.length : 0,
    });
  }

  return c.json({
    revenue: Number(row?.revenue ?? 0) || 0,
    units: Number(row?.units ?? 0) || 0,
    bySku: Array.isArray(row?.bySku) ? row.bySku : [],
    dailyRevenue: Array.isArray(row?.dailyRevenue) ? row.dailyRevenue : [],
  });
});

app.post('/sync', async (c) => {
  // Optional body lets a caller force a backfill further back than the
  // default watermark. Used by the UI / admin tools to pull a new keyed
  // client's recent history without waiting 30 days of cron ticks.
  let sinceMs: number | undefined;
  try {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (typeof body.sinceMs === 'number') sinceMs = body.sinceMs;
      if (body.fullResync === true) sinceMs = 0;
    }
  } catch {
    // empty / no body — run with defaults
  }
  const result = await syncOrders({ sinceMs });
  const shouldBackfillRates = sinceMs === 0 || result.synced > 0;
  const rateBackfillJob = shouldBackfillRates
    ? (() => {
        const job = startBackfillBestRates({ limit: 1000 });
        return { jobId: job.jobId, status: job.status };
      })()
    : null;
  return c.json({ ...result, rateBackfillJob });
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  excludeClientId: z.string().optional(),
  hideTestOrders: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  includeInactiveClients: z.coerce.boolean().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  search: z.string().optional(),
  // Filter to orders containing at least one items[] entry whose
  // sku exactly matches. The FE used to apply this client-side over
  // the in-memory page, which silently broke pagination — picking
  // a SKU that wasn't on page 1 returned 'no orders match' even
  // though dozens of matches existed on later pages. Pushing the
  // filter to SQL makes it work across the whole result set.
  sku: z.string().optional(),
});

const orderListSelect = {
  id: orders.id,
  externalOrderId: orders.externalOrderId,
  clientId: orders.clientId,
  orderNumber: orders.orderNumber,
  orderStatus: orders.orderStatus,
  orderDate: orders.orderDate,
  storeId: orders.storeId,
  customerEmail: orders.customerEmail,
  shipToName: orders.shipToName,
  shipToCity: orders.shipToCity,
  shipToState: orders.shipToState,
  shipToPostalCode: orders.shipToPostalCode,
  carrierCode: orders.carrierCode,
  serviceCode: orders.serviceCode,
  weightOz: orders.weightOz,
  orderTotal: orders.orderTotal,
  shippingAmount: orders.shippingAmount,
  items: orders.items,
  raw: sql<Record<string, unknown>>`
    jsonb_strip_nulls(jsonb_build_object(
      'shipTo', ${orders.raw}->'shipTo',
      'dimensions', ${orders.raw}->'dimensions',
      'advancedOptions', ${orders.raw}->'advancedOptions',
      'requestedShippingService', ${orders.raw}->'requestedShippingService',
      'serviceCode', ${orders.raw}->'serviceCode',
      'packageCode', ${orders.raw}->'packageCode',
      'insuranceOptions', ${orders.raw}->'insuranceOptions',
      'customerUsername', ${orders.raw}->'customerUsername',
      'externallyFulfilled', ${orders.raw}->'externallyFulfilled'
    ))
  `.as('raw'),
  externallyShipped: orders.externallyShipped,
  externallyFulfilledVerified: orders.externallyFulfilledVerified,
  assignedToUserId: orders.assignedToUserId,
  assignedToEmail: orders.assignedToEmail,
  assignedAt: orders.assignedAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
};

app.get('/', zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const routeStartedAt = performance.now();
  const timings: OrdersListTimings = {};
  const search = q.search?.trim();
  const searchPattern = search ? `%${search}%` : null;
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;

  // Order assignment scoping. Admins see every order. Non-admin callers see
  // only orders whose assigned_to_user_id matches their Supabase UUID. An
  // unassigned order is invisible to non-admins. Admin status is decided by
  // the caller's email (see src/lib/admin-emails.ts).
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  const assigneeFilter = !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;
  const excludeIds = (q.excludeClientId ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  // v2 parity: do NOT auto-exclude is_test clients. v2 shows them.
  // The `excludeClientId` query-string is the caller's explicit opt-in to hide
  // specific clients (used by the v2 UI when a user has toggled them off in
  // Settings). Silent server-side filtering caused real clients flagged
  // is_test=true to disappear from the Awaiting view.
  // If a future UI wants "hide test" as a toggle, it should pass excludeClientId
  // itself rather than the server guessing.

  // Status tabs must reflect the persisted order status. Shipment rows/labels
  // are enrichment data and should not move an awaiting order into Shipped —
  // ShipStation itself counts awaiting strictly by orderStatus, and v4 should
  // match that exact definition (otherwise users see "Walmart-DJC: 2" in
  // ShipStation but "1" in v4 because we silently hid one).
  let statusPredicate: ReturnType<typeof sql> | undefined;
  if (q.status) {
    statusPredicate = sql`${orders.orderStatus} = ${q.status}`;
  }

  const where = and(
    ...[
      statusPredicate,
      assigneeFilter,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      includeInactiveClients ? visibleStoreBasePredicate : visibleStorePredicate,
      excludeIds.length > 0 && q.clientId === undefined
        ? notInArray(orders.clientId, excludeIds)
        : undefined,
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
      // Server-side SKU filter — matches orders where any items[] entry
      // has sku === ${q.sku}. Adjustment rows are excluded so that a
      // discount / fee / shipping line never shows up as a match. This
      // replaces the old client-side filter that ran AFTER pagination
      // and was therefore broken whenever the filtered SKU's orders
      // weren't on page 1.
      q.sku
        ? sql`exists (
            select 1
            from jsonb_array_elements(${orders.items}) item
            where item->>'sku' = ${q.sku}
              and coalesce((item->>'adjustment')::boolean, false) = false
          )`
        : undefined,
      searchPattern
        ? or(
            ilike(orders.orderNumber, searchPattern),
            ilike(orders.externalOrderId, searchPattern),
            ilike(orders.shipToName, searchPattern),
            ilike(orders.customerEmail, searchPattern),
            ilike(orders.shipToCity, searchPattern),
            ilike(orders.shipToState, searchPattern),
            ilike(orders.shipToPostalCode, searchPattern),
            sql`${orders.id}::text ilike ${searchPattern}`,
            sql`${orders.raw}->>'customerUsername' ilike ${searchPattern}`,
            sql`${orders.raw}->'shipTo'->>'company' ilike ${searchPattern}`,
            sql`${orders.raw}->'shipTo'->>'street1' ilike ${searchPattern}`,
            sql`${orders.raw}->'shipTo'->>'street2' ilike ${searchPattern}`,
            sql`exists (
              select 1
              from jsonb_array_elements(${orders.items}) item
              where item->>'sku' ilike ${searchPattern}
                 or item->>'name' ilike ${searchPattern}
            )`,
            sql`exists (
              select 1
              from ${shipments} shipment_search
              where (
                  shipment_search.order_id = ${orders.id}
                  or (
                    shipment_search.order_number is not null
                    and shipment_search.order_number = ${orders.orderNumber}
                  )
                )
                and coalesce(shipment_search.voided, false) = false
                and (
                  shipment_search.tracking_number ilike ${searchPattern}
                  or shipment_search.label_tracking ilike ${searchPattern}
                )
            )`
          )
        : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  try {
  // No ROW_NUMBER() dedup: orders.external_order_id is already UNIQUE, so
  // ShipStation's orderId is the true key. Two rows with the same order_number
  // are legitimately distinct (different store / orderId) — v2 never collapses
  // by order_number and neither should we.
  const offset = offsetOf(q);
  const joined = await timedOrdersStep(timings, 'ordersPage', () =>
    db
      .select({ order: orderListSelect, overrides: orderOverrides })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(where)
      .orderBy(desc(orders.orderDate))
      .limit(q.pageSize)
      .offset(offset)
  );

  const canInferTotal = joined.length < q.pageSize && (q.page === 1 || joined.length > 0);
  let total = canInferTotal ? offset + joined.length : 0;
  let countWasSkipped = canInferTotal;
  if (!canInferTotal) {
    const countRows = await timedOrdersStep(timings, 'ordersCount', () =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(where)
    );
    total = countRows[0]?.count ?? 0;
    countWasSkipped = false;
  }

  // v2-parity enrichment: the Shipped grid expects `order.label` and
  // `order.selectedRate` objects so the Shipping Account / Selected Rate /
  // Service Code / Acct Nickname / Order Local columns render. In v2 those
  // come from joining the shipments table; v4 previously returned only the
  // orders row, so those columns rendered as "—". Attach the latest
  // non-voided shipment per order in one extra query (DISTINCT ON keeps it
  // a single round-trip regardless of page size).
  const pageOrderIds = joined
    .map((r) => r.order.id)
    .filter((id): id is number => id != null);
  const pageOrderNumbers = [
    ...new Set(joined.map((r) => r.order.orderNumber).filter(Boolean)),
  ];
  const latestShipByOrderId = new Map<number, LatestShipmentRow>();
  const latestShipByOrderNumber = new Map<string, LatestShipmentRow>();
  if (pageOrderIds.length) {
    const shipRowsById = await timedOrdersStep(timings, 'shipmentsByOrderId', () =>
      db.execute<LatestShipmentRow>(sql`
        select distinct on (order_id)
          order_id,
          order_number,
          tracking_number,
          carrier_code,
          service_code,
          ship_date,
          create_date,
          label_created_at,
          cost,
          label_cost,
          other_cost,
          label_url,
          label_shipment_id,
          provider_account_id,
          provider_account_nickname,
          selected_rate_json
        from shipments
        where order_id in (${sql.join(pageOrderIds.map((id) => sql`${id}`), sql`, `)})
          ${q.status === 'cancelled' ? sql`` : sql`and coalesce(voided, false) = false`}
        order by order_id, id desc
      `)
    );
    for (const s of shipRowsById) {
      if (s.order_id != null) {
        latestShipByOrderId.set(s.order_id, s);
      }
    }
  }
  if (pageOrderNumbers.length) {
    const shipRowsByOrderNumber = await timedOrdersStep(timings, 'shipmentsByOrderNumber', () =>
      db.execute<LatestShipmentRow>(sql`
        select distinct on (order_number)
          order_id,
          order_number,
          tracking_number,
          carrier_code,
          service_code,
          ship_date,
          create_date,
          label_created_at,
          cost,
          label_cost,
          other_cost,
          label_url,
          label_shipment_id,
          provider_account_id,
          provider_account_nickname,
          selected_rate_json
        from shipments
        where order_id is null
          and order_number in (${sql.join(pageOrderNumbers.map((n) => sql`${n}`), sql`, `)})
          ${q.status === 'cancelled' ? sql`` : sql`and coalesce(voided, false) = false`}
        order by order_number, id desc
      `)
    );
    for (const s of shipRowsByOrderNumber) {
      if (s.order_number) {
        latestShipByOrderNumber.set(s.order_number, s);
      }
    }
  }

  const rows = joined.map((r) => {
    const ship =
      latestShipByOrderId.get(r.order.id) ??
      latestShipByOrderNumber.get(r.order.orderNumber);
    const legacyClientId = resolveLegacyClientId(r.order.clientId, r.order.storeId);
    const isShippedBucket = q.status === 'shipped' || r.order.orderStatus === 'shipped';
    const effectiveOrderStatus = isShippedBucket ? 'shipped' : r.order.orderStatus;
    const hasV2SelectedRateJson = Boolean(ship?.selected_rate_json);
    const selectedRateJsonRecord = recordOrNull(ship?.selected_rate_json);
    const selectedRateJsonProviderId = providerIdOrNull(
      selectedRateJsonRecord?.shippingProviderId ??
        selectedRateJsonRecord?.providerAccountId ??
        selectedRateJsonRecord?.carrier_id,
    );
    const selectedRateCarrierCode =
      stringOrNull(selectedRateJsonRecord?.carrierCode) ??
      stringOrNull(selectedRateJsonRecord?.carrier_code);
    const selectedRateServiceCode =
      stringOrNull(selectedRateJsonRecord?.serviceCode) ??
      stringOrNull(selectedRateJsonRecord?.service_code);
    const selectedRateCarrierNickname =
      stringOrNull(selectedRateJsonRecord?.providerAccountNickname) ??
      stringOrNull(selectedRateJsonRecord?.carrierNickname) ??
      stringOrNull(selectedRateJsonRecord?.carrier_nickname);
    const selectedRateServiceName =
      stringOrNull(selectedRateJsonRecord?.serviceName) ??
      stringOrNull(selectedRateJsonRecord?.service_type) ??
      selectedRateServiceCode;
    const resolvedCarrierAccount = ship
      ? resolveV2CarrierAccountRef(
          ship.provider_account_id,
          ship.carrier_code,
          ship.tracking_number,
          legacyClientId,
        )
      : null;
    const storedProviderAccountId = ship?.provider_account_id ?? null;
    const providerAccountId = storedProviderAccountId ?? resolvedCarrierAccount?.shippingProviderId ?? null;
    const providerAccountNickname = ship
      ? ship.provider_account_nickname ?? resolvedCarrierAccount?.nickname ?? null
      : null;
    const baseShipmentCost = ship?.cost != null ? Number(ship.cost) : null;
    const shipmentOtherCost = ship?.other_cost != null ? Number(ship.other_cost) : null;
    const rawLabelCost = ship?.label_cost != null ? Number(ship.label_cost) : null;
    const shipmentTotalCost = baseShipmentCost != null ? baseShipmentCost + (shipmentOtherCost ?? 0) : null;
    const labelCost = rawLabelCost ?? shipmentTotalCost;
    const selectedRateShipmentCost = baseShipmentCost ?? rawLabelCost;
    const selectedRateOtherCost =
      labelCost != null && baseShipmentCost != null
        ? Math.max(0, labelCost - baseShipmentCost)
        : shipmentOtherCost ?? 0;
    const labelCreatedFallback = ship?.label_created_at ?? ship?.create_date ?? ship?.ship_date ?? null;
    const label = ship
      ? {
          trackingNumber: ship.tracking_number,
          carrierCode: ship.carrier_code,
          serviceCode: ship.service_code,
          shipDate: ship.ship_date,
          createdAt: labelCreatedFallback,
          cost: labelCost,
          rawCost: baseShipmentCost,
          labelUrl: ship.label_url,
          shippingProviderId: providerAccountId,
          shipmentId: ship.label_shipment_id,
        }
      : null;
    const selectedRate =
      selectedRateJsonRecord
        ? {
            ...selectedRateJsonRecord,
            providerAccountId:
              selectedRateJsonRecord.providerAccountId ??
              selectedRateJsonProviderId ??
              providerAccountId,
            shippingProviderId:
              selectedRateJsonRecord.shippingProviderId ??
              selectedRateJsonProviderId ??
              providerAccountId,
            carrierCode: selectedRateCarrierCode,
            serviceCode: selectedRateServiceCode,
            serviceName: selectedRateServiceName,
            providerAccountNickname:
              selectedRateCarrierNickname ??
              providerAccountNickname ??
              null,
          }
        : ship
          ? normalizeOrderSelectedRateDto(
              {
                providerAccountId,
                providerAccountNickname,
                shippingProviderId: providerAccountId,
                carrierCode: ship.carrier_code,
                serviceCode: ship.service_code,
                serviceName: ship.service_code,
                cost: labelCost ?? selectedRateShipmentCost,
                shipmentCost: selectedRateShipmentCost,
                otherCost: selectedRateOtherCost,
              },
              undefined,
              `order ${r.order.id} shipment selectedRate`,
            )
        : null;
    const selectedRateBestRateCandidate =
      selectedRate && typeof selectedRate === 'object'
        ? {
            ...(selectedRate as Record<string, unknown>),
            carrierNickname:
              (selectedRate as Record<string, unknown>).carrierNickname ??
              (selectedRate as Record<string, unknown>).providerAccountNickname ??
              providerAccountNickname,
          }
        : null;
    const overrideBestRate =
      !isShippedBucket && r.overrides?.bestRateJson && typeof r.overrides.bestRateJson === 'object'
        ? {
            ...selectedRateBestRateCandidate,
            ...(r.overrides.bestRateJson as Record<string, unknown>),
            carrierNickname:
              (r.overrides.bestRateJson as Record<string, unknown>).carrierNickname ??
              selectedRateBestRateCandidate?.carrierNickname ??
              providerAccountNickname,
          }
        : null;
    const bestRate = !isShippedBucket ? normalizeListBestRate(overrideBestRate) : null;
    const bestRateRecord = recordOrNull(bestRate);
    const v2BestRateRecord = overrideBestRate ? bestRateRecord : null;
    const selectedRateRecord = recordOrNull(selectedRate);
    const carrierPick = pickStringSource([
      {
        value: hasV2SelectedRateJson ? selectedRateRecord?.carrierCode : null,
        source: sourceOf('v2', 'shipments.selected_rate_json.carrierCode', 'ShipStation v2 label/rate payload'),
      },
      {
        value: v2BestRateRecord?.carrierCode,
        source: sourceOf('v2', 'order_overrides.best_rate_json.carrierCode', 'ShipStation v2 /rates/estimate best rate'),
      },
      {
        value: ship?.carrier_code,
        source: sourceOf('v1', 'shipments.carrier_code', 'ShipStation v1 /shipments.carrierCode stored on linked shipment'),
      },
    ]);
    const servicePick = pickStringSource([
      {
        value: hasV2SelectedRateJson ? selectedRateRecord?.serviceCode : null,
        source: sourceOf('v2', 'shipments.selected_rate_json.serviceCode', 'ShipStation v2 label/rate payload'),
      },
      {
        value: v2BestRateRecord?.serviceCode,
        source: sourceOf('v2', 'order_overrides.best_rate_json.serviceCode', 'ShipStation v2 /rates/estimate best rate'),
      },
      {
        value: ship?.service_code,
        source: sourceOf('v1', 'shipments.service_code', 'ShipStation v1 /shipments.serviceCode stored on linked shipment'),
      },
    ]);
    const trackingPick = pickStringSource([
      {
        value: hasV2SelectedRateJson ? ship?.tracking_number : null,
        source: sourceOf('v2', 'shipments.tracking_number', 'ShipStation v2 /labels tracking_number stored on shipment'),
      },
      {
        value: ship?.tracking_number,
        source: sourceOf('v1', 'shipments.tracking_number', 'ShipStation v1 /shipments.trackingNumber stored on linked shipment'),
      },
    ]);
    const canonicalCarrierCode = carrierPick.value;
    const canonicalServiceCode = servicePick.value;
    const canonicalTrackingNumber = trackingPick.value;
    const providerPick = pickNumberSource([
      {
        value: hasV2SelectedRateJson ? selectedRateRecord?.shippingProviderId : null,
        source: sourceOf('v2', 'shipments.selected_rate_json.shippingProviderId', 'ShipStation v2 label/rate payload'),
      },
      {
        value: hasV2SelectedRateJson ? selectedRateRecord?.providerAccountId : null,
        source: sourceOf('v2', 'shipments.selected_rate_json.providerAccountId', 'ShipStation v2 label/rate payload'),
      },
      {
        value: storedProviderAccountId,
        source: sourceOf('v2', 'shipments.provider_account_id', 'ShipStation v2 /shipments or /labels carrier_id normalized from se-*'),
      },
      {
        value: resolvedCarrierAccount?.shippingProviderId,
        source: sourceOf('derived', 'V2_CARRIER_ACCOUNT_REFS', 'Derived from provider id, carrier code, tracking account number, and client id'),
      },
      {
        value: bestRateRecord?.shippingProviderId,
        source: sourceOf('v2', 'order_overrides.best_rate_json.shippingProviderId', 'ShipStation v2 /rates/estimate carrier_id normalized from se-*'),
      },
      {
        value: bestRateRecord?.providerAccountId,
        source: sourceOf('v2', 'order_overrides.best_rate_json.providerAccountId', 'ShipStation v2 /rates/estimate carrier_id normalized from se-*'),
      },
    ]);
    const canonicalProviderAccountId = providerPick.value;
    const resolvedCanonicalCarrierAccount = resolveV2CarrierAccountRef(
      canonicalProviderAccountId,
      canonicalCarrierCode,
      canonicalTrackingNumber,
      legacyClientId,
    );
    const accountPick = pickStringSource([
      {
        value: hasV2SelectedRateJson ? selectedRateRecord?.providerAccountNickname : null,
        source: sourceOf('v2', 'shipments.selected_rate_json.providerAccountNickname', 'ShipStation v2 label/rate payload'),
      },
      {
        value: providerAccountNickname,
        source: sourceOf('v2', 'shipments.provider_account_nickname', 'ShipStation v2 /carriers nickname cached on shipment'),
      },
      {
        value: bestRateRecord?.providerAccountNickname,
        source: sourceOf('v2', 'order_overrides.best_rate_json.providerAccountNickname', 'ShipStation v2 /rates/estimate account metadata'),
      },
      {
        value: bestRateRecord?.carrierNickname,
        source: sourceOf('v2', 'order_overrides.best_rate_json.carrierNickname', 'ShipStation v2 /rates/estimate account metadata'),
      },
      {
        value: resolvedCanonicalCarrierAccount?.nickname,
        source: sourceOf('derived', 'V2_CARRIER_ACCOUNT_REFS', 'Derived from provider id, carrier code, tracking account number, and client id'),
      },
    ]);
    const canonicalAccountNickname = accountPick.value;
    const selectedRateFromJsonAmount = hasV2SelectedRateJson ? rateAmount(selectedRate) : null;
    const selectedRateFromV2BestRateAmount = overrideBestRate ? rateAmount(bestRate) : null;
    const selectedRatePick = pickNumberSource([
      {
        value: selectedRateFromJsonAmount,
        source: sourceOf('v2', 'shipments.selected_rate_json', 'ShipStation v2 selected label/rate payload'),
      },
      {
        value: !isShippedBucket ? selectedRateFromV2BestRateAmount : null,
        source: sourceOf('v2', 'order_overrides.best_rate_json', 'ShipStation v2 /rates/estimate best rate'),
      },
      {
        value: rawLabelCost,
        source: sourceOf('v2', 'shipments.label_cost', 'ShipStation v2 /labels shipment_cost stored from label purchase/sync'),
      },
      {
        value: shipmentTotalCost,
        source: sourceOf('v1', 'shipments.cost + shipments.other_cost', 'ShipStation v1 /shipments shipmentCost + otherCost stored on linked shipment'),
      },
    ]);
    const selectedRateAmount = selectedRatePick.value;
    const bestRatePick = isShippedBucket
      ? {
          value: null,
          source: sourceOf('local', 'null', 'Shipped rows intentionally do not expose awaiting best-rate data'),
        }
      : pickNumberSource([
          {
            value: rateAmount(bestRate),
            source: overrideBestRate
              ? sourceOf('v2', 'order_overrides.best_rate_json', 'ShipStation v2 /rates/estimate best rate')
              : sourceOf('local', 'null', 'No v2 best-rate JSON present'),
          },
        ]);
    const labelCreatedPick = [
      {
        value: ship?.label_created_at,
        source: sourceOf('v2', 'shipments.label_created_at', 'ShipStation v2 label creation timestamp stored on shipment'),
      },
      {
        value: ship?.create_date,
        source: sourceOf('v1', 'shipments.create_date', 'ShipStation v1 /shipments.createDate stored on linked shipment'),
      },
      {
        value: ship?.ship_date,
        source: sourceOf('v1', 'shipments.ship_date', 'ShipStation v1 /shipments.shipDate stored on linked shipment'),
      },
    ].find((candidate) => candidate.value != null) ?? {
      value: null,
      source: sourceOf('local', 'null', 'no populated source field'),
    };
    const labelCreatedAt =
      labelCreatedPick.value ??
      null;
    const labelCostPick = pickNumberSource([
      {
        value: rawLabelCost,
        source: sourceOf('v2', 'shipments.label_cost', 'ShipStation v2 /labels shipment_cost stored from label purchase/sync'),
      },
      {
        value: shipmentTotalCost,
        source: sourceOf('v1', 'shipments.cost + shipments.other_cost', 'ShipStation v1 /shipments shipmentCost + otherCost stored on linked shipment'),
      },
    ]);
    const shipping = {
      carrierCode: canonicalCarrierCode,
      serviceCode: canonicalServiceCode,
      trackingNumber: canonicalTrackingNumber,
      providerAccountId: canonicalProviderAccountId,
      accountNickname: canonicalAccountNickname,
      selectedRateAmount,
      bestRateAmount: bestRatePick.value,
      labelCost,
      labelCreatedAt,
      shipDate: ship?.ship_date ?? null,
      shipmentId: ship?.label_shipment_id ?? null,
      source: ship ? 'shipment' : overrideBestRate ? 'order_override' : null,
      selectedRate,
      bestRate,
      sourceMap: {
        'shipping.carrierCode': carrierPick.source,
        'shipping.serviceCode': servicePick.source,
        'shipping.trackingNumber': trackingPick.source,
        'shipping.providerAccountId': providerPick.source,
        'shipping.accountNickname': accountPick.source,
        'shipping.selectedRateAmount': selectedRatePick.source,
        'shipping.bestRateAmount': bestRatePick.source,
        'shipping.labelCost': labelCostPick.source,
        'shipping.labelCreatedAt': labelCreatedPick.source,
        'shipping.shipDate': ship?.ship_date != null
          ? sourceOf('v1', 'shipments.ship_date', 'ShipStation v1 /shipments.shipDate')
          : sourceOf('local', 'null', 'no populated source field'),
        'shipping.shipmentId': ship?.label_shipment_id != null
          ? sourceOf('v1', 'shipments.label_shipment_id', 'ShipStation v1 /shipments.shipmentId')
          : sourceOf('local', 'null', 'no populated source field'),
        'shipping.source': ship
          ? sourceOf('local', 'shipments row', 'Canonical shipping model was built from the linked PrepShip shipment row')
          : overrideBestRate
            ? sourceOf('local', 'order_overrides.best_rate_json', 'Canonical shipping model was built from saved rate override data')
            : sourceOf('local', 'null', 'no populated source field'),
        'shipping.selectedRate': hasV2SelectedRateJson
          ? sourceOf('v2', 'shipments.selected_rate_json', 'ShipStation v2 selected label/rate payload')
          : ship
            ? sourceOf('v1', 'shipments row', 'Selected-rate display was built from linked ShipStation shipment fields')
            : sourceOf('local', 'null', 'No selected-rate JSON or linked shipment row present'),
        'shipping.bestRate': overrideBestRate
          ? sourceOf('v2', 'order_overrides.best_rate_json', 'ShipStation v2 /rates/estimate best rate')
          : sourceOf('local', 'null', isShippedBucket ? 'Shipped rows intentionally do not expose awaiting best-rate data' : 'No v2 best-rate JSON present'),
      },
    };
    const orderForCanonical = {
      ...(r.order as Record<string, unknown>),
      orderStatus: effectiveOrderStatus,
    };
    const canonicalOrder = buildCanonicalOrderModel(
      orderForCanonical,
      r.overrides as Record<string, unknown> | null,
      legacyClientId,
      shipping,
    );
    return {
      ...r.order,
      orderStatus: effectiveOrderStatus,
      legacyClientId,
      overrides: r.overrides,
      label,
      selectedRate,
      bestRate,
      shipping,
      canonicalOrder,
    };
  });
  const totalMs = msSince(routeStartedAt);
  logSlowOrdersList(q, timings, totalMs, {
    rows: rows.length,
    total,
    countWasSkipped,
    shipmentsByOrderId: latestShipByOrderId.size,
    shipmentsByOrderNumber: latestShipByOrderNumber.size,
  });
  return c.json(paginated(rows, total, q));
  } catch (err) {
    const totalMs = msSince(routeStartedAt);
    console.error('[orders:list] failed', {
      ...orderListRequestMeta(q),
      totalMs,
      timings,
      error: dbErrorMessage(err),
    });
    return c.json(
      {
        error: 'Failed to load orders',
        code: isLikelyDbTimeout(err) ? 'ORDERS_LIST_TIMEOUT' : 'ORDERS_LIST_ERROR',
        message: isLikelyDbTimeout(err)
          ? 'The orders query is temporarily slow or the database pool is busy. Please retry.'
          : dbErrorMessage(err),
        timingsMs: timings,
      },
      isLikelyDbTimeout(err) ? 503 : 500,
    );
  }
});

type LatestShipmentRow = {
  order_id: number | null;
  order_number: string | null;
  tracking_number: string | null;
  carrier_code: string | null;
  service_code: string | null;
  ship_date: string | null;
  create_date: string | null;
  label_created_at: string | null;
  cost: string | null;
  label_cost: string | null;
  other_cost: string | null;
  label_url: string | null;
  label_shipment_id: number | null;
  provider_account_id: number | null;
  provider_account_nickname: string | null;
  selected_rate_json: Record<string, unknown> | null;
};

type ExportShipmentRow = LatestShipmentRow;

function buildOrderDetailPayload(
  order: Record<string, unknown>,
  overrides: Record<string, unknown> | null,
  shipmentRows: unknown[],
) {
  const legacyClientId = resolveLegacyClientId(
    finiteNumberOrNull(order.clientId),
    finiteNumberOrNull(order.storeId),
  );
  const canonicalOrder = buildCanonicalOrderModel(
    order,
    overrides,
    legacyClientId,
    {},
  );

  return {
    ...order,
    legacyClientId,
    client: canonicalOrder.client,
    canonicalOrder,
    overrides,
    shipments: shipmentRows,
  };
}

// Picklist: aggregated SKU + qty + order count per client over a date
// range and status filter. Used to print a warehouse pick list grouped
// by client. Skipping clients table to keep the query simple — we
// resolve client names client-side via the clients query.
const picklistQuery = z.object({
  status: z.string().optional().default('awaiting_shipment'),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

// Order IDs that contain a given SKU (warehouse pick lookup).
// Optional filters restored for v2 parity: qty (min qty on the line),
// orderStatus, storeId.
app.get(
  '/ids',
  zValidator(
    'query',
    z.object({
      sku: z.string().min(1),
      qty: z.coerce.number().int().positive().optional(),
      orderStatus: z.string().optional(),
      storeId: z.coerce.number().int().optional(),
    })
  ),
  async (c) => {
    const { sku, qty, orderStatus, storeId } = c.req.valid('query');
    const rows = await db.execute<{ id: number; order_number: string }>(sql`
      select distinct o.id, o.order_number
      from orders o, jsonb_array_elements(o.items) item
      where item ? 'sku' and item->>'sku' = ${sku}
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        ${qty !== undefined ? sql`and coalesce((item->>'quantity')::int, 1) >= ${qty}` : sql``}
        ${orderStatus ? sql`and o.order_status = ${orderStatus}` : sql``}
        ${storeId !== undefined ? sql`and o.store_id = ${storeId}` : sql``}
      order by o.id desc
      limit 500
    `);
    return c.json({ data: rows });
  }
);

// Per-store order counts in a window — useful for store dashboards.
app.get(
  '/store-counts',
  zValidator(
    'query',
    z.object({
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      status: z.string().optional(),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    const fromIso = (q.dateFrom ? new Date(q.dateFrom) : new Date(0)).toISOString();
    const toIso = (q.dateTo ? new Date(q.dateTo) : new Date(Date.now() + 86400000)).toISOString();
    const status = q.status ?? null;
    const rows = await db.execute<{
      store_id: number | null;
      count: number;
    }>(sql`
      select store_id, count(*)::int as count
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        and store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        and (${status}::text is null or order_status = ${status}::text)
      group by store_id
      order by count desc
    `);
    return c.json({ data: rows });
  }
);

// Fulfillment-day metrics answer: "How many orders came in early enough to
// prepare and hand off to the carrier today?" Normal weekdays use 12pm PT
// yesterday through 12pm PT today before 6pm, then roll to today noon through
// tomorrow noon after 6pm. Weekends match v2 by holding Friday noon through
// Monday noon until Monday's 6pm rollover.
//
// Order timestamps are stored as ShipStation wall-clock values stamped in UTC,
// so keep the query bounds as naive UTC noon values for the Pacific dates.
const FULFILLMENT_TIME_ZONE = 'America/Los_Angeles';

function getFulfillmentDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FULFILLMENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
  };
}

function addCalendarDaysUtc(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function naiveNoonUtcForFulfillmentDate(year: number, month: number, day: number) {
  // NB: returns *literal* noon-UTC, not noon-PT. Reason: orders are migrated
  // from v2's SQLite (which stored PT-local ISO strings) and the migration
  // labeled those PT clock values with `Z` rather than re-interpreting them
  // as PT moments. So `orders.order_date` in this database is PT-clock-time
  // wrapped in a UTC label. Comparing it against a PT-clock-as-UTC window
  // (this function) preserves the v2 semantic. Switching to true noon-PT-UTC
  // would shift the comparison off by 7-8 hours.
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function computeFulfillmentShiftWindow(now = new Date()): { from: Date; to: Date } {
  const ptNow = getFulfillmentDateParts(now);
  const dow = new Date(Date.UTC(ptNow.year, ptNow.month - 1, ptNow.day)).getUTCDay();
  const isAfterRollover = ptNow.hour >= 18;
  let startCalendarDate: { year: number; month: number; day: number };
  let endCalendarDate: { year: number; month: number; day: number };

  if (dow === 6) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -1);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 2);
  } else if (dow === 0) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -2);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 1);
  } else if (dow === 1 && !isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -3);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
  } else if (dow === 5 && isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 3);
  } else if (isAfterRollover) {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 1);
  } else {
    startCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, -1);
    endCalendarDate = addCalendarDaysUtc(ptNow.year, ptNow.month, ptNow.day, 0);
  }

  return {
    from: naiveNoonUtcForFulfillmentDate(
      startCalendarDate.year,
      startCalendarDate.month,
      startCalendarDate.day
    ),
    to: naiveNoonUtcForFulfillmentDate(
      endCalendarDate.year,
      endCalendarDate.month,
      endCalendarDate.day
    ),
  };
}

// v2-parity label — "Apr 21, 12pm PT" (comma, lowercase am/pm, no space).
// Formats with `timeZone: 'UTC'` because `naiveNoonUtcForFulfillmentDate`
// returns a Date whose UTC clock reads the desired PT clock value (see the
// comment on that function for why). Reading the same UTC clock back gives
// the right label.
function formatPtLabel(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const hour24 = Number(get('hour'));
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? 'pm' : 'am';
  return `${month} ${day}, ${hour12}${suffix} PT`;
}

// Daily stats for the Orders page throughput strip.
// Audit alignment with /init/counts (2026-05-12): operator reported the
// sidebar "Awaiting Shipment" count (65) and the strip "Need to Ship"
// count (67) disagreed. Root cause: the sidebar applies a fuller
// visibility predicate (active clients + non-hidden buckets) that the
// daily-stats query was missing. We now share the same predicate so
// the two numbers reflect the same conceptual set of operational work.
//
// Filters now applied here (matching /init/counts):
//   1. coalesce(c.active, true) = true     ← drops orders from a
//                                            disabled client
//   2. clients.name != 'api shipments'     ← drops the hidden internal
//                                            bucket (a technical client
//                                            used for sync plumbing)
//   3. store_id not in (excluded)          ← OR is a test-client order
//                                            (store_id is null + c.is_test)
// Previously the route applied only #3, so disabled-client / hidden-
// bucket orders inflated the strip without showing in the sidebar.
app.get(
  '/daily-stats',
  zValidator(
    'query',
    z.object({
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    // Current fulfillment intake: v2's PT noon-to-noon shift window, including
    // the Friday-noon to Monday-noon weekend hold.
    const shift = computeFulfillmentShiftWindow();
    const fromDate = q.dateFrom ? new Date(q.dateFrom) : shift.from;
    const toDate = q.dateTo ? new Date(q.dateTo) : shift.to;
    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    // Shared visibility predicate — identical shape to /init/counts so
    // sidebar and strip both count the same conceptual set. Inline
    // here (not extracted to a helper) so the SQL stays grep-friendly.
    // Inactive clients fall out; the 'api shipments' technical bucket
    // falls out; test-client orders (store_id is null + is_test) flow
    // through alongside real-store orders.
    const visibleOrderPredicate = sql`(
      (coalesce(c.is_test, false) = true and o.client_id is not null)
      or (
        o.store_id is not null
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
      )
    ) and coalesce(c.active, true) = true
    and not exists (
      select 1 from clients hidden_client
      where hidden_client.id = o.client_id
        and lower(hidden_client.name) = 'api shipments'
    )`;

    // totalOrders: all non-cancelled orders received inside the current
    // fulfillment intake window. The strip derives shipped as
    // totalOrders - needToShip, matching v2 daily-strip.js.
    const windowedRows = await db.execute<{
      total_orders: number;
    }>(sql`
      select count(*)::int as total_orders
      from orders o
      left join clients c on c.id = o.client_id
      where o.order_status <> 'cancelled'
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and ${visibleOrderPredicate}
    `);
    // needToShip: remaining same-day fulfillment work inside the intake
    // window. Bucket/external-shipped rules stay in the order list query.
    const backlogRows = await db.execute<{ need_to_ship: number }>(sql`
      select count(*)::int as need_to_ship
      from orders o
      left join clients c on c.id = o.client_id
      where o.order_status = 'awaiting_shipment'
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and ${visibleOrderPredicate}
    `);
    const upcomingRows = await db.execute<{ upcoming_orders: number }>(sql`
      select count(*)::int as upcoming_orders
      from orders o
      left join clients c on c.id = o.client_id
      where o.order_date > ${toIso}::timestamptz
        and o.order_status <> 'cancelled'
        and ${visibleOrderPredicate}
    `);
    const w = windowedRows[0];
    const b = backlogRows[0];
    const u = upcomingRows[0];
    return c.json({
      window: {
        from: fromIso,
        to: toIso,
        fromLabel: formatPtLabel(fromDate),
        toLabel: formatPtLabel(toDate),
      },
      totalOrders: w?.total_orders ?? 0,
      needToShip: b?.need_to_ship ?? 0,
      upcomingOrders: u?.upcoming_orders ?? 0,
    });
  }
);

app.get('/picklist', zValidator('query', picklistQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = q.dateFrom
    ? new Date(q.dateFrom).toISOString()
    : new Date(0).toISOString();
  const toIso = q.dateTo
    ? new Date(q.dateTo).toISOString()
    : new Date(Date.now() + 86400000).toISOString();
  const cid: number | null = q.clientId ?? null;
  const sid: number | null = q.storeId ?? null;
  const status = q.status;

  const rows = await db.execute<{
    client_id: number | null;
    client_name: string | null;
    sku: string;
    name: string | null;
    image_url: string | null;
    total_qty: number;
    order_count: number;
  }>(sql`
    select
      o.client_id                                   as client_id,
      coalesce(c.name, 'Unknown')                   as client_name,
      item->>'sku'                                  as sku,
      max(item->>'name')                            as name,
      max(nullif(item->>'imageUrl', ''))            as image_url,
      sum(coalesce((item->>'quantity')::int, 1))::int as total_qty,
      count(distinct o.id)::int                     as order_count
    from orders o
    left join clients c on c.id = o.client_id,
         jsonb_array_elements(o.items) item
    where (${status}::text is null or o.order_status = ${status}::text)
      and (
        (o.store_id is not null and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
        or c.is_test = true
      )
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and (${sid}::int is null or o.store_id = ${sid}::int)
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and item ? 'sku'
      and item->>'sku' is not null
      and item->>'sku' <> ''
    group by o.client_id, c.name, item->>'sku'
    order by client_name asc, total_qty desc
  `);

  return c.json({
    skus: rows,
    totalSkus: rows.length,
    totalUnits: rows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
  });
});

// GET /orders/by-number/:orderNumber  → { id, orderNumber, orderStatus }
//
// Lightweight lookup that resolves a marketplace-facing orderNumber
// (text — Amazon "111-XXX-XXX", eBay "10-XXX-XXX", PrepShip "TESTING-…",
// Shopify "#1234", etc.) to the local autoincrement PK. Used by the
// Packages page when a user clicks the order number embedded inside
// a package_ledger note ("Shipment XXX for order YYY") — the ledger
// table only stores the orderNumber as text, so the FE needs an
// explicit lookup before it can call onOpenOrder(localId).
//
// Route is mounted ABOVE the numeric-id catch-all so the literal
// `/by-number/...` segment matches first. Returns 404 if no row exists
// (e.g. the order was purged), letting the caller show a friendly
// "order no longer exists" toast instead of opening the drawer with
// stale data.
// GET /orders/distinct-skus
//
// Returns every distinct SKU that appears anywhere in the orders.items
// JSON arrays — across all statuses, all stores, all dates by default.
// Used to populate the global SKU filter dropdown on /orders so the
// list isn't capped by whatever fits on the current page (the previous
// behavior derived dropdown options from the in-memory orders array,
// so users only ever saw SKUs from the ~50 orders on page 1).
//
// Optional query params let callers narrow the set when needed:
//   ?status=awaiting_shipment   — only SKUs from awaiting orders
//   ?clientId=12                — only SKUs from this client
//   ?storeId=4                  — only SKUs from this store
//   ?dateFrom / ?dateTo         — bound by order_date range
//
// All filters are independent; omitting them returns the full universe.
//
// Excludes adjustment items (where item.adjustment is truthy) since
// those aren't real SKUs — they're discounts, fees, etc.
app.get('/distinct-skus', async (c) => {
  const status = c.req.query('status') ?? null;
  const clientIdRaw = c.req.query('clientId');
  const storeIdRaw = c.req.query('storeId');
  const dateFrom = c.req.query('dateFrom') ?? null;
  const dateTo = c.req.query('dateTo') ?? null;
  const includeInactiveRaw =
    c.req.query('includeInactiveClients') ?? c.req.query('includeInactive') ?? 'false';
  const includeInactiveClients = ['1', 'true', 'yes'].includes(includeInactiveRaw.toLowerCase());
  const cid = clientIdRaw ? Number.parseInt(clientIdRaw, 10) : null;
  const sid = storeIdRaw ? Number.parseInt(storeIdRaw, 10) : null;

  const rows = await db.execute<{ sku: string }>(sql`
    select distinct item->>'sku' as sku
    from orders o,
         jsonb_array_elements(o.items) item
    where item->>'sku' is not null
      and item->>'sku' <> ''
      and coalesce((item->>'adjustment')::boolean, false) = false
      and (
        (o.store_id is not null and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
        or exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
      )
      and (
        ${includeInactiveClients}::boolean = true
        or o.client_id is null
        or exists (
          select 1
          from clients owner_client
          where owner_client.id = o.client_id
            and coalesce(owner_client.active, true) = true
        )
      )
      and (${status}::text is null or o.order_status = ${status}::text)
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and (${sid}::int is null or o.store_id = ${sid}::int)
      and (${dateFrom}::timestamptz is null or o.order_date >= ${dateFrom}::timestamptz)
      and (${dateTo}::timestamptz is null or o.order_date <= ${dateTo}::timestamptz)
    order by sku asc
  `);

  // Drizzle execute() returns either array or { rows } depending on driver.
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  const skus = list
    .map((r: { sku: string }) => r.sku)
    .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);

  return c.json({ skus, count: skus.length });
});

app.get('/by-number/:orderNumber', async (c) => {
  // Decode in case the orderNumber contains URL-special characters
  // (unlikely for marketplace IDs, but defensive against a stray
  // "TESTING-" with a slash one day).
  const orderNumber = decodeURIComponent(c.req.param('orderNumber'));
  if (!orderNumber || orderNumber.length > 200) {
    return c.json({ error: 'Invalid orderNumber' }, 400);
  }
  const [row] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, orderStatus: orders.orderStatus })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  if (!row) return c.json({ error: 'Order not found' }, 404);
  return c.json(row);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const [overrides, shipmentRows] = await Promise.all([
    db
      .select()
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(shipments)
      .where(or(eq(shipments.orderId, id), eq(shipments.orderNumber, order.orderNumber)))
      .orderBy(desc(shipments.id)),
  ]);

  return c.json(buildOrderDetailPayload(order as Record<string, unknown>, overrides, shipmentRows));
});

// Alias of GET /orders/:id — old API exposed both shapes. Same payload.
app.get('/:id{[0-9]+}/full', async (c) => {
  const id = Number(c.req.param('id'));
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);
  const [overrides, shipmentRows] = await Promise.all([
    db
      .select()
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(shipments)
      .where(or(eq(shipments.orderId, id), eq(shipments.orderNumber, order.orderNumber)))
      .orderBy(desc(shipments.id)),
  ]);

  return c.json(buildOrderDetailPayload(order as Record<string, unknown>, overrides, shipmentRows));
});

const manualOrderNumberPart = z.union([z.string(), z.number()]).optional();

const manualOrderBody = z.object({
  shipToName: z.string().trim().min(1),
  shipToCompany: z.string().optional().default(''),
  shipToCountry: z.string().optional().default('US'),
  shipToAddress1: z.string().trim().min(1),
  shipToAddress2: z.string().optional().default(''),
  shipToAddress3: z.string().optional().default(''),
  shipToCity: z.string().trim().min(1),
  shipToState: z.string().trim().min(1),
  shipToPostalCode: z.string().trim().min(1),
  shipToPhone: z.string().optional().default(''),
  customerEmail: z.string().optional().default(''),
  orderNumber: z.string().optional().default(''),
  orderNumberAuto: z.boolean().optional().default(true),
  orderDate: z.string().optional().default(''),
  paidDate: z.string().optional().default(''),
  shippingPaid: manualOrderNumberPart,
  taxPaid: manualOrderNumberPart,
  totalPaid: manualOrderNumberPart,
  rateWeightLb: manualOrderNumberPart,
  rateWeightOz: manualOrderNumberPart,
  rateLength: manualOrderNumberPart,
  rateWidth: manualOrderNumberPart,
  rateHeight: manualOrderNumberPart,
  items: z.array(z.object({
    sku: z.string().optional().default(''),
    name: z.string().optional().default(''),
    quantity: z.coerce.number().positive().optional().default(1),
    price: z.coerce.number().nonnegative().optional().default(0),
  })).min(1),
});

function manualNumber(value: unknown, fallback = 0): number {
  const parsed = finiteNumberOrNull(value);
  return parsed == null ? fallback : parsed;
}

function manualDate(value: string | undefined): Date {
  if (value) {
    const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function manualOrderNumber(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\D/g, '')
    .slice(2, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MAN-${stamp}-${suffix}`;
}

async function ensureManualOrdersClient() {
  const [existing] = await db
    .select()
    .from(clients)
    .where(ilike(clients.name, 'Manual Orders'))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(clients)
      .set({ active: true, isTest: true, updatedAt: new Date() })
      .where(eq(clients.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(clients)
    .values({
      name: 'Manual Orders',
      storeIds: [],
      active: true,
      isTest: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!created) throw new Error('Manual Orders client could not be created');
  return created;
}

app.post('/manual', zValidator('json', manualOrderBody), async (c) => {
  const body = c.req.valid('json');
  const activeItems = body.items
    .map((item) => ({
      sku: item.sku.trim(),
      name: item.name.trim(),
      quantity: item.quantity,
      unitPrice: item.price,
      price: item.price,
      adjustment: false,
    }))
    .filter((item) => item.sku || item.name);

  if (activeItems.length === 0) {
    return c.json({ error: 'At least one line item is required' }, 400);
  }

  const manualClient = await ensureManualOrdersClient();
  const weightOz = (manualNumber(body.rateWeightLb) * 16) + manualNumber(body.rateWeightOz);
  const dims = {
    length: manualNumber(body.rateLength),
    width: manualNumber(body.rateWidth),
    height: manualNumber(body.rateHeight),
    units: 'inches',
  };
  const hasDims = dims.length > 0 && dims.width > 0 && dims.height > 0;
  const shippingAmount = manualNumber(body.shippingPaid);
  const taxAmount = manualNumber(body.taxPaid);
  const itemSubtotal = activeItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const orderTotal = manualNumber(body.totalPaid, itemSubtotal + shippingAmount + taxAmount);
  const orderNumber = body.orderNumberAuto || !body.orderNumber.trim()
    ? manualOrderNumber()
    : body.orderNumber.trim();
  const now = new Date();
  const raw = {
    source: 'manual',
    manual: true,
    test: true,
    orderNumber,
    orderDate: body.orderDate,
    paidDate: body.paidDate,
    customerEmail: body.customerEmail.trim() || null,
    shipTo: {
      name: body.shipToName,
      company: body.shipToCompany.trim() || null,
      street1: body.shipToAddress1,
      street2: body.shipToAddress2.trim() || null,
      street3: body.shipToAddress3.trim() || null,
      city: body.shipToCity,
      state: body.shipToState,
      postalCode: body.shipToPostalCode,
      country: body.shipToCountry.trim() || 'US',
      phone: body.shipToPhone.trim() || null,
      residential: true,
    },
    weight: weightOz > 0 ? { value: weightOz, units: 'ounces' } : null,
    dimensions: hasDims ? dims : null,
    items: activeItems,
    orderTotal,
    shippingAmount,
    taxAmount,
  };

  const [created] = await db
    .insert(orders)
    .values({
      externalOrderId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      clientId: manualClient.id,
      orderNumber,
      orderStatus: 'awaiting_shipment',
      orderDate: manualDate(body.orderDate),
      storeId: null,
      customerEmail: body.customerEmail.trim() || null,
      shipToName: body.shipToName,
      shipToCity: body.shipToCity,
      shipToState: body.shipToState,
      shipToPostalCode: body.shipToPostalCode,
      weightOz: weightOz > 0 ? weightOz : null,
      orderTotal: orderTotal.toFixed(2),
      shippingAmount: shippingAmount.toFixed(2),
      items: activeItems,
      raw,
      externallyShipped: false,
      externallyFulfilledVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!created) return c.json({ error: 'Manual order could not be created' }, 500);

  const [overrides] = await db
    .insert(orderOverrides)
    .values({
      orderId: created.id,
      residential: true,
      rateWeightOz: weightOz > 0 ? weightOz : null,
      rateDimsL: hasDims ? dims.length : null,
      rateDimsW: hasDims ? dims.width : null,
      rateDimsH: hasDims ? dims.height : null,
      bestRateDims: hasDims ? `${dims.length}x${dims.width}x${dims.height}` : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orderOverrides.orderId,
      set: {
        residential: true,
        rateWeightOz: weightOz > 0 ? weightOz : null,
        rateDimsL: hasDims ? dims.length : null,
        rateDimsW: hasDims ? dims.width : null,
        rateDimsH: hasDims ? dims.height : null,
        bestRateDims: hasDims ? `${dims.length}x${dims.width}x${dims.height}` : null,
        updatedAt: now,
      },
    })
    .returning();

  return c.json({
    data: {
      order: created,
      overrides: overrides ?? null,
      client: manualClient,
    },
  }, 201);
});

const patchBody = z.object({
  residential: z.boolean().nullable().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  trackingNumber: z.string().nullable().optional(),
  selectedPid: z.number().int().nullable().optional(),
  selectedPackageId: z.string().nullable().optional(),
  bestRateJson: z.unknown().optional(),
  bestRateDims: z.string().nullable().optional(),
  // v2-parity: clients may send a canonical selectedRateJson alongside
  // selectedPackageId when the user picks a rate in the Rate Browser.
  // We normalize it through normalizeOrderSelectedRateDto() before
  // the shipments insert consumes it (labels.ts).
  selectedRateJson: z.unknown().optional(),
  shippingAccount: z.string().nullable().optional(),
  externallyShipped: z.boolean().optional(),
  externallyShippedSource: z.string().nullable().optional(),
});

app.patch('/:id{[0-9]+}', zValidator('json', patchBody), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');

  // Lockdown: shipped/cancelled orders cannot be modified. Returns 403
  // before any update logic runs.
  const guard = await assertOrderEditable(c, id);
  if (!guard.ok) return guard.response;

  const [existing] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'Order not found' }, 404);

  // Split the body: externallyShipped lives on the `orders` table;
  // everything else (including externallyShippedSource) lives on order_overrides.
  // selectedRateJson is not a column on order_overrides — drop it from the
  // overrides payload (it rides along into shipments via the label flow).
  const { externallyShipped, selectedRateJson, ...overridesBody } = body;

  // v2-parity: canonicalize incoming bestRateJson before persisting.
  // Accepts raw ShipStation shapes (snake_case) or the already-normalized DTO.
  if (overridesBody.bestRateJson !== undefined && overridesBody.bestRateJson !== null) {
    try {
      overridesBody.bestRateJson = normalizeOrderBestRateDto(
        overridesBody.bestRateJson,
        'bestRateJson',
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // Normalize the selected rate the same way so downstream consumers see a
  // canonical shape. v4 has no column for it on order_overrides; currently
  // this is a no-op persistence-wise (future work: persist to shipments at
  // label-create time). Kept for request-level validation.
  if (selectedRateJson !== undefined && selectedRateJson !== null) {
    try {
      normalizeOrderSelectedRateDto(selectedRateJson, undefined, 'selectedRateJson');
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  if (externallyShipped !== undefined) {
    await db
      .update(orders)
      .set({ externallyShipped, updatedAt: new Date() })
      .where(eq(orders.id, id));
  }

  const bestRateAt = overridesBody.bestRateJson !== undefined ? new Date() : undefined;
  const [row] = await db
    .insert(orderOverrides)
    .values({ orderId: id, ...overridesBody, bestRateAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orderOverrides.orderId,
      set: { ...overridesBody, bestRateAt, updatedAt: new Date() },
    })
    .returning();

  return c.json(row);
});

// v2-parity POST aliases. v2's apiClient hits dedicated action endpoints per
// field (POST /orders/:id/residential, .../selected-pid, etc.) — v4's canonical
// update path is a PATCH with the field in the body. These aliases forward to
// the same upsert logic so v2 callers don't need to know the v4 shape.

async function applyOverridesPatch(
  id: number,
  patch: Partial<typeof orderOverrides.$inferInsert>,
) {
  const [existing] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return null;
  const bestRateAt = patch.bestRateJson !== undefined ? new Date() : undefined;
  const [row] = await db
    .insert(orderOverrides)
    .values({ orderId: id, ...patch, bestRateAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orderOverrides.orderId,
      set: { ...patch, bestRateAt, updatedAt: new Date() },
    })
    .returning();
  return row;
}

app.post(
  '/:id{[0-9]+}/residential',
  zValidator('json', z.object({ residential: z.boolean().nullable() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const row = await applyOverridesPatch(id, { residential: c.req.valid('json').residential });
    if (!row) return c.json({ error: 'Order not found' }, 404);
    return c.json({ data: row });
  }
);

app.post(
  '/:id{[0-9]+}/selected-pid',
  zValidator('json', z.object({ selectedPid: z.number().int().nullable() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const row = await applyOverridesPatch(id, { selectedPid: c.req.valid('json').selectedPid });
    if (!row) return c.json({ error: 'Order not found' }, 404);
    return c.json({ data: row });
  }
);

app.post(
  '/:id{[0-9]+}/selected-package-id',
  // v2 accepts either {packageId} or {selectedPid}; coalesce both into selectedPackageId (text).
  zValidator(
    'json',
    z.object({
      packageId: z.union([z.string(), z.number()]).nullable().optional(),
      selectedPid: z.union([z.string(), z.number()]).nullable().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');
    const raw = body.packageId ?? body.selectedPid ?? null;
    const selectedPackageId = raw === null ? null : String(raw);
    const row = await applyOverridesPatch(id, { selectedPackageId });
    if (!row) return c.json({ error: 'Order not found' }, 404);
    return c.json({ data: row });
  }
);

app.post(
  '/:id{[0-9]+}/best-rate',
  zValidator(
    'json',
    z.object({
      bestRateJson: z.unknown(),
      bestRateDims: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');

    // v2-parity: canonicalize + hard-assert that persisted best rate has
    // carrierCode + serviceCode. Downstream label creation and invoicing
    // depend on these fields being present. Any-shape (ShipStation raw or
    // pre-normalized) → canonical OrderBestRateDto.
    let canonical;
    try {
      canonical = assertPersistedOrderBestRateDto(body.bestRateJson, 'bestRateJson');
    } catch (err) {
      if (err instanceof InputValidationError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: (err as Error).message }, 400);
    }

    const row = await applyOverridesPatch(id, {
      bestRateJson: canonical,
      bestRateDims: body.bestRateDims ?? null,
    });
    if (!row) return c.json({ error: 'Order not found' }, 404);
    return c.json({ data: row });
  }
);

app.post(
  '/:id{[0-9]+}/shipped-external',
  zValidator(
    'json',
    z.object({
      externalShipped: z.boolean().optional(),
      externallyShipped: z.boolean().optional(),
      source: z.string().nullable().optional(),
      // NEW — optional fields for the "notify customer / notify
      // marketplace" toggles added to the side-panel popover. None of
      // these are required; when all of them are absent the route
      // behaves exactly like before (local DB flip + inventory
      // deduction, no ShipStation call). Backward compatible.
      trackingNumber: z.string().nullable().optional(),
      carrierCode: z.string().nullable().optional(),
      notifyCustomer: z.boolean().optional(),
      notifyMarketplace: z.boolean().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');
    const flag = body.externallyShipped ?? body.externalShipped ?? true;

    const [existing] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (!existing) return c.json({ error: 'Order not found' }, 404);

    // Flip both externallyShipped AND orderStatus when transitioning
    // INTO the externally-shipped state. The previous version updated
    // only externallyShipped, leaving order_status='awaiting_shipment'.
    // Net effect: marked-shipped orders stayed in the Awaiting tab
    // forever (the user's reported bug — 'i see 25 test orders and i
    // expected is 23'). The Awaiting list query filters by
    // order_status, not externallyShipped, so the flag was effectively
    // invisible to the operator.
    //
    // assertOrderEditable above guards this transition — the order
    // MUST be awaiting before this runs, so we're never overwriting
    // a real shipment status.
    //
    // Per user override `unlock shipped data` (this is a forward-only
    // awaiting → shipped transition, NOT a write to already-shipped
    // data; assertOrderEditable structurally enforces that).
    await db
      .update(orders)
      .set({
        externallyShipped: flag,
        // Forward transition only: setting flag=true moves to shipped.
        // The hypothetical flag=false unmark path doesn't change
        // status (we don't know what it was before the mark — could
        // have been awaiting OR cancelled OR already shipped).
        ...(flag ? { orderStatus: 'shipped' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id));

    const row = await applyOverridesPatch(id, {
      externallyShippedSource: body.source ?? null,
    });
    if (flag) {
      try {
        await deductInventoryForOrder(existing, {
          source: body.source ? `external:${body.source}` : 'external',
        });
      } catch (err) {
        console.warn('[orders] external shipped inventory deduction failed:', err);
      }
    }

    // Optional ShipStation v1 markasshipped call.
    //
    // We only invoke ShipStation when the user explicitly opted into
    // at least one notify channel — most "Mark as Shipped" usage is
    // pure local-state tracking ("I already shipped this somewhere
    // else, just close the loop in PrepShip") and shouldn't generate
    // duplicate marketplace pings. The frontend popover's Notify
    // Customer / Notify Marketplace toggles drive this.
    //
    // Failure to notify is logged but does NOT fail the request — the
    // local flag is already flipped, the inventory is already deducted,
    // and re-running the call would just create a duplicate ack. Better
    // to surface the warning in Render logs than to leave the order
    // in a half-marked state on retry.
    const shouldNotify =
      flag && (body.notifyCustomer === true || body.notifyMarketplace === true);
    let notifyResult: { ok: boolean; reason?: string } = { ok: false, reason: 'not requested' };

    if (shouldNotify) {
      const ssUpstreamOrderId = asSSUpstreamOrderId(existing.externalOrderId);
      if (!ssUpstreamOrderId) {
        notifyResult = { ok: false, reason: 'order has no upstream ShipStation ID — sync may be incomplete' };
      } else {
        try {
          const creds = await loadClientCredentials(existing.clientId);
          const shipDate = new Date().toISOString().slice(0, 10);
          await ssMarkOrderShippedV1(
            {
              orderId: ssUpstreamOrderId,
              carrierCode: body.carrierCode ?? null,
              trackingNumber: body.trackingNumber ?? '',
              shipDate,
              notifyCustomer: body.notifyCustomer === true,
              notifySalesChannel: body.notifyMarketplace === true,
            },
            { apiKey: creds.apiKey ?? undefined, apiSecret: creds.apiSecret ?? undefined }
          );
          notifyResult = { ok: true };
          console.info(
            `[orders] shipped-external notify ok orderId=${id} ssOrderId=${ssUpstreamOrderId} ` +
              `customer=${body.notifyCustomer === true} marketplace=${body.notifyMarketplace === true}`
          );
        } catch (notifyErr) {
          const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          notifyResult = { ok: false, reason: msg };
          console.warn(
            `[orders] shipped-external notify FAILED orderId=${id} reason=${msg}`
          );
        }
      }
    }

    return c.json({ data: row, notify: notifyResult });
  }
);

const saveDimsBody = z.object({
  l: z.number().nonnegative().optional(),
  w: z.number().nonnegative().optional(),
  h: z.number().nonnegative().optional(),
  weightOz: z.number().nonnegative().optional(),
}).refine(
  (body) =>
    body.l !== undefined ||
    body.w !== undefined ||
    body.h !== undefined ||
    body.weightOz !== undefined,
  { message: 'At least one dimension or weight is required' },
);

app.post(
  '/:id{[0-9]+}/save-dims',
  zValidator('json', saveDimsBody),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');

    const [existing] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (!existing) return c.json({ error: 'Order not found' }, 404);

    const patch: Record<string, unknown> = {};
    if (body.l !== undefined) patch.rateDimsL = body.l;
    if (body.w !== undefined) patch.rateDimsW = body.w;
    if (body.h !== undefined) patch.rateDimsH = body.h;
    if (body.weightOz !== undefined) patch.rateWeightOz = body.weightOz;

    const [row] = await db
      .insert(orderOverrides)
      .values({ orderId: id, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: orderOverrides.orderId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();

    return c.json({ data: row });
  }
);

app.get('/:id{[0-9]+}/dims', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db
    .select({
      rateDimsL: orderOverrides.rateDimsL,
      rateDimsW: orderOverrides.rateDimsW,
      rateDimsH: orderOverrides.rateDimsH,
      rateWeightOz: orderOverrides.rateWeightOz,
    })
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, id))
    .limit(1);

  if (
    !row ||
    (row.rateDimsL == null &&
      row.rateDimsW == null &&
      row.rateDimsH == null &&
      row.rateWeightOz == null)
  ) {
    return c.json({ data: null });
  }

  return c.json({
    data: {
      l: row.rateDimsL,
      w: row.rateDimsW,
      h: row.rateDimsH,
      weightOz: row.rateWeightOz,
    },
  });
});

const exportQuery = z.object({
  status: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  clientId: z.coerce.number().int().optional(),
});

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function compactCsvValue(parts: unknown[], separator = ', '): string {
  return parts
    .map((part) => {
      if (part === null || part === undefined) return '';
      const value = String(part).trim();
      return value === 'null' || value === 'undefined' ? '' : value;
    })
    .filter(Boolean)
    .join(separator);
}

function formatCsvNumber(value: unknown, decimals = 2): string | number {
  const n = finiteNumberOrNull(value);
  if (n === null) return '';
  return Number.isInteger(n) ? n : Number(n.toFixed(decimals));
}

function formatCsvDimensions(
  length: unknown,
  width: unknown,
  height: unknown
): string {
  const dims = [
    ['L', finiteNumberOrNull(length)],
    ['W', finiteNumberOrNull(width)],
    ['H', finiteNumberOrNull(height)],
  ] as const;
  if (dims.every(([, value]) => value !== null)) {
    return dims.map(([, value]) => formatCsvNumber(value)).join(' x ');
  }
  return dims
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${formatCsvNumber(value)}`)
    .join(' ');
}

function formatCsvItems(items: Array<Record<string, unknown>>): string {
  return items
    .map((item) => {
      const qty = finiteNumberOrNull(item.quantity);
      const sku = stringOrNull(item.sku);
      const name = stringOrNull(item.name);
      return compactCsvValue([qty !== null && qty > 0 ? `${qty}x` : '', sku, name], ' - ');
    })
    .filter(Boolean)
    .join(' | ');
}

function formatCsvSkuList(items: Array<Record<string, unknown>>): string {
  return [
    ...new Set(
      items
        .map((item) => stringOrNull(item.sku))
        .filter((sku): sku is string => Boolean(sku))
    ),
  ].join(', ');
}

app.get('/export', zValidator('query', exportQuery), async (c) => {
  const q = c.req.valid('query');

  // Auto-exclude is_test clients unless one is explicitly requested — keeps
  // sandbox orders out of the CSV. Mirrors the logic in GET / and
  // /daily-stats so all three surfaces behave consistently.
  let testExcludeFilter: ReturnType<typeof sql.raw> | undefined;
  if (q.clientId === undefined) {
    const testClientRows = await db.execute<{ id: number }>(
      sql`select id from clients where is_test = true`
    );
    if (testClientRows.length) {
      const ids = testClientRows.map((r) => r.id).join(',');
      testExcludeFilter = sql.raw(
        `(client_id is null or client_id not in (${ids}))`
      );
    }
  }

  const where = and(
    ...[
      q.status ? eq(orders.orderStatus, q.status) : undefined,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      notInArray(orders.storeId, [...EXCLUDED_STORE_IDS]),
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
      testExcludeFilter,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const rows = await db
    .select({ order: orders, overrides: orderOverrides })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(where)
    .orderBy(desc(orders.orderDate))
    .limit(5000);

  // Latest non-voided shipment per order (for label cost / tracking / created).
  // Fall back by order number so orphaned ShipStation shipment rows still
  // populate shipped columns, matching v2's joined shipment display.
  const orderIds = rows.map((r) => r.order.id);
  const orderNumbers = [
    ...new Set(rows.map((r) => r.order.orderNumber).filter(Boolean)),
  ];
  const shipmentsByOrder = new Map<number, ExportShipmentRow>();
  const shipmentsByOrderNumber = new Map<string, ExportShipmentRow>();
  if (orderIds.length > 0 || orderNumbers.length > 0) {
    try {
      const shipmentPredicates = [
        orderIds.length
          ? sql`order_id in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})`
          : undefined,
        orderNumbers.length
          ? sql`order_number in (${sql.join(orderNumbers.map((n) => sql`${n}`), sql`, `)})`
          : undefined,
      ].filter(<T>(x: T | undefined): x is T => x !== undefined);
      const ships = await db.execute<ExportShipmentRow>(sql`
        select
          order_id,
          order_number,
          tracking_number,
          carrier_code,
          service_code,
          ship_date,
          create_date,
          label_created_at,
          cost,
          label_cost,
          other_cost,
          selected_rate_json
        from shipments
        where (${sql.join(shipmentPredicates, sql` or `)})
          and coalesce(voided, false) = false
        order by id desc
      `);
      for (const s of ships) {
        if (s.order_id != null && !shipmentsByOrder.has(s.order_id)) {
          shipmentsByOrder.set(s.order_id, s);
        }
        if (s.order_id == null && s.order_number && !shipmentsByOrderNumber.has(s.order_number)) {
          shipmentsByOrderNumber.set(s.order_number, s);
        }
      }
    } catch (err) {
      // If shipments table is missing, has different columns, or the query
      // shape is wrong on this DB, log and continue without label data.
      console.warn('[orders/export] shipments lookup failed; carrying on without label cols:', err);
    }
  }

  const header = [
    'Order ID',
    'Order #',
    'Order Date',
    'Store ID',
    'Client ID',
    'Status',
    'Recipient',
    'Recipient Company',
    'Recipient Phone',
    'Ship To Address',
    'Ship To City',
    'Ship To State',
    'Ship To Postal Code',
    'Ship To Country',
    'Items',
    'Item Name',
    'SKU',
    'SKU List',
    'Qty',
    'Weight (oz)',
    'Carrier',
    'Service',
    'Carrier Account',
    'Package Type',
    'Package Dims (LxWxH)',
    'Delivery Days',
    'Estimated Delivery',
    'Tracking #',
    'Order Total',
    'Shipping Paid',
    'Best Rate',
    'Label Cost',
    'Ship Margin',
    'Label Created',
    'Shipped Date',
    'Age (hrs)',
  ];

  const lines: string[] = [header.join(',')];
  const now = Date.now();

  for (const { order, overrides } of rows) {
    const items = Array.isArray(order.items)
      ? (order.items as Array<Record<string, unknown>>)
      : [];
    const firstItem = items[0] ?? null;
    const itemName = stringOrNull(firstItem?.name) ?? '';
    const itemSku = stringOrNull(firstItem?.sku) ?? '';
    const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const rawOrder = recordOrNull(order.raw) ?? {};
    const rawShipTo = recordOrNull(rawOrder.shipTo) ?? {};
    const shipToCity = stringOrNull(order.shipToCity) ?? stringOrNull(rawShipTo.city) ?? '';
    const shipToState = stringOrNull(order.shipToState) ?? stringOrNull(rawShipTo.state) ?? '';
    const shipToPostalCode =
      stringOrNull(order.shipToPostalCode) ??
      stringOrNull(rawShipTo.postalCode) ??
      stringOrNull(rawShipTo.postal_code) ??
      '';
    const shipToCountry =
      stringOrNull(rawShipTo.country) ??
      stringOrNull(rawShipTo.countryCode) ??
      stringOrNull(rawShipTo.country_code) ??
      '';
    const shipToAddress = compactCsvValue([
      rawShipTo.street1,
      rawShipTo.street2,
      rawShipTo.street3,
      compactCsvValue([shipToCity, shipToState, shipToPostalCode], ' '),
      shipToCountry,
    ]);

    const ship = shipmentsByOrder.get(order.id) ?? shipmentsByOrderNumber.get(order.orderNumber) ?? null;
    const isShippedExport = q.status === 'shipped' || order.orderStatus === 'shipped';
    const selectedRateObj =
      ship?.selected_rate_json && typeof ship.selected_rate_json === 'object'
        ? (ship.selected_rate_json as Record<string, unknown>)
        : null;
    const bestRateObj =
      isShippedExport
        ? selectedRateObj
        : selectedRateObj ?? (overrides?.bestRateJson as Record<string, unknown> | null | undefined);
    const normalizedBestRate = normalizeListBestRate(bestRateObj);
    const shipmentTotalCost =
      ship?.cost != null
        ? Number(ship.cost) + (ship.other_cost != null ? Number(ship.other_cost) : 0)
        : null;
    const labelCost = ship?.label_cost ?? (shipmentTotalCost != null ? shipmentTotalCost.toFixed(2) : '');
    const bestRateAmount = normalizedBestRate?.amount ?? (isShippedExport ? labelCost : '');

    const tracking = ship?.tracking_number ?? (isShippedExport ? '' : overrides?.trackingNumber ?? '');
    const labelCreated = ship?.label_created_at ?? ship?.create_date ?? ship?.ship_date ?? '';
    const carrier = normalizedBestRate?.carrierCode ?? ship?.carrier_code ?? '';
    const service =
      normalizedBestRate?.serviceName ??
      normalizedBestRate?.serviceCode ??
      ship?.service_code ??
      '';
    const carrierAccount =
      normalizedBestRate?.providerAccountNickname ??
      normalizedBestRate?.carrierNickname ??
      '';
    const packageType = normalizedBestRate?.packageType ?? '';
    const packageDims = formatCsvDimensions(
      overrides?.rateDimsL,
      overrides?.rateDimsW,
      overrides?.rateDimsH
    );
    const effectiveWeightOz = overrides?.rateWeightOz ?? order.weightOz;

    let shipMargin = '';
    if (labelCost !== '' && bestRateAmount !== '' && bestRateAmount != null) {
      const m = Number(labelCost) - Number(bestRateAmount);
      if (Number.isFinite(m)) shipMargin = m.toFixed(2);
    }

    let ageHrs: string | number = '';
    if (order.orderDate) {
      const t = new Date(order.orderDate).getTime();
      if (!Number.isNaN(t)) ageHrs = Math.round((now - t) / 3_600_000);
    }

    lines.push(
      [
        order.id,
        order.orderNumber,
        order.orderDate,
        order.storeId,
        order.clientId,
        order.orderStatus,
        order.shipToName,
        rawShipTo.company,
        rawShipTo.phone,
        shipToAddress,
        shipToCity,
        shipToState,
        shipToPostalCode,
        shipToCountry,
        formatCsvItems(items),
        itemName,
        itemSku,
        formatCsvSkuList(items),
        totalQty || '',
        effectiveWeightOz,
        carrier,
        service,
        carrierAccount,
        packageType,
        packageDims,
        normalizedBestRate?.deliveryDays ?? '',
        normalizedBestRate?.estimatedDelivery ?? '',
        tracking,
        order.orderTotal,
        order.shippingAmount,
        bestRateAmount,
        labelCost,
        shipMargin,
        labelCreated,
        ship?.ship_date ?? '',
        ageHrs,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const body = `\ufeff${lines.join('\r\n')}\r\n`;
  const timestamp = new Date().toISOString().slice(0, 10);
  const statusLabel = q.status ? `-${q.status}` : '';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename=orders${statusLabel}-${timestamp}.csv`,
    },
  });
});

// POST /orders/bulk-assign — admin-only. Body either:
//   { orderIds: number[], userId: string, email: string } → assign
//   { orderIds: number[], userId: null, email: null }     → unassign
// Updates orders.assigned_to_user_id / email / at for every id.
const bulkAssignBody = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(500),
  userId: z.string().min(1).nullable(),
  email: z.string().email().nullable(),
});

app.post(
  '/bulk-assign',
  zValidator('json', bulkAssignBody),
  async (c) => {
    const callerEmail = c.get('email' as never) as string | undefined;
    if (!isAdminEmail(callerEmail)) {
      return c.json({ error: 'Only admins can assign orders' }, 403);
    }

    const { orderIds, userId, email } = c.req.valid('json');
    if ((userId == null) !== (email == null)) {
      return c.json({ error: 'userId and email must both be set or both null' }, 400);
    }

    const updated = await db
      .update(orders)
      .set({
        assignedToUserId: userId,
        assignedToEmail: email,
        assignedAt: userId ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(inArray(orders.id, orderIds))
      .returning({ id: orders.id });

    return c.json({
      updated: updated.length,
      requested: orderIds.length,
      assignedTo: userId ? { userId, email } : null,
    });
  }
);

export default app;
