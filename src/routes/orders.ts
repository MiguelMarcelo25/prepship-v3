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
const visibleStorePredicate = sql`(
  (${orders.storeId} is not null and ${orders.storeId} not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
  or exists (
    select 1 from ${clients} test_client
    where test_client.id = ${orders.clientId}
      and test_client.is_test = true
  )
) and (
  ${orders.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${orders.clientId}
      and coalesce(owner_client.active, true) = true
  )
)`;

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
    // v2 LegacySyncStatusDto parity fields
    status: lastSync ? 'done' : 'idle',
    mode: lastSync ? 'incremental' : 'idle',
    error: null as string | null,
    page: 0,
    total: 0,
    count: 0,
    lastSync,
    ratesCached: rateCount?.count ?? 0,
    ratePrefetchRunning: false,
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

  const where = and(
    ...[
      assigneeFilter,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      visibleStorePredicate,
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
  return c.json(result);
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  excludeClientId: z.string().optional(),
  hideTestOrders: z.coerce.boolean().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  search: z.string().optional(),
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
  const search = q.search?.trim();
  const searchPattern = search ? `%${search}%` : null;

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
      visibleStorePredicate,
      excludeIds.length > 0 && q.clientId === undefined
        ? notInArray(orders.clientId, excludeIds)
        : undefined,
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
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

  // No ROW_NUMBER() dedup: orders.external_order_id is already UNIQUE, so
  // ShipStation's orderId is the true key. Two rows with the same order_number
  // are legitimately distinct (different store / orderId) — v2 never collapses
  // by order_number and neither should we.
  const [joined, countRows] = await Promise.all([
    db
      .select({ order: orderListSelect, overrides: orderOverrides })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(where)
      .orderBy(desc(orders.orderDate))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(where),
  ]);

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
  if (pageOrderIds.length || pageOrderNumbers.length) {
    const shipmentPredicates = [
      pageOrderIds.length
        ? sql`order_id in (${sql.join(pageOrderIds.map((id) => sql`${id}`), sql`, `)})`
        : undefined,
      pageOrderNumbers.length
        ? sql`order_number in (${sql.join(pageOrderNumbers.map((n) => sql`${n}`), sql`, `)})`
        : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined);
    const shipRows = await db.execute<LatestShipmentRow>(sql`
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
        label_url,
        label_shipment_id,
        provider_account_id,
        provider_account_nickname,
        selected_rate_json
      from shipments
      where (${sql.join(shipmentPredicates, sql` or `)})
        ${q.status === 'cancelled' ? sql`` : sql`and coalesce(voided, false) = false`}
      order by id desc
    `);
    for (const s of shipRows) {
      if (s.order_id != null && !latestShipByOrderId.has(s.order_id)) {
        latestShipByOrderId.set(s.order_id, s);
      }
      if (s.order_id == null && s.order_number && !latestShipByOrderNumber.has(s.order_number)) {
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
  const total = countRows[0]?.count ?? 0;
  return c.json(paginated(rows, total, q));
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
// V2 parity: the three counts only apply the configured excluded store IDs.
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

    // totalOrders: all non-cancelled orders received inside the current
    // fulfillment intake window. The strip derives shipped as
    // totalOrders - needToShip, matching v2 daily-strip.js.
    const windowedRows = await db.execute<{
      total_orders: number;
    }>(sql`
      select
        count(*) filter (where order_status <> 'cancelled')::int as total_orders
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        and store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
    `);
    // needToShip: remaining same-day fulfillment work inside the intake
    // window. Bucket/external-shipped rules stay in the order list query.
    const backlogRows = await db.execute<{ need_to_ship: number }>(sql`
      select count(*)::int as need_to_ship
      from orders o
      where o.order_status = 'awaiting_shipment'
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
    `);
    const upcomingRows = await db.execute<{ upcoming_orders: number }>(sql`
      select count(*)::int as upcoming_orders
      from orders
      where order_date > ${toIso}::timestamptz
        and order_status <> 'cancelled'
        and store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
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

    await db
      .update(orders)
      .set({ externallyShipped: flag, updatedAt: new Date() })
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
    'Item Name',
    'SKU',
    'Qty',
    'Weight (oz)',
    'Ship To',
    'Carrier',
    'Service',
    'Tracking #',
    'Order Total',
    'Best Rate',
    'Label Cost',
    'Ship Margin',
    'Label Created',
    'Age (hrs)',
    'Raw API (JSON)',
    'Best Rate JSON',
  ];

  const lines: string[] = [header.join(',')];
  const now = Date.now();

  for (const { order, overrides } of rows) {
    const items = Array.isArray(order.items)
      ? (order.items as Array<Record<string, unknown>>)
      : [];
    const firstItem = items[0] ?? null;
    const itemName = firstItem?.name ?? '';
    const itemSku = firstItem?.sku ?? '';
    const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const shipTo = [order.shipToCity, order.shipToState].filter(Boolean).join(', ');

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
    const service = normalizedBestRate?.serviceCode ?? ship?.service_code ?? '';

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
        itemName,
        itemSku,
        totalQty || '',
        order.weightOz,
        shipTo,
        carrier,
        service,
        tracking,
        order.orderTotal,
        bestRateAmount,
        labelCost,
        shipMargin,
        labelCreated,
        ageHrs,
        order.raw ? JSON.stringify(order.raw) : '',
        bestRateObj ? JSON.stringify(bestRateObj) : '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const body = lines.join('\r\n') + '\r\n';
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
