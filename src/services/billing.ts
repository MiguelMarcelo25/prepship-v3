import { and, desc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
// Audit B-4 (2026-07-13): xact advisory lock serializes concurrent storage-line writers.
import { advisoryLockKeyPair } from '../lib/advisory-lock';
import { db } from '../db/client';
import {
  billingBoxResolutions,
  billingConfig,
  billingLineItems,
  billingStorageProof,
  clientPackagePrices,
} from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import { orderOverrides, orders } from '../db/schema/orders';
import { returns } from '../db/schema/returns';
import { packages } from '../db/schema/packages';
import { clients } from '../db/schema/clients';
import { orderCompetitiveRate } from '../db/schema/order-competitive-rate';
import { ensureOrderCompetitiveRateSchema } from '../db/ensure-order-competitive-rate';
import { ensureShipmentsSelectedRateCostColumn } from '../db/ensure-shipments-selected-rate-cost';
import { ensureBillingStorageProofSchema } from '../db/ensure-billing-storage-proof';
import { cuFtPerUnit } from '../lib/inventory-cuft';
import { roundMoney } from '../lib/money';
import { logStructured, reportError } from '../lib/structured-log';
import {
  calendarStoragePeriodsForRange,
  computeClientStorageBilling,
  type StorageLedgerMovement,
} from './billing-storage';
import { ensureInventoryLedgerSchema } from './inventory-ledger-schema';
import { resolveCustomerShippingMoney } from './customer-shipping-money';
// #798 slice 2: billing resolves its shipping markup through the ONE canonical owner (the same
// resolver the rate-display path uses), so a per-client markup is identical at quote + invoice time.
// Slice 2c (fixed): the per-account OVERRIDE is wired via the shipment's providerAccountId — the
// reliably-written account id (sync + labels both write it) — keyed through resolvePerAccountMarkupRule
// into settings markup.<account> in the SAME namespace the rate display uses. (The earlier slice keyed
// on shipments.carrierAccountId, which is NULL on synced rows + a different namespace → never billed.)
// Gated DEFAULT-OFF behind BILLING_PER_ACCOUNT_MARKUP: OFF => null per-account map => per-CLIENT-only
// behavior, byte-identical to slice 2a.
import { resolveCanonicalMarkup } from './shipping-workflow/markup-resolver';
import { resolvePerAccountMarkupRule } from './shipping-workflow/per-account-markup-key';
// PS-207: the `inventory` import is deliberately GONE — billing must never
// consult inventory/SKU package defaults (the storage-fee block reads
// inventory via raw SQL for cubic-feet, which is not box resolution).
// #798 2c: loadCarrierMarkups is the SOT loader for settings markup.<account> (same map the rate
// display + orders row-money read) — billing delegates to it rather than re-deriving the rules.
import { loadCarrierMarkups } from './rates';
import {
  boxDimsKey,
  decidePackageCostLine,
  NO_CHARGE_BOX_SOURCE,
  resolveShippedPackageId,
  type BoxLookups,
  type BoxPackage,
  type OperatorBoxResolution,
} from './billing-box-policy';
import { resolveCarrierNickname } from './labels';
import {
  getFreshBillingSummaryMetrics,
  refreshBillingSummaryMetrics,
} from './reporting-metrics';
import { summarizeBillingItemsForDetail } from './billing-detail-utils';
import { SYSTEM_CLIENT_NAMES } from '../lib/system-clients';
// PS-275: backend owns the $0-shipping review decision + prep-fee waiver
// (pure policy) and the durable, reversible waiver state (migration-owned store).
import {
  applyPrepFeeWaiver,
  decideZeroShippingReview,
} from './billing-shipping-policy';
import {
  ensureBillingFeeWaiverSchema,
  readBillingFeeWaivers,
} from './billing-fee-waiver-store';
import {
  applyManualBillingOverrides,
  manualBillingOverrideLabel,
  readBillingManualOverrides,
} from './billing-manual-overrides';
import { getBundlesForOrders } from './shipment-bundles/bundle-read-model';
import { decideBundleBillingTreatment } from './shipment-bundles/bundle-billing-policy';
import { env } from '../lib/env';
import {
  BILLING_POLICY_WEEKEND_ROLLFORWARD,
  assertBillingWeekdayOperationAllowed,
  billingLineEffectiveDayRangeSql,
  billingLineEffectiveDaySql,
  billingProviderActivityTimestampSql,
  billingSourceCalendarSql,
  resolveBillingCalendarDay,
  type BillingPolicyVersion,
} from './billing-calendar-policy';
import { toBillingDetailOrderRows } from './billing-detail-row-sot';
import { planReturnBillingLines } from './billing-return-line-planner';
import {
  RETURN_PROCESSING_LINE_TYPE,
  RETURN_SHIPPING_LINE_TYPE,
} from './billing-return-event-contract';
import { resolveBillingSelectedRateCost } from './billing-selected-rate-cost';
import { resolveBillingBoxCostAlert } from './billing-box-cost-alert';
import { resolveBillingRowStatus } from './billing-row-status';
import {
  assertBillingOrdersEditable,
  billingLineItemIsEditablePredicate,
  ensureBillingFinalizationPolicySchema,
  finalizedBillingOrderIdsForRange,
  isBillingFinalizedLockError,
  reconcileFinalizedBillingOrderAdjustments,
  rethrowAsBillingFinalizedLock,
  setBillingOrdersDirty,
} from './billing-finalization-policy';
import {
  cancelledNoChargeBillingLinePredicateSql,
  cancelledNoChargeBillingAmountSql,
  isCancelledBillingStatus,
} from './billing-cancelled-no-charge';
import {
  isBillingLifecycleSourceStatus,
  orderLifecycleBillingSourcePredicateAlias,
  orderLifecycleBillingSourcePredicate,
  resolveOrderLifecycleStatus,
} from './order-lifecycle-status';
import { resolveFulfillmentConflict } from './fulfillment-conflict';
import {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  ensureHugrabShippingRateOverrideColumns,
} from './billing-hugrab-shipping-rate-override';
import { requireBillingRegenerationRead } from './billing-regeneration-readiness';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';
import {
  activeOutboundShipmentPredicate,
  withShipmentBillingLineage,
} from './shipment-aggregate';

// PS-132: synthetic/system clients excluded from billing summaries/details — single source.
// Parameterized SQL fragment (same semantics as the prior inline literal list).
const systemClientNamesSql = sql.join(
  SYSTEM_CLIENT_NAMES.map((name) => sql`${name}`),
  sql`, `,
);

export function isBillingSourceOrderBillable(input: {
  orderStatus: string | null;
  clientName: string | null;
  canonicalStatus?: string | null;
  externallyShipped?: boolean | null;
}) {
  const lifecycle = resolveOrderLifecycleStatus({
    orderStatus: input.orderStatus,
    canonicalStatus: input.canonicalStatus,
    externallyShipped: input.externallyShipped,
  });
  // Per user override unlock shipped data on 2026-07-04 (PS-377): shipped AND
  // cancelled orders are billing SOURCE rows for EVERY client (was shipped +
  // HUGRAB-only cancelled), so cancelled orders are VISIBLE in Billing instead of
  // silently excluded. The $0-vs-fees decision for cancelled rows is made in
  // generateLineItems (default: a single $0.00 "Cancelled" row; HUGRAB keeps its
  // existing cancelled billing). This is read-only classification — no orders /
  // shipments source rows are mutated. clientName is retained for the caller
  // shape + the generator's per-client cancelled-policy check.
  return isBillingLifecycleSourceStatus(lifecycle);
}

export type GenerateInput = {
  clientId?: number;
  clientIds?: number[];
  // PS-208: UTC-midnight calendar-day bounds from billingDayRange. dateFrom is
  // INCLUSIVE; dateTo is EXCLUSIVE (midnight after the last day). PS-434 keeps
  // the bound shape but period membership delegates to the canonical effective
  // billing day, with ship_date only as the legacy fallback. Bounds remain
  // `>= dateFrom AND < dateTo` — never `<=`.
  dateFrom: string; // ISO, UTC midnight, inclusive
  dateTo: string; // ISO, UTC midnight, EXCLUSIVE
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeIsGlobal?: boolean;
  scopeRestricted?: boolean;
  actorId?: string | null;
  actorEmail?: string | null;
  /** Internal test clock only. HTTP callers never supply this value. */
  now?: Date;
};

export type BillingGenerationStatus = {
  upToDate: boolean;
  dateFrom: string;
  dateTo: string;
  clientId?: number;
  latestBillingShipDate: string | null;
  latestSourceShipDate: string | null;
  missingFrom: string | null;
  missingTo: string | null;
};

// v2 parity constant: the first unit on every order is included in the pick/pack
// fee; every subsequent unit is billed at additionalUnitFee. v2 hardcodes this
// to 1 (see apps/api/src/modules/billing/data/sqlite-billing-repository.ts:216).
// If a configurable per-client cap is needed later, add a pick_pack_max_units
// column to billing_config and read it here.
// Fallback when a client's billing_config row has no pickPackMaxUnits set
// (legacy rows or newly-created clients). Matches v2's hardcoded constant.
const PICK_PACK_MAX_UNITS_DEFAULT = 1;

function toNum(v: string | null | undefined) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function billingSummaryHasValues(summary: { clients: BillingSummaryRow[] }): boolean {
  return summary.clients.some(
    (row) =>
      row.orderCount > 0 ||
      row.pickPackTotal > 0 ||
      row.additionalTotal > 0 ||
      row.packageTotal > 0 ||
      row.shippingTotal > 0 ||
      row.storageTotal > 0 ||
      row.adjustmentTotal !== 0 ||
      row.grandTotal !== 0
  );
}

// PS-434 generation entry boundary. Per user override unlock shipped data on
// 2026-07-16: read the canonical source instant without mutating orders or
// shipments. Date-only provider values are preserved as their stated calendar
// day; true instants use the Los Angeles activity day. The calendar owner then
// decides both persisted actual and effective billing days.
const billingSourceActivityTimestampSql = sql<Date | null>`coalesce(
  ${shipments.shipDate},
  ${billingProviderActivityTimestampSql(sql`${orders.raw}->>'fulfilledAt'`)},
  ${billingProviderActivityTimestampSql(sql`${orders.raw}->>'shipDate'`)},
  ${billingProviderActivityTimestampSql(sql`${orders.raw}->>'shippedAt'`)},
  ${orders.orderDate}
)`;
const billingLegacyActivityDaySql = sql<Date | null>`date_trunc(
  'day', ${billingSourceActivityTimestampSql} at time zone 'UTC'
) at time zone 'UTC'`;
const billingSourceCalendar = billingSourceCalendarSql({
  sourceTimestamp: billingSourceActivityTimestampSql,
  legacyActivityDay: billingLegacyActivityDaySql,
  effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
});
const billingPersistedEffectiveDaySql = billingLineEffectiveDaySql(
  billingLineItems.billingEffectiveDate,
  billingLineItems.shipDate,
);

// PS-207 migration readiness; migration 0043 owns billing_box_resolutions.
export async function ensureBillingBoxResolutionsSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

function billingClientScopePredicate(input: GenerateInput): SQL {
  if (input.scopeIsGlobal === true) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);

  if (clientIds.length) {
    predicates.push(sql`c.id = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`c.store_ids && ${intArraySql(storeIds)}`);
  }
  if (!predicates.length) {
    return input.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function billingLineItemScopePredicate(
  input: GenerateInput,
  clientIdColumn: SQL = sql`${billingLineItems.clientId}`,
): SQL {
  if (input.scopeIsGlobal === true) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);

  if (clientIds.length) {
    predicates.push(sql`${clientIdColumn} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = ${clientIdColumn}
        and scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) {
    return input.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function requestedClientIds(input: GenerateInput): number[] {
  if (input.clientId !== undefined) return [input.clientId];
  return normalizeScopeIds(input.clientIds);
}

function isoDayStart(value: Date): string {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  ).toISOString();
}

function isoDayEnd(value: Date): string {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      23,
      59,
      59,
      999
    )
  ).toISOString();
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * True when package prices or billing config changed AFTER the billing line
 * items in a range were generated — meaning the range must be rebuilt to
 * re-price even though no new orders shipped.
 *
 * Background: the freshness check only compares shipment recency, so editing a
 * box price (client_package_prices) never marked billing stale and "Update
 * Billing" no-op'd, leaving the cached summary on the old price. This makes the
 * status price-aware.
 *
 * Null-safe: a null generation time means "nothing billed yet for this range"
 * (the source-vs-billing comparison handles that), so this returns false then.
 */
export function billingNeedsRepriceForPriceChange(
  billingGeneratedAt: Date | string | null,
  pricingChangedAt: Date | string | null,
): boolean {
  if (!billingGeneratedAt || !pricingChangedAt) return false;
  const generated = new Date(billingGeneratedAt).getTime();
  const changed = new Date(pricingChangedAt).getTime();
  if (!Number.isFinite(generated) || !Number.isFinite(changed)) return false;
  return changed > generated;
}

// /generate/status is an ADVISORY freshness probe the FE polls (and fans out
// once per client) — but computing it runs four heavy queries including a
// full lifecycle scan of orders (~1.4s observed in production). Cache the
// verdict briefly, keyed by range + client + the CALLER'S SCOPE (a restricted
// caller must never see a global caller's verdict). Freshness contract: the
// cache is cleared whenever THIS process generates line items (the only
// in-process write that changes the verdict); other staleness inputs (price
// edits, fee waivers, another instance generating) are picked up when an
// entry expires — an acceptable window for an advisory signal. Override with
// BILLING_STATUS_CACHE_TTL_MS (0 disables).
const BILLING_STATUS_CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.BILLING_STATUS_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
})();
const billingStatusCache = new Map<string, { at: number; value: BillingGenerationStatus }>();

export function clearBillingGenerationStatusCache(): void {
  billingStatusCache.clear();
}

function billingStatusCacheKey(input: GenerateInput, fromIso: string, toIso: string): string {
  return [
    input.clientId ?? 'all',
    fromIso,
    toIso,
    input.scopeIsGlobal ? 'g1' : 'g0',
    input.scopeRestricted ? 'r1' : 'r0',
    (input.scopeClientIds ?? []).slice().sort((a, b) => a - b).join(','),
    (input.scopeStoreIds ?? []).slice().sort((a, b) => a - b).join(','),
  ].join('|');
}

function rememberBillingStatus(
  cacheKey: string,
  value: BillingGenerationStatus,
): BillingGenerationStatus {
  if (BILLING_STATUS_CACHE_TTL_MS > 0) {
    // Bounded: keys vary by range/scope only; a runaway caller can't grow this
    // past the cap without the whole map resetting.
    if (billingStatusCache.size > 200) billingStatusCache.clear();
    billingStatusCache.set(cacheKey, { at: Date.now(), value });
  }
  return value;
}

