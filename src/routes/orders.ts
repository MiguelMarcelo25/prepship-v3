import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orderOverrides, orders } from '../db/schema/orders';
import { rateCache } from '../db/schema/rates';
import { shipments } from '../db/schema/shipments';
import { orderCompetitiveRate } from '../db/schema/order-competitive-rate';
// PS-798 (slice 2b): per-client shipping markup (billing_config) for the Best Rate column reconciliation.
import { billingConfig } from '../db/schema/billing';
import { ensureOrderCompetitiveRateSchema } from '../db/ensure-order-competitive-rate';
// PS-207 (B): canonical dims-identity key — shared with the billing box
// resolver so order-side coherence and billing-side resolution can't drift.
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import { getSyncStatus } from '../services/order-sync';
import { enqueueManualOrderSyncJob } from '../services/sync-job-queue';
import { getActiveBackfillJob, getLatestBackfillJob, startBackfillBestRates, startBackfillBestRatesForOrderIds } from '../services/rates-backfill';
// PS-136: the manual mark-shipped-externally transition (status flip + inventory deduction +
// ShipStation notify) is owned by this canonical service; the route delegates after assertOrderEditable.
import { markOrderShippedExternally } from '../services/fulfillment/mark-shipped-externally';
import { resolveOrdersStatusScope } from '../services/orders-search-scope';
// Per user override unlock shipped data on 2026-07-14: locked order DTO assembly now delegates
// to the backend read-model owner; editability guards and mutation authorization stay in this route.
import {
  buildCanonicalOrderModel,
  buildOrderBulkSnapshotDto,
  buildOrderDetailPayload,
  normalizeOrderBulkSnapshotIds,
  orderShippingEligibilityContext,
  resolveLegacyClientId,
  sanitizeAwaitingOverridesForShippingEligibility,
  shippingRateEligibilityReason,
} from '../services/orders-read-model';
import { loadClientIsTest } from '../services/fulfillment/test-label-policy';
// Per user override unlock shipped data on 2026-07-14: locked mutation routes retain
// assertOrderEditable and delegate override/rate commands only after it succeeds.
import {
  applyBestRateForOrder,
  applyBoxDimsCoherence,
  applyEditableOrderPatch,
  applyOrderOverridesPatch,
  saveBestRateForOrder,
} from '../services/orders-overrides-command';
import type {
  OrderEditWriteAuthorization,
  OrderEditWriteFailure,
} from '../services/order-editable-write';
// PS-219 (per user override unlock shipped data on 2026-06-13): read-only,
// backend-owned label voidability for the operator Void Label UI.
import { resolveOrderLabelVoidability } from '../services/label-voidability';
import { loadOrderTrackingSummary } from '../services/shipment-tracking';
// Per user override unlock shipped data on 2026-05-23: shipped rows receive a
// read-only return summary; order/shipments mutation guards remain unchanged.
import { loadReturnOrderSummaries } from '../services/return-order-read-model';
import { replaceOrderItemsForOrders } from '../services/order-items';
import {
  getComboPackageDefaultForOrder,
  resolveOrderPackageFacts,
  saveComboPackageDefault,
} from '../services/combo-package-defaults';
import { analyticsCacheKey, getAnalyticsCache, setAnalyticsCache } from '../services/analytics-cache';
// PS-136: ssMarkOrderShippedV1 / asSSUpstreamOrderId / loadClientCredentials moved with the
// shipped-external logic into src/services/fulfillment/mark-shipped-externally.ts (their only
// consumer in this route). deductInventoryForOrder likewise — all now imported by that service.
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
  normalizeListBestRate,
} from '../services/order-rate-dto';
// PS-292 (items 2/4): backend-owned house-tuple verdict + half-house reject at the best-rate SAVE
// boundary. clientHouseAccountEnabled gives the per-client opt-in (default-OFF). The reject is gated
// behind the HOUSE_TUPLE_SAVE_GUARD canary; the verdict stamp is always applied (inert for non-house).
import {
  houseTupleStatus,
  shouldRejectHalfHouseSave,
  HOUSE_TUPLE_REQUIRED_MESSAGE,
} from '../services/shipping-workflow/house-tuple-save-policy';
import { clientHouseAccountEnabled } from '../services/house-account-opt-in';
// PS-291 (slice, card DoD item 6): build the canonical bestRate DTO from the
// operator-selected New Order preview rate, so the saved manual order carries it
// for Create Label / Print Queue (delegates to normalizeOrderBestRateDto).
import { buildManualSelectedBestRate } from './orders/manual-selected-rate';
// PS-137: pure orders DTO helpers extracted from this route into shared service modules
// (behavior-preserving). Primitives + CSV formatters are consumed by the list row-map, /export,
// and order-detail; co-locating them keeps the route a thinner consumer.
import {
  recordOrNull,
  stringOrNull,
  booleanOrNull,
  finiteNumberOrNull,
  providerIdOrNull,
  rateAmount,
  sourceOf,
  pickStringSource,
  pickNumberSource,
} from '../services/orders-dto-primitives';
import {
  csvEscape,
  compactCsvValue,
  formatCsvNumber,
  formatCsvDimensions,
  formatCsvItems,
  formatCsvSkuList,
} from '../services/orders-csv-format';
import { EXCLUDED_STORE_IDS, EXCLUDED_STORE_IDS_SQL, isExcludedStoreId } from '../config/prepship';
import { isAdminEmail } from '../lib/admin-emails';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
// PS-240 (Per user override unlock shipped data on 2026-06-13): caller-scope
// enforcement on order WRITE paths (reads were already scoped; writes were not).
import { isResourceInScope } from '../lib/scope-predicates';
// PS-234: durable audit trail for shipped/cancelled ?force=1 overrides + manual orders.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
import { type BundleRowDto } from '../services/shipment-bundles/bundle-read-model';
import { resolveScopedBundles, createScopedBundle, BundleScopeError } from '../services/shipment-bundles/resolve-scoped-bundles';
// PS-231: per-admin rate limit on the ?force=1 lockdown override.
// Audit PL-6 (2026-07-13): durable variant backed by lockdown_override audit rows.
import { checkForceOverrideRateLimitDurable } from '../lib/force-override-rate-limit';
import { KNOWN_CARRIER_ACCOUNTS } from '../lib/carrier-account-registry';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import { manualOrdersOrderPredicateSql } from '../lib/manual-orders-visibility';
import { detectExpeditedShipping } from '../lib/shipping/expedited';
import { californiaDayEnd, californiaDayStart } from '../lib/time/california';
import {
  computeFulfillmentShiftWindow,
  formatFulfillmentBoundaryLabel,
} from '../lib/time/fulfillment-window';
import { hasAppPermission, requireInternalPermission } from '../middleware/auth';
import {
  WALMART_DIRECT_STORE_ID,
  WALMART_SHIPSTATION_STORE_ID,
  walmartDirectStoreDebugInfo,
} from '../lib/walmart-order-dedupe';
import {
  isHugrabShippingContext,
  type ShippingServiceEligibilityContext,
} from '../lib/shipping-service-eligibility';
import { buildBestRateWorkflowDto, withOrderRowWorkflow } from '../services/shipping-workflow/best-rate-workflow-dto';
// Per user override unlock shipped data on 2026-07-14: the read model compares
// saved HUGRAB rate proof with the current policy; it does not mutate historical rows.
import { loadHugrabDefaultInsuranceEnabled } from '../services/shipping-workflow/hugrab-insurance-policy';
import { buildOrderRowPackageFacts } from '../services/shipping-workflow/order-row-package-facts';
import { buildOrderShippingWorkflowState } from '../services/shipping-workflow/order-shipping-state';
import { resolveShippedLabelDisplayState } from '../services/shipping-workflow/shipped-label-display-state';
import {
  orderLifecycleEffectiveStatusAliasSql,
  orderLifecycleEffectiveStatusSql,
  resolveOrderLifecycleStatus,
} from '../services/order-lifecycle-status';
import {
  normalizeFulfillmentTrackingNumber,
  resolveFulfillmentConflict,
} from '../services/fulfillment-conflict';
import {
  validateBestRateDimsForPersistedRate,
} from '../services/shipping-workflow/apply-best-rate';
import { houseMarkedAmountForRow } from '../services/shipping-workflow/house-row-marked-amount';
import { redactRateMoneyFields, redactOrderFinancials } from '../services/orders-financial-redaction';
// PS-276 (slice 4): expose the BACKEND's resolved residential verdict on the order DTO
// (the value the rate path uses) via the SAME classifier + money-safe policy, so every
// surface — incl. the FE rate draft key — can read one residential instead of re-deriving.
import {
  ensureOrderRecipientOverrideSchema,
  normalizeRecipientOverride,
} from '../services/order-recipient-override';
import {
  addressClassificationKey,
  getCachedAddressClassifications,
} from '../services/shipping-workflow/address-classification-cache';
import {
  addressResolverMode,
  evidenceFromCacheRow,
  type ResolvedAddressEvidence,
} from '../services/shipping-workflow/resolve-address-classification';
import {
  computeOrderRateJobFingerprint,
  resolveRateJobWorkflowOverride,
} from '../services/shipping-workflow/order-rate-job-status';
import {
  extractInsuranceAddOn,
  resolveOrderRowMarkupRule,
  type MarkupRule,
} from '../services/shipping-workflow/rate-money';
import { loadCarrierMarkups } from '../services/rates';
// PS-798: the ONE markup resolver (per-account override -> per-client default) billing also consumes.
import { resolveCanonicalMarkup } from '../services/shipping-workflow/markup-resolver';
import { hugrabShippingRateOverrideConfigsByClientId } from '../services/billing-hugrab-shipping-rate-override';
// PS-239: marketplace-fee rules (loaded once per request) + per-row resolution + subtotal.
import {
  loadMarketplaceFeeRules,
  resolveMarketplaceFeeRule,
  computeProductSubtotal,
  type StoredMarketplaceFeeRule,
} from '../services/marketplace-fee';
import { getOrderDimsDefaultsForOrder } from '../services/order-dims-defaults';
import { getTestClientIds } from '../services/test-client-ids';
// PS-273: synthetic direct-carrier provider-id offset (10_000_000 + carrier_accounts.id).
// Any provider id at/above this offset is a DIRECT/brokered account that has no entry in the
// static ShipStation registry — it must NEVER be back-resolved to a carrier-family/1Z guess.
import { DIRECT_CARRIER_PROVIDER_ID_OFFSET } from '../services/labels-direct';
// PS-273: brokered-Shipp identity helpers (pure, no DB/network). A Shipp-brokered shipment is
// shipp_-prefixed (service code) or source='shipp'; its account label is the literal "Shipp".
import {
  isShippBrokeredServiceCode,
  SHIPP_BROKERED_ACCOUNT_LABEL,
} from '../services/shipping-workflow/shipp-account-nickname-backfill';

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

function requestIdFromContext(c: Context<any, any, any>): string | null {
  const requestId = c.get('requestId');
  return typeof requestId === 'string' && requestId.trim() ? requestId : null;
}

function logSlowOrdersList(
  q: z.infer<typeof listQuery>,
  requestId: string | null,
  timings: OrdersListTimings,
  totalMs: number,
  extra: Record<string, unknown>,
): void {
  const slowestStepMs = Math.max(0, ...Object.values(timings));
  if (totalMs < 750 && slowestStepMs < 500) return;
  console.info('[orders:list] completed', {
    requestId: requestId ?? undefined,
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

function inferBestRateWorkflowSource(rate: Record<string, unknown> | null) {
  const matchType = stringOrNull(rate?.matchType)?.toLowerCase() ?? '';
  if (!rate) return 'none' as const;
  if (matchType.includes('cache') || matchType === 'exact') return 'cache' as const;
  if (matchType.includes('live') || matchType === 'strict-live' || matchType === 'browse') {
    return 'live' as const;
  }
  return 'saved_override' as const;
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
): Promise<
  | { ok: true; writeAuthorization: OrderEditWriteAuthorization }
  | { ok: false; response: Response }
> {
  const [row] = await db
    .select({
      id: orders.id,
      status: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      clientId: orders.clientId,
      storeId: orders.storeId,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) {
    return { ok: false, response: c.json({ error: 'Order not found' }, 404) };
  }
  // PS-240 (Per user override unlock shipped data on 2026-06-13): a restricted
  // caller may only mutate an order within its scope. Out-of-scope → the same 404
  // as not-found (no cross-tenant existence leak). Runs BEFORE the ?force=1 admin
  // override so a restricted principal can never force-edit another tenant's row.
  // This single check covers PATCH /:id and every mutation subroute, which all
  // funnel through assertOrderEditable. The shipped/cancelled lock below is
  // unchanged — scope is enforced in ADDITION to it, never instead of it.
  const editScope = ordersScopeFromContext(c);
  if (!isResourceInScope(editScope, { clientId: row.clientId, storeId: row.storeId })) {
    return { ok: false, response: c.json({ error: 'Order not found' }, 404) };
  }
  // Per user override unlock shipped data on 2026-07-09: PS-411 moves the edit lock
  // from raw order_status-only checks to the canonical effective lifecycle owner, so
  // upstream-cancelled and externally-shipped awaiting rows stay immutable too.
  const rawStatus = String(row.status ?? '').toLowerCase();
  const lifecycle = resolveOrderLifecycleStatus({
    orderStatus: row.status,
    canonicalStatus: row.canonicalStatus,
    externallyShipped: row.externallyShipped === true,
  });
  const status = lifecycle.orderLifecycleStatus;
  const rawStatusLocked = LOCKED_STATUSES.has(rawStatus);
  if (!lifecycle.isTerminal) {
    // Per user override unlock shipped data on 2026-07-14: carry a fail-closed
    // authorization into the transaction-time lifecycle guard; this is not a bypass.
    return { ok: true, writeAuthorization: { allowTerminal: false } };
  }
  // Optional admin override: ?force=1 + admin email lets the operation
  // through with a warning logged. Use sparingly; the standard answer
  // is "create a new order or correction record" rather than mutating
  // historical data.
  const forceFlag = c.req.query('force');
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  if (forceFlag === '1' && callerIsAdmin) {
    // PS-231: cap how many shipped/cancelled overrides one admin can do per hour —
    // a compromised admin token must not rewrite unlimited locked records in a
    // burst. A throttled attempt is itself audited and rejected with 429.
    // Per user override unlock shipped data on 2026-07-13 (audit PL-6): the cap is
    // now DURABLE — derived from the append-only lockdown_override audit rows, so
    // a restart or second instance no longer resets the security throttle.
    // Call-site swap only; assertOrderEditable itself is not refactored.
    const rl = await checkForceOverrideRateLimitDurable(callerEmail);
    if (!rl.allowed) {
      await recordAuditEvent({
        ...auditActorFromContext(c),
        eventType: 'lockdown_override',
        resourceType: 'order',
        resourceId: orderId,
        action: 'force_override_throttled',
        details: {
          priorStatus: rawStatus,
          lifecycleStatus: status,
          effectiveOrderStatus: lifecycle.effectiveOrderStatus,
          rawStatusLocked,
          route: c.req.path,
          retryAfterMs: rl.retryAfterMs,
        },
      });
      return {
        ok: false,
        response: c.json(
          {
            error: 'Force-override rate limit exceeded — too many shipped/cancelled overrides this hour.',
            status,
            effectiveOrderStatus: lifecycle.effectiveOrderStatus,
            lifecycleStatus: status,
            orderId,
            locked: true,
            retryAfterMs: rl.retryAfterMs,
          },
          429,
        ),
      };
    }
    console.warn(
      `[orders] LOCKDOWN BYPASS — admin ${callerEmail} forced modification of ${status} order ${orderId}`
    );
    // PS-234: every ?force=1 lockdown override leaves a durable, queryable audit
    // row (actor, order, prior status, route, optional ?reason=) — not just an
    // ephemeral console line.
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'lockdown_override',
      resourceType: 'order',
      resourceId: orderId,
      action: 'force_override',
      details: {
        priorStatus: rawStatus,
        lifecycleStatus: status,
        effectiveOrderStatus: lifecycle.effectiveOrderStatus,
        rawStatusLocked,
        route: c.req.path,
        reason: c.req.query('reason') ?? null,
        remaining: rl.remaining,
      },
    });
    // Per user override unlock shipped data on 2026-07-14: only this audited
    // admin ?force=1 branch can authorize a terminal-row write at the final boundary.
    return { ok: true, writeAuthorization: { allowTerminal: true } };
  }
  return {
    ok: false,
    response: c.json(
      {
        error: `Cannot modify a ${status} order — historical records are locked.`,
        status,
        effectiveOrderStatus: lifecycle.effectiveOrderStatus,
        lifecycleStatus: status,
        lifecycleReason: lifecycle.orderLifecycleReason,
        orderId,
        locked: true,
        hint: `Shipped and cancelled orders are immutable. ${lifecycle.orderLifecycleLabel} effective-terminal orders are locked too. Admins can pass ?force=1 to override (logged).`,
      },
      403,
    ),
  };
}

function orderEditWriteFailureResponse(
  c: Context<any, any, any>,
  failure: OrderEditWriteFailure,
): Response {
  if (failure.reason === 'not_found') {
    return c.json({ error: 'Order not found' }, 404);
  }
  const lifecycle = failure.lifecycle;
  return c.json(
    {
      error: `Cannot modify a ${lifecycle.orderLifecycleStatus} order — it became locked before the write.`,
      code: 'ORDER_LOCKED',
      status: lifecycle.orderLifecycleStatus,
      effectiveOrderStatus: lifecycle.effectiveOrderStatus,
      lifecycleStatus: lifecycle.orderLifecycleStatus,
      lifecycleReason: lifecycle.orderLifecycleReason,
      locked: true,
    },
    403,
  );
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
  or ${orders.clientId} in (
    select test_client.id
    from ${clients} test_client
    where test_client.is_test = true
  )
)`;

const activeOrderClientPredicate = sql`(
  ${orders.clientId} is null
  or ${orders.clientId} in (
    select owner_client.id
    from ${clients} owner_client
    where ${sql.raw(activeClientPredicateSql('owner_client'))}
  )
)`;

const visibleStorePredicate = sql`${visibleStoreBasePredicate} and ${activeOrderClientPredicate}`;

function visiblePredicateForOrdersList(q: { storeId?: number; includeInactiveClients?: boolean }): SQL | undefined {
  if (typeof q.storeId === 'number' && !isExcludedStoreId(q.storeId)) {
    return q.includeInactiveClients === true ? undefined : activeOrderClientPredicate;
  }
  return q.includeInactiveClients === true ? visibleStoreBasePredicate : visibleStorePredicate;
}

function visibleAwaitingOrdersPredicate(alias: 'orders' | 'o' = 'orders') {
  const externalOrderId = sql.raw(`${alias}.external_order_id`);
  return sql`not (
    coalesce(${externalOrderId}, '') ilike 'ebay-%'
  )`;
}

function ordersScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function canViewOrderFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

// PS-220: order financial redaction (RATE_MONEY_FIELD_KEYS + redactRateMoneyFields +
// redactOrderFinancials) now lives in its own pure, behaviorally-testable module. This route
// still owns WHO can view financials (canViewOrderFinancials above); the module owns WHAT is
// scrubbed — including overrides.bestRateJson (the projected houseMargin/nextBestNonHouseRate
// stamp) and bestRateWorkflow.money, the two house surfaces a client must never see.

function orderScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(orders.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) predicates.push(inArray(orders.storeId, scope.storeIds));
  if (!predicates.length) return sql`false`;
  return predicates.length === 1 ? predicates[0] : (or(...predicates) ?? sql`false`);
}

function orderAliasScopePredicate(alias: 'orders' | 'o', scope: ClientStoreScope): SQL {
  if (!scope.isRestricted) return sql`true`;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) {
    predicates.push(
      sql`${sql.raw(`${alias}.client_id`)} in (${sql.join(scope.clientIds.map((id) => sql`${id}`), sql`, `)})`
    );
  }
  if (scope.storeIds.length > 0) {
    predicates.push(
      sql`${sql.raw(`${alias}.store_id`)} in (${sql.join(scope.storeIds.map((id) => sql`${id}`), sql`, `)})`
    );
  }
  if (!predicates.length) return sql`false`;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

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


type V2CarrierAccountRef = {
  carrierCode: string;
  shippingProviderId: number;
  nickname: string;
  clientId: number | null;
  accountNumber: string | null;
};

// PS-137: canonical DTO coercion/provenance primitives live in
// ../services/orders-dto-primitives (imported above).

// PS-132: derived from the single backend carrier-account registry (src/lib/
// carrier-account-registry.ts). Same fields/order as before; nickname for 433543 reconciled
// to the canonical "UPS by SS - Chase x7439".
const V2_CARRIER_ACCOUNT_REFS: V2CarrierAccountRef[] = KNOWN_CARRIER_ACCOUNTS.map((account) => ({
  carrierCode: account.carrierCode,
  shippingProviderId: account.shippingProviderId,
  nickname: account.nickname,
  clientId: account.clientId,
  accountNumber: account.accountNumber,
}));

// PS-273: exported so the offline guard (scripts/ps-273-shipp-account-nickname-guard.ts)
// can pin the identity-first contract directly against the backend owner.
export function resolveV2CarrierAccountRef(
  providerAccountId: number | null | undefined,
  carrierCode: string | null | undefined,
  trackingNumber: string | null | undefined,
  clientId: number | null,
): V2CarrierAccountRef | null {
  if (providerAccountId != null) {
    const exact = V2_CARRIER_ACCOUNT_REFS.find((account) => account.shippingProviderId === providerAccountId);
    if (exact) return exact;
    // PS-273: a synthetic direct/brokered provider id (>= 10_000_000 + carrier_accounts.id) is
    // NOT a ShipStation registry account. Before this gate, a Shipp-brokered UPS label
    // (provider id 10_000_025, carrier 'ups', 1Z tracking) fell through to the 1Z / carrier-family
    // fabrication below and resolved the first shared UPS account (GG6381 on order #1587) — a
    // direct account the label was never bought on. Identity FIRST: there is no registry truth
    // for a direct id, so return null and let the persisted provider_account_nickname or the
    // Shipp brokered-fallback own the display. No carrier-family guess.
    if (providerAccountId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET) return null;
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

// PS-137: normalizeListBestRate moved to ../services/order-rate-dto (co-located with its owner
// normalizeOrderBestRateDto; imported above).

// PS-137: recordOrNull / stringOrNull / booleanOrNull / finiteNumberOrNull / providerIdOrNull /
// rateAmount / sourceOf / pickStringSource / pickNumberSource moved to
// ../services/orders-dto-primitives (imported above). Pure relocation, no behavior change.

// User-initiated sync + status. Sits behind requireAuth (mounted at main.ts).
// /cron/sync-orders is the cron-secret equivalent for schedulers.
//
// v2 parity: the response shape extends v4's native `{lastSyncedAt,
// orderCount}` with v2's `LegacySyncStatusDto` fields (status, mode, error,
// page, ratesCached, ratePrefetchRunning) so the ported progress UIs can
// render without a second round-trip. Backend account/job state supplies the
// status truth while `lastSyncAt` remains an alias for back-compat.
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
  const latestSync =
    status.latestSyncedAt && Number.isFinite(Date.parse(status.latestSyncedAt))
      ? Date.parse(status.latestSyncedAt)
      : null;
  return c.json({
    // v4 native fields
    lastSyncedAt: status.lastSyncedAt,
    latestSyncedAt: status.latestSyncedAt,
    orderCount: status.orderCount,
    health: status.health,
    allAccountsFresh: status.allAccountsFresh,
    staleAccountCount: status.staleAccountCount,
    accounts: status.accounts,
    statusCatchup: status.statusCatchup,
    laneOwner: status.laneOwner,
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
    status:
      status.health === 'running'
        ? 'syncing'
        : status.health === 'error'
          ? 'error'
          : latestSync
            ? 'done'
            : 'idle',
    mode: latestSync ? 'incremental' : 'idle',
    error:
      status.health === 'error'
        ? 'One or more ShipStation accounts failed their latest sync.'
        : null,
    page: 0,
    total: 0,
    count: 0,
    lastSync,
    latestSync,
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
          // Per user override unlock shipped data on 2026-07-15: pass through
          // read-only backend-classified diagnostics; lifecycle guards are unchanged.
          skipSamples: rateJob.skipSamples,
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
  const dailyCountsScope = ordersScopeFromContext(c);

  // Same assignee-scoping rules as GET / (admins see all; workers see only
  // their assigned orders).
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  const assigneeFilter = !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;

  // Inclusive California business-day range, independent of API/server/browser
  // timezone. Operator date filters should match the ShipStation account day.
  const fromDate = californiaDayStart(q.from);
  const toDate = californiaDayEnd(q.to);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;

  const where = and(
    ...[
      assigneeFilter,
      orderScopePredicate(dailyCountsScope),
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
  // Per user override unlock shipped data on 2026-07-06: PS-387 changes this
  // read-only count to use the backend lifecycle SOT. It does not mutate
  // shipped/cancelled orders or weaken assertOrderEditable.
  const dailyEffectiveStatusSql = orderLifecycleEffectiveStatusSql();
  const rows = await db.execute<{
    day: string;
    awaiting: number;
    shipped: number;
    cancelled: number;
    total: number;
  }>(sql`
    select
      to_char(date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
      count(*) filter (where ${dailyEffectiveStatusSql} = 'awaiting_shipment')::int as awaiting,
      count(*) filter (where ${dailyEffectiveStatusSql} = 'shipped')::int as shipped,
      count(*) filter (where ${dailyEffectiveStatusSql} = 'cancelled')::int as cancelled,
      count(*)::int as total
    from ${orders}
    where ${where}
    group by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles')
    order by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles') asc
  `);

  return c.json({ data: rows });
});

const dashboardSalesQuery = dailyCountsQuery.extend({
  sevenFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sevenFrom must be YYYY-MM-DD').optional(),
});

app.get('/dashboard-sales', zValidator('query', dashboardSalesQuery), async (c) => {
  const q = c.req.valid('query');
  const startedAt = performance.now();
  const dashboardSalesScope = ordersScopeFromContext(c);

  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  const assigneeFilter = !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;

  const fromDate = californiaDayStart(q.from);
  const toDate = californiaDayEnd(q.to);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const sevenFrom = q.sevenFrom ?? q.from;
  // Per user override unlock shipped data on 2026-07-06: dashboard sales reads
  // the backend lifecycle SOT so upstream-cancelled rows do not count as sales.
  // This is read-only and leaves shipped/cancelled write locks intact.
  const dashboardEffectiveStatusSql = orderLifecycleEffectiveStatusSql();

  const where = and(
    ...[
      assigneeFilter,
      orderScopePredicate(dashboardSalesScope),
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      visiblePredicateForOrdersList(q),
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      gte(orders.orderDate, fromDate),
      lte(orders.orderDate, toDate),
      sql`${dashboardEffectiveStatusSql} <> 'cancelled'`,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined)
  );

  type DashboardSalesPayload = {
    revenue: number;
    units: number;
    bySku: Array<{ sku: string; revenue: number | string; units30: number | string; units7: number | string }>;
    dailyRevenue: Array<{ day: string; revenue: number | string }>;
  };

  const cacheKey = analyticsCacheKey('orders.dashboard-sales.v2', {
    from: q.from,
    to: q.to,
    sevenFrom,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: callerIsAdmin ? 'admin' : callerUserId ?? 'anonymous',
    scopeClientIds: dashboardSalesScope.isRestricted ? dashboardSalesScope.clientIds : null,
    scopeStoreIds: dashboardSalesScope.isRestricted ? dashboardSalesScope.storeIds : null,
  });
  const cached = await getAnalyticsCache<DashboardSalesPayload>(cacheKey);
  if (cached) return c.json(cached);

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
        to_char(date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
        trim(coalesce(oi.sku, '')) as sku,
        greatest(0, coalesce(oi.quantity, 0))::numeric as qty
      from order_items oi
      join ${orders} on ${orders.id} = oi.order_id
      where ${where}
        and trim(coalesce(oi.sku, '')) <> ''
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

  const payload: DashboardSalesPayload = {
    revenue: Number(row?.revenue ?? 0) || 0,
    units: Number(row?.units ?? 0) || 0,
    bySku: Array.isArray(row?.bySku) ? row.bySku : [],
    dailyRevenue: Array.isArray(row?.dailyRevenue) ? row.dailyRevenue : [],
  };
  void setAnalyticsCache(cacheKey, payload, 120);
  return c.json(payload);
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
  const result = await enqueueManualOrderSyncJob({
    sinceMs,
    fullResync: sinceMs === 0,
  });
  return c.json(
    {
      ...result,
      status: result.queued ? 'queued' : result.error ? 'error' : 'already_queued',
    },
    result.error ? 503 : 202,
  );
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
  // PS-210: explicit operator intent that a non-empty search reads across
  // the whole order lifecycle (awaiting/shipped/cancelled) instead of the
  // active tab. Ignored when search is empty — see orders-search-scope.ts.
  searchScope: z.enum(['active_status', 'global']).optional(),
  sort: z.enum(['sku']).optional(),
  includeTotal: z.coerce.boolean().optional(),
  idsOnly: z.coerce.boolean().optional(),
  selectionLimit: z.coerce.number().int().positive().max(5000).optional(),
  // Filter to orders containing at least one items[] entry whose
  // sku exactly matches. The FE used to apply this client-side over
  // the in-memory page, which silently broke pagination — picking
  // a SKU that wasn't on page 1 returned 'no orders match' even
  // though dozens of matches existed on later pages. Pushing the
  // filter to SQL makes it work across the whole result set.
  sku: z.string().optional(),
});

const bulkSnapshotBody = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(5000),
});

const orderListSelect = {
  id: orders.id,
  externalOrderId: orders.externalOrderId,
  clientId: orders.clientId,
  // Joined (not a correlated per-row subquery): the list query LEFT JOINs
  // clients once — same value, one join instead of one subquery per returned row.
  clientName: clients.name,
  orderNumber: orders.orderNumber,
  orderStatus: orders.orderStatus,
  // PS-128/PS-129: surfaced so the UI can show the shipping-hold badge (cancelled upstream /
  // externally shipped). The backend remains authoritative (the label paths hard-block).
  canonicalStatus: orders.canonicalStatus,
  orderDate: orders.orderDate,
  storeId: orders.storeId,
  sourceProvider: orders.sourceProvider,
  sourceAccountId: orders.sourceAccountId,
  sourceOrderId: orders.sourceOrderId,
  sourceOrderNumber: orders.sourceOrderNumber,
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

async function ordersListResponse(
  c: Context,
  q: z.infer<typeof listQuery>,
  requestedOrderIds: number[] | null = null,
) {
  const routeStartedAt = performance.now();
  const timings: OrdersListTimings = {};
  const orderScope = ordersScopeFromContext(c);
  const canViewFinancials = canViewOrderFinancials(c);
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
  //
  // PS-210: a NON-EMPTY search with searchScope=global is a global READ
  // across the lifecycle (awaiting/shipped/cancelled) — the single-status tab
  // predicate is replaced by the lifecycle union BEFORE pagination/totals, so
  // a Shipped match surfaces while the operator is on Awaiting. The awaiting
  // arm keeps visibleAwaitingOrdersPredicate so search can never surface
  // awaiting rows the tab itself would hide. Every other predicate below
  // (auth scope, assignee, client/store, store visibility, test exclusion,
  // dates) still applies unchanged. This is read-only routing — shipped/
  // cancelled rows stay locked by assertOrderEditable on every mutation
  // endpoint regardless of how they were listed.
  const statusScope = resolveOrdersStatusScope({
    status: q.status,
    search,
    searchScope: q.searchScope,
  });
  // Per user override unlock shipped data on 2026-07-06: PS-387 changes
  // read-only filtering only; mutation endpoints remain protected by
  // assertOrderEditable and no source rows are modified here.
  const listEffectiveStatusSql = orderLifecycleEffectiveStatusSql();
  const baseVisibilityPredicate = includeInactiveClients ? visibleStoreBasePredicate : visibleStorePredicate;
  const manualOrdersAwaitingVisibilityPredicate = sql`(
    ${listEffectiveStatusSql} = 'awaiting_shipment'
    and ${sql.raw(manualOrdersOrderPredicateSql('orders', 'manual_orders_client'))}
  )`;
  const listVisibilityPredicate = sql`(${baseVisibilityPredicate} or ${manualOrdersAwaitingVisibilityPredicate})`;
  let statusPredicate: ReturnType<typeof sql> | undefined;
  if (statusScope.mode === 'single_status') {
    statusPredicate = sql`${listEffectiveStatusSql} = ${statusScope.status}`;
  } else if (statusScope.mode === 'global_lifecycle') {
    statusPredicate = sql`(
      (${listEffectiveStatusSql} = 'awaiting_shipment' and ${visibleAwaitingOrdersPredicate('orders')})
      or ${listEffectiveStatusSql} in ('shipped', 'cancelled')
    )`;
  }
  const where = and(
    ...[
      statusPredicate,
      requestedOrderIds ? inArray(orders.id, requestedOrderIds) : undefined,
      statusScope.mode === 'single_status' && statusScope.status === 'awaiting_shipment'
        ? visibleAwaitingOrdersPredicate('orders')
        : undefined,
      orderScopePredicate(orderScope),
      assigneeFilter,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      listVisibilityPredicate,
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
            from order_items oi
            where oi.order_id = ${orders.id}
              and oi.sku = ${q.sku}
              and oi.quantity > 0
          )`
        : undefined,
      // Search reshape (API-audit Phase 3 slice 2): this predicate was a single
      // 14-branch OR. Postgres can only index an OR when EVERY branch is
      // indexable, and the two EXISTS branches never are — so every search
      // seq-scanned the 415MB orders table (19-51s measured in production).
      // Rewritten as `orders.id IN (UNION ALL of per-branch probes)`: the
      // MATCHING ID SET IS IDENTICAL branch-for-branch (the shipments EXISTS
      // splits into its two link arms, order_id and order_number — the union
      // of the two equals the original OR inside that EXISTS; IN dedups), but
      // each probe can now use its own trigram/btree index (migration 0058).
      searchPattern
        ? sql`${orders.id} in (
            select o.id from orders o where o.order_number ilike ${searchPattern}
            union all select o.id from orders o where o.external_order_id ilike ${searchPattern}
            union all select o.id from orders o where o.ship_to_name ilike ${searchPattern}
            union all select o.id from orders o where o.customer_email ilike ${searchPattern}
            union all select o.id from orders o where o.ship_to_city ilike ${searchPattern}
            union all select o.id from orders o where o.ship_to_state ilike ${searchPattern}
            union all select o.id from orders o where o.ship_to_postal_code ilike ${searchPattern}
            union all select o.id from orders o where o.id::text ilike ${searchPattern}
            union all select o.id from orders o where o.raw->>'customerUsername' ilike ${searchPattern}
            union all select o.id from orders o where o.raw->'shipTo'->>'company' ilike ${searchPattern}
            union all select o.id from orders o where o.raw->'shipTo'->>'street1' ilike ${searchPattern}
            union all select o.id from orders o where o.raw->'shipTo'->>'street2' ilike ${searchPattern}
            union all select oi.order_id from order_items oi
              where oi.sku ilike ${searchPattern}
                 or oi.name ilike ${searchPattern}
            union all select s.order_id from shipments s
              where s.order_id is not null
                and coalesce(s.voided, false) = false
                and (
                  s.tracking_number ilike ${searchPattern}
                  or s.label_tracking ilike ${searchPattern}
                )
            union all select o2.id from orders o2
              inner join shipments s2
                on s2.order_number is not null
               and s2.order_number = o2.order_number
              where coalesce(s2.voided, false) = false
                and (
                  s2.tracking_number ilike ${searchPattern}
                  or s2.label_tracking ilike ${searchPattern}
                )
          )`
        : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  try {
    await ensureOrderRecipientOverrideSchema();
  // No ROW_NUMBER() dedup: orders.external_order_id is already UNIQUE, so
  // ShipStation's orderId is the true key. Two rows with the same order_number
  // are legitimately distinct (different store / orderId) — v2 never collapses
  // by order_number and neither should we.
  const offset = offsetOf(q);
  const sku_composition_for_sort = sql<string>`coalesce((
    select string_agg(sku_qty.sku_key || ':' || sku_qty.qty_text, '|' order by sku_qty.sku_key)
    from (
      select
        case
          when trim(coalesce(oi.sku, '')) = '' then '__missing_sku__'
          else lower(trim(oi.sku))
        end as sku_key,
        trim(to_char(sum(oi.quantity), 'FM999999999990.###')) as qty_text
      from order_items oi
      where oi.order_id = ${orders.id}
        and oi.quantity > 0
      group by
        case
          when trim(coalesce(oi.sku, '')) = '' then '__missing_sku__'
          else lower(trim(oi.sku))
        end
    ) sku_qty
  ), '__missing_sku__:1')`;
  const orderByClauses = q.sort === 'sku'
    ? [sql`${sku_composition_for_sort} asc`, desc(orders.orderDate), desc(orders.id)]
    : [desc(orders.orderDate), desc(orders.id)];

  if (q.idsOnly) {
    const selectionLimit = q.selectionLimit ?? 5000;
    const [idRows, countRows] = await Promise.all([
      timedOrdersStep(timings, 'ordersIdsOnlyPage', () =>
        db
          .select({ id: orders.id })
          .from(orders)
          .where(where)
          .orderBy(...orderByClauses)
          .limit(selectionLimit)
      ),
      timedOrdersStep(timings, 'ordersIdsOnlyCount', () =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(where)
      ),
    ]);
    const ids = idRows.map((row) => row.id).filter((id): id is number => id != null);
    const total = countRows[0]?.count ?? ids.length;
    logSlowOrdersList(q, requestIdFromContext(c), timings, msSince(routeStartedAt), {
      rows: ids.length,
      total,
      totalApproximate: false,
      countWasSkipped: false,
      idsOnly: true,
      truncated: total > ids.length,
    });
    return c.json({
      data: ids,
      ids,
      total,
      selectionLimit,
      truncated: total > ids.length,
      pagination: {
        page: 1,
        pageSize: ids.length,
        total,
        totalPages: 1,
      },
    });
  }

  const includeExactTotal = q.includeTotal !== false;
  const joinedPromise = timedOrdersStep(timings, 'ordersPage', () =>
    db
      .select({ order: orderListSelect, overrides: orderOverrides })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .leftJoin(clients, eq(clients.id, orders.clientId))
      .where(where)
      .orderBy(...orderByClauses)
      .limit(q.pageSize)
      .offset(offset)
  );
  // The exact count runs CONCURRENTLY with the page query (it used to run
  // after it, serially, re-evaluating the same WHERE). It is only CONSULTED
  // when the returned page is full; on a short page the inferred total wins
  // and this result is ignored — a cheap speculative count in exchange for
  // removing a serial round-trip from the hottest route's common case.
  const countRowsPromise = includeExactTotal
    ? timedOrdersStep(timings, 'ordersCount', () =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(where)
      )
    : null;
  if (countRowsPromise) countRowsPromise.catch(() => {});

  const joined = await joinedPromise;

  const canInferTotal = joined.length < q.pageSize && (q.page === 1 || joined.length > 0);
  let total = canInferTotal ? offset + joined.length : 0;
  let totalApproximate = false;
  let countWasSkipped = canInferTotal;
  if (!canInferTotal && includeExactTotal && countRowsPromise) {
    const countRows = await countRowsPromise;
    total = countRows[0]?.count ?? 0;
    countWasSkipped = false;
  } else if (!canInferTotal) {
    total = offset + joined.length + (joined.length >= q.pageSize ? 1 : 0);
    totalApproximate = joined.length >= q.pageSize;
    countWasSkipped = true;
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
  const returnSummaryByOrderId = await timedOrdersStep(timings, 'returnOrderSummaries', () =>
    loadReturnOrderSummaries(pageOrderIds),
  );
  const latestShipByOrderId = new Map<number, LatestShipmentRow>();
  const latestShipByOrderNumber = new Map<string, LatestShipmentRow>();
  const walmartDirectDuplicateByOrderNumber = new Map<string, {
    id: number;
    external_order_id: string | null;
    source_provider: string | null;
    source_account_id: string | null;
    order_status: string | null;
  }>();
  const walmartShipStationPageOrderNumbers = [
    ...new Set(
      joined
        .filter((r) => r.order.storeId === WALMART_SHIPSTATION_STORE_ID)
        .map((r) => r.order.orderNumber)
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  if (walmartShipStationPageOrderNumbers.length) {
    const directRows = await timedOrdersStep(timings, 'walmartDirectDuplicates', () =>
      db.execute<{
        id: number;
        order_number: string;
        external_order_id: string | null;
        source_provider: string | null;
        source_account_id: string | null;
        order_status: string | null;
      }>(sql`
        select distinct on (order_number)
          id,
          order_number,
          external_order_id,
          source_provider,
          source_account_id,
          order_status
        from orders
        where store_id = ${WALMART_DIRECT_STORE_ID}
          and order_number in (${sql.join(walmartShipStationPageOrderNumbers.map((n) => sql`${n}`), sql`, `)})
        order by order_number, order_date desc nulls last, id desc
      `)
    );
    for (const row of directRows) {
      walmartDirectDuplicateByOrderNumber.set(row.order_number, row);
    }
  }
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
          source,
          selected_rate_json,
          -- PS-309 (Per user override unlock shipped data on 2026-06-23): surface the voided
          -- flag so the shipped-label display state can show a voided-only order as
          -- "Voided label" instead of falling back to "Ext. Label". READ-ONLY projection.
          coalesce(voided, false) as voided
        from shipments
        where order_id in (${sql.join(pageOrderIds.map((id) => sql`${id}`), sql`, `)})
          -- PS-309: SHIPPED also surfaces voided shipments (as a fallback) so a voided-only
          -- order is classified honestly; awaiting still excludes voided (unchanged).
          ${q.status === 'cancelled' || q.status === 'shipped' ? sql`` : sql`and coalesce(voided, false) = false`}
        -- PS-309: prefer the active (non-voided) shipment for shipped; fall back to the
        -- latest voided one only when no active exists. Awaiting/cancelled ordering unchanged.
        order by order_id, ${q.status === 'shipped' ? sql`coalesce(voided, false) asc, ` : sql``}id desc
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
          source,
          selected_rate_json,
          -- PS-309 (Per user override unlock shipped data on 2026-06-23): see the by-order_id
          -- query above — surface voided + prefer active for shipped, READ-ONLY.
          coalesce(voided, false) as voided
        from shipments
        where order_id is null
          and order_number in (${sql.join(pageOrderNumbers.map((n) => sql`${n}`), sql`, `)})
          ${q.status === 'cancelled' || q.status === 'shipped' ? sql`` : sql`and coalesce(voided, false) = false`}
        order by order_number, ${q.status === 'shipped' ? sql`coalesce(voided, false) asc, ` : sql``}id desc
      `)
    );
    for (const s of shipRowsByOrderNumber) {
      if (s.order_number) {
        latestShipByOrderNumber.set(s.order_number, s);
      }
    }
  }

  const overrideTrackingByOrderId = new Map<number, string>();
  const overrideTrackingKeys = [
    ...new Set(
      joined
        .map((r) => {
          const key = normalizeFulfillmentTrackingNumber(r.overrides?.trackingNumber);
          if (key && r.order.id != null) overrideTrackingByOrderId.set(r.order.id, key);
          return key;
        })
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  const shipmentRowsByTracking = new Map<string, Array<{ order_id: number | null; order_number: string | null }>>();
  if (overrideTrackingKeys.length) {
    const trackingRows = await timedOrdersStep(timings, 'shipmentTrackingCollisions', () =>
      db.execute<{ order_id: number | null; order_number: string | null; tracking_number: string | null }>(sql`
        select order_id, order_number, tracking_number
        from shipments
        where coalesce(voided, false) = false
          and upper(coalesce(tracking_number, '')) in (${sql.join(overrideTrackingKeys.map((tracking) => sql`${tracking}`), sql`, `)})
      `),
    );
    for (const row of trackingRows) {
      const key = normalizeFulfillmentTrackingNumber(row.tracking_number);
      if (!key) continue;
      const list = shipmentRowsByTracking.get(key) ?? [];
      list.push({ order_id: row.order_id, order_number: row.order_number });
      shipmentRowsByTracking.set(key, list);
    }
  }

  // PS-120 (reader): batch-load the per-order backend rate-job rows (pending/rating) in ONE
  // query (no N+1). Only the Awaiting view ever shows these in-progress states, and the
  // producer only writes awaiting orders, so a single store/lookup gated to awaiting keeps
  // this additive and cheap. When a page has no rows, the map stays empty and the per-row
  // override below is a no-op — the orders payload is byte-identical to before.
  // PS-120 (reader watchdog): a rate-job stamp older than this is a leaked/orphan row — a worker that
  // crashed before finalize, a row stamped by a DIFFERENT process/instance, or one re-stamped then
  // abandoned. Drop it HERE so a stamp can never outlive the FE watchdog window or re-inject a spinner
  // across instances (the per-job finally-sweep in rates-backfill only clears its OWN job's rows). Mirror
  // of the FE PENDING_RATING_WATCHDOG_MS, kept as a backend literal (no FE import).
  const RATE_JOB_STALE_MS = 6 * 60 * 1000;
  const rateJobByOrderId = new Map<number, { state: string; requestFingerprint: string; updatedAtMs: number }>();
  if (q.status === 'awaiting_shipment' && pageOrderIds.length) {
    try {
      const rateJobRows = await timedOrdersStep(timings, 'orderRateJobs', () =>
        db.execute<{ order_id: number; state: string; request_fingerprint: string; updated_at: string }>(sql`
          select order_id, state, request_fingerprint, updated_at
          from order_rate_jobs
          where order_id in (${sql.join(pageOrderIds.map((id) => sql`${id}`), sql`, `)})
        `),
      );
      const rateJobNowMs = Date.now();
      for (const job of rateJobRows) {
        if (job.order_id == null) continue;
        const updatedAtMs = Date.parse(String(job.updated_at));
        // Skip stale/orphan stamps (older than the watchdog) so a leaked row never surfaces as a spinner.
        if (Number.isFinite(updatedAtMs) && rateJobNowMs - updatedAtMs > RATE_JOB_STALE_MS) continue;
        rateJobByOrderId.set(job.order_id, {
          state: job.state,
          requestFingerprint: job.request_fingerprint,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : rateJobNowMs,
        });
      }
    } catch (err) {
      // ADDITIVE SAFETY: the order_rate_jobs table may not exist yet (first deploy before the
      // worker ensured it). Any lookup failure leaves the map empty, the per-row override
      // becomes a no-op, and the orders payload is byte-identical to before. Never break /orders
      // for an optional display-only enhancement.
      console.warn(
        '[orders] order_rate_jobs lookup skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  const rateJobReadNowMs = Date.now();

  // PS-186: backend-owned test-order fact for the row DTO. One tiny indexed query per request
  // (clients_test_client_id_idx partial index) so every row carries `isTest` and the FE reads
  // the backend fact instead of inventing heuristics. Failure leaves the set empty (rows fall
  // back to false) — display-only, never breaks /orders.
  const testClientIds = new Set<number>();
  try {
    // 60s TTL cache (src/services/test-client-ids.ts) — was a fresh query per request.
    for (const id of await getTestClientIds()) testClientIds.add(id);
  } catch (err) {
    console.warn('[orders] test-client lookup skipped:', err instanceof Error ? err.message : err);
  }

  // PS-177 (Phase 5): the SAME markup rules browse responses use, loaded once per
  // request, so every row carries a backend-owned money tuple instead of the FE
  // re-applying markups from its own settings fetch. Failure leaves the map empty
  // (rows price without markup facts — FE fallback still renders); display-only,
  // never breaks /orders.
  let carrierMarkupRules: Map<string, MarkupRule> = new Map();
  try {
    carrierMarkupRules = await loadCarrierMarkups();
  } catch (err) {
    console.warn('[orders] markup rules lookup skipped:', err instanceof Error ? err.message : err);
  }

  // PS-239: marketplace-fee rules loaded once per request (mirrors carrierMarkupRules).
  // Empty on failure (rows just render no fee — display-only, never breaks /orders).
  const marketplaceFeeRules: StoredMarketplaceFeeRule[] = await loadMarketplaceFeeRules();

  // PS-276 (slice 2b-2c): batch-read the resolver's address-classification cache so each list row's
  // resi/comm TAG reflects the SAME resolved verdict the rate fingerprint already used. /rates/browse +
  // rates-backfill WRITE this cache when ADDRESS_RESOLVER=on; here we only READ it (cache-only — no live
  // USPS call on the list path) and feed the cached evidence into buildCanonicalOrderModel, where it runs
  // through the SAME residentialForShipping money-safe policy as the rate path. A miss falls back to the
  // override+heuristic verdict (today's behavior). One IN(...) query per page; ZERO queries when OFF.
  const resolvedResidentialByOrderId = new Map<number, ResolvedAddressEvidence>();
  if (addressResolverMode() === 'on') {
    const keyByOrderId = new Map<number, string>();
    for (const r of joined) {
      const orderId = finiteNumberOrNull(r.order.id);
      if (orderId == null) continue;
      const rawShipTo = recordOrNull(recordOrNull(r.order.raw)?.shipTo) ?? {};
      const key = addressClassificationKey({
        street1: stringOrNull(rawShipTo.street1),
        state: stringOrNull(rawShipTo.state) ?? stringOrNull(r.order.shipToState),
        postalCode: stringOrNull(rawShipTo.postalCode) ?? stringOrNull(r.order.shipToPostalCode),
        country: stringOrNull(rawShipTo.country) ?? 'US',
      });
      if (key) keyByOrderId.set(orderId, key);
    }
    const cacheByKey = await getCachedAddressClassifications([...keyByOrderId.values()]);
    for (const [orderId, key] of keyByOrderId) {
      const row = cacheByKey.get(key);
      if (row) resolvedResidentialByOrderId.set(orderId, evidenceFromCacheRow(row));
    }
  }

  // PS-220 (slice 4b-2): per-page bulk-load of the REALIZED house customer_rate (+ drp_cost) for
  // shipped rows, so the Ship Margin column + HOUSE badge show the billed margin. Best-effort +
  // bounded (one indexed IN(...) per page) + gated to financial viewers on pages that actually
  // contain shipped rows, so awaiting views add ZERO queries. A missing table / transient error
  // must NEVER break the orders list (catch -> empty map -> shipped margin renders as today).
  const houseRealizedByOrderId = new Map<number, { customerRate: number; drpCost: number | null }>();
  if (canViewFinancials && joined.some((r) => r.order.orderStatus === 'shipped')) {
    try {
      const shippedOrderIds = joined
        .filter((r) => r.order.orderStatus === 'shipped')
        .map((r) => finiteNumberOrNull(r.order.id))
        .filter((id): id is number => id != null);
      if (shippedOrderIds.length) {
        await ensureOrderCompetitiveRateSchema();
        const houseRows = await db
          .select({
            orderId: orderCompetitiveRate.orderId,
            customerRate: orderCompetitiveRate.customerRate,
            drpCost: orderCompetitiveRate.drpCost,
          })
          .from(orderCompetitiveRate)
          .where(and(eq(orderCompetitiveRate.isHouseOrder, true), inArray(orderCompetitiveRate.orderId, shippedOrderIds)));
        for (const hr of houseRows) {
          const customerRate = Number(hr.customerRate);
          const drpCost = Number(hr.drpCost);
          if (Number.isFinite(customerRate) && customerRate > 0) {
            houseRealizedByOrderId.set(hr.orderId, { customerRate, drpCost: Number.isFinite(drpCost) ? drpCost : null });
          }
        }
      }
    } catch (err) {
      console.warn('[ps-220] shipped house customer_rate bulk-load skipped:', err instanceof Error ? err.message : err);
    }
  }

  // PS-798 (slice 2b): per-page bulk-load of each client's PER-CLIENT shipping markup (billing_config),
  // so the Best Rate column resolves the SAME canonical markup (per-account override -> per-client
  // default) the invoice bills -- quote == invoice for a per-client markup. Mirrors the PS-220 house
  // load: gated to financial viewers, one indexed IN(...) per page, best-effort (a failure -> empty map
  // -> per-account-only display exactly as today). Display-only; never breaks /orders. Only non-zero
  // markups are mapped, so default (0/0) clients stay byte-identical.
  const clientShippingMarkupByClientId = new Map<number, { pct: number; flat: number }>();
  const hugrabShippingOverrideByClientId = new Map<number, { enabled: boolean; threshold: number; amount: number }>();
  if (canViewFinancials) {
    try {
      const billingClientIds = [...new Set(
        joined.map((r) => finiteNumberOrNull(r.order.clientId)).filter((id): id is number => id != null),
      )];
      if (billingClientIds.length) {
        const [cfgRows, hugrabConfigs] = await Promise.all([
          db
            .select({
              clientId: billingConfig.clientId,
              pct: billingConfig.shippingMarkupPct,
              flat: billingConfig.shippingMarkupFlat,
            })
            .from(billingConfig)
            .where(inArray(billingConfig.clientId, billingClientIds)),
          hugrabShippingRateOverrideConfigsByClientId(billingClientIds),
        ]);
        for (const cfg of cfgRows) {
          const pct = Number(cfg.pct);
          const flat = Number(cfg.flat);
          if ((Number.isFinite(pct) && pct !== 0) || (Number.isFinite(flat) && flat !== 0)) {
            clientShippingMarkupByClientId.set(cfg.clientId, {
              pct: Number.isFinite(pct) ? pct : 0,
              flat: Number.isFinite(flat) ? flat : 0,
            });
          }
        }
        for (const [clientId, cfg] of hugrabConfigs) {
          hugrabShippingOverrideByClientId.set(clientId, cfg);
        }
      }
    } catch (err) {
      console.warn('[ps-798/ps-367] client billing config bulk-load skipped:', err instanceof Error ? err.message : err);
    }
  }

  // Per user override unlock shipped data on 2026-07-14: a changed HUGRAB toggle
  // makes prior saved Best Rates stale immediately. Fail safe to the legacy ON
  // policy if the setting read itself is unavailable; this remains read-only.
  const hugrabDefaultInsuranceEnabled = await loadHugrabDefaultInsuranceEnabled().catch((err) => {
    console.warn('[orders] HUGRAB insurance policy read failed; defaulting enabled:', err instanceof Error ? err.message : err);
    return true;
  });

  // PS-137 #8 (deliberate non-extraction): this per-row mapper is intentionally left inline. It is NOT
  // a source-of-truth concern — it only ORCHESTRATES already-canonical helpers (recordOrNull/stringOrNull/
  // normalizeListBestRate/normalizeOrderSelectedRateDto from the #1-7 extractions, plus buildCanonicalOrderModel,
  // buildBestRateWorkflowDto, detectExpeditedShipping, pick*Source, redactOrderFinancials). Extracting it is a
  // cosmetic decomposition only, and its clean form needs a query-builder extraction to type `joined`'s custom
  // projection (orderListSelect + computed `raw`) safely under strict mode. Per "minimize bugs", that risk on the
  // main Orders screen is not worth a zero-behavior change. Leave inline unless a real SoT/test need arises.
  const rows = joined.map((r) => {
    const safeOverrides = sanitizeAwaitingOverridesForShippingEligibility(
      {
        clientId: r.order.clientId,
        storeId: r.order.storeId,
        orderStatus: r.order.orderStatus,
        raw: r.order.raw,
      },
      r.overrides,
    );
    const ship =
      latestShipByOrderId.get(r.order.id) ??
      latestShipByOrderNumber.get(r.order.orderNumber);
    const legacyClientId = resolveLegacyClientId(r.order.clientId, r.order.storeId);
    const rowShippingEligibilityContext: ShippingServiceEligibilityContext =
      orderShippingEligibilityContext({
        clientId: legacyClientId ?? r.order.clientId ?? null,
        clientName: r.order.clientName ?? null,
        storeId: r.order.storeId ?? null,
        raw: r.order.raw,
        recipientOverride: safeOverrides?.recipientOverride,
      });
    const rowIsHugrab = isHugrabShippingContext(rowShippingEligibilityContext);
    const baseOrderLifecycle = resolveOrderLifecycleStatus({
      orderStatus: r.order.orderStatus,
      canonicalStatus: r.order.canonicalStatus,
      externallyShipped: r.order.externallyShipped === true,
    });
    const effectiveOrderStatus = baseOrderLifecycle.effectiveOrderStatus;
    const isShippedBucket = effectiveOrderStatus === 'shipped';
    const returnSummary = isShippedBucket
      ? returnSummaryByOrderId.get(r.order.id) ?? null
      : null;
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
    // Per user override unlock shipped data on 2026-06-17 (PS-273): DISPLAY-ONLY shipped/cancelled
    // account-label correction. A Shipp-brokered shipment is shipp_-prefixed (service code) or
    // carries source='shipp'. Its account label is the literal "Shipp" — never a fabricated
    // direct carrier account. This flag selects that label as a fallback that beats the static
    // registry guess but LOSES to genuinely-persisted provider_account_nickname / selected_rate_json
    // nicknames (which still win first below). No mutation; reads the same row the DTO already loaded.
    const isShippBrokeredShipment = Boolean(
      ship &&
        (isShippBrokeredServiceCode(ship.service_code) ||
          (typeof ship.source === 'string' && ship.source.trim().toLowerCase() === 'shipp')),
    );
    const storedProviderAccountId = ship?.provider_account_id ?? null;
    const providerAccountId = storedProviderAccountId ?? resolvedCarrierAccount?.shippingProviderId ?? null;
    const providerAccountNickname = ship
      ? ship.provider_account_nickname ??
        (isShippBrokeredShipment ? SHIPP_BROKERED_ACCOUNT_LABEL : null) ??
        resolvedCarrierAccount?.nickname ??
        null
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
        ? normalizeOrderSelectedRateDto(
            {
              // Per user override unlock shipped data on 2026-07-07: display-only PS-402 fix.
              // Persisted selected_rate_json can carry insuranceCost/provenance/total, so route
              // it through the backend selected-rate DTO owner with HUGRAB context instead of
              // spreading raw JSON into shipped rows.
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
            },
            undefined,
            `order ${r.order.id} shipment selectedRateJson`,
            { isHugrab: rowIsHugrab, eligibility: rowShippingEligibilityContext },
          )
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
              { isHugrab: rowIsHugrab, eligibility: rowShippingEligibilityContext },
            )
        : null;
    const selectedRateBestRateCandidateRecord = recordOrNull(selectedRate);
    const selectedRateBestRateCandidate =
      selectedRateBestRateCandidateRecord
        ? {
            ...selectedRateBestRateCandidateRecord,
            carrierNickname:
              selectedRateBestRateCandidateRecord.carrierNickname ??
              selectedRateBestRateCandidateRecord.providerAccountNickname ??
              providerAccountNickname,
          }
        : null;
    const overrideBestRate =
      !isShippedBucket && safeOverrides?.bestRateJson && typeof safeOverrides.bestRateJson === 'object'
        ? {
            ...selectedRateBestRateCandidate,
            ...(safeOverrides.bestRateJson as Record<string, unknown>),
            carrierNickname:
              (safeOverrides.bestRateJson as Record<string, unknown>).carrierNickname ??
              selectedRateBestRateCandidate?.carrierNickname ??
              providerAccountNickname,
          }
        : null;
    const bestRate = !isShippedBucket ? normalizeListBestRate(overrideBestRate) : null;
    const walmartDirectDuplicate =
      r.order.storeId === WALMART_SHIPSTATION_STORE_ID
        ? walmartDirectDuplicateByOrderNumber.get(r.order.orderNumber)
        : undefined;
    const walmartSourceLink = walmartDirectDuplicate
      ? {
          provider: 'walmart',
          canonicalVisibleStoreId: WALMART_SHIPSTATION_STORE_ID,
          hiddenDuplicateStoreId: WALMART_DIRECT_STORE_ID,
          identity: r.order.orderNumber,
          hasShipStationSource: true,
          hasDirectWalmartSource: true,
          directDuplicateOrderId: walmartDirectDuplicate.id,
          directDuplicateExternalOrderId: walmartDirectDuplicate.external_order_id,
          directDuplicateStatus: walmartDirectDuplicate.order_status,
          directDuplicateSourceProvider: walmartDirectDuplicate.source_provider,
          directDuplicateSourceAccountId: walmartDirectDuplicate.source_account_id,
          mapping: walmartDirectStoreDebugInfo(),
        }
      : null;
    const bestRateRecord = recordOrNull(bestRate);
    const v2BestRateRecord = overrideBestRate ? bestRateRecord : null;
    const selectedRateRecord = recordOrNull(selectedRate);
    const rowRaw = recordOrNull(r.order.raw) ?? {};
    const rowRawDims = recordOrNull(rowRaw.dimensions) ?? {};
    const rowRawShipTo = recordOrNull(rowRaw.shipTo) ?? {};
    const rowDimsL = finiteNumberOrNull(safeOverrides?.rateDimsL) ?? finiteNumberOrNull(rowRawDims.length);
    const rowDimsW = finiteNumberOrNull(safeOverrides?.rateDimsW) ?? finiteNumberOrNull(rowRawDims.width);
    const rowDimsH = finiteNumberOrNull(safeOverrides?.rateDimsH) ?? finiteNumberOrNull(rowRawDims.height);
    const rowWeightOz = finiteNumberOrNull(safeOverrides?.rateWeightOz) ?? finiteNumberOrNull(r.order.weightOz);
    const rowToZip = stringOrNull(r.order.shipToPostalCode) ?? stringOrNull(rowRawShipTo.postalCode);
    const rowToCountry = stringOrNull(rowRawShipTo.country) ?? 'US';
    const rowResidential = booleanOrNull(safeOverrides?.residential) ?? booleanOrNull(rowRawShipTo.residential);
    const bestRateRequestFingerprint =
      stringOrNull(bestRateRecord?.requestFingerprint) ??
      stringOrNull(bestRateRecord?.cacheKey);
    const bestRateWorkflow = !isShippedBucket
      ? buildBestRateWorkflowDto({
          currentRequestFingerprint: bestRateRequestFingerprint,
          currentShipmentFacts: {
            weightOz: rowWeightOz,
            dimsL: rowDimsL,
            dimsW: rowDimsW,
            dimsH: rowDimsH,
            toZip: rowToZip,
            toCountry: rowToCountry,
            toState: stringOrNull(r.order.shipToState) ?? stringOrNull(rowRawShipTo.state),
            toCity: stringOrNull(r.order.shipToCity) ?? stringOrNull(rowRawShipTo.city),
            residential: rowResidential,
            hugrabDefaultInsuranceEnabled: rowIsHugrab ? hugrabDefaultInsuranceEnabled : null,
          },
          backendRequestKey: bestRateRequestFingerprint,
          savedBestRate: bestRateRecord,
          source: inferBestRateWorkflowSource(bestRateRecord),
        })
      // Shipped-row DTO phase: shipped rows now carry the SAME workflow object
      // (extend-never-parallel) — built WITHOUT best-rate data (shipped rows
      // intentionally never expose awaiting best-rate amounts; bestRatePick
      // stays null), so the row enrichment below contributes rowState
      // (local_shipped / external_shipped / missing_shipment_sync), the
      // canonical-first display tuple, and the money tuple priced from the
      // SELECTED rate — letting the FE's last markup-math call die.
      : buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' });
    // PS-120 (reader): ADDITIVELY override the derived bestRateState with a backend-owned
    // in-progress state (pending/rating) ONLY when (a) there is a job row for this order,
    // (b) its stored fingerprint == the order's CURRENT job fingerprint, and (c) a fresh
    // derived state defers only the QUEUED 'pending' stamp — an ACTIVE 'rating' overrides
    // even fresh, so Recalculate All visibly spins on rows being re-rated. In any
    // other case resolveRateJobWorkflowOverride() returns null and bestRateWorkflow is left
    // exactly as buildBestRateWorkflowDto produced it (the byte-identical / harm-free path).
    if (bestRateWorkflow) {
      const rateJob = rateJobByOrderId.get(r.order.id);
      if (rateJob) {
        const currentJobFingerprint = computeOrderRateJobFingerprint({
          orderId: r.order.id,
          weightOz: rowWeightOz,
          shipToPostalCode: r.order.shipToPostalCode ?? null,
          shipToState: r.order.shipToState ?? null,
          shipToCity: r.order.shipToCity ?? null,
          rateDimsL: safeOverrides?.rateDimsL ?? null,
          rateDimsW: safeOverrides?.rateDimsW ?? null,
          rateDimsH: safeOverrides?.rateDimsH ?? null,
          raw: r.order.raw ?? null,
        });
        const override = resolveRateJobWorkflowOverride({
          jobState: rateJob.state,
          jobFingerprint: rateJob.requestFingerprint,
          currentFingerprint: currentJobFingerprint,
          hasFreshRate: bestRateWorkflow.bestRateState === 'fresh',
          jobUpdatedAtMs: rateJob.updatedAtMs,
          nowMs: rateJobReadNowMs,
        });
        if (override) {
          bestRateWorkflow.activeRateCheckState = override.bestRateState;
          bestRateWorkflow.activeRateCheckAgeMs = override.bestRateStateAgeMs;
          if (!bestRateWorkflow.canDisplayFinalRate) {
            bestRateWorkflow.bestRateState = override.bestRateState;
            bestRateWorkflow.bestRateStateAgeMs = override.bestRateStateAgeMs;
            bestRateWorkflow.canDisplayFinalRate = false;
            bestRateWorkflow.canUseDisplayedRateForPurchase = false;
            bestRateWorkflow.savedRateDisplay = 'none';
            bestRateWorkflow.allowedActions.canUseSavedRate = false;
            bestRateWorkflow.allowedActions.canCreateLabel = false;
            bestRateWorkflow.allowedActions.requiresRerate = true;
          }
        }
      }
    }
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
        // Genuinely-persisted nickname only (PS-273: the brokered "Shipp" fallback is a SEPARATE
        // lower-priority slot below — it must not pre-empt persisted best-rate nicknames here).
        value: ship?.provider_account_nickname ?? null,
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
        // Per user override unlock shipped data on 2026-06-17 (PS-273): DISPLAY-ONLY. A Shipp-brokered
        // label with no persisted nickname renders the literal "Shipp" BEFORE the static-registry
        // guess — so it can never fabricate the direct GG6381 account the label was not bought on.
        // Loses to every persisted nickname above.
        value: isShippBrokeredShipment ? SHIPP_BROKERED_ACCOUNT_LABEL : null,
        source: sourceOf('derived', 'shipp_brokered_account_label', 'PS-273 brokered Shipp account label (shipp_ service code or source=shipp)'),
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
    // PS-173 (Phase 1): enrich the workflow DTO with the backend-owned row state,
    // action verbs, and the carrier/service/account display tuple (PS-165b absorbed)
    // — derived from the SAME canonical picks the shipping model uses, and applied
    // AFTER the PS-120 pending/rating override so rowState reflects the
    // operator-visible rate state. Additive: shipped-bucket rows keep
    // bestRateWorkflow=null (their intentional payload design — shipped-row states
    // wire in when later phases revisit that); /rates/browse never enriches, so its
    // output is byte-identical to before PS-173.
    // PS-176: queue-routing facts. A queueable label = a real http(s) URL (the
    // FE's getQueueableLabelUrl semantics — '[object Object]' corruption and
    // non-strings don't count); a direct-carrier selection = the synthetic
    // 10M+ provider id range the direct accounts use.
    const rowLabelUrl = ship?.label_url;
    const rowHasQueueableLabel =
      typeof rowLabelUrl === 'string' && /^https?:\/\//i.test(rowLabelUrl) && !rowLabelUrl.includes('[object Object]');
    const rowIsDirectCarrierSelection = (canonicalProviderAccountId ?? 0) >= 10_000_000;
    // PS-177: row money facts — rule resolution (pid-first, awaiting best-rate
    // identity vs shipped canonical-first) owned by the pure rate-money module.
    const rowIsAwaiting = effectiveOrderStatus === 'awaiting_shipment';
    const rowMarkupRule = resolveOrderRowMarkupRule(
      {
        isAwaiting: rowIsAwaiting,
        bestRateProviderAccountId:
          providerIdOrNull(bestRateRecord?.providerAccountId ?? bestRateRecord?.shippingProviderId) ?? null,
        canonicalProviderAccountId: canonicalProviderAccountId ?? null,
        selectedRateProviderAccountId: selectedRateJsonProviderId ?? null,
        bestRateCarrierCode: stringOrNull(bestRateRecord?.carrierCode),
        canonicalCarrierCode,
        selectedRateCarrierCode,
      },
      carrierMarkupRules,
    );
    // PS-798 (slice 2b): resolve the CANONICAL markup (per-account override from rowMarkupRule -> the
    // per-client billing_config default) so the Best Rate column matches what the invoice bills.
    // Financial-only (non-financial money is null anyway); undefined keeps rate-money's legacy
    // per-account path. Byte-identical for existing per-account markups (resolver returns the account
    // override verbatim) and for default clients (0/0 -> null -> base unchanged).
    const rowClientMarkup = r.order.clientId != null ? clientShippingMarkupByClientId.get(r.order.clientId) : undefined;
    const rowHugrabShippingOverride =
      r.order.clientId != null ? hugrabShippingOverrideByClientId.get(r.order.clientId) : undefined;
    const rowCanonicalMarkup = canViewFinancials
      ? resolveCanonicalMarkup({
          carrierAccountMarkup: rowMarkupRule,
          clientShippingMarkupPct: rowClientMarkup?.pct ?? 0,
          clientShippingMarkupFlat: rowClientMarkup?.flat ?? 0,
        })
      : undefined;
    let bestRateWorkflowRow = bestRateWorkflow
      ? withOrderRowWorkflow(bestRateWorkflow, {
          orderStatus: r.order.orderStatus ?? null,
          externallyShipped: r.order.externallyShipped === true,
          canonicalStatus: r.order.canonicalStatus ?? null,
          isTest: r.order.clientId != null && testClientIds.has(r.order.clientId),
          hasCompleteDims: rowDimsL != null && rowDimsL > 0 && rowDimsW != null && rowDimsW > 0 && rowDimsH != null && rowDimsH > 0,
          hasWeight: rowWeightOz != null && rowWeightOz > 0,
          hasShipment: Boolean(ship),
          hasQueueableLabel: rowHasQueueableLabel,
          isDirectCarrierSelection: rowIsDirectCarrierSelection,
          bestRateCarrierCode: stringOrNull(bestRateRecord?.carrierCode),
          bestRateServiceCode: stringOrNull(bestRateRecord?.serviceCode),
          canonicalCarrierCode,
          canonicalServiceCode,
          canonicalAccountNickname,
          selectedRateCarrierCode: stringOrNull(selectedRateRecord?.carrierCode),
          providerAccountId: canonicalProviderAccountId ?? null,
          money: {
            canViewFinancials,
            bestRateBaseAmount: bestRatePick.value ?? null,
            selectedRateBaseAmount: selectedRateAmount ?? null,
            labelFinalCost: labelCost ?? null,
            markupRule: rowMarkupRule,
            markupRuleCanonical: rowCanonicalMarkup,
            insuranceAddOn: extractInsuranceAddOn(rowIsAwaiting ? bestRateRecord : selectedRateRecord),
            // PS-220 (slice 4b): SHIPP house customer_rate. Awaiting reads the PROJECTED stamp on the
            // raw best_rate_json (nextBestNonHouseRate.totalCost); realized (shipped) is wired in 4b-2.
            // null => not a house row => the tuple owner uses the normal carrier-markup branch.
            houseMarkedAmount: houseMarkedAmountForRow({
              isAwaiting: rowIsAwaiting,
              projectedNextBestTotalCost: finiteNumberOrNull(
                recordOrNull(recordOrNull(overrideBestRate)?.nextBestNonHouseRate)?.totalCost,
              ),
              realizedCustomerRate: null,
            }),
            clientName: r.order.clientName ?? null,
            hugrabShippingRateOverrideConfig: rowHugrabShippingOverride ?? null,
            // PS-239: marketplace-fee facts. Subtotal from the order items (Σ
            // non-adjustment unitPrice×qty); rule resolved most-specific-wins. The
            // marketplace axis is an optional refinement — store/client scope covers
            // the carded KF-Goods two-store case (resolved by storeId).
            productSubtotal: computeProductSubtotal(r.order.items),
            marketplaceFeeRule: resolveMarketplaceFeeRule(marketplaceFeeRules, {
              clientId: r.order.clientId ?? null,
              storeId: r.order.storeId ?? null,
              marketplace: null,
            }),
          },
        })
      : null;
    // PS-220 (slice 4b-2): a shipped row gets no awaiting workflow, but a REALIZED house order should
    // still show its Ship Margin + HOUSE badge. Build a MINIMAL workflow carrying only the money tuple,
    // scoped to shipped house rows with a captured customer_rate and a financial viewer. Non-house
    // shipped rows have no realized capture => bestRateWorkflowRow stays null => byte-identical to today.
    if (!bestRateWorkflowRow && isShippedBucket && canViewFinancials) {
      const realizedHouse = houseRealizedByOrderId.get(finiteNumberOrNull(r.order.id) ?? -1);
      if (realizedHouse) {
        bestRateWorkflowRow = withOrderRowWorkflow(buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' }), {
          orderStatus: 'shipped',
          externallyShipped: r.order.externallyShipped === true,
          canonicalStatus: r.order.canonicalStatus ?? null,
          isTest: r.order.clientId != null && testClientIds.has(r.order.clientId),
          hasCompleteDims: true,
          hasWeight: true,
          hasShipment: Boolean(ship),
          hasQueueableLabel: rowHasQueueableLabel,
          isDirectCarrierSelection: rowIsDirectCarrierSelection,
          bestRateCarrierCode: null,
          bestRateServiceCode: null,
          canonicalCarrierCode,
          canonicalServiceCode,
          canonicalAccountNickname,
          selectedRateCarrierCode: stringOrNull(selectedRateRecord?.carrierCode),
          providerAccountId: canonicalProviderAccountId ?? null,
          money: {
            canViewFinancials,
            bestRateBaseAmount: null,
            // base = DRP's SHIPP cost (the selected/label cost; sidecar drp_cost as a last resort).
            selectedRateBaseAmount: selectedRateAmount ?? null,
            labelFinalCost: labelCost ?? realizedHouse.drpCost,
            markupRule: null, // house: the margin IS the markup; no carrier markup applied
            insuranceAddOn: extractInsuranceAddOn(selectedRateRecord),
            houseMarkedAmount: realizedHouse.customerRate,
            clientName: r.order.clientName ?? null,
            hugrabShippingRateOverrideConfig: rowHugrabShippingOverride ?? null,
            productSubtotal: null,
            marketplaceFeeRule: null,
          },
        });
      }
    }
    const shippingWorkflowState = buildOrderShippingWorkflowState({
      bestRateWorkflow: bestRateWorkflowRow,
      displayRate: bestRate ? (bestRate as Record<string, unknown>) : null,
      hasCompleteDims: rowDimsL != null && rowDimsL > 0 && rowDimsW != null && rowDimsW > 0 && rowDimsH != null && rowDimsH > 0,
      hasWeight: rowWeightOz != null && rowWeightOz > 0,
      isTest: r.order.clientId != null && testClientIds.has(r.order.clientId),
    });
    const shipping = {
      carrierCode: canonicalCarrierCode,
      serviceCode: canonicalServiceCode,
      trackingNumber: canonicalTrackingNumber,
      providerAccountId: canonicalProviderAccountId,
      accountNickname: canonicalAccountNickname,
      selectedRateAmount: canViewFinancials ? selectedRateAmount : null,
      bestRateAmount: canViewFinancials ? bestRatePick.value : null,
      labelCost: canViewFinancials ? labelCost : null,
      labelCreatedAt,
      shipDate: ship?.ship_date ?? null,
      shipmentId: ship?.label_shipment_id ?? null,
      source: ship ? 'shipment' : overrideBestRate ? 'order_override' : null,
      selectedRate: canViewFinancials ? selectedRate : redactRateMoneyFields(selectedRate),
      bestRate: canViewFinancials ? bestRate : redactRateMoneyFields(bestRate),
      bestRateWorkflow: bestRateWorkflowRow,
      shippingWorkflowState: shippingWorkflowState,
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
    const rawForExpedited = recordOrNull(r.order.raw);
    // PS-309 (Per user override unlock shipped data on 2026-06-23): the canonical
    // shipped-label display state, owned HERE so the Shipped list + the detail drawer agree
    // (the FE must not re-derive it). Only meaningful on shipped rows; null otherwise.
    const lifecycleShippedLabelDisplayState =
      effectiveOrderStatus === 'shipped'
        ? resolveShippedLabelDisplayState({
            externallyShipped: r.order.externallyShipped === true,
            externallyFulfilled: booleanOrNull(rawForExpedited?.externallyFulfilled),
            hasActiveShipment: Boolean(ship) && ship?.voided !== true,
            hasVoidedShipment: Boolean(ship) && ship?.voided === true,
          })
        : null;
    // Per user override unlock shipped data on 2026-07-06: PS-387 centralizes
    // read-only lifecycle classification after shipped-label display state is
    // known. This does not modify source orders or shipments.
    const orderLifecycle = resolveOrderLifecycleStatus({
      orderStatus: r.order.orderStatus,
      canonicalStatus: r.order.canonicalStatus,
      externallyShipped: r.order.externallyShipped === true,
      shippedLabelDisplayState: lifecycleShippedLabelDisplayState,
    });
    const overrideTrackingKey = overrideTrackingByOrderId.get(r.order.id) ?? null;
    const trackingCollision = overrideTrackingKey
      ? (shipmentRowsByTracking.get(overrideTrackingKey) ?? []).find(
          (candidate) =>
            (candidate.order_id != null && candidate.order_id !== r.order.id) ||
            (candidate.order_id == null &&
              candidate.order_number != null &&
              candidate.order_number !== r.order.orderNumber),
        ) ?? null
      : null;
    // Per user override unlock shipped data on 2026-07-07: PS-402 adds a
    // read-only reconciliation exception DTO for cancelled rows that still have
    // marketplace fulfillment proof. It does not mutate orders/shipments or
    // weaken shipped/cancelled edit locks.
    const fulfillmentConflict = resolveFulfillmentConflict({
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      orderStatus: r.order.orderStatus,
      canonicalStatus: r.order.canonicalStatus,
      effectiveOrderStatus: orderLifecycle.effectiveOrderStatus,
      orderLifecycleStatus: orderLifecycle.orderLifecycleStatus,
      sourceProvider: r.order.sourceProvider,
      externallyShipped: r.order.externallyShipped === true,
      externallyFulfilled: booleanOrNull(rawForExpedited?.externallyFulfilled),
      externallyFulfilledVerified: r.order.externallyFulfilledVerified === true,
      externallyShippedSource: stringOrNull(safeOverrides?.externallyShippedSource),
      marketplaceTrackingNumber: stringOrNull(safeOverrides?.trackingNumber) ?? canonicalTrackingNumber,
      hasLocalShipment: Boolean(ship) && ship?.voided !== true,
      trackingAttachedOrderId: trackingCollision?.order_id ?? null,
      trackingAttachedOrderNumber: trackingCollision?.order_number ?? null,
    });
    const orderLifecycleLabel = fulfillmentConflict?.label ?? orderLifecycle.orderLifecycleLabel;
    const orderLifecycleReason = fulfillmentConflict?.reason ?? orderLifecycle.orderLifecycleReason;
    const orderForCanonical = {
      ...(r.order as Record<string, unknown>),
      orderStatus: orderLifecycle.effectiveOrderStatus,
      effectiveOrderStatus: orderLifecycle.effectiveOrderStatus,
      orderLifecycleStatus: orderLifecycle.orderLifecycleStatus,
      orderLifecycleLabel,
      orderLifecycleReason,
      isTerminalOrderLifecycle: orderLifecycle.isTerminal,
      isShippingBlockedByLifecycle: orderLifecycle.isShippingBlocked,
    };
    const canonicalOrder = buildCanonicalOrderModel(
      orderForCanonical,
      safeOverrides as Record<string, unknown> | null,
      legacyClientId,
      shipping,
      // PS-276 (slice 2b-2c): the resolver's cached verdict for this address, so the row's resi/comm
      // TAG matches the rate fingerprint. null (miss / resolver OFF) -> override+heuristic verdict.
      resolvedResidentialByOrderId.get(r.order.id) ?? null,
    );
    // PS-038 — expedited indicator for BOTH awaiting and shipped rows. Detected
    // from the BUYER'S REQUESTED service (the original customer expectation),
    // never the purchased label: raw.requestedShippingService → raw.serviceCode
    // → orders.serviceCode, with carrierCode as a final hint. This is a
    // display/normalization-only derived field — no shipped/cancelled mutation.
    const expedited = detectExpeditedShipping(
      stringOrNull(rawForExpedited?.requestedShippingService),
      stringOrNull(rawForExpedited?.serviceCode),
      stringOrNull(r.order.serviceCode),
      stringOrNull(r.order.carrierCode),
    );
    // PS-309 (Per user override unlock shipped data on 2026-06-23): the canonical
    // shipped-label display state, owned HERE so the Shipped list + the detail drawer agree
    // (the FE must not re-derive it). Only meaningful on shipped rows; null otherwise. The
    // active-preferred shipment query above means `ship` is the voided row ONLY when no
    // active label exists — so a voided-only order classifies as 'voided_label' and that
    // beats the externally_shipped flag (the #1298 fix). Read-only; no mutation.
    const shippedLabelDisplayState = lifecycleShippedLabelDisplayState;
    return {
      ...r.order,
      orderStatus: orderLifecycle.effectiveOrderStatus,
      effectiveOrderStatus: orderLifecycle.effectiveOrderStatus,
      orderLifecycleStatus: orderLifecycle.orderLifecycleStatus,
      orderLifecycleLabel,
      orderLifecycleReason,
      isTerminalOrderLifecycle: orderLifecycle.isTerminal,
      isShippingBlockedByLifecycle: orderLifecycle.isShippingBlocked,
      billingStatus: orderLifecycle.billingStatus,
      fulfillmentConflict,
      expedited,
      legacyClientId,
      // PS-186: backend-owned test-order fact (clients.isTest) — the FE must read this,
      // never classify test-ness itself for money paths.
      isTest: r.order.clientId != null && testClientIds.has(r.order.clientId),
      overrides: safeOverrides,
      // PS-309: backend-owned shipped-label display state (active_label / voided_label /
      // external_label / missing_shipment_sync). The shipped table + drawer read THIS.
      shippedLabelDisplayState,
      // Per user override unlock shipped data on 2026-05-23: display-only
      // summary from returns; no shipped order or shipment row is modified.
      returnSummary: returnSummary
        ? {
            ...returnSummary,
            returnCustomerShippingRate: canViewFinancials
              ? returnSummary.returnCustomerShippingRate
              : null,
          }
        : null,
      label: label
        ? {
            ...label,
            cost: canViewFinancials ? labelCost : null,
            rawCost: canViewFinancials ? baseShipmentCost : null,
          }
        : null,
      selectedRate: canViewFinancials ? selectedRate : redactRateMoneyFields(selectedRate),
      bestRate: canViewFinancials ? bestRate : redactRateMoneyFields(bestRate),
      bestRateWorkflow: bestRateWorkflowRow,
      shippingWorkflowState: shippingWorkflowState,
      // PS-304: backend-owned package facts ON THE ROW (not just the detail panel),
      // projected from the PS-301 axes + lifecycle/label already in scope — no extra
      // query. immutableReason reinforces the shipped/cancelled lock.
      packageFacts: buildOrderRowPackageFacts({
        orderStatus: orderLifecycle.effectiveOrderStatus,
        externallyShipped: r.order.externallyShipped === true,
        canonicalStatus: r.order.canonicalStatus ?? null,
        hasActiveLabel: rowHasQueueableLabel || Boolean(ship),
        packageState: bestRateWorkflowRow?.packageState ?? null,
        rateState: bestRateWorkflowRow?.rateState ?? null,
        requiresRerate: bestRateWorkflowRow?.allowedActions?.requiresRerate ?? null,
        weightOz: rowWeightOz,
        dims:
          rowDimsL != null && rowDimsW != null && rowDimsH != null
            ? { length: rowDimsL, width: rowDimsW, height: rowDimsH }
            : null,
        // selectedPackageId is the PACKAGE id (text column), distinct from selectedPid
        // (the integer shipping-provider id). Read the package column, not the provider one.
        selectedPackageId: safeOverrides?.selectedPackageId != null ? String(safeOverrides.selectedPackageId) : null,
      }),
      shipping,
      canonicalOrder,
      sourceLink: walmartSourceLink,
    };
  }).map((row) => redactOrderFinancials(row, canViewFinancials));
  const totalMs = msSince(routeStartedAt);
  logSlowOrdersList(q, requestIdFromContext(c), timings, totalMs, {
    rows: rows.length,
    total,
    totalApproximate,
    countWasSkipped,
    walmartDirectDuplicatesOnPage: walmartDirectDuplicateByOrderNumber.size,
    shipmentsByOrderId: latestShipByOrderId.size,
    shipmentsByOrderNumber: latestShipByOrderNumber.size,
  });
  const response = paginated(rows, total, q) as ReturnType<typeof paginated<typeof rows[number]>> & {
    pagination: ReturnType<typeof paginated<typeof rows[number]>>['pagination'] & {
      totalApproximate?: boolean;
      hasNextPage?: boolean;
    };
  };
  response.pagination.totalApproximate = totalApproximate;
  response.pagination.hasNextPage = joined.length >= q.pageSize;
  if (requestedOrderIds) {
    return c.json(buildOrderBulkSnapshotDto(requestedOrderIds, rows));
  }
  return c.json(response);
  } catch (err) {
    const totalMs = msSince(routeStartedAt);
    console.error('[orders:list] failed', {
      requestId: requestIdFromContext(c) ?? undefined,
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
}

app.get('/', zValidator('query', listQuery), (c) =>
  ordersListResponse(c, c.req.valid('query')),
);

// Per user override unlock shipped data on 2026-07-14: this read-only endpoint
// reuses the canonical Orders list DTO; mutation guards and lifecycle locks are unchanged.
app.post('/bulk-snapshot', zValidator('json', bulkSnapshotBody), (c) => {
  const orderIds = normalizeOrderBulkSnapshotIds(c.req.valid('json').orderIds);
  return ordersListResponse(c, {
    page: 1,
    pageSize: orderIds.length,
    includeTotal: false,
    includeInactiveClients: true,
  }, orderIds);
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
  // PS-273: shipments.source ('shipp' for brokered labels) — read DISPLAY-ONLY to label the
  // account as "Shipp" instead of fabricating a direct carrier account. Additive projection.
  source: string | null;
  selected_rate_json: Record<string, unknown> | null;
  // PS-309 (Per user override unlock shipped data on 2026-06-23): the chosen shipment's
  // voided flag (coalesce(voided,false)) — drives the shipped-label display state.
  voided: boolean | null;
};

type ExportShipmentRow = LatestShipmentRow;

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
    const idsScope = ordersScopeFromContext(c);
    const idsEffectiveStatusSql = orderLifecycleEffectiveStatusAliasSql('o');
    const rows = await db.execute<{ id: number; order_number: string }>(sql`
      select distinct o.id, o.order_number
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.sku = ${sku}
        and ${orderAliasScopePredicate('o', idsScope)}
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        ${qty !== undefined ? sql`and oi.quantity >= ${qty}` : sql``}
        ${orderStatus ? sql`and ${idsEffectiveStatusSql} = ${orderStatus}` : sql``}
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
    const storeCountsScope = ordersScopeFromContext(c);
    const fromIso = (q.dateFrom ? new Date(q.dateFrom) : new Date(0)).toISOString();
    const toIso = (q.dateTo ? new Date(q.dateTo) : new Date(Date.now() + 86400000)).toISOString();
    const status = q.status ?? null;
    const storeCountsEffectiveStatusSql = orderLifecycleEffectiveStatusAliasSql('orders');
    const rows = await db.execute<{
      store_id: number | null;
      count: number;
    }>(sql`
      select store_id, count(*)::int as count
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        and store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        and ${orderAliasScopePredicate('orders', storeCountsScope)}
        and (${status}::text is null or ${storeCountsEffectiveStatusSql} = ${status}::text)
        and (${status}::text is distinct from 'awaiting_shipment' or ${visibleAwaitingOrdersPredicate('orders')})
      group by store_id
      order by count desc
    `);
    return c.json({ data: rows });
  }
);

// Fulfillment-day window math (12pm-CA noon-to-noon shift with the 6pm
// rollover and Fri→Mon weekend hold) lives in
// `src/lib/time/fulfillment-window.ts` so it can be unit-tested without the
// route. See PS-047: boundaries are true noon-Pacific instants in UTC, aligned
// with the standardized true-UTC `orders.order_date` storage.

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
    const dailyStatsScope = ordersScopeFromContext(c);
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
    ) and ${sql.raw(activeClientPredicateSql('c'))}
    and not exists (
      select 1 from clients hidden_client
      where hidden_client.id = o.client_id
        and lower(hidden_client.name) = 'api shipments'
    )`;
    // Per user override unlock shipped data on 2026-07-06: daily stats use
    // the backend lifecycle SOT for read-only counts.
    const dailyStatsEffectiveStatusSql = orderLifecycleEffectiveStatusAliasSql('o');
    const manualOrdersDailyStatsAwaitingPredicate = sql`(
      ${dailyStatsEffectiveStatusSql} = 'awaiting_shipment'
      and ${sql.raw(manualOrdersOrderPredicateSql('o', 'manual_orders_client'))}
    )`;
    const dailyStatsVisibilityPredicate = sql`(${visibleOrderPredicate} or ${manualOrdersDailyStatsAwaitingPredicate})`;

    // totalOrders: all non-cancelled orders received inside the current
    // fulfillment intake window. The strip derives shipped as
    // totalOrders - needToShip, matching v2 daily-strip.js.
    // Run the three count aggregates CONCURRENTLY so a single daily-stats request
    // holds DB connections for ~1x wall-clock instead of 3x sequential — this
    // reduces cold-start pool contention (the main cause of post-restart slowness).
    // - totalOrders: all non-cancelled orders received inside the current intake
    //   window (strip derives shipped as totalOrders - needToShip, v2 parity).
    // - needToShip: remaining same-day fulfillment work inside the intake window.
    // - upcomingOrders: non-cancelled orders dated after the window.
    const [windowedRows, backlogRows, upcomingRows] = await Promise.all([
      db.execute<{ total_orders: number }>(sql`
      select count(*)::int as total_orders
      from orders o
      left join clients c on c.id = o.client_id
      where ${dailyStatsEffectiveStatusSql} <> 'cancelled'
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and ${dailyStatsVisibilityPredicate}
        and ${orderAliasScopePredicate('o', dailyStatsScope)}
    `),
      db.execute<{ need_to_ship: number }>(sql`
      select count(*)::int as need_to_ship
      from orders o
      left join clients c on c.id = o.client_id
      where ${dailyStatsEffectiveStatusSql} = 'awaiting_shipment'
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and ${dailyStatsVisibilityPredicate}
        and ${orderAliasScopePredicate('o', dailyStatsScope)}
        and ${visibleAwaitingOrdersPredicate('o')}
    `),
      db.execute<{ upcoming_orders: number }>(sql`
      select count(*)::int as upcoming_orders
      from orders o
      left join clients c on c.id = o.client_id
      where o.order_date > ${toIso}::timestamptz
        and ${dailyStatsEffectiveStatusSql} <> 'cancelled'
        and ${dailyStatsVisibilityPredicate}
        and ${orderAliasScopePredicate('o', dailyStatsScope)}
    `),
    ]);
    const w = windowedRows[0];
    const b = backlogRows[0];
    const u = upcomingRows[0];
    return c.json({
      window: {
        from: fromIso,
        to: toIso,
        fromLabel: formatFulfillmentBoundaryLabel(fromDate),
        toLabel: formatFulfillmentBoundaryLabel(toDate),
      },
      totalOrders: w?.total_orders ?? 0,
      needToShip: b?.need_to_ship ?? 0,
      upcomingOrders: u?.upcoming_orders ?? 0,
    });
  }
);

app.get('/picklist', zValidator('query', picklistQuery), async (c) => {
  const q = c.req.valid('query');
  const picklistScope = ordersScopeFromContext(c);
  const fromIso = q.dateFrom
    ? new Date(q.dateFrom).toISOString()
    : new Date(0).toISOString();
  const toIso = q.dateTo
    ? new Date(q.dateTo).toISOString()
    : new Date(Date.now() + 86400000).toISOString();
  const cid: number | null = q.clientId ?? null;
  const sid: number | null = q.storeId ?? null;
  const status = q.status;
  const picklistEffectiveStatusSql = orderLifecycleEffectiveStatusAliasSql('o');

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
      oi.sku                                        as sku,
      max(oi.name)                                  as name,
      max(nullif(oi.image_url, ''))                 as image_url,
      sum(oi.quantity)::int                         as total_qty,
      count(distinct o.id)::int                     as order_count
    from order_items oi
    join orders o on o.id = oi.order_id
    left join clients c on c.id = o.client_id
    where (${status}::text is null or ${picklistEffectiveStatusSql} = ${status}::text)
      and (
        (o.store_id is not null and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
        or c.is_test = true
      )
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and (${sid}::int is null or o.store_id = ${sid}::int)
      and ${orderAliasScopePredicate('o', picklistScope)}
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and oi.sku is not null
      and oi.sku <> ''
      and oi.quantity > 0
    group by o.client_id, c.name, oi.sku
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
// PS-232: zod-validate the /distinct-skus query (was read raw via c.req.query).
// IDs are coerced (empty string -> undefined, not NaN); booleans keep the exact
// '1'|'true'|'yes' semantics; values still flow into PARAMETERIZED SQL below.
const distinctSkusOptionalId = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.coerce.number().int().positive().optional(),
);
const distinctSkusQuery = z.object({
  status: z.string().max(64).optional(),
  clientId: distinctSkusOptionalId,
  storeId: distinctSkusOptionalId,
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  includeInactiveClients: z.string().max(8).optional(),
  includeInactive: z.string().max(8).optional(),
});
app.get('/distinct-skus', zValidator('query', distinctSkusQuery), async (c) => {
  const q = c.req.valid('query');
  const distinctSkusScope = ordersScopeFromContext(c);
  const status = q.status ?? null;
  const dateFrom = q.dateFrom ?? null;
  const dateTo = q.dateTo ?? null;
  const includeInactiveRaw = (q.includeInactiveClients ?? q.includeInactive ?? 'false').toLowerCase();
  const includeInactiveClients = ['1', 'true', 'yes'].includes(includeInactiveRaw);
  const cid = q.clientId ?? null;
  const sid = q.storeId ?? null;

  const rows = await db.execute<{ sku: string }>(sql`
    select distinct oi.sku as sku
    from order_items oi
    join orders o on o.id = oi.order_id
    where oi.sku is not null
      and oi.sku <> ''
      and oi.quantity > 0
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
            and ${sql.raw(activeClientPredicateSql('owner_client'))}
        )
      )
      and (${status}::text is null or o.order_status = ${status}::text)
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and (${sid}::int is null or o.store_id = ${sid}::int)
      and ${orderAliasScopePredicate('o', distinctSkusScope)}
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
  const byNumberScope = ordersScopeFromContext(c);
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
    .where(and(eq(orders.orderNumber, orderNumber), orderScopePredicate(byNumberScope)))
    .limit(1);
  if (!row) return c.json({ error: 'Order not found' }, 404);
  return c.json(row);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const detailScope = ordersScopeFromContext(c);
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), orderScopePredicate(detailScope)))
    .limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);

  await ensureOrderRecipientOverrideSchema();
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

  // PS-037: resolve the per-client SKU+qty combination package default (if any)
  // so the side panel can auto-select it. Derived server-side from order items.
  const comboPackageDefault = await getComboPackageDefaultForOrder(id);
  const detailClientIsTest = await loadClientIsTest(order.clientId);

  // PS-220 (portal redaction): the detail payload carries overrides.bestRateJson (the projected
  // houseMargin + nextBestNonHouseRate stamp) and bestRateWorkflow.money — both INTERNAL. The
  // detail routes previously returned them raw; scope them with the SAME redactor the list uses.
  const detailCanViewFinancials = canViewOrderFinancials(c);
  return c.json(redactOrderFinancials({
    ...buildOrderDetailPayload(order as Record<string, unknown>, overrides, shipmentRows),
    comboPackageDefault,
    // PS-177 (Phase 5): backend-owned dims/weight/package DEFAULTS from product
    // data — replaces the panel's N-per-open /products/by-sku fetch loop. Null
    // when nothing resolvable; the loader swallows its own errors.
    dimsDefaults: await getOrderDimsDefaultsForOrder(id),
    // PS-205: the CANONICAL effective package facts + their source
    // ('override' | 'combo_default' | 'single_sku_default' | 'imported') so the
    // panel can say where the weight/dims came from instead of mixing sources.
    // Read-only; the loader swallows its own errors.
    packageFacts: await resolveOrderPackageFacts(id),
    // PS-186: backend-owned test-order fact (clients.isTest) — mirrors the list row field.
    isTest: detailClientIsTest,
    // PS-219 (per user override unlock shipped data on 2026-06-13): backend-owned
    // read-only voidability so the operator Void Label UI never guesses. Reads the
    // shipmentRows already loaded above; performs NO write.
    labelVoidability: resolveOrderLabelVoidability(shipmentRows, detailClientIsTest),
    // Tracking-driven queue retirement: read-only carrier tracking summary for the
    // side panel ("Delivered Jun 12" / "In transit"). Null until the poller has seen
    // this order; never blocks the payload (the loader swallows its own errors).
    tracking: await loadOrderTrackingSummary(id),
  }, detailCanViewFinancials));
});

// Alias of GET /orders/:id — old API exposed both shapes. Same payload.
app.get('/:id{[0-9]+}/full', async (c) => {
  const id = Number(c.req.param('id'));
  const fullDetailScope = ordersScopeFromContext(c);
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), orderScopePredicate(fullDetailScope)))
    .limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);
  await ensureOrderRecipientOverrideSchema();
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

  // PS-037: resolve the per-client SKU+qty combination package default (if any)
  // so the side panel can auto-select it. Derived server-side from order items.
  const comboPackageDefault = await getComboPackageDefaultForOrder(id);
  const detailClientIsTest = await loadClientIsTest(order.clientId);

  // PS-220 (portal redaction): same scrub as GET /:id — overrides.bestRateJson + bestRateWorkflow.money
  // carry internal house cost/margin/source that a non-financial / client_user viewer must never see.
  const fullCanViewFinancials = canViewOrderFinancials(c);
  return c.json(redactOrderFinancials({
    ...buildOrderDetailPayload(order as Record<string, unknown>, overrides, shipmentRows),
    comboPackageDefault,
    // PS-177 (Phase 5): same backend-owned dims/weight/package defaults as GET /:id.
    dimsDefaults: await getOrderDimsDefaultsForOrder(id),
    // PS-205: same canonical effective package facts as GET /:id.
    packageFacts: await resolveOrderPackageFacts(id),
    // PS-186: backend-owned test-order fact (clients.isTest) — mirrors the list row field.
    isTest: detailClientIsTest,
    // PS-219 (per user override unlock shipped data on 2026-06-13): backend-owned
    // read-only voidability so the operator Void Label UI never guesses. Reads the
    // shipmentRows already loaded above; performs NO write.
    labelVoidability: resolveOrderLabelVoidability(shipmentRows, detailClientIsTest),
    // Tracking-driven queue retirement: same read-only tracking summary as GET /:id.
    tracking: await loadOrderTrackingSummary(id),
  }, fullCanViewFinancials));
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
  // PS-291 (slice 1): line items are OPTIONAL — allow items:[] (no .min(1)).
  items: z.array(z.object({
    sku: z.string().optional().default(''),
    name: z.string().optional().default(''),
    quantity: z.coerce.number().positive().optional().default(1),
    price: z.coerce.number().nonnegative().optional().default(0),
  })).optional().default([]),
  // PS-291 (slice, card DoD item 6): the rate the operator SELECTED in the
  // preview, echoed back verbatim from the backend quoter. OPTIONAL — saving
  // without a selection still works. When present it is normalized through the
  // canonical owner (buildManualSelectedBestRate → normalizeOrderBestRateDto)
  // and persisted onto order_overrides.bestRateJson so Create Label / Print
  // Queue reuse it without a silent re-rate. The selected ship-from origin rides
  // alongside (carried into raw.shipFromOrigin for label provenance).
  selectedRate: z.object({
    carrierCode: z.string().optional().default(''),
    serviceCode: z.string().optional().default(''),
    serviceName: z.string().optional().default(''),
    carrierNickname: z.string().nullable().optional().default(null),
    shippingProviderId: z.coerce.number().int().nullable().optional().default(null),
    shipmentCost: z.coerce.number().nonnegative().optional().default(0),
    otherCost: z.coerce.number().nonnegative().optional().default(0),
    cost: z.coerce.number().nonnegative().optional().default(0),
  }).optional(),
  shipFrom: z.object({
    street1: z.string().optional().default(''),
    city: z.string().optional().default(''),
    state: z.string().optional().default(''),
    postalCode: z.string().optional().default(''),
    country: z.string().optional().default('US'),
  }).optional(),
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
    // PS-291 (slice 1): manual orders are REAL operational orders, not test
    // fixtures — the Manual Orders client carries isTest:false so its orders
    // enter the real Awaiting/billing/rate flows (clients.isTest is the
    // backend-owned source of truth the row/detail DTOs derive `isTest` from).
    const [updated] = await db
      .update(clients)
      .set({ active: true, isTest: false, updatedAt: new Date() })
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
      // PS-291 (slice 1): real operational client (see note above).
      isTest: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!created) throw new Error('Manual Orders client could not be created');
  return created;
}

// PS-240: manual order creation is an internal-operator tool — block portal roles
// (client_user / read_only_support). It writes to the fixed manual-orders client,
// so there is no cross-tenant target to scope, but a portal principal must not be
// able to create orders at all.
app.post('/manual', requireInternalPermission('print_queue:write'), zValidator('json', manualOrderBody), async (c) => {
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

  // PS-291 (slice 1): line items are OPTIONAL — an operator may save a manual
  // order with zero items (e.g. a shipping-only / placeholder order). Persist
  // `items: []` safely; the order total falls back to explicit
  // totalPaid/shippingPaid/taxPaid (and 0 when none are provided) below.

  // PS-291 (slice, card DoD item 6): if the operator SELECTED a preview rate,
  // normalize it into the canonical bestRate DTO here (backend is the SOT — the
  // modal echoed the quoter's numbers, it did not recompute them). Persisted to
  // order_overrides.bestRateJson below so Create Label / Print Queue reuse it.
  const selectedBestRate = buildManualSelectedBestRate(body.selectedRate ?? null);
  // The ship-from origin the operator picked for the quote — carried into raw for
  // label provenance (readShipFrom stays the runtime origin source of truth).
  const shipFromOrigin = body.shipFrom
    ? {
        street1: body.shipFrom.street1.trim() || null,
        city: body.shipFrom.city.trim() || null,
        state: body.shipFrom.state.trim() || null,
        postalCode: body.shipFrom.postalCode.trim() || null,
        country: body.shipFrom.country.trim() || 'US',
      }
    : null;

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
    // PS-291 (slice 1): manual orders are REAL — do NOT mark raw.test true.
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
    // PS-291 (slice, card DoD item 6): the operator-selected ship-from origin
    // (label provenance). null when no origin was selected (legacy default).
    shipFromOrigin,
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
  await replaceOrderItemsForOrders([created]);
  // PS-234: audit manual order creation (actor + new order id; no PII values).
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'order',
    resourceType: 'order',
    resourceId: created.id,
    action: 'manual_create',
    details: { orderNumber, itemCount: activeItems.length },
  });

  // PS-291 (slice, card DoD item 6): persist the selected bestRate + its SAVE
  // timestamp so Create Label / Print Queue read it back like any other saved
  // best rate. null when no rate was selected (bestRateAt stays null too).
  await ensureOrderRecipientOverrideSchema();
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
      bestRateJson: selectedBestRate,
      bestRateAt: selectedBestRate ? now : null,
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
        bestRateJson: selectedBestRate,
        bestRateAt: selectedBestRate ? now : null,
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

const recipientOverrideBody = z.object({
  name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  street1: z.string().nullable().optional(),
  street2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
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
  recipientOverride: recipientOverrideBody.optional(),
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

  // Per user override unlock shipped data on 2026-07-15: read the effective
  // destination only to reject an ineligible PO Box rate before the guarded write.
  const [existing] = await db
    .select({
      id: orders.id,
      clientId: orders.clientId,
      storeId: orders.storeId,
      raw: orders.raw,
      recipientOverride: orderOverrides.recipientOverride,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'Order not found' }, 404);

  // Split the body: externallyShipped lives on the `orders` table;
  // everything else (including externallyShippedSource) lives on order_overrides.
  // selectedRateJson is not a column on order_overrides — drop it from the
  // overrides payload (it rides along into shipments via the label flow).
  const { externallyShipped, selectedRateJson, ...overridesBody } = body;

  if (overridesBody.recipientOverride !== undefined) {
    try {
      overridesBody.recipientOverride = normalizeRecipientOverride(body.recipientOverride);
    } catch (err) {
      return c.json({ error: (err as Error).message, code: 'INVALID_RECIPIENT_OVERRIDE' }, 400);
    }
  }

  // v2-parity: canonicalize incoming bestRateJson before persisting.
  // Accepts raw ShipStation shapes (snake_case) or the already-normalized DTO.
  if (overridesBody.bestRateJson !== undefined && overridesBody.bestRateJson !== null) {
    const validatedDims = validateBestRateDimsForPersistedRate(
      overridesBody.bestRateJson,
      overridesBody.bestRateDims,
    );
    if (!validatedDims) {
      return c.json({ error: 'Complete dimensions are required before saving a best rate' }, 400);
    }
    overridesBody.bestRateDims = validatedDims;
    // PS-292: capture the RAW provider before normalize drops it. SHIPP identity is provider-only
    // (the connector rewrites carrier_code) and translateRateToV2Shape preserves the original under .raw.
    const rawIncoming = overridesBody.bestRateJson as Record<string, unknown> | null;
    const rawHouseProvider =
      (rawIncoming?.provider ?? (rawIncoming?.raw as Record<string, unknown> | undefined)?.provider) ?? null;
    try {
      overridesBody.bestRateJson = normalizeOrderBestRateDto(
        overridesBody.bestRateJson,
        'bestRateJson',
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const eligibilityReason = shippingRateEligibilityReason(
      orderShippingEligibilityContext({
        ...existing,
        recipientOverride: overridesBody.recipientOverride ?? existing.recipientOverride,
      }),
      overridesBody.bestRateJson,
    );
    if (eligibilityReason) {
      return c.json({ error: eligibilityReason, code: 'SHIPPING_SERVICE_NOT_ELIGIBLE' }, 400);
    }
    // PS-292 (items 2/4): stamp the backend house-tuple verdict (always — inert 'not_house' for
    // non-house) + reject a half-house SHIPP save (gated behind the default-OFF HOUSE_TUPLE_SAVE_GUARD
    // canary). The verdict persists into best_rate_json so the awaiting row renders 'House rate needs
    // refresh' verbatim. Lockdown-safe: only the awaiting order_overrides.best_rate_json is touched.
    const normalizedBest = overridesBody.bestRateJson as
      | { nextBestNonHouseRate?: unknown; houseMargin?: number | null; houseTupleStatus?: ReturnType<typeof houseTupleStatus> }
      | null;
    const hStatus = houseTupleStatus({
      rawProvider: rawHouseProvider,
      nextBestNonHouseRate: normalizedBest?.nextBestNonHouseRate ?? null,
      houseMargin: normalizedBest?.houseMargin ?? null,
      optedIn: await clientHouseAccountEnabled(existing.clientId ?? null),
    });
    if (shouldRejectHalfHouseSave(hStatus) && process.env.HOUSE_TUPLE_SAVE_GUARD === 'on') {
      return c.json({ error: HOUSE_TUPLE_REQUIRED_MESSAGE, code: 'HOUSE_TUPLE_REQUIRED' }, 400);
    }
    if (normalizedBest) normalizedBest.houseTupleStatus = hStatus;
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

  // PS-207 (B): keep an explicitly-submitted package and dims coherent
  // (the PATCH body carries selectedPackageId; rateDims* never ride this
  // route today, but the chokepoint covers any future caller).
  const coherentBody = await applyBoxDimsCoherence(
    overridesBody as Partial<typeof orderOverrides.$inferInsert>
  );
  if (!coherentBody.ok) {
    return c.json({ error: coherentBody.error, code: 'BOX_DIMS_MISMATCH' }, 400);
  }

  // Per user override unlock shipped data on 2026-07-14: the final lifecycle
  // check, orders flag update, and override upsert share one row-locked transaction.
  const result = await applyEditableOrderPatch(id, {
    externallyShipped,
    overridesPatch: coherentBody.patch,
  }, guard.writeAuthorization);
  if (!result.ok) return orderEditWriteFailureResponse(c, result);
  return c.json(result.value);
});

// v2-parity POST aliases. v2's apiClient hits dedicated action endpoints per
// field (POST /orders/:id/residential, .../selected-pid, etc.) — v4's canonical
// update path is a PATCH with the field in the body. These aliases forward to
// the same upsert logic so v2 callers don't need to know the v4 shape.

// ─── PS-207 (B): dims ⇄ selected-box coherence for MUTABLE orders ───────────
// The panel's Package dropdown and Size fields must persist in lockstep:
// choosing a package also persists its dims; entering dims that exactly match
// a package selects that package; explicitly submitting a package AND dims
// that identify different boxes is rejected (400) — never silently
// precedence-picked. Applies to the PACKAGE channel only
// (selectedPackageId + rateDims*): orderOverrides.selectedPid is the SHIP
// ACCOUNT channel in v4 (the panel writes shippingProviderId there) and gets
// no box coherence. Custom dims do NOT clear an existing selection here —
// cross-time disagreement is billing's job to flag as a review line
// (PS-193's dirty-flag work will revisit panel auto-persist behavior).
app.post(
  '/:id{[0-9]+}/residential',
  zValidator('json', z.object({ residential: z.boolean().nullable() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const result = await applyOrderOverridesPatch(
      id,
      { residential: c.req.valid('json').residential },
      guard.writeAuthorization,
    );
    if (!result.ok) return orderEditWriteFailureResponse(c, result);
    return c.json({ data: result.value });
  }
);

app.post(
  '/:id{[0-9]+}/selected-pid',
  zValidator('json', z.object({ selectedPid: z.number().int().nullable() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const result = await applyOrderOverridesPatch(
      id,
      { selectedPid: c.req.valid('json').selectedPid },
      guard.writeAuthorization,
    );
    if (!result.ok) return orderEditWriteFailureResponse(c, result);
    return c.json({ data: result.value });
  }
);

// PS-302 / Audit PL-3: the locked HTTP boundary guards first, then delegates the
// complete atomic command to the backend owner. The route does not rank, mint proof, or persist.
app.post(
  '/:id{[0-9]+}/apply-best-rate',
  zValidator(
    'json',
    z.object({
      bestRateJson: z.unknown(),
      bestRateDims: z.string().nullable().optional(),
      selectedPid: z.number().int().nullable().optional(),
      weightOz: z.number().nullable().optional(),
      currentRequestFingerprint: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');
    const result = await applyBestRateForOrder(id, {
      bestRateJson: body.bestRateJson,
      bestRateDims: body.bestRateDims,
      selectedPid: body.selectedPid,
      weightOz: body.weightOz,
      currentRequestFingerprint: body.currentRequestFingerprint,
    }, guard.writeAuthorization);
    if (!result.ok) {
      const payload = result.code
        ? { error: result.error, code: result.code }
        : { error: result.error };
      return result.status === 404
        ? c.json(payload, 404)
        : result.status === 403
          ? c.json(payload, 403)
          : c.json(payload, 400);
    }
    return c.json({ data: result.row });
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
    // PS-207 (B): selecting a known package also persists its dims (lockstep).
    const coherent = await applyBoxDimsCoherence({ selectedPackageId });
    if (!coherent.ok) return c.json({ error: coherent.error, code: 'BOX_DIMS_MISMATCH' }, 400);
    const result = await applyOrderOverridesPatch(id, coherent.patch, guard.writeAuthorization);
    if (!result.ok) return orderEditWriteFailureResponse(c, result);
    return c.json({ data: result.value });
  }
);

// PS-037: save the chosen package as the reusable default for this order's
// EXACT client + SKU+qty combination (not per-SKU). The combo key is derived
// server-side from the order's items — the client only supplies the package +
// optional dims/weight snapshot. Guarded by assertOrderEditable so shipped/
// cancelled lockdown + client scope are enforced.
app.post(
  '/:id{[0-9]+}/save-combo-package-default',
  zValidator(
    'json',
    z.object({
      packageId: z.union([z.string(), z.number()]).nullable().optional(),
      packageCode: z.string().nullable().optional(),
      length: z.number().nullable().optional(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      weightOz: z.number().nullable().optional(),
      // PS-121: explicit "Save weights & dims as SKU defaults" sets this true so the backend
      // invalidates + targeted-recalcs the same SKU+qty group's stale sibling rates. Silent
      // autosave / normal panel Save omit it (default false) → propagate only, no group recalc.
      recalcGroup: z.boolean().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');
    const packageIdNum =
      body.packageId == null || body.packageId === ''
        ? null
        : Number.isFinite(Number(body.packageId))
          ? Math.trunc(Number(body.packageId))
          : null;
    const result = await saveComboPackageDefault(
      id,
      {
        packageId: packageIdNum,
        packageCode: body.packageCode ?? null,
        length: body.length ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        weightOz: body.weightOz ?? null,
      },
      {
        recalcGroup: body.recalcGroup === true,
        writeAuthorization: guard.writeAuthorization,
      },
    );
    // PS-121: kick a bounded targeted recalc for the invalidated ids (awaiting only — the primitive
    // keeps the awaiting_shipment lockdown filter). Fire-and-forget; the order already shows
    // "refreshing" via the pending stamp the service wrote.
    // Per user override unlock shipped data on 2026-06-24: re-rate the changed order even for a SINGLE
    // package change (not just recalcGroup) — a package change invalidates the saved rate, so without a
    // re-rate the row sits on a mismatched_request spinner forever. Fall back to [id] when the service
    // reported no sibling ids. No shipped/cancelled mutation (assertOrderEditable + the awaiting filter).
    const rerateIds = result.affectedOrderIds && result.affectedOrderIds.length ? result.affectedOrderIds : [id];
    startBackfillBestRatesForOrderIds(rerateIds);
    return c.json({ data: result });
  }
);

app.post(
  '/:id{[0-9]+}/best-rate',
  zValidator(
    'json',
    z.object({
      bestRateJson: z.unknown().nullable(),
      bestRateDims: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const guard = await assertOrderEditable(c, id);
    if (!guard.ok) return guard.response;
    const body = c.req.valid('json');
    const result = await saveBestRateForOrder(id, {
      bestRateJson: body.bestRateJson,
      bestRateDims: body.bestRateDims,
    }, guard.writeAuthorization);
    if (!result.ok) {
      const payload = result.code
        ? { error: result.error, code: result.code }
        : { error: result.error };
      return result.status === 404
        ? c.json(payload, 404)
        : result.status === 403
          ? c.json(payload, 403)
          : c.json(payload, 400);
    }
    return c.json({ data: result.row });
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

    // PS-136 (Per user override unlock shipped data on 2026-06-09): the mark-shipped-externally
    // transition (forward-only awaiting->shipped flip + externally_shipped=true + inventory
    // deduction + optional ShipStation markasshipped notify) is now owned by the canonical
    // service markOrderShippedExternally(). assertOrderEditable (above) STAYS in this route as the
    // shipped/cancelled lockdown guard; the service adds a defense-in-depth forward-only
    // final lifecycle predicate so the transition cannot re-flip a shipped/cancelled order.
    // Per user override unlock shipped data on 2026-07-14: persist the generic source override
    // through the row-locked command BEFORE the service performs its atomic status transition.
    // If a concurrent lifecycle transition wins first, no override or status write is applied.
    const sourceWrite = await applyOrderOverridesPatch(id, {
      externallyShippedSource: body.source ?? null,
    }, guard.writeAuthorization);
    if (!sourceWrite.ok) return orderEditWriteFailureResponse(c, sourceWrite);

    const { notify: notifyResult } = await markOrderShippedExternally({
      order: existing,
      flag,
      source: body.source ?? null,
      trackingNumber: body.trackingNumber ?? null,
      carrierCode: body.carrierCode ?? null,
      notifyCustomer: body.notifyCustomer,
      notifyMarketplace: body.notifyMarketplace,
      writeAuthorization: guard.writeAuthorization,
    });
    return c.json({ data: sourceWrite.value, notify: notifyResult });
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

    // PS-207 (B): complete dims that exactly identify a package auto-select
    // that package, so the saved selection and dims stay in lockstep.
    const coherent = await applyBoxDimsCoherence(
      patch as Partial<typeof orderOverrides.$inferInsert>
    );
    if (!coherent.ok) return c.json({ error: coherent.error, code: 'BOX_DIMS_MISMATCH' }, 400);

    // Per user override unlock shipped data on 2026-07-14: save dimensions only
    // after the transaction-time lifecycle owner re-checks the locked order row.
    const result = await applyOrderOverridesPatch(id, coherent.patch, guard.writeAuthorization);
    if (!result.ok) return orderEditWriteFailureResponse(c, result);

    // Per user override unlock shipped data on 2026-06-24: a dims/package change invalidates the saved
    // rate (the FE otherwise sits on a perpetual "package changed" / mismatched_request spinner with no
    // watchdog). Fire a bounded TARGETED re-rate so the row re-rates to the new dims. awaiting-only —
    // assertOrderEditable blocked shipped/cancelled above AND the backfill itself filters
    // order_status = 'awaiting_shipment'. Fire-and-forget; the targeted backfill stamps `pending` (bounded
    // by the reader watchdog + finalize-sweep) and resolves to the fresh rate. No shipped/cancelled
    // mutation, no labels/postage.
    startBackfillBestRatesForOrderIds([id]);

    return c.json({ data: result.value });
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

// PS-137: csvEscape / compactCsvValue / formatCsvNumber / formatCsvDimensions / formatCsvItems /
// formatCsvSkuList moved to ../services/orders-csv-format (imported above). Pure relocation.

app.get('/export', zValidator('query', exportQuery), async (c) => {
  const q = c.req.valid('query');
  const exportScope = ordersScopeFromContext(c);
  const canViewFinancials = canViewOrderFinancials(c);

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

  // Per user override unlock shipped data on 2026-07-06: PS-387 makes CSV
  // status filtering read the backend lifecycle SOT. No source rows are
  // mutated and shipped/cancelled write locks are unchanged.
  const exportEffectiveStatusSql = orderLifecycleEffectiveStatusSql();
  const where = and(
    ...[
      q.status ? sql`${exportEffectiveStatusSql} = ${q.status}` : undefined,
      orderScopePredicate(exportScope),
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      notInArray(orders.storeId, [...EXCLUDED_STORE_IDS]),
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
      testExcludeFilter,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  await ensureOrderRecipientOverrideSchema();
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
          source,
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
    const exportLifecycle = resolveOrderLifecycleStatus({
      orderStatus: order.orderStatus,
      canonicalStatus: order.canonicalStatus,
      externallyShipped: order.externallyShipped === true,
    });
    const isShippedExport = exportLifecycle.effectiveOrderStatus === 'shipped';
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
    const exportBestRateAmount = canViewFinancials ? bestRateAmount : '';
    const exportLabelCost = canViewFinancials ? labelCost : '';
    const exportShipMargin = canViewFinancials ? shipMargin : '';

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
        exportLifecycle.effectiveOrderStatus,
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
        exportBestRateAmount,
        exportLabelCost,
        exportShipMargin,
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

    // PS-247 (defense-in-depth): scope the UPDATE to the caller's allowed client/store
    // ids ON TOP OF the admin-email gate above. For a global admin orderScopePredicate
    // returns undefined (no-op); for any restricted caller it prevents cross-tenant
    // assignment by bare orderIds. Mirrors the inventory bulk-update-dims scope pattern.
    const bulkAssignScope = ordersScopeFromContext(c);
    const scopedRows = await db
      .select({
        id: orders.id,
        status: orders.orderStatus,
        canonicalStatus: orders.canonicalStatus,
        externallyShipped: orders.externallyShipped,
      })
      .from(orders)
      .where(and(orderScopePredicate(bulkAssignScope), inArray(orders.id, orderIds)));
    const terminalRows = scopedRows
      .map((row) => ({
        id: row.id,
        lifecycle: resolveOrderLifecycleStatus({
          orderStatus: row.status,
          canonicalStatus: row.canonicalStatus,
          externallyShipped: row.externallyShipped === true,
        }),
      }))
      .filter((row) => row.lifecycle.isTerminal);
    if (terminalRows.length) {
      return c.json(
        {
          error: 'Cannot assign orders whose order lifecycle is terminal.',
          requested: orderIds.length,
          blocked: terminalRows.map((row) => ({
            id: row.id,
            lifecycleStatus: row.lifecycle.orderLifecycleStatus,
            effectiveOrderStatus: row.lifecycle.effectiveOrderStatus,
            reason: row.lifecycle.orderLifecycleReason,
          })),
        },
        409,
      );
    }

    const updated = await db
      .update(orders)
      .set({
        assignedToUserId: userId,
        assignedToEmail: email,
        assignedAt: userId ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          orderScopePredicate(bulkAssignScope),
          inArray(orders.id, orderIds),
          sql`${orderLifecycleEffectiveStatusSql()} not in ('shipped', 'cancelled')`,
        ),
      )
      .returning({ id: orders.id });

    return c.json({
      updated: updated.length,
      requested: orderIds.length,
      assignedTo: userId ? { userId, email } : null,
    });
  }
);

// PS-312/PS-317 (S4 slice 1): expose the combined-shipment-bundle read-model (S3) to the FE.
// READ-ONLY. Returns which of the caller's IN-SCOPE orders belong to a bundle + each bundle's shared
// label/tracking/status/members (BundleRowDto). The FE renders the DTO verbatim — no logic in the
// frontend. Scope-filtered through the SAME orderScopePredicate the list endpoint uses: a bundle's
// members all share one client/store by construction, so an in-scope member implies the whole bundle
// is visible. An order outside the caller's scope is dropped before the read-model ever sees it.
app.post(
  '/bundles/resolve',
  zValidator('json', z.object({ order_ids: z.array(z.number().int().positive()).min(1).max(1000) })),
  async (c) => {
    const { order_ids } = c.req.valid('json');
    const scope = ordersScopeFromContext(c);
    const map = await resolveScopedBundles(order_ids, scope);
    const bundles: Record<string, BundleRowDto> = {};
    for (const [orderId, dto] of map) bundles[String(orderId)] = dto;
    return c.json({ bundles });
  },
);

// PS-312/PS-317 (S4): create a combined-shipment bundle from the caller's IN-SCOPE orders. A WRITE,
// but additive — it only inserts the bundle sidecar rows (no postage, no shipped/cancelled mutation;
// the ONE label is bought later by the existing queue/print flow). The scope check (reject any order
// outside the caller's scope) + the createBundle delegation live in createScopedBundle (pglite-
// tested); the route stays thin and just maps the outcomes to status codes.
app.post(
  '/bundles',
  zValidator(
    'json',
    z.object({
      order_ids: z.array(z.number().int().positive()).min(2).max(100),
      primary_order_id: z.number().int().positive().optional(),
    }),
  ),
  async (c) => {
    const { order_ids, primary_order_id } = c.req.valid('json');
    const scope = ordersScopeFromContext(c);
    const resolvedBy = (c.get('email' as never) as string | undefined) ?? null;
    try {
      const bundle = await createScopedBundle(order_ids, primary_order_id ?? null, scope, resolvedBy);
      return c.json({ bundle }, 201);
    } catch (err) {
      if (err instanceof BundleScopeError) {
        return c.json({ error: 'Some orders are not in your scope', order_ids: err.outOfScopeOrderIds }, 403);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Could not create bundle' }, 400);
    }
  },
);

export default app;