export async function billingGenerationStatus(
  input: GenerateInput
): Promise<BillingGenerationStatus> {
  const fromIso = new Date(input.dateFrom).toISOString();
  const toIso = new Date(input.dateTo).toISOString();
  const billedEffectiveDay = billingLineEffectiveDaySql(
    sql`b.billing_effective_date`,
    sql`b.ship_date`,
  );
  const billedEffectiveDayB2 = billingLineEffectiveDaySql(
    sql`b2.billing_effective_date`,
    sql`b2.ship_date`,
  );

  const cacheKey = billingStatusCacheKey(input, fromIso, toIso);
  if (BILLING_STATUS_CACHE_TTL_MS > 0) {
    const cached = billingStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < BILLING_STATUS_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  // Queries 1-3 (latest billed line, price-change staleness, fee-waiver
  // staleness) are mutually independent — run them together. Only the
  // source-freshness query further down needs latestBilling from query 1.
  const billingRowPromise = db.execute<{
    latest_billing_ship_date: string | null;
  }>(sql`
    select max(${billedEffectiveDay})::text as latest_billing_ship_date
    from billing_line_items b
    where ${billedEffectiveDay} >= ${fromIso}::timestamptz
      and ${billedEffectiveDay} < ${toIso}::timestamptz
      and b.order_id is not null
      ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
      -- Per user override unlock shipped data on 2026-07-16: restricted billing
      -- freshness uses the query's b alias without weakening tenant scope.
      and ${billingLineItemScopePredicate(input, sql`b.client_id`)}
  `);

  // Re-price detection (PER CLIENT): a range is stale when ANY scoped client
  // that already has billing in the range had a package-price or billing-config
  // change AFTER that client's newest billing line was generated — even when no
  // new orders shipped. Computed per-client (not by comparing two GLOBAL maxima)
  // so the all-clients "Update Billing" path cannot mask one client's stale
  // price behind another client's later (re)bill. The underlying rule is
  // billingNeedsRepriceForPriceChange (unit-tested in
  // scripts/ps-billing-reprice-staleness-guard.ts).
  const staleRowPromise = db.execute<{ pricing_stale: boolean }>(sql`
    select exists (
      select 1
      from clients c
      where c.active = true
        and c.name not in (${systemClientNamesSql})
        ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
        and ${billingClientScopePredicate(input)}
        and exists (
          select 1 from billing_line_items b
          where b.client_id = c.id
            and ${billedEffectiveDay} >= ${fromIso}::timestamptz
            and ${billedEffectiveDay} < ${toIso}::timestamptz
        )
        and greatest(
          coalesce((select max(updated_at) from client_package_prices where client_id = c.id), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from billing_config        where client_id = c.id), 'epoch'::timestamptz)
        ) > (
          select max(b.created_at) from billing_line_items b
          where b.client_id = c.id
            and ${billedEffectiveDay} >= ${fromIso}::timestamptz
            and ${billedEffectiveDay} < ${toIso}::timestamptz
        )
    ) as pricing_stale
  `);
  const feeWaiverStalePromise = (async () => {
    await ensureBillingFeeWaiverSchema();
    const [feeWaiverRow] = await db.execute<{ fee_waiver_stale: boolean }>(sql`
      select exists (
        select 1
        from billing_fee_waivers fw
        inner join billing_line_items b on b.order_id = fw.order_id
        inner join clients c on c.id = b.client_id
        where ${billedEffectiveDay} >= ${fromIso}::timestamptz
          and ${billedEffectiveDay} < ${toIso}::timestamptz
          and b.order_id is not null
          and c.active = true
          and c.name not in (${systemClientNamesSql})
          ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
          and ${billingClientScopePredicate(input)}
          and fw.updated_at > (
            select max(b.created_at)
            from billing_line_items b
            where b.order_id = fw.order_id
              and ${billedEffectiveDay} >= ${fromIso}::timestamptz
              and ${billedEffectiveDay} < ${toIso}::timestamptz
              ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
          )
      ) as fee_waiver_stale
    `);
    return feeWaiverRow?.fee_waiver_stale === true;
  })();
  // Audit B-3 (2026-07-13): VOID staleness. voidLabelV2 sets shipments.voided=true
  // (bumping updated_at in the same transaction) but historically emitted no billing
  // signal — the range kept reporting "up to date" while billing_line_items still
  // carried the voided label's charges, so clients stayed billed for refunded postage
  // until some unrelated event forced a regenerate. Derive the signal from the SOURCE
  // rows instead of trusting the mutator to remember: a range is stale when any billed
  // order in it has a shipment voided AFTER that order's newest billing line was
  // generated. Read-only over shipments; also retroactively surfaces historical voids
  // that never got reversed.
  const voidStalePromise = (async () => {
    const [voidRow] = await db.execute<{ void_stale: boolean }>(sql`
      select exists (
        select 1
        from shipments s
        inner join billing_line_items b on b.order_id = s.order_id
        inner join clients c on c.id = b.client_id
        where s.voided = true
          and ${billedEffectiveDay} >= ${fromIso}::timestamptz
          and ${billedEffectiveDay} < ${toIso}::timestamptz
          and b.order_id is not null
          and c.active = true
          and c.name not in (${systemClientNamesSql})
          ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
          and ${billingClientScopePredicate(input)}
          and s.updated_at > (
            select max(b2.created_at)
            from billing_line_items b2
            where b2.order_id = s.order_id
              and ${billedEffectiveDayB2} >= ${fromIso}::timestamptz
              and ${billedEffectiveDayB2} < ${toIso}::timestamptz
              ${input.clientId !== undefined ? sql`and b2.client_id = ${input.clientId}` : sql``}
          )
      ) as void_stale
    `);
    return voidRow?.void_stale === true;
  })();

  const [[billingRow], [staleRow], feeWaiverStale, voidStale] = await Promise.all([
    billingRowPromise,
    staleRowPromise,
    feeWaiverStalePromise,
    voidStalePromise,
  ]);
  const latestBilling = billingRow?.latest_billing_ship_date
    ? new Date(billingRow.latest_billing_ship_date)
    : null;
  const pricingStale = staleRow?.pricing_stale === true;

  const sourceLowerBound = latestBilling?.toISOString() ?? fromIso;
  // Per user override unlock shipped data on 2026-07-06: PS-387 makes Billing
  // freshness use the same read-only lifecycle source predicate as generation.
  const sourceLifecyclePredicate = orderLifecycleBillingSourcePredicateAlias('o');
  const statusSourceTimestamp = sql<Date | null>`coalesce(
    s.ship_date,
    ${billingProviderActivityTimestampSql(sql`o.raw->>'fulfilledAt'`)},
    ${billingProviderActivityTimestampSql(sql`o.raw->>'shipDate'`)},
    ${billingProviderActivityTimestampSql(sql`o.raw->>'shippedAt'`)},
    o.order_date
  )`;
  const statusLegacyDay = sql<Date | null>`date_trunc(
    'day', ${statusSourceTimestamp} at time zone 'UTC'
  ) at time zone 'UTC'`;
  const statusSourceCalendar = billingSourceCalendarSql({
    sourceTimestamp: statusSourceTimestamp,
    legacyActivityDay: statusLegacyDay,
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
  const [sourceRow] = await db.execute<{
    latest_source_ship_date: string | null;
  }>(sql`
    with scoped_clients as (
      select c.id, c.name, c.store_ids
      from clients c
      where c.active = true
        and c.name not in (${systemClientNamesSql})
        ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
        and ${billingClientScopePredicate(input)}
    )
    select max(coalesce(
      s.ship_date,
      case
        when coalesce(o.raw->>'fulfilledAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
          then (o.raw->>'fulfilledAt')::timestamptz
        else null
      end,
      case
        when coalesce(o.raw->>'shipDate', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
          then (o.raw->>'shipDate')::timestamptz
        else null
      end,
      case
        when coalesce(o.raw->>'shippedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
          then (o.raw->>'shippedAt')::timestamptz
        else null
      end,
      o.order_date
    ))::text as latest_source_ship_date
    from orders o
    left join shipments s on s.order_id = o.id and s.voided = false
    where ${sourceLifecyclePredicate}
      and coalesce(
        s.ship_date,
        case
          when coalesce(o.raw->>'fulfilledAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
            then (o.raw->>'fulfilledAt')::timestamptz
          else null
        end,
        case
          when coalesce(o.raw->>'shipDate', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
            then (o.raw->>'shipDate')::timestamptz
          else null
        end,
        case
          when coalesce(o.raw->>'shippedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
            then (o.raw->>'shippedAt')::timestamptz
          else null
        end,
        o.order_date
        -- PS-208: an instant < the EXCLUSIVE UTC-midnight upper bound is
        -- exactly "UTC day <= toDay" — no truncation needed for comparison.
      ) < ${toIso}::timestamptz
      ${latestBilling
        ? sql`and coalesce(
            s.ship_date,
            case
              when coalesce(o.raw->>'fulfilledAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'fulfilledAt')::timestamptz
              else null
            end,
            case
              when coalesce(o.raw->>'shipDate', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'shipDate')::timestamptz
              else null
            end,
            case
              when coalesce(o.raw->>'shippedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'shippedAt')::timestamptz
              else null
            end,
            o.order_date
          ) > ${sourceLowerBound}::timestamptz`
        : sql`and coalesce(
            s.ship_date,
            case
              when coalesce(o.raw->>'fulfilledAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'fulfilledAt')::timestamptz
              else null
            end,
            case
              when coalesce(o.raw->>'shipDate', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'shipDate')::timestamptz
              else null
            end,
            case
              when coalesce(o.raw->>'shippedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (o.raw->>'shippedAt')::timestamptz
              else null
            end,
            o.order_date
          ) >= ${sourceLowerBound}::timestamptz`}
      and exists (
        select 1
        from scoped_clients sc
        where (
          o.client_id = sc.id
          or (o.store_id is not null and o.store_id = any(sc.store_ids))
          or (
            coalesce(
              case
                when coalesce(o.raw->>'storeId', '') ~ '^[0-9]+$'
                  then (o.raw->>'storeId')::int
                else null
              end,
              case
                when coalesce(o.raw->'advancedOptions'->>'storeId', '') ~ '^[0-9]+$'
                  then (o.raw->'advancedOptions'->>'storeId')::int
                else null
              end
            ) = any(sc.store_ids)
          )
        )
        -- PS-377 (Per user override unlock shipped data on 2026-07-04): the
        -- freshness/source query includes cancelled orders for EVERY client (was
        -- shipped + HUGRAB-only cancelled), matching the billable-rows query, so a
        -- new cancelled order marks Billing out-of-date. Read-only.
        and ${sourceLifecyclePredicate}
      )
  `);

  // PS-434 late-arrival boundary: compare every source shipment/order whose
  // canonical EFFECTIVE day is in the requested range against its persisted
  // line identity. A Sunday record discovered after Monday is therefore stale
  // even though its source timestamp sorts before Monday's billed watermark.
  const [sourceMissingRow] = await db.execute<{ source_missing: boolean }>(sql`
    select exists (
      select 1
      from orders o
      left join shipments s
        on s.order_id = o.id
        and coalesce(s.voided, false) = false
        and coalesce(s.is_return, false) = false
      where ${sourceLifecyclePredicate}
        and ${statusSourceCalendar.billingEffectiveDay} >= ${fromIso}::timestamptz
        and ${statusSourceCalendar.billingEffectiveDay} < ${toIso}::timestamptz
        and exists (
          select 1
          from clients c
          where c.active = true
            and c.name not in (${systemClientNamesSql})
            ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
            and ${billingClientScopePredicate(input)}
            and (
              o.client_id = c.id
              or (o.store_id is not null and o.store_id = any(c.store_ids))
              or coalesce(
                case when coalesce(o.raw->>'storeId', '') ~ '^[0-9]+$'
                  then (o.raw->>'storeId')::int else null end,
                case when coalesce(o.raw->'advancedOptions'->>'storeId', '') ~ '^[0-9]+$'
                  then (o.raw->'advancedOptions'->>'storeId')::int else null end
              ) = any(c.store_ids)
            )
        )
        and not exists (
          select 1
          from billing_line_items b
          where b.order_id = o.id
            and b.shipment_id is not distinct from s.id
            and ${billedEffectiveDay} >= ${fromIso}::timestamptz
            and ${billedEffectiveDay} < ${toIso}::timestamptz
        )
    ) as source_missing
  `);

  const latestSource = sourceRow?.latest_source_ship_date
    ? new Date(sourceRow.latest_source_ship_date)
    : null;
  const sourceMissing = sourceMissingRow?.source_missing === true;

  const from = new Date(fromIso);

  if (!latestSource) {
    // No new shipments to bill. Still rebuild if prices changed after the
    // existing lines were generated, so a box-price edit re-prices them —
    // or if a billed label was voided (audit B-3), so the dead charge drops.
    if (pricingStale || feeWaiverStale || voidStale || sourceMissing) {
      return rememberBillingStatus(cacheKey, {
        upToDate: false,
        dateFrom: fromIso,
        dateTo: toIso,
        clientId: input.clientId,
        latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
        latestSourceShipDate: billingRow?.latest_billing_ship_date ?? null,
        missingFrom: isoDayStart(from),
        missingTo: isoDayEnd(latestBilling ?? new Date(toIso)),
      });
    }
    return rememberBillingStatus(cacheKey, {
      upToDate: true,
      dateFrom: fromIso,
      dateTo: toIso,
      clientId: input.clientId,
      latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
      latestSourceShipDate: billingRow?.latest_billing_ship_date ?? null,
      missingFrom: null,
      missingTo: null,
    });
  }

  if (
    !sourceMissing &&
    !pricingStale &&
    !feeWaiverStale &&
    !voidStale &&
    latestBilling &&
    isoDayStart(latestBilling) === isoDayStart(latestSource)
  ) {
    return rememberBillingStatus(cacheKey, {
      upToDate: true,
      dateFrom: fromIso,
      dateTo: toIso,
      clientId: input.clientId,
      latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
      latestSourceShipDate: sourceRow?.latest_source_ship_date ?? null,
      missingFrom: null,
      missingTo: null,
    });
  }

  const latestBillingDay = latestBilling ? isoDayStart(latestBilling) : null;
  const latestSourceDay = isoDayStart(latestSource);
  // A price/config change requires rebuilding the WHOLE range (to re-price the
  // existing lines), not just the missing tail after the last billed day. A
  // void (audit B-3) likewise rebuilds the whole range so the voided label's
  // lines are deleted, not just appended after.
  const missingFrom =
    pricingStale || feeWaiverStale || voidStale || sourceMissing || !latestBilling
      ? isoDayStart(from)
      : latestBillingDay === latestSourceDay
        ? latestBillingDay
        : isoDayStart(addUtcDays(latestBilling, 1));

  return rememberBillingStatus(cacheKey, {
    upToDate: false,
    dateFrom: fromIso,
    dateTo: toIso,
    clientId: input.clientId,
    latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
    latestSourceShipDate: sourceRow?.latest_source_ship_date ?? null,
    missingFrom,
    missingTo: isoDayEnd(latestSource),
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerAccountIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized =
    typeof value === 'string' ? value.replace(/^se-/i, '') : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemSummary(items: unknown) {
  return summarizeBillingItemsForDetail(items);
}

function dimsKey(length: unknown, width: unknown, height: unknown) {
  const l = toFiniteNumber(length);
  const w = toFiniteNumber(width);
  const h = toFiniteNumber(height);
  if (l == null || w == null || h == null || l <= 0 || w <= 0 || h <= 0) {
    return null;
  }
  return `${l}x${w}x${h}`;
}

function dimsLabel(length: unknown, width: unknown, height: unknown) {
  const key = dimsKey(length, width, height);
  return key ? `${key} in` : null;
}

// Sum the billable units on an order. Mirrors v2's logic:
//   - Filter out items flagged as `adjustment: true` (refunds, price tweaks)
//   - Default missing `quantity` to 1 (v2 line 192 / pick-list default)
function totalUnitsFromItems(items: unknown[] | null | undefined): number {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if ((it as { adjustment?: unknown }).adjustment === true) continue;
    const qRaw = (it as { quantity?: unknown }).quantity;
    const q = qRaw == null ? 1 : Number(qRaw);
    if (Number.isFinite(q) && q > 0) n += q;
  }
  return n;
}

export async function generateLineItems(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  // Per user override unlock shipped data on 2026-07-16: PS-434 blocks this
  // derived shipped-billing money workflow at the backend boundary on a
  // California weekend. Unset cutoff remains byte-compatible/default-off.
  assertBillingWeekdayOperationAllowed({
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
  // Per user override unlock shipped data on 2026-07-11: PS-416 verifies the
  // backend-owned freshness source before regenerating shipped-order billing.
  // Regeneration is a money mutation. Verify the backend-owned
  // freshness/status source before any delete/insert. Frontend force flags and
  // direct API callers cannot bypass this boundary.
  await requireBillingRegenerationRead(
    'billing freshness status',
    () => billingGenerationStatus(input),
  );
  await ensureHugrabShippingRateOverrideColumns();
  // PS-370: verify migration-owned selected-rate schema before reading it.
  await ensureShipmentsSelectedRateCostColumn();
  await ensureBillingFinalizationPolicySchema();
  // Per user override unlock shipped data on 2026-05-23: PS-449 permits a
  // regeneration read of finalized shipped/cancelled source orders solely to
  // calculate an append-only current-period correction. Frozen billing rows
  // remain excluded from the delete/rebuild transaction below.

  // Scope-independent prefetch reads, fired TOGETHER (they used to run
  // serially — one pooler round-trip after another). Each is awaited exactly
  // where its result is first consumed below, so evaluation order and every
  // downstream input are unchanged. The no-configs early return simply
  // abandons the in-flight reads; the noop catch keeps an abandoned
  // rejection from surfacing as unhandled (the real await still throws).
  const clientRowsPromise = db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
  void clientRowsPromise.catch(() => {});
  const allPackagesPromise = db
    .select({
      id: packages.id,
      name: packages.name,
      packageCode: packages.packageCode,
      length: packages.length,
      width: packages.width,
      height: packages.height,
      // PS-222b: source carries the no-charge/factory marker into BoxPackage so
      // decidePackageCostLine can emit an explicit $0.00 line for those boxes.
      source: packages.source,
    })
    .from(packages);
  void allPackagesPromise.catch(() => {});
  const resolutionRowsPromise = (async () => {
    await ensureBillingBoxResolutionsSchema();
    return db.select().from(billingBoxResolutions);
  })();
  void resolutionRowsPromise.catch(() => {});

  // Match /billing/config: active clients without a billing_config row still
  // generate with defaults, otherwise a fresh install has visible clients but
  // "Generate Invoices" finds no configs and produces an empty summary.
  const configs = await db.execute<{
    clientId: number;
    clientName: string;
    pickPackFee: string;
    pickPackMaxUnits: number;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    storageFeePerCuFt: string;
    billingMode: string;
    active: boolean;
    hugrabShippingRateOverrideEnabled: boolean;
    hugrabShippingRateOverrideThreshold: string;
    hugrabShippingRateOverrideAmount: string;
    returnProcessingFee: string;
  }>(sql`
    select
      c.id as "clientId",
      c.name as "clientName",
      coalesce(b.pick_pack_fee, '0'::numeric)::text as "pickPackFee",
      coalesce(b.pick_pack_max_units, 1)::int as "pickPackMaxUnits",
      coalesce(b.additional_unit_fee, '0'::numeric)::text as "additionalUnitFee",
      coalesce(b.package_cost_markup, '0'::numeric)::text as "packageCostMarkup",
      coalesce(b.shipping_markup_pct, '0'::numeric)::text as "shippingMarkupPct",
      coalesce(b.shipping_markup_flat, '0'::numeric)::text as "shippingMarkupFlat",
      coalesce(b.storage_fee_per_cu_ft, '0'::numeric)::text as "storageFeePerCuFt",
      coalesce(b.billing_mode, 'per_shipment') as "billingMode",
      coalesce(b.active, true) as active,
      coalesce(b.hugrab_shipping_rate_override_enabled, false) as "hugrabShippingRateOverrideEnabled",
      coalesce(
        b.hugrab_shipping_rate_override_threshold,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD}::numeric
      )::text as "hugrabShippingRateOverrideThreshold",
      coalesce(
        b.hugrab_shipping_rate_override_amount,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT}::numeric
      )::text as "hugrabShippingRateOverrideAmount",
      -- PS-487: the configured return-processing fee. Every client currently holds
      -- 0.00, so a return bills a visible $0 processing line until one is set.
      coalesce(b.return_processing_fee, 0)::text as "returnProcessingFee"
    from clients c
    left join billing_config b on b.client_id = c.id
    where c.active = true
      and c.name not in (${systemClientNamesSql})
      and coalesce(b.active, true) = true
      ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
      and ${billingClientScopePredicate(input)}
    order by c.name asc
  `);
  if (!configs.length) {
    return {
      generated: 0,
      count: 0,
      total: 0,
      skipped: 0,
      message: 'No billing configs found',
    };
  }

  const configByClient = new Map(configs.map((c) => [c.clientId, c]));
  const clientNameById = new Map(configs.map((c) => [c.clientId, c.clientName]));

  const clientRows = await clientRowsPromise;
  const clientByStore = new Map<number, number>();
  for (const c of clientRows) {
    for (const storeId of c.storeIds ?? []) {
      clientByStore.set(storeId, c.id);
    }
  }

  const orderShipmentRows = await db
    .select({
      shipmentId: shipments.id,
      shipmentClientId: shipments.clientId,
      shipDate: shipments.shipDate,
      labelCost: shipments.labelCost,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      // PS-370: the persisted normalized selected/label total (postage + other),
      // read by the invoice shipping line so TS + SQL share one value. NULL for
      // un-backfilled rows -> the reader falls back to cost/labelCost + otherCost.
      selectedRateCost: shipments.selectedRateCost,
      selectedRateJson: shipments.selectedRateJson,
      carrierCode: shipments.carrierCode,
      // #798 2c (fixed): the shipment's reliably-written provider ACCOUNT id (sync + labels both write
      // it; carrierAccountId was NULL on synced rows). Keys settings markup.<account> in the SAME
      // namespace the rate display uses (see per-account-markup-key). READ of shipped data.
      providerAccountId: shipments.providerAccountId,
      selectedPid: shipments.selectedPid,
      selectedPackageId: shipments.selectedPackageId,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      refUspsRate: orderOverrides.refUspsRate,
      refUpsRate: orderOverrides.refUpsRate,
      overrideTrackingNumber: orderOverrides.trackingNumber,
      externallyShippedSource: orderOverrides.externallyShippedSource,
      orderId: orders.id,
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      orderNumber: orders.orderNumber,
      orderClientId: orders.clientId,
      orderDate: orders.orderDate,
      billingShipDate: billingSourceCalendar.actualActivityDay,
      billingEffectiveDate: billingSourceCalendar.billingEffectiveDay,
      billingPolicyVersion: billingSourceCalendar.policyVersion,
      orderStoreId: orders.storeId,
      orderItems: orders.items,
      orderRaw: orders.raw,
      sourceProvider: orders.sourceProvider,
      externallyShipped: orders.externallyShipped,
      externallyFulfilled: sql<boolean>`coalesce(${orders.raw}->>'externallyFulfilled', 'false') = 'true'`,
      externallyFulfilledVerified: orders.externallyFulfilledVerified,
    })
    .from(orders)
    .leftJoin(
      shipments,
      and(
        eq(shipments.orderId, orders.id),
        // Per user override unlock shipped data on 2026-05-23: PS-425 reads
        // the canonical active-outbound set. Returns and voided/replaced labels
        // are excluded; distinct active outbound shipments remain billable.
        activeOutboundShipmentPredicate(),
      )
    )
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        // Per user override unlock shipped data on 2026-07-06: PS-387 uses
        // read-only lifecycle classification for Billing source inclusion.
        // It does not mutate orders/shipments or weaken shipped locks.
        orderLifecycleBillingSourcePredicate(),
        sql`${billingSourceCalendar.billingEffectiveDay} >= ${fromIso}::timestamptz`,
        sql`${billingSourceCalendar.billingEffectiveDay} < ${toIso}::timestamptz`
      )
    );

  function rawStoreId(
    raw: Record<string, unknown>,
    orderStoreId: number | null
  ): number | null {
    if (orderStoreId !== null) return orderStoreId;
    const advanced =
      raw.advancedOptions && typeof raw.advancedOptions === 'object'
        ? (raw.advancedOptions as Record<string, unknown>)
        : {};
    const rawStore = advanced.storeId ?? raw.storeId;
    const n = Number(rawStore);
    return Number.isFinite(n) ? n : null;
  }

  type BillableRow = {
    id: number | null;
    orderId: number | null;
    orderNumber: string | null;
    clientId: number | null;
    shipDate: Date | null;
    billingEffectiveDate: Date | null;
    billingPolicyVersion: BillingPolicyVersion;
    labelCost: string | null;
    cost: string | null;
    otherCost: string | null;
    selectedRateCost: string | null;
    selectedRateJson: unknown;
    carrierCode: string | null;
    providerAccountId: number | null;
    selectedPid: number | null;
    selectedPackageId: string | null;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
    refUspsRate: string | null;
    refUpsRate: string | null;
    overrideTrackingNumber: string | null;
    externallyShippedSource: string | null;
    items: unknown[];
    sourceProvider: string | null;
    externallyShipped: boolean;
    externallyFulfilled: boolean;
    externallyFulfilledVerified: boolean;
    // PS-377: source order status ('shipped' | 'cancelled'), so the generator can
    // emit a $0 no-charge line for cancelled orders. Read-only.
    orderStatus: string | null;
    effectiveOrderStatus: string | null;
    orderLifecycleStatus: string | null;
  };

  const allBillableRows: BillableRow[] = orderShipmentRows
    .map<BillableRow | null>((row) => {
      const storeId = rawStoreId(row.orderRaw ?? {}, row.orderStoreId ?? null);
      const clientId =
        (storeId !== null ? clientByStore.get(storeId) ?? null : null) ??
        row.orderClientId ??
        row.shipmentClientId ??
        null;
      const lifecycle = resolveOrderLifecycleStatus({
        orderStatus: row.orderStatus,
        canonicalStatus: row.canonicalStatus,
        externallyShipped: row.externallyShipped === true,
      });
      if (!isBillingSourceOrderBillable({
        orderStatus: row.orderStatus,
        canonicalStatus: row.canonicalStatus,
        externallyShipped: row.externallyShipped === true,
        clientName: clientId == null ? null : clientNameById.get(clientId) ?? null,
      })) {
        return null;
      }
      return {
        id: row.shipmentId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        clientId,
        // billingShipDate comes from a raw sql<> expression, which drizzle
        // returns as a STRING at runtime (not a Date) even though it's typed
        // Date|null. Inserting it directly makes drizzle call .toISOString() on
        // a string -> "value.toISOString is not a function", which silently
        // skipped every billing row and left clients (e.g. HUGRAB) un-billed.
        // Coerce to a real Date here.
        shipDate: row.billingShipDate ? new Date(row.billingShipDate) : null,
        billingEffectiveDate: row.billingEffectiveDate
          ? new Date(row.billingEffectiveDate)
          : null,
        billingPolicyVersion: row.billingPolicyVersion,
        labelCost: row.labelCost,
        cost: row.cost,
        otherCost: row.otherCost,
        selectedRateCost: row.selectedRateCost,
        selectedRateJson: row.selectedRateJson,
        carrierCode: row.carrierCode,
        providerAccountId: row.providerAccountId,
        selectedPid: row.selectedPid,
        selectedPackageId: row.selectedPackageId,
        dimsL: row.dimsL,
        dimsW: row.dimsW,
        dimsH: row.dimsH,
        refUspsRate: row.refUspsRate,
        refUpsRate: row.refUpsRate,
        overrideTrackingNumber: row.overrideTrackingNumber,
        externallyShippedSource: row.externallyShippedSource,
        items: Array.isArray(row.orderItems) ? row.orderItems : [],
        sourceProvider: row.sourceProvider,
        externallyShipped: row.externallyShipped === true,
        externallyFulfilled: row.externallyFulfilled === true,
        externallyFulfilledVerified: row.externallyFulfilledVerified === true,
        orderStatus: lifecycle.billingStatus ?? lifecycle.effectiveOrderStatus, // PS-377/PS-387
        effectiveOrderStatus: lifecycle.effectiveOrderStatus,
        orderLifecycleStatus: lifecycle.orderLifecycleStatus,
      };
    })
    .filter(
      (row): row is BillableRow =>
        row !== null &&
        row.shipDate !== null &&
        (input.clientId === undefined || row.clientId === input.clientId)
    );

  // PS-412: one invoiced line freezes the whole client/order bill. Resolve
  // finality for the candidate order ids (not just finalized rows whose own
  // date happens to be in this range), then exclude the whole order from both
  // delete and rebuild.
  const finalizedOrderIds = await finalizedBillingOrderIdsForRange({
    dateFrom: fromIso,
    dateTo: toIso,
    orderIds: [...new Set(
      allBillableRows
        .map((row) => row.orderId)
        .filter((orderId): orderId is number => orderId != null && orderId > 0),
    )],
    clientId: input.clientId,
    scopePredicate: billingLineItemScopePredicate(input),
  });
  const billableRows = allBillableRows.filter(
    (row) => row.orderId == null || !finalizedOrderIds.has(row.orderId),
  );
  // PS-449 recomputes finalized candidates through the same canonical billing
  // calculator. Only billableRows may be rebuilt; calculationRows are also
  // compared with their immutable finalized invoice totals afterward.
  const calculationRows = allBillableRows;
  const skippedFinalizedOrderCount = new Set(
    allBillableRows
      .map((row) => row.orderId)
      .filter((orderId): orderId is number => orderId != null && finalizedOrderIds.has(orderId)),
  ).size;

  // ─── B2 pre-fetch: packages + per-client package prices ──────────────────
  // PS-207: the billed box comes from the SHIPMENT'S RECORDED BOX ONLY,
  // resolved by the pure policy module (billing-box-policy.ts — operator
  // directive → selected pid/code → exact dims; mismatch/unresolved → review
  // line). The pre-PS-207 fallbacks are deliberately GONE and must not come
  // back: SKU/inventory package defaults, rounded-dims matching, and
  // rate-dims resolution all billed boxes the parcel never shipped in
  // (HKP audit: SP6754 billed a 12x10x3 it never used; SP6755/6759 billed
  // $0.00 off an unpriced SKU-default box).
  const allPackages = await allPackagesPromise;

  const packagesById = new Map<number, BoxPackage>();
  const packagesByCode = new Map<string, BoxPackage>();
  const packagesByDims = new Map<string, BoxPackage>();
  for (const p of allPackages) {
    packagesById.set(p.id, p);
    if (p.packageCode) packagesByCode.set(p.packageCode, p);
    const key = boxDimsKey(p.length, p.width, p.height);
    if (key) packagesByDims.set(key, p);
  }
  const boxLookups: BoxLookups = {
    byId: packagesById,
    byCode: packagesByCode,
    byDims: packagesByDims,
  };

  const clientIdsInScope = [...configByClient.keys()];
  const priceRows = clientIdsInScope.length
    ? await db
        .select()
        .from(clientPackagePrices)
        .where(inArray(clientPackagePrices.clientId, clientIdsInScope))
    : [];
  const pricesByClient = new Map<number, Map<number, number>>();
  for (const r of priceRows) {
    let m = pricesByClient.get(r.clientId);
    if (!m) {
      m = new Map();
      pricesByClient.set(r.clientId, m);
    }
    m.set(r.packageId, Number(r.price));
  }

  // PS-207: operator review resolutions — explicit directives that persist
  // across regeneration (this DELETE/INSERT cycle never touches the table).
  const resolutionRows = await resolutionRowsPromise;
  const resolutionByOrderId = new Map<number, OperatorBoxResolution>();
  for (const r of resolutionRows) {
    resolutionByOrderId.set(r.orderId, {
      packageId: r.packageId,
      overridePrice: r.overridePrice != null ? Number(r.overridePrice) : null,
      note: r.note,
    });
  }

  // #798 slice 2c: per-ACCOUNT markup on the invoice. DEFAULT-OFF — only when
  // BILLING_PER_ACCOUNT_MARKUP=on do we load settings markup.<account> (the SAME loadCarrierMarkups
  // map the rate display + orders row-money read) and key it by the shipment's frozen carrierAccountId
  // as the per-account OVERRIDE. OFF => null map => the resolver keeps per-CLIENT-only behavior,
  // byte-identical to slice 2a (carrierAccountMarkup stays null). One load per generate, not per row.
  // Regeneration preserves any order group that contains an invoiced line, so activating
  // this setting only changes editable billing groups.
  const perAccountMarkups =
    process.env.BILLING_PER_ACCOUNT_MARKUP === 'on' ? await loadCarrierMarkups() : null;

  let generated = 0;
  let skipped = 0;
  const skippedFinalizedStorageGroups = new Set<string>();
  let total = 0;

  // Collect ALL line-item rows across every billable shipped order first, then run a
  // single batched INSERT at the end. Previous per-row insert + ON
  // CONFLICT DO NOTHING loop was the bottleneck (16K round-trips over a
  // 3,267-shipment generate). Batched upsert turns that into ~32
  // round-trips (chunks of 500).
  type LineRow = {
    clientId: number;
    orderId: number | null;
    orderNumber: string | null;
    shipmentId: number | null;
    shipDate: Date | null;
    billingEffectiveDate?: Date | null;
    billingPolicyVersion?: BillingPolicyVersion | null;
    lineType: string;
    description: string;
    qty: string;
    unitCost: string;
    totalCost: string;
    // PS-207: the package this order was BILLED as (resolver outcome or
    // operator directive). Stamped on every line of the order so the Box
    // Size column in billing details always shows the billed box.
    packageId: number | null;
  };
  const allRows: LineRow[] = [];

  // PS-220 (billing branch): for opted-in SHIPP house orders, bill the captured C. Shipping Rate
  // (cheapest eligible non-SHIPP) instead of the SHIPP drp_cost, and suppress the carrier markup —
  // the margin IS the spread. A failed sidecar read blocks regeneration instead
  // of silently billing a house order through the carrier/default path.
  const cShippingRateByShipmentId = new Map<number, number>();
  await requireBillingRegenerationRead('house shipping-rate sidecar', async () => {
    const houseShipmentIds = [
      ...new Set(calculationRows.map((r) => r.id).filter((id): id is number => typeof id === 'number')),
    ];
    if (houseShipmentIds.length) {
      await ensureOrderCompetitiveRateSchema();
      const houseRows = await db
        .select({ shipmentId: orderCompetitiveRate.shipmentId, customerRate: orderCompetitiveRate.customerRate })
        .from(orderCompetitiveRate)
        .where(and(eq(orderCompetitiveRate.isHouseOrder, true), inArray(orderCompetitiveRate.shipmentId, houseShipmentIds)));
      for (const hr of houseRows) {
        if (hr.shipmentId != null) cShippingRateByShipmentId.set(Number(hr.shipmentId), Number(hr.customerRate));
      }
    }
  });

  // PS-275: prep-fee waivers (operator's $0-shipping review decisions). Durable,
  // reversible, default-inert: with NO waiver row the map is empty and billing is
  // byte-identical to today. An unavailable sidecar is not a verified empty
  // sidecar and blocks regeneration. Read once for every order in scope; the
  // per-order loop zeroes ONLY prep/fulfillment/pick-pack fee lines when an
  // order is waived (never product/marketplace/box/storage/shipping).
  // Sidecar failures propagate before the billing-line transaction begins.
  const orderIdsInScope = [
    ...new Set(calculationRows.map((r) => r.orderId).filter((id): id is number => typeof id === 'number')),
  ];
  const [feeWaiverByOrderId, manualBillingOverrideByOrderId] = await Promise.all([
    requireBillingRegenerationRead(
      'billing fee-waiver sidecar',
      () => readBillingFeeWaivers(orderIdsInScope),
    ),
    requireBillingRegenerationRead(
      'manual billing-override sidecar',
      () => readBillingManualOverrides(orderIdsInScope),
    ),
  ]);
  // PS-312 S5 bill-once (Per user override unlock shipped data on 2026-06-24): load the bundle
  // membership for the in-scope orders (mirrors feeWaiverByOrderId). OFF -> the map is never loaded ->
  // every order bills normally -> byte-identical. Reads the additive bundle read-model only.
  const bundleByOrderId: Awaited<ReturnType<typeof getBundlesForOrders>> = env.BUNDLE_BILL_ONCE
    ? await getBundlesForOrders(orderIdsInScope)
    : new Map();

  for (const s of calculationRows) {
    if (s.clientId === null) {
      skipped += 1;
      continue;
    }
    const clientId = s.clientId;
    const cfg = configByClient.get(clientId);
    if (!cfg) {
      skipped += 1;
      continue;
    }

    // Per user override unlock shipped data on 2026-07-07: PS-402 keeps
    // marketplace-fulfilled/cancelled conflicts out of the generic cancelled
    // no-charge collapse. Billing must show a reconciliation row until verified
    // outbound shipment proof exists. Read-only; no source rows are mutated.
    const fulfillmentConflict = resolveFulfillmentConflict({
      orderId: s.orderId,
      orderNumber: s.orderNumber,
      orderStatus: s.orderStatus,
      effectiveOrderStatus: s.effectiveOrderStatus,
      orderLifecycleStatus: s.orderLifecycleStatus,
      sourceProvider: s.sourceProvider,
      externallyShipped: s.externallyShipped,
      externallyFulfilled: s.externallyFulfilled,
      externallyFulfilledVerified: s.externallyFulfilledVerified,
      externallyShippedSource: s.externallyShippedSource,
      marketplaceTrackingNumber: s.overrideTrackingNumber,
      hasLocalShipment: s.id != null,
    });
    const cancelledNoCharge =
      !fulfillmentConflict &&
      (isCancelledBillingStatus(s.orderStatus) ||
        isCancelledBillingStatus(s.effectiveOrderStatus) ||
        isCancelledBillingStatus(s.orderLifecycleStatus));

    const rows: LineRow[] = [];

    // PS-312 S5 bill-once: this order's bundle treatment (bill-normally vs included-in-bundle). Drives
    // the shipping + box suppression below. OFF / non-bundled / primary -> bill-normally (the map is
    // empty when the flag is OFF), so the shipping + box blocks run unchanged (byte-identical).
    const bundleTreatment = decideBundleBillingTreatment(
      s.orderId ?? -1,
      s.orderId != null ? bundleByOrderId.get(s.orderId) ?? null : null,
    );

    // ─── PS-207: shipped-box resolution (canonical: billing-box-policy.ts) ──
    // Operator directive → selected pid/code (dims-coherent) → exact dims.
    // The outcome feeds the package_cost block below AND stamps packageId on
    // every line of the order so the billed box is what details display.
    const boxResolution = resolveShippedPackageId({
      operator: s.orderId != null ? resolutionByOrderId.get(s.orderId) ?? null : null,
      selectedPid: s.selectedPid,
      selectedPackageId: s.selectedPackageId,
      dimsL: s.dimsL,
      dimsW: s.dimsW,
      dimsH: s.dimsH,
      lookups: boxLookups,
    });
    const billedPackageId =
      boxResolution.status === 'resolved' ? boxResolution.packageId : null;

    const pickPackFee = toNum(cfg.pickPackFee);
    if (pickPackFee > 0) {
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'pick_pack',
        description: `Pick/pack for order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: roundMoney(pickPackFee).toFixed(2),
        totalCost: roundMoney(pickPackFee).toFixed(2),
        packageId: billedPackageId,
      });
    }

    // ─── Additional-unit fee (gap B1) ───────────────────────────────────────
    // Every unit past pickPackMaxUnits on the order is billed at
    // additionalUnitFee each. Threshold is now per-client (was hardcoded);
    // defaults to 1 via schema default and the constant below as a belt-and-
    // braces fallback for any row missing the column.
    const additionalUnitFee = toNum(cfg.additionalUnitFee);
    const maxUnits =
      typeof cfg.pickPackMaxUnits === 'number' && cfg.pickPackMaxUnits > 0
        ? cfg.pickPackMaxUnits
        : PICK_PACK_MAX_UNITS_DEFAULT;
    const items = Array.isArray(s.items) ? s.items : [];
    const totalUnits = totalUnitsFromItems(items);
    if (totalUnits > maxUnits && additionalUnitFee > 0) {
      const extraUnits = totalUnits - maxUnits;
      const extraCost = extraUnits * additionalUnitFee;
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'additional_unit',
        description: `Additional units (×${extraUnits})`,
        qty: String(extraUnits),
        unitCost: roundMoney(additionalUnitFee).toFixed(2),
        totalCost: roundMoney(extraCost).toFixed(2),
        packageId: billedPackageId,
      });
    }

    // Per user override unlock shipped data on 2026-07-06: PS-381 makes billing
    // generation delegate selected/purchased shipping cost to the same backend
    // resolver used by billing detail and the backfill planner. This reads only
    // shipment proof fields and does not mutate shipments.
    const labelCost = resolveBillingSelectedRateCost({
      selectedRateCost: s.selectedRateCost,
      cost: s.cost,
      labelCost: s.labelCost,
      otherCost: s.otherCost,
      selectedRateJson: s.selectedRateJson,
    }) ?? 0;
    if (bundleTreatment.kind === 'included-in-bundle') {
      // PS-312 S5: bundle child — shipping is billed ONCE on the primary. Emit a $0 "Included" line in
      // the shipping slot (mirrors the shipping_missing/$0 pattern; the unique (order_id, line_type,
      // description) key holds; $0 never inflates the total). The box block below is suppressed too.
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping',
        description: bundleTreatment.note,
        qty: '1',
        unitCost: '0.00',
        totalCost: '0.00',
        packageId: billedPackageId,
      });
    } else if (labelCost > 0) {
      const cShippingRateAmount = s.id != null ? cShippingRateByShipmentId.get(Number(s.id)) : undefined;
      // PS-220: single source of truth for the billed shipping amount. A captured house
      // customer_rate is billed verbatim (carrier markup + reference-rate suppressed); otherwise
      // the label cost flows through optional reference-rate flooring + the carrier markup. The
      // SHIPP drp_cost and the margin are INTERNAL and never appear on the invoice.
      // #798: resolve the shipping markup through the canonical owner (per-account override -> per-
      // client default -> none). Slice 2c (fixed): the per-account override is the shipment's account
      // markup from settings markup.<account>, keyed on providerAccountId in the SAME namespace the rate
      // display uses (resolvePerAccountMarkupRule mirrors applyMarkups' se-<id>/bare lookup). Present
      // only when BILLING_PER_ACCOUNT_MARKUP=on (perAccountMarkups non-null). DEFAULT-OFF:
      // perAccountMarkups null -> carrierAccountMarkup null -> per-client default; with markups at 0 the
      // resolver returns null -> 0pct/0flat, byte-identical to slice 2a. House orders suppress markup.
      const resolvedShippingMarkup = resolveCanonicalMarkup({
        carrierAccountMarkup: perAccountMarkups
          ? resolvePerAccountMarkupRule(perAccountMarkups, s.providerAccountId)
          : null,
        clientShippingMarkupPct: toNum(cfg.shippingMarkupPct),
        clientShippingMarkupFlat: toNum(cfg.shippingMarkupFlat),
      });
      const shippingDecision = resolveCustomerShippingMoney({
        selectedRateCost: labelCost,
        cShippingRateAmount,
        billingMode: cfg.billingMode,
        carrierCode: s.carrierCode,
        refUspsRate: toNum(s.refUspsRate),
        refUpsRate: toNum(s.refUpsRate),
        shippingMarkupPct: resolvedShippingMarkup?.pct ?? 0,
        shippingMarkupFlat: resolvedShippingMarkup?.flat ?? 0,
        shippingMarkupKind: resolvedShippingMarkup?.adjustmentKind ?? 'customer_profit_markup',
        hugrabShippingRateOverride: {
          enabled: cfg.hugrabShippingRateOverrideEnabled,
          threshold: cfg.hugrabShippingRateOverrideThreshold,
          amount: cfg.hugrabShippingRateOverrideAmount,
        },
      });
      const billedShippingAmount = shippingDecision.cShippingRateAmount;
      const billingDescriptionSuffix = shippingDecision.billingDescriptionSuffix;
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping',
        description: `Shipping${billingDescriptionSuffix} · order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: roundMoney(billedShippingAmount).toFixed(2),
        totalCost: roundMoney(billedShippingAmount).toFixed(2),
        packageId: billedPackageId,
      });
    } else if (fulfillmentConflict?.billingAction === 'shipping_missing_review') {
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping_missing',
        description: `Fulfillment conflict - reconcile verified outbound shipment for order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: '0.00',
        totalCost: '0.00',
        packageId: billedPackageId,
      });
    } else if (s.externallyShipped || s.externallyFulfilled || s.id === null) {
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping_missing',
        description: `Missing shipping cost - reconcile ShipStation/source rate for order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: '0.00',
        totalCost: '0.00',
        packageId: billedPackageId,
      });
    } else if (s.id != null) {
      // PS-275 (Per user override unlock shipped data on 2026-06-17): an order
      // WE fulfilled (a real internal shipment exists) whose recorded shipping
      // cost is exactly $0 / blank. Previously this fell through every branch
      // above and produced NO shipping line at all, so the order silently
      // dropped out of billing and the $0-shipping review could never fire.
      // Emit an explicit $0.00 shipping line so the operator gets the
      // waive-prep-fee review affordance (decideZeroShippingReview below reads
      // totalCost === 0 + a shipment row). $0.00 never inflates the invoice
      // total; this is a derived display line, not a mutation of shipped data.
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping',
        description: `Shipping · order ${s.orderNumber ?? s.orderId} (no recorded cost — review)`,
        qty: '1',
        unitCost: '0.00',
        totalCost: '0.00',
        packageId: billedPackageId,
      });
    }

    // ─── Package cost (PS-207: shipment box ONLY, review when unsure) ───────
    // The DECISION (gate on configured box pricing, override-vs-configured
    // pricing, review emission) is owned by decidePackageCostLine in
    // billing-box-policy.ts — this block only translates it into a LineRow.
    const clientPrices = pricesByClient.get(clientId);
    const packageCostDecision = decidePackageCostLine({
      resolution: boxResolution,
      clientHasBoxPricing: (clientPrices?.size ?? 0) > 0,
      // PS-372(a): NULL is the one "no configured price" sentinel (shared with
      // clientUsedPackagePricingRows). A map miss normalizes to null here so no
      // caller ever sees 0-vs-undefined ambiguity for "unconfigured".
      configuredPrice:
        boxResolution.status === 'resolved' && boxResolution.packageId != null
          ? clientPrices?.get(boxResolution.packageId) ?? null
          : null,
      markupPct: toNum(cfg.packageCostMarkup),
    });
    if (bundleTreatment.kind === 'included-in-bundle') {
      // PS-312 S5: bundle child — the box is billed ONCE on the primary; suppress the child's box line.
    } else if (packageCostDecision.kind === 'line') {
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'package_cost',
        description: `Box (${packageCostDecision.pkgName})`,
        qty: '1',
        unitCost: roundMoney(packageCostDecision.amount).toFixed(2),
        totalCost: roundMoney(packageCostDecision.amount).toFixed(2),
        packageId: billedPackageId,
      });
    } else if (packageCostDecision.kind === 'review') {
      // Mismatch or unresolved — explicit $0.00 review line (mirrors the
      // shipping_missing pattern). Stays $0.00 until the operator resolves
      // it via billing_box_resolutions; never inflates totals.
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'package_cost_missing',
        description: packageCostDecision.description,
        qty: '1',
        unitCost: '0.00',
        totalCost: '0.00',
        packageId: null,
      });
    }

    // ─── PS-275: prep-fee waiver (the $0-shipping review outcome) ───────────
    // When the operator has WAIVED this order's prep fee, zero ONLY the
    // prep/fulfillment/pick-pack fee lines (applyPrepFeeWaiver — the pure
    // owner). Product/marketplace/box/storage/shipping label lines are NEVER
    // touched. No waiver (the default for every order) => byte-identical rows.
    // Applied BEFORE the batch collect so details, summary metrics, and the
    // PDF/XLSX exports all read the SAME adjusted billing_line_items — no forked
    // export math.
    const waiver = s.orderId != null ? feeWaiverByOrderId.get(s.orderId) : undefined;
    const waived = waiver?.decision === 'waived';
    // PS-377: a cancelled no-charge order is billed as a SINGLE $0.00 "Cancelled"
    // row — the per-order fee lines above were computed (pure, no side effects)
    // and are discarded here so the row is VISIBLE but adds no dollars to totals.
    const effectiveRows: LineRow[] = cancelledNoCharge
      ? [
          {
            clientId,
            orderId: s.orderId,
            orderNumber: s.orderNumber,
            shipmentId: s.id,
            shipDate: s.shipDate,
            lineType: 'cancelled',
            description: `Cancelled — order ${s.orderNumber ?? s.orderId} (no charge)`,
            qty: '1',
            unitCost: '0.00',
            totalCost: '0.00',
            packageId: null,
          },
        ]
      : applyManualBillingOverrides(
          applyPrepFeeWaiver(rows, waived),
          s.orderId != null ? manualBillingOverrideByOrderId.get(s.orderId) ?? [] : [],
          {
            clientId,
            orderId: s.orderId,
            orderNumber: s.orderNumber,
            shipmentId: s.id,
            shipDate: s.shipDate,
            packageId: billedPackageId,
          },
        );

    // PS-425: the frozen description carries the same shipment identity as
    // shipmentId, so audits and exports retain human-readable lineage.
    for (const row of effectiveRows) {
      allRows.push({
        ...row,
        billingEffectiveDate: s.billingEffectiveDate,
        billingPolicyVersion: s.billingPolicyVersion,
        description: withShipmentBillingLineage(row.description, row.shipmentId),
      });
    }
  }

  // PS-412: lock every candidate bill, then delete and rebuild order lines in
  // one transaction. A concurrent finalizer either commits first (this rejects
  // before deleting) or waits until the complete rebuild commits. Any insert
  // failure rolls the delete back instead of leaving a partially rebuilt bill.
  const editableOrderIds = [...new Set(
    billableRows
      .map((row) => row.orderId)
      .filter((orderId): orderId is number => orderId != null && orderId > 0),
  )];
  const editableRows = allRows.filter(
    (row) => row.orderId == null || !finalizedOrderIds.has(row.orderId),
  );
  const requestedWindowOrderLines = and(
    sql`${billingPersistedEffectiveDaySql} >= ${fromIso}::timestamptz`,
    sql`${billingPersistedEffectiveDaySql} < ${toIso}::timestamptz`,
  );
  // Per user override unlock shipped data on 2026-07-14 (Audit B-5):
  // a canonical billing ship-date correction can move an order across periods.
  // Delete every editable line for current candidate orders, regardless of its
  // old period, while retaining the requested-window sweep for orders that are
  // no longer billable. Finalized siblings remain protected by the policy
  // assertion, editable predicate, and database triggers below.
  const orderLinesToRebuild = editableOrderIds.length > 0
    ? or(
        inArray(billingLineItems.orderId, editableOrderIds),
        requestedWindowOrderLines,
      )
    : requestedWindowOrderLines;
  const CHUNK = 500;
  try {
    await db.transaction(async (tx) => {
      await assertBillingOrdersEditable(
        {
          orderIds: editableOrderIds,
          clientId: input.clientId,
          scopePredicate: billingLineItemScopePredicate(input),
        },
        tx,
      );
      await tx.delete(billingLineItems).where(
        and(
          sql`${billingLineItems.orderId} is not null`,
          orderLinesToRebuild,
          input.clientId !== undefined
            ? eq(billingLineItems.clientId, input.clientId)
            : undefined,
          billingLineItemScopePredicate(input),
          billingLineItemIsEditablePredicate(),
        ),
      );
      for (let i = 0; i < editableRows.length; i += CHUNK) {
        const chunk = editableRows.slice(i, i + CHUNK);
        if (!chunk.length) continue;
        const inserted = await tx
          .insert(billingLineItems)
          .values(chunk)
          // PS-425: a duplicate candidate is a loud transaction failure, never
          // a conflict-ignore that reports an attempted row as persisted.
          .returning({
            id: billingLineItems.id,
            shipmentId: billingLineItems.shipmentId,
            totalCost: billingLineItems.totalCost,
          });
        generated += inserted.length;
        for (const row of inserted) total += toNum(row.totalCost);
      }
      await setBillingOrdersDirty(
        {
          orderIds: editableOrderIds,
          dirty: false,
          clientId: input.clientId,
          scopePredicate: billingLineItemScopePredicate(input),
        },
        tx,
      );
    });
  } catch (error) {
    if (isBillingFinalizedLockError(error)) rethrowAsBillingFinalizedLock(error);
    throw error;
  }

  // ── PS-487: return billing ────────────────────────────────────────────────
  // Default OFF. Flipping RETURN_BILLING_ENABLED is what starts putting
  // return_processing / return_label lines on real invoices, so it is a deliberate
  // Render env change after canary — never a deploy side effect.
  //
  // Modelled on the storage pass below: its own delete+insert inside one transaction,
  // fenced by billingLineItemIsEditablePredicate() so a finalized or invoiced period is
  // never touched. WHICH lines exist and what they cost is decided by the pure planner
  // (billing-return-line-planner); this block only reads, deletes and inserts.
  //
  // The forward-only cutover lives in the contract, so the 8 pre-PS-487 production
  // returns can never be swept into an invoice by turning the flag on.
  let returnLinesGenerated = 0;
  let returnLinesSkipped = 0;
  let returnLinesIntoFinalizedAdjustment = 0;
  // Return amounts whose order is already finalized — folded into the PS-449
  // reconciliation below instead of being written into the frozen period.
  const finalizedReturnTotalsByClient = new Map<number, Map<number, number>>();
  if (env.RETURN_BILLING_ENABLED) {
    const returnRows = await db
      .select({
        id: returns.id,
        orderId: returns.orderId,
        clientId: returns.clientId,
        createdAt: returns.createdAt,
        returnCustomerShippingRate: returns.returnCustomerShippingRate,
        returnReference: returns.returnReference,
        orderNumber: orders.orderNumber,
      })
      .from(returns)
      .leftJoin(orders, eq(orders.id, returns.orderId))
      .where(
        and(
          sql`${returns.createdAt} >= ${fromIso}::timestamptz`,
          sql`${returns.createdAt} < ${toIso}::timestamptz`,
          input.clientId !== undefined ? eq(returns.clientId, input.clientId) : undefined,
        ),
      );

    const returnPlan = planReturnBillingLines({
      returns: returnRows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.orderNumber ?? null,
        clientId: r.clientId,
        createdAt: r.createdAt,
        returnCustomerShippingRate: r.returnCustomerShippingRate,
        returnReference: r.returnReference,
      })),
      returnProcessingFeeByClientId: new Map(
        [...configByClient.entries()].map(([cid, cfg]) => [
          cid,
          toNum(cfg.returnProcessingFee ?? 0),
        ]),
      ),
    });
    returnLinesSkipped = returnPlan.skipped.length;

    // AC-6. A return whose order sits in a FINALIZED period must not be inserted there —
    // that would add to a frozen invoice. Split it out and let PS-449's canonical
    // reconciliation owner handle it exactly like a finalized order line: it locks the
    // client, compares against the immutable finalized rows AND prior signed
    // corrections, then appends only the remaining delta to the backend-selected open
    // period. Building a second override/adjustment path here would be a duplicate owner
    // of the rule PS-449 already owns.
    const openReturnLines = returnPlan.lines.filter((l) => !finalizedOrderIds.has(l.orderId));
    for (const line of returnPlan.lines) {
      if (!finalizedOrderIds.has(line.orderId)) continue;
      returnLinesIntoFinalizedAdjustment += 1;
      let clientTotals = finalizedReturnTotalsByClient.get(line.clientId);
      if (!clientTotals) {
        clientTotals = new Map<number, number>();
        finalizedReturnTotalsByClient.set(line.clientId, clientTotals);
      }
      clientTotals.set(
        line.orderId,
        roundMoney((clientTotals.get(line.orderId) ?? 0) + toNum(line.totalCost)),
      );
    }
    returnPlan.lines.length = 0;
    returnPlan.lines.push(...openReturnLines);

    if (returnPlan.lines.length) {
      await db.transaction(async (tx) => {
        // Clear only EDITABLE return lines in range, so regeneration is repeatable and a
        // finalized period keeps its rows.
        await tx.delete(billingLineItems).where(
          and(
            inArray(billingLineItems.lineType, [
              RETURN_PROCESSING_LINE_TYPE,
              RETURN_SHIPPING_LINE_TYPE,
            ]),
            sql`${billingLineItems.billingEffectiveDate} >= ${fromIso}::timestamptz`,
            sql`${billingLineItems.billingEffectiveDate} < ${toIso}::timestamptz`,
            input.clientId !== undefined
              ? eq(billingLineItems.clientId, input.clientId)
              : undefined,
            billingLineItemScopePredicate(input),
            billingLineItemIsEditablePredicate(),
          ),
        );
        const inserted = await tx
          .insert(billingLineItems)
          .values(
            returnPlan.lines.map((line) => ({
              clientId: line.clientId,
              orderId: line.orderId,
              orderNumber: line.orderNumber,
              shipmentId: null,
              lineType: line.lineType,
              description: line.description,
              qty: line.qty,
              unitCost: line.unitCost,
              totalCost: line.totalCost,
              shipDate: new Date(`${line.shipDate}T00:00:00.000Z`),
              billingEffectiveDate: new Date(`${line.billingEffectiveDate}T00:00:00.000Z`),
            })),
          )
          // Same choice as PS-425: a duplicate is a loud transaction failure. The unique
          // index on (order_id, line_type, description) is what makes this idempotent,
          // and the description carries the canonical return event key.
          .returning({ id: billingLineItems.id, totalCost: billingLineItems.totalCost });
        returnLinesGenerated = inserted.length;
        for (const r of inserted) total += toNum(r.totalCost);
      });
      generated += returnLinesGenerated;
    }
  }

  const finalizedCandidateTotalsByClient = new Map<number, Map<number, number>>();
  for (const row of allRows) {
    if (row.orderId == null || !finalizedOrderIds.has(row.orderId)) continue;
    let clientTotals = finalizedCandidateTotalsByClient.get(row.clientId);
    if (!clientTotals) {
      clientTotals = new Map<number, number>();
      finalizedCandidateTotalsByClient.set(row.clientId, clientTotals);
    }
    clientTotals.set(row.orderId, roundMoney((clientTotals.get(row.orderId) ?? 0) + toNum(row.totalCost)));
  }
  // AC-6: fold finalized-period return amounts into the SAME candidate set, so the
  // reconciliation owner sees one total per order and appends a single delta rather
  // than the return being handled by a parallel adjustment path.
  for (const [clientId, returnTotals] of finalizedReturnTotalsByClient) {
    let clientTotals = finalizedCandidateTotalsByClient.get(clientId);
    if (!clientTotals) {
      clientTotals = new Map<number, number>();
      finalizedCandidateTotalsByClient.set(clientId, clientTotals);
    }
    for (const [orderId, amount] of returnTotals) {
      clientTotals.set(orderId, roundMoney((clientTotals.get(orderId) ?? 0) + amount));
    }
  }

  let finalizedAdjustmentCount = 0;
  let finalizedAdjustmentCreditCount = 0;
  let finalizedAdjustmentDebitCount = 0;
  let finalizedAdjustmentUntouchedCount = 0;
  for (const [clientId, candidateTotals] of finalizedCandidateTotalsByClient) {
    const result = await reconcileFinalizedBillingOrderAdjustments({
      clientId,
      dateFrom: fromIso,
      dateTo: toIso,
      candidates: [...candidateTotals].map(([orderId, currentTotal]) => ({
        orderId,
        currentTotal: currentTotal.toFixed(2),
      })),
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      now: input.now,
    });
    finalizedAdjustmentCount += result.adjustedOrderCount;
    finalizedAdjustmentCreditCount += result.creditCount;
    finalizedAdjustmentDebitCount += result.debitCount;
    finalizedAdjustmentUntouchedCount += result.untouchedOrderCount;
  }
  // ─── Storage fees (PS-373: prorated cubic-foot-DAYS from the inventory ledger) ─
  // The billable-storage math is owned by computeClientStorageBilling
  // (src/services/billing-storage.ts). For each client with a positive storage
  // rate, it rebuilds each positive-volume SKU's on-hand timeline from the
  // canonical inventory_ledger and integrates cubic-foot-DAYS over the billing
  // month, prorated by the actual days in that month — replacing the old
  // end-of-period balance snapshot. One frozen storage line per client;
  // per-unit volume via cuFtPerUnit(); rate from billing_config. Reads inventory /
  // inventory_ledger only (never mutates order/shipment rows).
  const storagePeriods = calendarStoragePeriodsForRange(input.dateFrom, input.dateTo);
  const storageRangeStart = storagePeriods[0]?.periodStart ?? new Date(input.dateFrom);
  const storageRangeEnd = storagePeriods.at(-1)?.periodEnd ?? new Date(input.dateTo);

  const existingStorageRows = await db
    .select({
      clientId: billingLineItems.clientId,
      shipDate: billingLineItems.shipDate,
      invoiced: billingLineItems.invoiced,
    })
    .from(billingLineItems)
    .where(
      and(
        sql`${billingLineItems.orderId} is null`,
        eq(billingLineItems.lineType, 'storage'),
        sql`${billingLineItems.shipDate} >= ${storageRangeStart.toISOString()}::timestamptz`,
        sql`${billingLineItems.shipDate} < ${storageRangeEnd.toISOString()}::timestamptz`,
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined,
        billingLineItemScopePredicate(input),
      ),
    );
  for (const row of existingStorageRows) {
    if (row.invoiced === true) {
      skippedFinalizedStorageGroups.add(
        `${row.clientId}:${row.shipDate?.toISOString() ?? 'null'}`,
      );
    }
  }
  const storageClientIdsToProcess = [...new Set([
    ...configByClient.keys(),
    ...existingStorageRows.map((row) => row.clientId),
  ])];

  const cleanupEditableStorage = async (
    clientId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx
        .delete(billingLineItems)
        .where(
          and(
            eq(billingLineItems.clientId, clientId),
            sql`${billingLineItems.orderId} is null`,
            eq(billingLineItems.lineType, 'storage'),
            sql`${billingLineItems.shipDate} >= ${periodStart.toISOString()}::timestamptz`,
            sql`${billingLineItems.shipDate} < ${periodEnd.toISOString()}::timestamptz`,
            billingLineItemScopePredicate(input),
            billingLineItemIsEditablePredicate(),
          ),
        );
    });
  };

  // One inventory read + one ledger read for ALL storage-billed clients — this
  // loop used to issue both queries PER CLIENT, serially. Same predicates, same
  // rows; client_id/inventory_id are carried so the in-memory split feeds each
  // client's computeClientStorageBilling with EXACTLY the rows the per-client
  // queries returned. The per-client proof+line transaction below is unchanged.
  const storageClientIds = [...configByClient.entries()]
    .filter(([, cfg]) => toNum(cfg.storageFeePerCuFt ?? 0) > 0 && cfg.active !== false)
    .map(([clientId]) => clientId);
  const storageInvRowsByClient = new Map<
    number,
    Array<{
      id: number;
      sku: string;
      cu_ft_override: number | null;
      length: number | null;
      width: number | null;
      height: number | null;
    }>
  >();
  const storageMovesByInv = new Map<number, StorageLedgerMovement[]>();
  if (storageClientIds.length) {
    await ensureInventoryLedgerSchema();
    const invRowsAll = await db.execute<{
      id: number;
      client_id: number;
      sku: string;
      cu_ft_override: number | null;
      length: number | null;
      width: number | null;
      height: number | null;
    }>(sql`
      select id, client_id, sku, cu_ft_override, length, width, height
       from inventory
       where client_id = any(${intArraySql(storageClientIds)})
    `);
    for (const r of invRowsAll) {
      const list = storageInvRowsByClient.get(Number(r.client_id)) ?? [];
      list.push(r);
      storageInvRowsByClient.set(Number(r.client_id), list);
    }
    const allInvIds = invRowsAll.map((r) => Number(r.id));
    if (allInvIds.length) {
      // Ledger movements up to the period end — pre-period rows set the starting
      // balance (storage carries over from prior months); in-period rows move it.
      const ledgerRowsAll = await db.execute<{
        inventory_id: number;
        type: string;
        qty: number;
        order_id: number | null;
        effective_at: string;
      }>(sql`
        select inventory_id, type, qty, order_id, coalesce(effective_at, created_at) as effective_at
        from inventory_ledger
        where inventory_id = any(${intArraySql(allInvIds)})
          and coalesce(effective_at, created_at) < ${storageRangeEnd.toISOString()}::timestamptz
      `);
      for (const row of ledgerRowsAll) {
        const id = Number(row.inventory_id);
        const list = storageMovesByInv.get(id) ?? [];
        list.push({ type: row.type, qty: row.qty, orderId: row.order_id, effectiveAt: row.effective_at });
        storageMovesByInv.set(id, list);
      }
    }
  }

  for (const storagePeriod of storagePeriods) {
    const { monthKey, periodStart, periodEnd, lineDate: storageShipDate } = storagePeriod;
    const storageCalendar = resolveBillingCalendarDay({
      actualActivityDay: storageShipDate.toISOString().slice(0, 10),
      effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
    });
    const storageBillingEffectiveDate = new Date(
      `${storageCalendar.billingEffectiveDay}T00:00:00.000Z`,
    );

    for (const clientId of storageClientIdsToProcess) {
    const cfg = configByClient.get(clientId);
    const storageRate = toNum(cfg?.storageFeePerCuFt ?? '0');
    if (!cfg || storageRate <= 0 || cfg.active === false) {
      await cleanupEditableStorage(clientId, periodStart, periodEnd);
      continue;
    }

    // Historical monthly storage must include deactivated catalog rows when
    // their signed ledger held inventory during this month.
    const invRows = storageInvRowsByClient.get(clientId) ?? [];
    if (!invRows.length) {
      await cleanupEditableStorage(clientId, periodStart, periodEnd);
      continue;
    }

    const storage = computeClientStorageBilling({
      skus: invRows.map((r) => ({
        inventoryId: Number(r.id),
        sku: r.sku,
        cuFtPerUnit: cuFtPerUnit(r.cu_ft_override, r.length, r.width, r.height),
        movements: storageMovesByInv.get(Number(r.id)) ?? [],
      })),
      storageFeePerCuFtMonth: storageRate,
      periodStart,
      periodEnd,
    });
    if (storage.amount <= 0) {
      await cleanupEditableStorage(clientId, periodStart, periodEnd);
      continue;
    }

    // PS-462: stable client+calendar-month display identity. Volatile math and
    // exception details live in the frozen proof sidecar, not this unique key.
    const description = `Storage — ${monthKey}`;

    // Invoice-line display (numeric(10,2)): bill the average cuft held over the
    // month (cuft-months = cuft-days / days) at the monthly rate, so
    // qty × unitCost reconciles to totalCost. The frozen totalCost (Σ per-SKU
    // rounded amounts) stays authoritative.
    const cuFtMonths = storage.daysInMonth > 0 ? storage.totalCuFtDays / storage.daysInMonth : 0;

    // PS-373 (slice 2): freeze the per-SKU / per-interval PROOF for this
    // client+period so the admin drilldown and any client dispute can see
    // exactly how the storage total was built. PS-383 makes this proof
    // durability the gate: proof schema + proof row + line row commit together,
    // or the storage charge is skipped.
    const proofValues = {
      daysInMonth: storage.daysInMonth,
      monthlyRatePerCuFt: storage.monthlyRatePerCuFt.toFixed(4),
      dailyRatePerCuFt: storage.dailyRatePerCuFt.toFixed(10),
      totalCuFtDays: storage.totalCuFtDays.toFixed(6),
      amount: roundMoney(storage.amount).toFixed(2),
      skuCount: storage.skuProofs.length,
      exceptionCount: storage.exceptions.length,
      proof: { skuProofs: storage.skuProofs, exceptions: storage.exceptions },
      updatedAt: new Date(),
    };
    try {
      await ensureBillingStorageProofSchema();
      const insertedStorageLines = await db.transaction(async (tx) => {
        // Audit B-4 (2026-07-13): serialize concurrent storage writers for this
        // client+period. The shipment-cardinality key does not carry client/date,
        // so billing_li_storage_unique_idx remains storage's DB identity. The
        // advisory lock prevents two writers from racing between delete/insert.
        // It releases on
        // commit/rollback; the second writer waits (ms — this tx is 3 small
        // statements), then its delete sees the committed row.
        const [storageLockClassId, storageLockObjId] = advisoryLockKeyPair(
          `billing-storage:${clientId}:${monthKey}`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(${storageLockClassId}, ${storageLockObjId})`,
        );
        // PS-412: replace the editable storage line in the same transaction as
        // its proof. Finalized storage remains untouched and makes the insert
        // fail closed, rolling the proof update back as well.
        await tx
          .delete(billingLineItems)
          .where(
            and(
              eq(billingLineItems.clientId, clientId),
              sql`${billingLineItems.orderId} is null`,
              eq(billingLineItems.lineType, 'storage'),
              sql`${billingLineItems.shipDate} >= ${periodStart.toISOString()}::timestamptz`,
              sql`${billingLineItems.shipDate} < ${periodEnd.toISOString()}::timestamptz`,
              billingLineItemScopePredicate(input),
              billingLineItemIsEditablePredicate(),
            ),
          );
        await tx
          .insert(billingStorageProof)
          .values({ clientId, periodStart, periodEnd, ...proofValues })
          .onConflictDoUpdate({
            target: [
              billingStorageProof.clientId,
              billingStorageProof.periodStart,
              billingStorageProof.periodEnd,
            ],
            set: proofValues,
          });
        return tx
          .insert(billingLineItems)
          .values({
            clientId,
            orderId: null,
            orderNumber: null,
            shipmentId: null,
            shipDate: storageShipDate,
            billingEffectiveDate: storageBillingEffectiveDate,
            billingPolicyVersion: storageCalendar.policyVersion,
            lineType: 'storage',
            description,
            qty: cuFtMonths.toFixed(2),
            unitCost: roundMoney(storageRate).toFixed(2),
            totalCost: roundMoney(storage.amount).toFixed(2),
          })
          .onConflictDoNothing({
            target: [
              billingLineItems.clientId,
              billingLineItems.lineType,
              billingLineItems.shipDate,
              billingLineItems.description,
            ],
            where: sql`${billingLineItems.orderId} is null`,
          })
          // Per user override unlock shipped data on 2026-07-14 (Audit B-9):
          // report only the derived billing rows Postgres actually persisted.
          // This does not write orders or shipments.
          .returning({ totalCost: billingLineItems.totalCost });
      });
      generated += insertedStorageLines.length;
      for (const row of insertedStorageLines) total += toNum(row.totalCost);
    } catch (storageErr) {
      skipped += 1;
      if (isBillingFinalizedLockError(storageErr)) {
        skippedFinalizedStorageGroups.add(`${clientId}:${storageShipDate.toISOString()}`);
      }
      reportError('billing.storage_line.freeze_failed', storageErr, {
        clientId,
        monthKey,
        dateFrom: periodStart.toISOString(),
        dateTo: periodEnd.toISOString(),
      });
    }
  }
  }

  // New lines were just written — any cached freshness verdict in this
  // process is now stale.
  clearBillingGenerationStatusCache();

  let billingSummaryMetricsRows: number | null = null;
  try {
    billingSummaryMetricsRows = await refreshBillingSummaryMetrics(
      new Date(input.dateFrom),
      new Date(input.dateTo)
    );
  } catch (err) {
    reportError('billing.summary_metrics.refresh_failed', err, {
      clientId: input.clientId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
  }

  return {
    generated,
    count: generated,
    total: roundMoney(total),
    skipped,
    skippedFinalizedOrderCount,
    finalizedAdjustmentCount,
    finalizedAdjustmentCreditCount,
    finalizedAdjustmentDebitCount,
    finalizedAdjustmentUntouchedCount,
    skippedFinalizedStorageCount: skippedFinalizedStorageGroups.size,
    billingSummaryMetricsRows,
    message: `Generated ${generated} line items from ${billableRows.length} editable shipments/orders; finalized rows stayed unchanged (${finalizedAdjustmentCount} current-period adjustment(s), ${finalizedAdjustmentUntouchedCount} untouched order(s)); ${skippedFinalizedStorageGroups.size} finalized storage period(s) left unchanged.`,
  };
}

export type BillingSummaryRow = {
  clientId: number;
  clientName: string;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  missingShippingCostCount?: number;
  storageTotal: number;
  adjustmentTotal: number;
  fulfillmentFeeTotal: number;
  orderCount: number;
  grandTotal: number;
  // Back-compat fields for legacy callers of the old shape.
  total: number;
  count: number;
  byType: Record<string, number>;
};

async function hasBillingLineItemsForSummary(input: GenerateInput): Promise<boolean> {
  const [row] = await db.execute<{ exists: boolean }>(sql`
    select exists (
      select 1
      from billing_line_items
      where coalesce(billing_effective_date, ship_date) >= ${input.dateFrom}::timestamptz
        and coalesce(billing_effective_date, ship_date) < ${input.dateTo}::timestamptz
        ${input.clientId !== undefined ? sql`and client_id = ${input.clientId}` : sql``}
        and ${billingLineItemScopePredicate(input)}
      limit 1
    ) as exists
  `);
  return row?.exists === true;
}

export async function billingSummary(
  input: GenerateInput
): Promise<{ clients: BillingSummaryRow[]; grandTotal: number }> {
  let hasGeneratedRows: boolean | null = null;
  const hasLineItems = async () => {
    if (hasGeneratedRows === null) {
      hasGeneratedRows = await hasBillingLineItemsForSummary(input);
    }
    return hasGeneratedRows;
  };

  const metrics = await getFreshBillingSummaryMetrics({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    clientId: input.clientId,
    scopeClientIds: input.scopeClientIds,
    scopeStoreIds: input.scopeStoreIds,
    scopeIsGlobal: input.scopeIsGlobal,
    scopeRestricted: input.scopeRestricted,
    maxAgeMinutes: 45,
  }).catch((err) => {
    reportError('billing.summary_metrics.read_failed', err, {
      clientId: input.clientId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
    return null;
  });
  if (metrics && billingSummaryHasValues(metrics)) return metrics;

  if (metrics && !(await hasLineItems())) return metrics;

  if (!metrics || !billingSummaryHasValues(metrics)) {
    if (await hasLineItems()) {
      try {
        logStructured('info', 'billing.summary_metrics.refreshing_stale', {
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          clientId: input.clientId ?? null,
        });
        await refreshBillingSummaryMetrics(
          new Date(input.dateFrom),
          new Date(input.dateTo)
        );
        const refreshedMetrics = await getFreshBillingSummaryMetrics({
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          clientId: input.clientId,
          scopeClientIds: input.scopeClientIds,
          scopeStoreIds: input.scopeStoreIds,
          scopeIsGlobal: input.scopeIsGlobal,
          scopeRestricted: input.scopeRestricted,
          maxAgeMinutes: 45,
        });
        if (refreshedMetrics) return refreshedMetrics;
      } catch (err) {
        reportError('billing.summary_metrics.stale_refresh_failed', err, {
          clientId: input.clientId,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        });
      }
    }
  }

  const useLiveFallback =
    process.env.BILLING_SUMMARY_LIVE_FALLBACK === 'true' || (await hasLineItems());
  if (!useLiveFallback) {
    const clientRows = await db.execute<{
      client_id: number;
      client_name: string;
    }>(sql`
      select
        c.id as client_id,
        c.name as client_name
      from clients c
      where c.active = true
        and c.name not in (${systemClientNamesSql})
        ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
        and ${billingClientScopePredicate(input)}
      order by c.name asc
    `);

    return {
      clients: clientRows.map((row) => ({
        clientId: row.client_id,
        clientName: row.client_name,
        pickPackTotal: 0,
        additionalTotal: 0,
        pickPackFeeTotal: 0,
        packageTotal: 0,
        shippingTotal: 0,
        missingShippingCostCount: 0,
        storageTotal: 0,
        adjustmentTotal: 0,
        fulfillmentFeeTotal: 0,
        orderCount: 0,
        grandTotal: 0,
        total: 0,
        count: 0,
        byType: {
          pick_pack: 0,
          additional_unit: 0,
          package_cost: 0,
          shipping: 0,
          shipping_missing: 0,
          storage: 0,
          billing_adjustment: 0,
        },
      })),
      grandTotal: 0,
    };
  }

  // v2-parity aggregation. Starts from `clients` with a LEFT JOIN to
  // billing_line_items so every active, non-system client surfaces — even
  // those with zero volume in the window (HUGRAB, KimlyParc, IntegrationTest,
  // the TEST_* sandboxes). The previous version aggregated from
  // billing_line_items alone, dropping zero-volume clients entirely and
  // causing the Summary grid to look half-empty vs. v2.
  //
  // Totals are filtered SUMs per line_type; orderCount counts distinct billed
  // orders from any order-backed line so clients with $0 pick/pack defaults
  // still show order volume when shipping lines were generated.
  const selectedClientIds = requestedClientIds(input);
  const summaryAmount = cancelledNoChargeBillingAmountSql({
    lineType: sql`b.line_type`,
    orderStatus: sql`o.order_status`,
    canonicalStatus: sql`o.canonical_status`,
    totalCost: sql`b.total_cost`,
  });
  const summaryCancelledNoCharge = cancelledNoChargeBillingLinePredicateSql({
    lineType: sql`b.line_type`,
    orderStatus: sql`o.order_status`,
    canonicalStatus: sql`o.canonical_status`,
  });
  const rows = await db.execute<{
    client_id: number;
    client_name: string;
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    adjustment_total: string;
    missing_shipping_cost_count: number;
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      c.id as client_id,
      c.name as client_name,
      coalesce(sum(case when b.line_type = 'pick_pack' then ${summaryAmount} else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type = 'additional_unit' then ${summaryAmount} else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type = 'package_cost' then ${summaryAmount} else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then ${summaryAmount} else 0 end), 0)::text as shipping_total,
      sum(case when b.line_type = 'shipping_missing' and not ${summaryCancelledNoCharge} then 1 else 0 end)::int as missing_shipping_cost_count,
      coalesce(sum(case when b.line_type = 'storage' then ${summaryAmount} else 0 end), 0)::text as storage_total,
      coalesce(sum(case when b.line_type = 'billing_adjustment' then ${summaryAmount} else 0 end), 0)::text as adjustment_total,
      count(distinct b.order_id)::int as order_count,
      coalesce(sum(${summaryAmount}), 0)::text as grand_total
    from clients c
    left join billing_line_items b
      on b.client_id = c.id
      and coalesce(b.billing_effective_date, b.ship_date) >= ${input.dateFrom}::timestamptz
      and coalesce(b.billing_effective_date, b.ship_date) < ${input.dateTo}::timestamptz
    left join orders o on o.id = b.order_id
    where c.active = true
      and c.name not in (${systemClientNamesSql})
      ${selectedClientIds.length ? sql`and c.id = any(${intArraySql(selectedClientIds)})` : sql``}
      and ${billingClientScopePredicate(input)}
    group by c.id, c.name
    order by c.name asc
  `);

  const clientsOut: BillingSummaryRow[] = rows.map((r) => {
    const pickPackTotal = roundMoney(toNum(r.pickpack_total));
    const additionalTotal = roundMoney(toNum(r.additional_total));
    const packageTotal = roundMoney(toNum(r.package_total));
    const shippingTotal = roundMoney(toNum(r.shipping_total));
    const missingShippingCostCount = Number(r.missing_shipping_cost_count ?? 0);
    const storageTotal = roundMoney(toNum(r.storage_total));
    const adjustmentTotal = roundMoney(toNum(r.adjustment_total));
    const grandTotal = roundMoney(toNum(r.grand_total));
    const pickPackFeeTotal = roundMoney(pickPackTotal + additionalTotal);
    const fulfillmentFeeTotal = roundMoney(
      shippingTotal + pickPackFeeTotal + packageTotal + storageTotal,
    );
    return {
      clientId: r.client_id,
      clientName: r.client_name,
      pickPackTotal,
      additionalTotal,
      pickPackFeeTotal,
      packageTotal,
      shippingTotal,
      missingShippingCostCount,
      storageTotal,
      adjustmentTotal,
      fulfillmentFeeTotal,
      orderCount: Number(r.order_count ?? 0),
      grandTotal,
      total: grandTotal,
      count: Number(r.order_count ?? 0),
      byType: {
        pick_pack: pickPackTotal,
        additional_unit: additionalTotal,
        package_cost: packageTotal,
        shipping: shippingTotal,
        shipping_missing: missingShippingCostCount,
        storage: storageTotal,
        billing_adjustment: adjustmentTotal,
      },
    };
  });

  return {
    clients: clientsOut,
    grandTotal: roundMoney(clientsOut.reduce((sum, c) => sum + c.grandTotal, 0)),
  };
}

export async function billingDetails(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);
  // PS-370: verify migration-owned selected-rate schema before reading it.
  await ensureShipmentsSelectedRateCostColumn();
  const rows = await db
    .select({
      id: billingLineItems.id,
      clientId: billingLineItems.clientId,
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      shipmentId: billingLineItems.shipmentId,
      shipDate: billingLineItems.shipDate,
      billingEffectiveDate: billingLineItems.billingEffectiveDate,
      billingPolicyVersion: billingLineItems.billingPolicyVersion,
      lineType: billingLineItems.lineType,
      description: billingLineItems.description,
      qty: billingLineItems.qty,
      unitCost: billingLineItems.unitCost,
      totalCost: billingLineItems.totalCost,
      sourceFinalizationId: billingLineItems.sourceFinalizationId,
      billingAdjustmentId: billingLineItems.billingAdjustmentId,
      overridePackageId: billingLineItems.packageId,
      invoiced: billingLineItems.invoiced,
      createdAt: billingLineItems.createdAt,
      carrierCode: shipments.carrierCode,
      providerAccountId: shipments.providerAccountId,
      labelProvider: shipments.labelProvider,
      trackingNumber: shipments.trackingNumber,
      providerAccountNickname: shipments.providerAccountNickname,
      selectedRateJson: shipments.selectedRateJson,
      selectedPackageId: shipments.selectedPackageId,
      selectedPid: shipments.selectedPid,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      labelCost: shipments.labelCost,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      selectedRateCost: shipments.selectedRateCost, // PS-370
      orderItems: orders.items,
      // PS-376: order status feeds the $0-shipping review reason (cancelled →
      // prep fee may be unwarranted vs a real recorded $0 label).
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      sourceProvider: orders.sourceProvider,
      externallyShipped: orders.externallyShipped,
      externallyFulfilled: sql<boolean>`coalesce(${orders.raw}->>'externallyFulfilled', 'false') = 'true'`,
      externallyFulfilledVerified: orders.externallyFulfilledVerified,
      overrideTrackingNumber: orderOverrides.trackingNumber,
      externallyShippedSource: orderOverrides.externallyShippedSource,
      refUspsRate: orderOverrides.refUspsRate,
      refUpsRate: orderOverrides.refUpsRate,
      // Destination country for the INTERNATIONAL billing badge. `orders` has no
      // country column — it lives only inside raw.shipTo — so read it the same way
      // externallyFulfilled above reads raw. Classification is NOT done here: the
      // canonical owner is classifyDestinationCountry (billing-destination-international).
      destinationCountry: sql<string | null>`nullif(trim(${orders.raw}->'shipTo'->>'country'), '')`,
    })
    .from(billingLineItems)
    .leftJoin(shipments, eq(billingLineItems.shipmentId, shipments.id))
    .leftJoin(orders, eq(billingLineItems.orderId, orders.id))
    .leftJoin(orderOverrides, eq(billingLineItems.orderId, orderOverrides.orderId))
    .where(
      and(
        // PS-208: `to` is the EXCLUSIVE day-after midnight. The canonical
        // range owner emits a strict `<` upper bound, never `<=`.
        billingLineEffectiveDayRangeSql(
          billingLineItems.billingEffectiveDate,
          billingLineItems.shipDate,
          from,
          to,
        ),
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined,
        billingLineItemScopePredicate(input)
      )
    )
    .orderBy(desc(billingPersistedEffectiveDaySql), desc(billingLineItems.id));

  const staleOrderIds = Array.from(
    new Set(
      rows
        .filter((row) => row.shipmentId == null && row.orderId != null)
        .map((row) => row.orderId!)
    )
  );
  const staleOrderNumbers = Array.from(
    new Set(
      rows
        .filter((row) => row.shipmentId == null && row.orderNumber)
        .map((row) => row.orderNumber!)
    )
  );
  const fallbackShipmentWhere =
    staleOrderIds.length && staleOrderNumbers.length
      ? or(
          inArray(shipments.orderId, staleOrderIds),
          inArray(shipments.orderNumber, staleOrderNumbers)
        )
      : staleOrderIds.length
        ? inArray(shipments.orderId, staleOrderIds)
        : staleOrderNumbers.length
          ? inArray(shipments.orderNumber, staleOrderNumbers)
          : undefined;
  const fallbackShipments = fallbackShipmentWhere
    ? await db
        .select({
          id: shipments.id,
          orderId: shipments.orderId,
          orderNumber: shipments.orderNumber,
          carrierCode: shipments.carrierCode,
          providerAccountId: shipments.providerAccountId,
          labelProvider: shipments.labelProvider,
          trackingNumber: shipments.trackingNumber,
          providerAccountNickname: shipments.providerAccountNickname,
          selectedRateJson: shipments.selectedRateJson,
          selectedPackageId: shipments.selectedPackageId,
          selectedPid: shipments.selectedPid,
          dimsL: shipments.dimsL,
          dimsW: shipments.dimsW,
          dimsH: shipments.dimsH,
          labelCost: shipments.labelCost,
          cost: shipments.cost,
          otherCost: shipments.otherCost,
          selectedRateCost: shipments.selectedRateCost, // PS-370
        })
        .from(shipments)
        .where(and(
          eq(shipments.voided, false),
          // Audit B-1: never surface a return label as the order's purchased
          // shipping proof in billingDetails (tracking/cost/selected-rate).
          sql`coalesce(${shipments.isReturn}, false) = false`,
          fallbackShipmentWhere
        ))
        .orderBy(desc(shipments.id))
    : [];
  const fallbackShipmentByOrderId = new Map<number, (typeof fallbackShipments)[number]>();
  const fallbackShipmentByOrderNumber = new Map<string, (typeof fallbackShipments)[number]>();
  for (const shipment of fallbackShipments) {
    if (shipment.orderId != null && !fallbackShipmentByOrderId.has(shipment.orderId)) {
      fallbackShipmentByOrderId.set(shipment.orderId, shipment);
    }
    if (shipment.orderNumber && !fallbackShipmentByOrderNumber.has(shipment.orderNumber)) {
      fallbackShipmentByOrderNumber.set(shipment.orderNumber, shipment);
    }
  }

  const packageRows = await db
    .select({
      id: packages.id,
      name: packages.name,
      packageCode: packages.packageCode,
      length: packages.length,
      width: packages.width,
      height: packages.height,
      source: packages.source,
    })
    .from(packages);
  const packagesById = new Map(packageRows.map((pkg) => [pkg.id, pkg]));
  const packagesByCode = new Map(
    packageRows
      .filter((pkg) => pkg.packageCode)
      .map((pkg) => [pkg.packageCode!, pkg])
  );
  const packagesByDims = new Map(
    packageRows
      .map((pkg) => [dimsKey(pkg.length, pkg.width, pkg.height), pkg] as const)
      .filter((entry): entry is [string, (typeof packageRows)[number]] => Boolean(entry[0]))
  );
  const nicknameCache = new Map<string, Promise<string | null>>();

  // PS-068: per-client latest package-price / billing-config change time, used
  // to flag package_cost detail rows whose stored cost predates the change (so
  // the operator can see "this box price is stale — regenerate" before export).
  const detailClientIds = Array.from(
    new Set(rows.map((row) => row.clientId).filter((id): id is number => id != null))
  );
  const pricingChangedByClient = new Map<number, Date>();
  // PS-372(b): which detail clients have ANY configured box pricing — the same
  // gate decidePackageCostLine uses to suppress box lines, threaded to the
  // box-cost alert so badge and emitter can never disagree.
  const boxPricingByClient = new Map<number, boolean>();
  if (detailClientIds.length) {
    const priceChangeRows = await db.execute<{ client_id: number; changed_at: string | null; has_box_pricing: boolean }>(sql`
      select c.id as client_id,
        greatest(
          coalesce((select max(updated_at) from client_package_prices where client_id = c.id), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from billing_config        where client_id = c.id), 'epoch'::timestamptz)
        )::text as changed_at,
        exists(select 1 from client_package_prices where client_id = c.id) as has_box_pricing
      from clients c
      where c.id = any(${intArraySql(detailClientIds)})
    `);
    for (const row of priceChangeRows) {
      if (row.changed_at) pricingChangedByClient.set(row.client_id, new Date(row.changed_at));
      boxPricingByClient.set(row.client_id, row.has_box_pricing === true);
    }
  }

  // PS-275: load any prep-fee waiver decisions for the orders on screen so the
  // detail rows can show the current state (waived / decided-not / undecided).
  // Default-inert only after the canonical stores verify there are no rows.
  const detailOrderIds = Array.from(
    new Set(rows.map((row) => row.orderId).filter((id): id is number => id != null))
  );
  const feeWaiverByOrderId = await readBillingFeeWaivers(detailOrderIds);
  const manualBillingOverrideByOrderId = await readBillingManualOverrides(detailOrderIds);
  const manuallyResolvedBoxOrderIds = new Set<number>();
  if (detailOrderIds.length) {
    await ensureBillingBoxResolutionsSchema();
    const boxResolutionRows = await db
      .select({
        orderId: billingBoxResolutions.orderId,
        packageId: billingBoxResolutions.packageId,
        overridePrice: billingBoxResolutions.overridePrice,
      })
      .from(billingBoxResolutions)
      .where(inArray(billingBoxResolutions.orderId, detailOrderIds));
    for (const row of boxResolutionRows) {
      if (row.packageId != null || row.overridePrice != null) {
        manuallyResolvedBoxOrderIds.add(row.orderId);
      }
    }
  }

  const detailRows = await Promise.all(
    rows.map(async (row) => {
      const fallbackShipment =
        row.shipmentId == null
          ? (row.orderId != null ? fallbackShipmentByOrderId.get(row.orderId) : undefined) ??
            (row.orderNumber ? fallbackShipmentByOrderNumber.get(row.orderNumber) : undefined) ??
            null
          : null;
      const selectedRate =
        (row.selectedRateJson ?? fallbackShipment?.selectedRateJson) &&
        typeof (row.selectedRateJson ?? fallbackShipment?.selectedRateJson) === 'object'
          ? ((row.selectedRateJson ?? fallbackShipment?.selectedRateJson) as Record<string, unknown>)
          : null;

      const providerAccountId =
        row.providerAccountId ??
        fallbackShipment?.providerAccountId ??
        row.labelProvider ??
        fallbackShipment?.labelProvider ??
        providerAccountIdOrNull(
          selectedRate?.providerAccountId ??
            selectedRate?.shippingProviderId ??
            selectedRate?.carrier_id
        );
      const carrierCode =
        row.carrierCode ??
        fallbackShipment?.carrierCode ??
        stringOrNull(selectedRate?.carrierCode ?? selectedRate?.carrier_code);
      const storedNickname =
        row.providerAccountNickname ??
        fallbackShipment?.providerAccountNickname ??
        stringOrNull(
          selectedRate?.providerAccountNickname ??
            selectedRate?.carrierNickname ??
            selectedRate?.carrier_nickname
        );

      let carrierNickname = storedNickname;
      if (!carrierNickname && carrierCode) {
        const cacheKey = `${providerAccountId ?? 'none'}:${carrierCode}`;
        let pending = nicknameCache.get(cacheKey);
        if (!pending) {
          pending = resolveCarrierNickname(
            providerAccountId ?? null,
            carrierCode,
            row.trackingNumber,
            row.clientId
          );
          nicknameCache.set(cacheKey, pending);
        }
        carrierNickname = await pending;
      }

      const items = itemSummary(row.orderItems);
      const lineType = row.lineType ?? '';
      const rowLifecycle = resolveOrderLifecycleStatus({
        orderStatus: row.orderStatus,
        canonicalStatus: row.canonicalStatus,
        externallyShipped: row.externallyShipped === true,
      });
      const fulfillmentConflict = resolveFulfillmentConflict({
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        orderStatus: row.orderStatus,
        canonicalStatus: row.canonicalStatus,
        effectiveOrderStatus: rowLifecycle.effectiveOrderStatus,
        orderLifecycleStatus: rowLifecycle.orderLifecycleStatus,
        sourceProvider: row.sourceProvider,
        externallyShipped: row.externallyShipped === true,
        externallyFulfilled: row.externallyFulfilled === true,
        externallyFulfilledVerified: row.externallyFulfilledVerified === true,
        externallyShippedSource: row.externallyShippedSource,
        marketplaceTrackingNumber: row.overrideTrackingNumber ?? row.trackingNumber ?? fallbackShipment?.trackingNumber ?? null,
        hasLocalShipment: (row.shipmentId ?? fallbackShipment?.id) != null,
      });
      const detailOrderStatus = rowLifecycle.billingStatus ?? rowLifecycle.effectiveOrderStatus;
      const isCancelledNoChargeDetailRow =
        !fulfillmentConflict &&
        (isCancelledBillingStatus(detailOrderStatus) ||
          isCancelledBillingStatus(rowLifecycle.orderLifecycleStatus));
      const manualBillingOverrideLineTypes = row.orderId != null
        ? [
            ...(manualBillingOverrideByOrderId.get(row.orderId)?.map((override) => override.lineType) ?? []),
            ...(manuallyResolvedBoxOrderIds.has(row.orderId) ? ['package_cost'] : []),
          ]
        : [];
      const manualBillingOverrideLabels = [
        ...new Set(manualBillingOverrideLineTypes.map(manualBillingOverrideLabel)),
      ];
      const hasManualShippingOverride = manualBillingOverrideLineTypes.includes('shipping');
      const isShippingLine = lineType === 'shipping';
      const isMissingShippingLine = lineType === 'shipping_missing';
      // PS-312 S5: a bundle CHILD's "Included — bundled with #N" line is intentionally $0 (shipping is
      // billed ONCE on the primary) — it is NOT a real recorded $0 label, so it must NOT raise the
      // $0-shipping review chip (which would pollute the operator's review queue with a false entry).
      const isBundleIncludedShippingLine =
        isShippingLine && (row.description ?? '').startsWith('Included — bundled');
      // PS-275 + PS-376: a billed shipping line of EXACTLY $0.00 needs operator
      // review; the decision AND its reason are owned by the pure policy module —
      // this only reads them off the billed line. PS-376: the bundle-child's $0
      // "Included" line is now flagged too (reason 'bundled_with_order'), so EVERY
      // $0 shipping row is reviewable — the reason lets the operator tell a
      // cancelled row (prep fee may be unwarranted) from a bundled row (prep fee
      // likely valid) from one with no shipment proof.
      const zeroShippingReview = isShippingLine && !hasManualShippingOverride && !isCancelledNoChargeDetailRow
        ? decideZeroShippingReview({
            shippingAmount: toFiniteNumber(row.totalCost),
            hasShipmentRow: row.shipmentId != null,
            orderStatus: detailOrderStatus,
            isBundledChild: isBundleIncludedShippingLine,
          })
        : { needsReview: false, reason: null, label: '', severity: 'info' as const };
      const isZeroShippingReviewLine = zeroShippingReview.needsReview;
      // PS-207: $0.00 box review line — the shipped box could not be resolved
      // to a known package (or selected box and shipment dims disagree). The
      // FE renders a NEEDS REVIEW chip from these flags; it does no policy
      // math of its own.
      const isBoxReviewLine = !isCancelledNoChargeDetailRow && lineType === 'package_cost_missing';
      const isPackageCostLine = !isCancelledNoChargeDetailRow && lineType === 'package_cost';
      const stalePackagePrice =
        lineType === 'package_cost' &&
        row.createdAt != null &&
        row.clientId != null &&
        (() => {
          const changedAt = pricingChangedByClient.get(row.clientId);
          return changedAt ? new Date(row.createdAt) < changedAt : false;
        })();
      const selectedRateCost = resolveBillingSelectedRateCost({
        // PS-370: prefer the persisted normalized total; the resolver falls back
        // to the component derivation for un-backfilled NULL rows.
        selectedRateCost: row.selectedRateCost ?? fallbackShipment?.selectedRateCost,
        cost: row.cost ?? fallbackShipment?.cost,
        labelCost: row.labelCost ?? fallbackShipment?.labelCost,
        otherCost: row.otherCost ?? fallbackShipment?.otherCost,
        selectedRateJson: row.selectedRateJson ?? fallbackShipment?.selectedRateJson,
      });
      const refUspsRate = toFiniteNumber(row.refUspsRate);
      const refUpsRate = toFiniteNumber(row.refUpsRate);
      const selectedPackageId = row.selectedPackageId ?? fallbackShipment?.selectedPackageId ?? null;
      const selectedPid = row.selectedPid ?? fallbackShipment?.selectedPid ?? null;
      const dimsL = row.dimsL ?? fallbackShipment?.dimsL ?? null;
      const dimsW = row.dimsW ?? fallbackShipment?.dimsW ?? null;
      const dimsH = row.dimsH ?? fallbackShipment?.dimsH ?? null;
      const selectedPackageNumericId = providerAccountIdOrNull(selectedPackageId);
      // PS — a billing-line package override (set via the Edit Billing Detail
      // modal) wins over the shipment-derived package for the box name/dims.
      const overridePackage =
        row.overridePackageId != null ? packagesById.get(row.overridePackageId) : undefined;
      const selectedPackage =
        overridePackage ??
        (selectedPid != null ? packagesById.get(selectedPid) : undefined) ??
        (selectedPackageNumericId != null ? packagesById.get(selectedPackageNumericId) : undefined) ??
        (selectedPackageId ? packagesByCode.get(selectedPackageId) : undefined) ??
        (dimsKey(dimsL, dimsW, dimsH)
          ? packagesByDims.get(dimsKey(dimsL, dimsW, dimsH)!)
          : undefined);
      const packageName =
        selectedPackage?.name ??
        row.description.match(/^Box\s+\((.+)\)$/i)?.[1] ??
        dimsLabel(dimsL, dimsW, dimsH);
      const boxCostNoCharge =
        isPackageCostLine &&
        toFiniteNumber(row.totalCost) === 0 &&
        selectedPackage?.source === NO_CHARGE_BOX_SOURCE;
      const boxCostAlert = resolveBillingBoxCostAlert({
        packageCost: isPackageCostLine ? row.totalCost : null,
        hasPackageCostLine: isPackageCostLine,
        packageCostNeedsReview: isBoxReviewLine,
        isNoChargeBoxCostLine: boxCostNoCharge,
        canAlertMissing: false,
      });
      const feeWaiver = row.orderId != null ? feeWaiverByOrderId.get(row.orderId) ?? null : null;
      const feeWaived = feeWaiver?.decision === 'waived';
      const billingStatus = resolveBillingRowStatus({
        lineType,
        orderStatus: detailOrderStatus,
        orderLifecycleStatus: rowLifecycle.orderLifecycleStatus,
        totalCost: row.totalCost,
        fulfillmentConflictCode: fulfillmentConflict?.code ?? null,
        feeWaived,
        packageCostNeedsReview: isBoxReviewLine,
        shippingZeroNeedsReview: isZeroShippingReviewLine || fulfillmentConflict?.billingAction === 'shipping_missing_review',
        manualBillingOverrideLabels,
      });

      const {
        selectedRateJson: _selectedRateJson,
        labelProvider: _labelProvider,
        orderItems: _orderItems,
        sourceProvider: _sourceProvider,
        externallyFulfilled: _externallyFulfilled,
        externallyFulfilledVerified: _externallyFulfilledVerified,
        externallyShippedSource: _externallyShippedSource,
        overrideTrackingNumber: _overrideTrackingNumber,
        labelCost: _labelCost,
        cost: _cost,
        otherCost: _otherCost,
        selectedPackageId: _selectedPackageId,
        selectedPid: _selectedPid,
        dimsL: _dimsL,
        dimsW: _dimsW,
        dimsH: _dimsH,
        refUspsRate: _refUspsRate,
        refUpsRate: _refUpsRate,
        overridePackageId: _overridePackageId,
        ...rest
      } = row;
      return {
        ...rest,
        actualActivityDate: row.shipDate,
        rolledFromWeekend:
          row.billingPolicyVersion === BILLING_POLICY_WEEKEND_ROLLFORWARD &&
          row.shipDate != null &&
          row.billingEffectiveDate != null &&
          row.shipDate.getTime() !== row.billingEffectiveDate.getTime(),
        orderStatus: detailOrderStatus,
        effectiveOrderStatus: rowLifecycle.effectiveOrderStatus,
        orderLifecycleStatus: rowLifecycle.orderLifecycleStatus,
        orderLifecycleLabel: rowLifecycle.orderLifecycleLabel,
        orderLifecycleReason: rowLifecycle.orderLifecycleReason,
        shipmentId: row.shipmentId ?? fallbackShipment?.id ?? null,
        // PS — the package backing this row's box (override if set, else the
        // shipment-derived package). Lets the Edit modal preselect the box.
        packageId: row.overridePackageId ?? selectedPackage?.id ?? null,
        carrierCode,
        providerAccountId,
        providerAccountNickname: carrierNickname,
        carrierNickname: carrierNickname ?? carrierCode,
        itemNames: items.itemNames,
        itemSkus: items.itemSkus,
        totalQty: items.totalQty,
        packageName,
        // PS-372(b): the emitter's box-pricing gate, carried on the row so the
        // aggregated order row's alert consumes the SAME suppression decision.
        clientHasBoxPricing: row.clientId != null ? boxPricingByClient.get(row.clientId) : undefined,
        // PS-368: the detail-row boundary is camelCase-only (BillingDetailRowDto);
        // the snake_case mirrors this block used to write are deleted.
        selectedRateCost: isShippingLine && !isCancelledNoChargeDetailRow ? selectedRateCost : null,
        shippingCostMissing:
          (isMissingShippingLine || fulfillmentConflict?.billingAction === 'shipping_missing_review') &&
          !isCancelledNoChargeDetailRow,
        fulfillmentConflictCode: fulfillmentConflict?.code ?? null,
        fulfillmentConflictLabel: fulfillmentConflict?.label ?? null,
        fulfillmentConflictReason: fulfillmentConflict?.reason ?? null,
        // PS-207: box-review flag + the generator's reason text (the review
        // line's description, e.g. "Box mismatch — selected box (12x10x3)
        // disagrees with shipment dims (12x10x1)").
        packageCostNeedsReview: isBoxReviewLine,
        packageCostReviewReason: isBoxReviewLine ? row.description : null,
        hasPackageCostLine: isPackageCostLine,
        boxCostNoCharge,
        boxCostAlert: boxCostAlert.boxCostAlert,
        billingBadges: boxCostAlert.billingBadges,
        manualBillingOverrideLineTypes,
        manualBillingOverrideLabels,
        refUspsRate: isShippingLine && !isCancelledNoChargeDetailRow ? refUspsRate : null,
        refUpsRate: isShippingLine && !isCancelledNoChargeDetailRow ? refUpsRate : null,
        // PS-068: true when this box charge was generated BEFORE the client's
        // latest package-price/config change — the stored cost may be stale and
        // the range should be regenerated. Only meaningful for box lines.
        stalePackagePrice,
        // PS-275: a billed shipping line of EXACTLY $0.00 — the FE shows a
        // "Review $0 shipping" affordance from this flag (it does NO policy math
        // of its own; the decision is owned by decideZeroShippingReview).
        shippingZeroNeedsReview: isZeroShippingReviewLine,
        // PS-376: WHY the $0-shipping row needs review + a thin-UI label/severity
        // (the FE renders these verbatim; it does no classification of its own).
        zeroShippingReviewReason: zeroShippingReview.reason,
        zeroShippingReviewLabel: zeroShippingReview.label,
        zeroShippingReviewSeverity: zeroShippingReview.severity,
        // Per user override unlock shipped data on 2026-07-06: PS-393 adds
        // read-only billing status fields for cancelled no-charge and return rows.
        ...billingStatus,
        // PS-275: the order's prep-fee waiver decision (durable, reversible).
        // null = undecided; the FE badges "Prep fee waived" when true.
        feeWaived,
        feeWaiverDecision: feeWaiver?.decision ?? null,
      };
    })
  );

  return toBillingDetailOrderRows(detailRows);
}

export async function upsertBillingConfig(
  clientId: number,
  patch: Partial<{
    pickPackFee: string;
    pickPackMaxUnits: number;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    storageFeePerCuFt: string;
    billingMode: string;
    active: boolean;
  }>
) {
  const [row] = await db
    .insert(billingConfig)
    .values({ clientId, ...patch })
    .onConflictDoUpdate({
      target: billingConfig.clientId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return row;
}
