import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
import { db } from '../db/client';
import {
  billingBoxResolutions,
  billingConfig,
  billingLineItems,
  clientPackagePrices,
} from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import { orderOverrides, orders } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { clients } from '../db/schema/clients';
import { orderCompetitiveRate } from '../db/schema/order-competitive-rate';
import { ensureOrderCompetitiveRateSchema } from '../db/ensure-order-competitive-rate';
import { decideShippingLineBilling } from './billing-shipping-line';
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
import { SS_BASELINE_CARRIER_CODES, loadCarrierMarkups } from './rates';
import {
  boxDimsKey,
  decidePackageCostLine,
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
// (pure policy) and the durable, reversible waiver state (runtime-DDL store).
import {
  applyPrepFeeWaiver,
  decideZeroShippingReview,
} from './billing-shipping-policy';
import {
  ensureBillingFeeWaiverSchema,
  readBillingFeeWaivers,
} from './billing-fee-waiver-store';
import { getBundlesForOrders } from './shipment-bundles/bundle-read-model';
import { decideBundleBillingTreatment } from './shipment-bundles/bundle-billing-policy';
import { env } from '../lib/env';
import { toBillingDetailOrderRows } from './billing-detail-row-sot';

// PS-132: synthetic/system clients excluded from billing summaries/details — single source.
// Parameterized SQL fragment (same semantics as the prior inline literal list).
const systemClientNamesSql = sql.join(
  SYSTEM_CLIENT_NAMES.map((name) => sql`${name}`),
  sql`, `,
);

export type GenerateInput = {
  clientId?: number;
  clientIds?: number[];
  // PS-208: UTC-midnight calendar-day bounds from billingDayRange (the
  // canonical owner, src/lib/time/billing-day.ts). dateFrom is INCLUSIVE
  // (midnight of the first day); dateTo is EXCLUSIVE (midnight of the day
  // AFTER the last day). Every ship_date comparison in this file must be
  // `>= dateFrom AND < dateTo` — never `<=`.
  dateFrom: string; // ISO, UTC midnight, inclusive
  dateTo: string; // ISO, UTC midnight, EXCLUSIVE
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeIsGlobal?: boolean;
  scopeRestricted?: boolean;
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
      row.grandTotal > 0
  );
}

// PS-208: a billing ship date is a CALENDAR DAY (canonical owner:
// src/lib/time/billing-day.ts). The raw sources can carry a time-of-day
// (shipments.ship_date is a real instant; raw fulfilledAt/shippedAt are
// marketplace timestamps), so normalize to UTC midnight of the UTC day HERE —
// every billing_line_items.ship_date written by generateLineItems then lands
// exactly on the storage invariant, and the day-range bounds
// (>= dateFrom AND < dateTo) are exact day membership. No timezone other than
// UTC may ever touch this value.
const billingShipDateSql = sql<Date | null>`date_trunc('day', coalesce(
  ${shipments.shipDate},
  case
    when coalesce(${orders.raw}->>'fulfilledAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
      then (${orders.raw}->>'fulfilledAt')::timestamptz
    else null
  end,
  case
    when coalesce(${orders.raw}->>'shipDate', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
      then (${orders.raw}->>'shipDate')::timestamptz
    else null
  end,
  case
    when coalesce(${orders.raw}->>'shippedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
      then (${orders.raw}->>'shippedAt')::timestamptz
    else null
  end,
  ${orders.orderDate}
) at time zone 'UTC') at time zone 'UTC'`;

// ── PS-207 runtime schema ensure (mirrors drizzle/0043_billing_box_resolutions.sql;
// same pattern as shipment-tracking.ts so API/worker both work pre-migration). ──
let boxResolutionsEnsured: Promise<void> | null = null;

export async function ensureBillingBoxResolutionsSchema(): Promise<void> {
  boxResolutionsEnsured ??= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS billing_box_resolutions (
        id serial PRIMARY KEY,
        order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        shipment_id integer REFERENCES shipments(id),
        package_id integer REFERENCES packages(id),
        override_price numeric(10, 2),
        note text,
        resolved_by text,
        resolved_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_box_resolutions_order_unq UNIQUE (order_id)
      )
    `);
    await db.execute(sql`ALTER TABLE billing_box_resolutions ENABLE ROW LEVEL SECURITY`);
  })().catch((err) => {
    boxResolutionsEnsured = null;
    throw err;
  });
  return boxResolutionsEnsured;
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

function billingLineItemScopePredicate(input: GenerateInput): SQL {
  if (input.scopeIsGlobal === true) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);

  if (clientIds.length) {
    predicates.push(sql`${billingLineItems.clientId} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = ${billingLineItems.clientId}
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

export async function billingGenerationStatus(
  input: GenerateInput
): Promise<BillingGenerationStatus> {
  const fromIso = new Date(input.dateFrom).toISOString();
  const toIso = new Date(input.dateTo).toISOString();

  const [billingRow] = await db.execute<{
    latest_billing_ship_date: string | null;
  }>(sql`
    select max(b.ship_date)::text as latest_billing_ship_date
    from billing_line_items b
    where b.ship_date >= ${fromIso}::timestamptz
      and b.ship_date < ${toIso}::timestamptz
      and b.order_id is not null
      ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
      and ${billingLineItemScopePredicate(input)}
  `);

  const latestBilling = billingRow?.latest_billing_ship_date
    ? new Date(billingRow.latest_billing_ship_date)
    : null;

  // Re-price detection (PER CLIENT): a range is stale when ANY scoped client
  // that already has billing in the range had a package-price or billing-config
  // change AFTER that client's newest billing line was generated — even when no
  // new orders shipped. Computed per-client (not by comparing two GLOBAL maxima)
  // so the all-clients "Update Billing" path cannot mask one client's stale
  // price behind another client's later (re)bill. The underlying rule is
  // billingNeedsRepriceForPriceChange (unit-tested in
  // scripts/ps-billing-reprice-staleness-guard.ts).
  const [staleRow] = await db.execute<{ pricing_stale: boolean }>(sql`
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
            and b.ship_date >= ${fromIso}::timestamptz
            and b.ship_date < ${toIso}::timestamptz
        )
        and greatest(
          coalesce((select max(updated_at) from client_package_prices where client_id = c.id), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from billing_config        where client_id = c.id), 'epoch'::timestamptz)
        ) > (
          select max(b.created_at) from billing_line_items b
          where b.client_id = c.id
            and b.ship_date >= ${fromIso}::timestamptz
            and b.ship_date < ${toIso}::timestamptz
        )
    ) as pricing_stale
  `);
  const pricingStale = staleRow?.pricing_stale === true;

  let feeWaiverStale = false;
  try {
    await ensureBillingFeeWaiverSchema();
    const [feeWaiverRow] = await db.execute<{ fee_waiver_stale: boolean }>(sql`
      select exists (
        select 1
        from billing_fee_waivers fw
        inner join billing_line_items b on b.order_id = fw.order_id
        inner join clients c on c.id = b.client_id
        where b.ship_date >= ${fromIso}::timestamptz
          and b.ship_date < ${toIso}::timestamptz
          and b.order_id is not null
          and c.active = true
          and c.name not in (${systemClientNamesSql})
          ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
          and ${billingClientScopePredicate(input)}
          and fw.updated_at > (
            select max(b.created_at)
            from billing_line_items b
            where b.order_id = fw.order_id
              and b.ship_date >= ${fromIso}::timestamptz
              and b.ship_date < ${toIso}::timestamptz
              ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
          )
      ) as fee_waiver_stale
    `);
    feeWaiverStale = feeWaiverRow?.fee_waiver_stale === true;
  } catch (err) {
    console.warn(
      '[billing] fee-waiver freshness check skipped:',
      err instanceof Error ? err.message : err,
    );
    feeWaiverStale = true;
  }

  const sourceLowerBound = latestBilling?.toISOString() ?? fromIso;
  const [sourceRow] = await db.execute<{
    latest_source_ship_date: string | null;
  }>(sql`
    with scoped_clients as (
      select c.id, c.store_ids
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
    where o.order_status = 'shipped'
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
        where o.client_id = sc.id
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
  `);

  const latestSource = sourceRow?.latest_source_ship_date
    ? new Date(sourceRow.latest_source_ship_date)
    : null;

  const from = new Date(fromIso);

  if (!latestSource) {
    // No new shipments to bill. Still rebuild if prices changed after the
    // existing lines were generated, so a box-price edit re-prices them.
    if (pricingStale || feeWaiverStale) {
      return {
        upToDate: false,
        dateFrom: fromIso,
        dateTo: toIso,
        clientId: input.clientId,
        latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
        latestSourceShipDate: billingRow?.latest_billing_ship_date ?? null,
        missingFrom: isoDayStart(from),
        missingTo: isoDayEnd(latestBilling ?? new Date(toIso)),
      };
    }
    return {
      upToDate: true,
      dateFrom: fromIso,
      dateTo: toIso,
      clientId: input.clientId,
      latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
      latestSourceShipDate: billingRow?.latest_billing_ship_date ?? null,
      missingFrom: null,
      missingTo: null,
    };
  }

  const latestBillingDay = latestBilling ? isoDayStart(latestBilling) : null;
  const latestSourceDay = isoDayStart(latestSource);
  // A price/config change requires rebuilding the WHOLE range (to re-price the
  // existing lines), not just the missing tail after the last billed day.
  const missingFrom =
    pricingStale || feeWaiverStale || !latestBilling
      ? isoDayStart(from)
      : latestBillingDay === latestSourceDay
        ? latestBillingDay
        : isoDayStart(addUtcDays(latestBilling, 1));

  return {
    upToDate: false,
    dateFrom: fromIso,
    dateTo: toIso,
    clientId: input.clientId,
    latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
    latestSourceShipDate: sourceRow?.latest_source_ship_date ?? null,
    missingFrom,
    missingTo: isoDayEnd(latestSource),
  };
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

  // Match /billing/config: active clients without a billing_config row still
  // generate with defaults, otherwise a fresh install has visible clients but
  // "Generate Invoices" finds no configs and produces an empty summary.
  const configs = await db.execute<{
    clientId: number;
    pickPackFee: string;
    pickPackMaxUnits: number;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    storageFeePerCuFt: string;
    billingMode: string;
    active: boolean;
  }>(sql`
    select
      c.id as "clientId",
      coalesce(b.pick_pack_fee, '0'::numeric)::text as "pickPackFee",
      coalesce(b.pick_pack_max_units, 1)::int as "pickPackMaxUnits",
      coalesce(b.additional_unit_fee, '0'::numeric)::text as "additionalUnitFee",
      coalesce(b.package_cost_markup, '0'::numeric)::text as "packageCostMarkup",
      coalesce(b.shipping_markup_pct, '0'::numeric)::text as "shippingMarkupPct",
      coalesce(b.shipping_markup_flat, '0'::numeric)::text as "shippingMarkupFlat",
      coalesce(b.storage_fee_per_cu_ft, '0'::numeric)::text as "storageFeePerCuFt",
      coalesce(b.billing_mode, 'per_shipment') as "billingMode",
      coalesce(b.active, true) as active
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

  const clientRows = await db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
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
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderClientId: orders.clientId,
      orderDate: orders.orderDate,
      billingShipDate: billingShipDateSql,
      orderStoreId: orders.storeId,
      orderItems: orders.items,
      orderRaw: orders.raw,
      externallyShipped: orders.externallyShipped,
      externallyFulfilled: sql<boolean>`coalesce(${orders.raw}->>'externallyFulfilled', 'false') = 'true'`,
    })
    .from(orders)
    .leftJoin(
      shipments,
      and(eq(shipments.orderId, orders.id), eq(shipments.voided, false))
    )
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        eq(orders.orderStatus, 'shipped'),
        sql`${billingShipDateSql} >= ${fromIso}::timestamptz`,
        sql`${billingShipDateSql} < ${toIso}::timestamptz`
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
    labelCost: string | null;
    cost: string | null;
    otherCost: string | null;
    carrierCode: string | null;
    providerAccountId: number | null;
    selectedPid: number | null;
    selectedPackageId: string | null;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
    refUspsRate: string | null;
    refUpsRate: string | null;
    items: unknown[];
    externallyShipped: boolean;
    externallyFulfilled: boolean;
  };

  const billableRows: BillableRow[] = orderShipmentRows
    .map((row) => {
      const storeId = rawStoreId(row.orderRaw ?? {}, row.orderStoreId ?? null);
      const clientId =
        (storeId !== null ? clientByStore.get(storeId) ?? null : null) ??
        row.orderClientId ??
        row.shipmentClientId ??
        null;
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
        labelCost: row.labelCost,
        cost: row.cost,
        otherCost: row.otherCost,
        carrierCode: row.carrierCode,
        providerAccountId: row.providerAccountId,
        selectedPid: row.selectedPid,
        selectedPackageId: row.selectedPackageId,
        dimsL: row.dimsL,
        dimsW: row.dimsW,
        dimsH: row.dimsH,
        refUspsRate: row.refUspsRate,
        refUpsRate: row.refUpsRate,
        items: Array.isArray(row.orderItems) ? row.orderItems : [],
        externallyShipped: row.externallyShipped === true,
        externallyFulfilled: row.externallyFulfilled === true,
      };
    })
    .filter(
      (row) =>
        row.shipDate !== null &&
        (input.clientId === undefined || row.clientId === input.clientId)
    );

  if (!billableRows.length) {
    return {
      generated: 0,
      count: 0,
      total: 0,
      skipped: 0,
      message: 'No billable shipped orders or shipments found for this range.',
    };
  }

  // Rebuild the requested billing period only after we know the source query
  // has billable rows. That protects existing summaries if a transient query
  // problem happens during generation.
  await db.delete(billingLineItems).where(
    and(
      sql`${billingLineItems.shipDate} >= ${fromIso}::timestamptz`,
      // PS-208: STRICT upper bound. dateTo is the EXCLUSIVE day-after
      // midnight — `<=` here would delete the first day of the NEXT period's
      // lines on every regenerate.
      sql`${billingLineItems.shipDate} < ${toIso}::timestamptz`,
      input.clientId !== undefined
        ? eq(billingLineItems.clientId, input.clientId)
        : undefined,
      billingLineItemScopePredicate(input)
    )
  );

  // ─── B2 pre-fetch: packages + per-client package prices ──────────────────
  // PS-207: the billed box comes from the SHIPMENT'S RECORDED BOX ONLY,
  // resolved by the pure policy module (billing-box-policy.ts — operator
  // directive → selected pid/code → exact dims; mismatch/unresolved → review
  // line). The pre-PS-207 fallbacks are deliberately GONE and must not come
  // back: SKU/inventory package defaults, rounded-dims matching, and
  // rate-dims resolution all billed boxes the parcel never shipped in
  // (HKP audit: SP6754 billed a 12x10x3 it never used; SP6755/6759 billed
  // $0.00 off an unpriced SKU-default box).
  const allPackages = await db
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
  await ensureBillingBoxResolutionsSchema();
  const resolutionRows = await db.select().from(billingBoxResolutions);
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
  // ACTIVATION CAVEAT: the regenerate DELETE above is date-windowed and does NOT honor billing_line_
  // items.invoiced, so flipping this ON then regenerating an already-invoiced PAST period retroactively
  // applies the markup — flip ON, then only generate/regenerate go-forward periods.
  const perAccountMarkups =
    process.env.BILLING_PER_ACCOUNT_MARKUP === 'on' ? await loadCarrierMarkups() : null;

  let generated = 0;
  let skipped = 0;
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

  // PS-220 (billing branch): for opted-in SHIPP house orders, bill the captured customer_rate
  // (cheapest eligible non-SHIPP) instead of the SHIPP drp_cost, and suppress the carrier markup —
  // the margin IS the spread. Best-effort bulk load keyed by shipment id; empty when the sidecar is
  // absent or no house orders exist (then billing is byte-identical to today). Reads only.
  const houseCustomerRateByShipmentId = new Map<number, number>();
  try {
    const houseShipmentIds = [
      ...new Set(billableRows.map((r) => r.id).filter((id): id is number => typeof id === 'number')),
    ];
    if (houseShipmentIds.length) {
      await ensureOrderCompetitiveRateSchema();
      const houseRows = await db
        .select({ shipmentId: orderCompetitiveRate.shipmentId, customerRate: orderCompetitiveRate.customerRate })
        .from(orderCompetitiveRate)
        .where(and(eq(orderCompetitiveRate.isHouseOrder, true), inArray(orderCompetitiveRate.shipmentId, houseShipmentIds)));
      for (const hr of houseRows) {
        if (hr.shipmentId != null) houseCustomerRateByShipmentId.set(Number(hr.shipmentId), Number(hr.customerRate));
      }
    }
  } catch {
    /* best-effort: sidecar absent or unreadable -> no house billing (today's behavior) */
  }

  // PS-275: prep-fee waivers (operator's $0-shipping review decisions). Durable,
  // reversible, default-inert: with NO waiver row the map is empty and billing is
  // byte-identical to today. Read once for every order in scope; the per-order
  // loop zeroes ONLY prep/fulfillment/pick-pack fee lines when an order is waived
  // (never product/marketplace/box/storage/shipping). Best-effort — the store
  // already returns an empty Map on any error and never throws.
  const orderIdsInScope = [
    ...new Set(billableRows.map((r) => r.orderId).filter((id): id is number => typeof id === 'number')),
  ];
  const feeWaiverByOrderId = await readBillingFeeWaivers(orderIdsInScope);
  // PS-312 S5 bill-once (Per user override unlock shipped data on 2026-06-24): load the bundle
  // membership for the in-scope orders (mirrors feeWaiverByOrderId). OFF -> the map is never loaded ->
  // every order bills normally -> byte-identical. Reads the additive bundle read-model only.
  const bundleByOrderId: Awaited<ReturnType<typeof getBundlesForOrders>> = env.BUNDLE_BILL_ONCE
    ? await getBundlesForOrders(orderIdsInScope)
    : new Map();

  for (const s of billableRows) {
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
        unitCost: pickPackFee.toFixed(2),
        totalCost: pickPackFee.toFixed(2),
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
        unitCost: additionalUnitFee.toFixed(2),
        totalCost: extraCost.toFixed(2),
        packageId: billedPackageId,
      });
    }

    // v2 bills shipmentCost + otherCost from the synced shipment row. In v4
    // that source column is `cost`; `labelCost` is only a fallback for rows
    // created before the synced cost was available.
    const labelCost = (toNum(s.cost) || toNum(s.labelCost)) + toNum(s.otherCost);
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
      const houseCustomerRate = s.id != null ? houseCustomerRateByShipmentId.get(Number(s.id)) : undefined;
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
      const shippingDecision = decideShippingLineBilling({
        labelCost,
        houseCustomerRate,
        billingMode: cfg.billingMode,
        isBaselineCarrier: SS_BASELINE_CARRIER_CODES.has(s.carrierCode ?? ''),
        refUspsRate: toNum(s.refUspsRate),
        refUpsRate: toNum(s.refUpsRate),
        shippingMarkupPct: resolvedShippingMarkup?.pct ?? 0,
        shippingMarkupFlat: resolvedShippingMarkup?.flat ?? 0,
      });
      rows.push({
        clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping',
        description: `Shipping${shippingDecision.descriptionSuffix} · order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: shippingDecision.billedAmount.toFixed(2),
        totalCost: shippingDecision.billedAmount.toFixed(2),
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
      configuredPrice:
        boxResolution.status === 'resolved' && boxResolution.packageId != null
          ? clientPrices?.get(boxResolution.packageId)
          : undefined,
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
        unitCost: packageCostDecision.amount.toFixed(2),
        totalCost: packageCostDecision.amount.toFixed(2),
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
    const effectiveRows = applyPrepFeeWaiver(rows, waived);

    // Collect for batch insert instead of inserting one at a time.
    for (const row of effectiveRows) {
      allRows.push(row);
      total += toNum(row.totalCost);
    }
  }

  // Batch INSERT in chunks of 500 with ON CONFLICT DO NOTHING. The unique
  // constraint (order_id, line_type, description) still guards against
  // duplicates, so re-running the generate is idempotent.
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    try {
      await db
        .insert(billingLineItems)
        .values(chunk)
        .onConflictDoNothing({
          target: [
            billingLineItems.orderId,
            billingLineItems.lineType,
            billingLineItems.description,
          ],
        });
      generated += chunk.length;
    } catch (chunkErr) {
      // Fall back to per-row to isolate which row poisoned the chunk.
      console.warn(
        '[billing] chunk insert failed, retrying per-row:',
        chunkErr instanceof Error ? chunkErr.message : chunkErr
      );
      for (const row of chunk) {
        try {
          await db
            .insert(billingLineItems)
            .values(row)
            .onConflictDoNothing({
              target: [
                billingLineItems.orderId,
                billingLineItems.lineType,
                billingLineItems.description,
              ],
            });
          generated += 1;
        } catch (rowErr) {
          // Never swallow billing insert failures silently — a swallowed error
          // here once wiped a client's billing and rebuilt nothing.
          console.error(
            '[billing] line item insert skipped',
            {
              clientId: row.clientId,
              orderId: row.orderId,
              lineType: row.lineType,
              description: row.description,
            },
            rowErr instanceof Error ? rowErr.message : rowErr
          );
          skipped += 1;
        }
      }
    }
  }

  // ─── Storage fees (once per client per billing period) ──────────────────────
  // v2 charged storage per cuft/month on current inventory on hand. v4
  // approximates: for each client with storageFeePerCuFt > 0, compute
  // SUM(stock_qty × cuFt_per_unit) × feeRate, emitted as one line item
  // dated at the period's end.
  const periodEnd = new Date(input.dateTo);
  for (const [clientId, cfg] of configByClient.entries()) {
    const storageRate = toNum(cfg.storageFeePerCuFt ?? 0);
    if (storageRate <= 0) continue;
    if (cfg.active === false) continue;

    const invRows = await db.execute<{
      total_cuft: string | number | null;
    }>(sql`
      select
        coalesce(sum(
          case
            when coalesce(cu_ft_override, 0) > 0 then stock_qty * cu_ft_override
            when length > 0 and width > 0 and height > 0
              then stock_qty * ((length * width * height) / 1728.0)
            else 0
          end
        ), 0)::numeric(14,4) as total_cuft
      from inventory
      where client_id = ${clientId}
        and active = true
        and stock_qty > 0
    `);
    const totalCuFt = Number(invRows[0]?.total_cuft ?? 0);
    if (totalCuFt <= 0) continue;
    const fee = totalCuFt * storageRate;
    if (fee <= 0) continue;

    try {
      await db
        .insert(billingLineItems)
        .values({
          clientId,
          orderId: null,
          orderNumber: null,
          shipmentId: null,
          shipDate: periodEnd,
          lineType: 'storage',
          description: `Storage — ${totalCuFt.toFixed(2)} cuft × $${storageRate.toFixed(4)}/cuft`,
          qty: totalCuFt.toFixed(2),
          unitCost: storageRate.toFixed(4),
          totalCost: fee.toFixed(2),
        })
        .onConflictDoNothing({
          target: [
            billingLineItems.orderId,
            billingLineItems.lineType,
            billingLineItems.description,
          ],
        });
      generated += 1;
      total += fee;
    } catch {
      skipped += 1;
    }
  }

  let billingSummaryMetricsRows: number | null = null;
  try {
    billingSummaryMetricsRows = await refreshBillingSummaryMetrics(
      new Date(input.dateFrom),
      new Date(input.dateTo)
    );
  } catch (err) {
    console.warn(
      '[billing] generated line items but failed to refresh summary metrics:',
      err instanceof Error ? err.message : err
    );
  }

  return {
    generated,
    count: generated,
    total,
    skipped,
    billingSummaryMetricsRows,
    message: `Generated ${generated} line items from ${billableRows.length} billable shipments/orders.`,
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
      where ship_date >= ${input.dateFrom}::timestamptz
        and ship_date < ${input.dateTo}::timestamptz
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
    console.warn(
      '[billing] summary reporting metrics unavailable:',
      err instanceof Error ? err.message : err
    );
    return null;
  });
  if (metrics && billingSummaryHasValues(metrics)) return metrics;

  if (metrics && !(await hasLineItems())) return metrics;

  if (!metrics || !billingSummaryHasValues(metrics)) {
    if (await hasLineItems()) {
      try {
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
        console.warn(
          '[billing] failed to refresh stale summary metrics:',
          err instanceof Error ? err.message : err
        );
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
  const rows = await db.execute<{
    client_id: number;
    client_name: string;
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    missing_shipping_cost_count: number;
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      c.id as client_id,
      c.name as client_name,
      coalesce(sum(case when b.line_type = 'pick_pack' then b.total_cost else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type = 'additional_unit' then b.total_cost else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type = 'package_cost' then b.total_cost else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_total,
      sum(case when b.line_type = 'shipping_missing' then 1 else 0 end)::int as missing_shipping_cost_count,
      coalesce(sum(case when b.line_type = 'storage' then b.total_cost else 0 end), 0)::text as storage_total,
      count(distinct b.order_id)::int as order_count,
      coalesce(sum(b.total_cost), 0)::text as grand_total
    from clients c
    left join billing_line_items b
      on b.client_id = c.id
      and b.ship_date >= ${input.dateFrom}::timestamptz
      and b.ship_date < ${input.dateTo}::timestamptz
    where c.active = true
      and c.name not in (${systemClientNamesSql})
      ${selectedClientIds.length ? sql`and c.id = any(${intArraySql(selectedClientIds)})` : sql``}
      and ${billingClientScopePredicate(input)}
    group by c.id, c.name
    order by c.name asc
  `);

  const clientsOut: BillingSummaryRow[] = rows.map((r) => {
    const pickPackTotal = toNum(r.pickpack_total);
    const additionalTotal = toNum(r.additional_total);
    const packageTotal = toNum(r.package_total);
    const shippingTotal = toNum(r.shipping_total);
    const missingShippingCostCount = Number(r.missing_shipping_cost_count ?? 0);
    const storageTotal = toNum(r.storage_total);
    const grandTotal = toNum(r.grand_total);
    const pickPackFeeTotal = pickPackTotal + additionalTotal;
    const fulfillmentFeeTotal =
      shippingTotal + pickPackFeeTotal + packageTotal + storageTotal;
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
      },
    };
  });

  return {
    clients: clientsOut,
    grandTotal: clientsOut.reduce((sum, c) => sum + c.grandTotal, 0),
  };
}

export type BillingInvoiceHeaderTotals = {
  orderCount: number;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  grandTotal: number;
  fulfillmentFeeTotal: number;
};

// PS-134 (slice 2): canonical owner of the per-client INVOICE header totals, co-located with
// billingSummary in the billing service (one source of truth). Runs the invoice's EXACT aggregate
// VERBATIM — client_id-only scope, full ::timestamptz window, the legacy alias IN-lists — so the
// /invoice route delegates byte-identically. Intentionally NOT billingSummary(): that path filters
// out inactive/system clients, uses single-canonical line_types, and reads a day-keyed cache, all
// of which would CHANGE customer invoices. This sibling preserves the invoice's exact semantics.
export async function billingInvoiceHeaderTotals(
  clientId: number,
  dateFrom: string,
  dateTo: string,
): Promise<BillingInvoiceHeaderTotals> {
  const summaryRow = await db.execute<{
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      coalesce(sum(case when line_type in ('pick_pack', 'pickpack') then total_cost else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when line_type in ('additional_unit', 'additional') then total_cost else 0 end), 0)::text as additional_total,
      coalesce(sum(case when line_type in ('package_cost', 'package') then total_cost else 0 end), 0)::text as package_total,
      coalesce(sum(case when line_type = 'shipping' then total_cost else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when line_type = 'storage' then total_cost else 0 end), 0)::text as storage_total,
      count(distinct order_id)::int as order_count,
      coalesce(sum(total_cost), 0)::text as grand_total
    from billing_line_items
    where client_id = ${clientId}
      and ship_date >= ${dateFrom}::timestamptz
      and ship_date < ${dateTo}::timestamptz
  `);
  const s = summaryRow[0];

  const orderCount = s?.order_count ?? 0;
  const pickPackTotal = Number(s?.pickpack_total ?? 0);
  const additionalTotal = Number(s?.additional_total ?? 0);
  const pickPackFeeTotal = pickPackTotal + additionalTotal;
  const packageTotal = Number(s?.package_total ?? 0);
  const shippingTotal = Number(s?.shipping_total ?? 0);
  const storageTotal = Number(s?.storage_total ?? 0);
  const grandTotal = Number(s?.grand_total ?? 0);
  const fulfillmentFeeTotal =
    shippingTotal + pickPackFeeTotal + packageTotal + storageTotal;

  return {
    orderCount,
    pickPackTotal,
    additionalTotal,
    pickPackFeeTotal,
    packageTotal,
    shippingTotal,
    storageTotal,
    grandTotal,
    fulfillmentFeeTotal,
  };
}

export async function billingDetails(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);
  const rows = await db
    .select({
      id: billingLineItems.id,
      clientId: billingLineItems.clientId,
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      shipmentId: billingLineItems.shipmentId,
      shipDate: billingLineItems.shipDate,
      lineType: billingLineItems.lineType,
      description: billingLineItems.description,
      qty: billingLineItems.qty,
      unitCost: billingLineItems.unitCost,
      totalCost: billingLineItems.totalCost,
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
      orderItems: orders.items,
      refUspsRate: orderOverrides.refUspsRate,
      refUpsRate: orderOverrides.refUpsRate,
    })
    .from(billingLineItems)
    .leftJoin(shipments, eq(billingLineItems.shipmentId, shipments.id))
    .leftJoin(orders, eq(billingLineItems.orderId, orders.id))
    .leftJoin(orderOverrides, eq(billingLineItems.orderId, orderOverrides.orderId))
    .where(
      and(
        gte(billingLineItems.shipDate, from),
        // PS-208: `to` is the EXCLUSIVE day-after midnight — lt, never lte
        // (the drizzle form the literal `<=` sweep missed).
        lt(billingLineItems.shipDate, to),
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined,
        billingLineItemScopePredicate(input)
      )
    )
    .orderBy(desc(billingLineItems.shipDate), desc(billingLineItems.id));

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
        })
        .from(shipments)
        .where(and(eq(shipments.voided, false), fallbackShipmentWhere))
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
  if (detailClientIds.length) {
    const priceChangeRows = await db.execute<{ client_id: number; changed_at: string | null }>(sql`
      select c.id as client_id,
        greatest(
          coalesce((select max(updated_at) from client_package_prices where client_id = c.id), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from billing_config        where client_id = c.id), 'epoch'::timestamptz)
        )::text as changed_at
      from clients c
      where c.id = any(${intArraySql(detailClientIds)})
    `);
    for (const row of priceChangeRows) {
      if (row.changed_at) pricingChangedByClient.set(row.client_id, new Date(row.changed_at));
    }
  }

  // PS-275: load any prep-fee waiver decisions for the orders on screen so the
  // detail rows can show the current state (waived / decided-not / undecided).
  // Default-inert: the store returns an empty Map when there are no rows or on
  // any error, so this leaves today's detail payload unchanged.
  const detailOrderIds = Array.from(
    new Set(rows.map((row) => row.orderId).filter((id): id is number => id != null))
  );
  const feeWaiverByOrderId = await readBillingFeeWaivers(detailOrderIds);

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
      const isShippingLine = lineType === 'shipping';
      const isMissingShippingLine = lineType === 'shipping_missing';
      // PS-312 S5: a bundle CHILD's "Included — bundled with #N" line is intentionally $0 (shipping is
      // billed ONCE on the primary) — it is NOT a real recorded $0 label, so it must NOT raise the
      // $0-shipping review chip (which would pollute the operator's review queue with a false entry).
      const isBundleIncludedShippingLine =
        isShippingLine && (row.description ?? '').startsWith('Included — bundled');
      // PS-275: a billed shipping line of EXACTLY $0.00 needs operator review
      // (a real recorded $0 label — distinct from the missing-cost review,
      // which fires when the cost is unknown). The decision is owned by the
      // pure policy module; this just reads its boolean off the billed line.
      const isZeroShippingReviewLine =
        isShippingLine &&
        !isBundleIncludedShippingLine &&
        decideZeroShippingReview({
          shippingAmount: toFiniteNumber(row.totalCost),
          hasShipmentRow: row.shipmentId != null,
        }).needsReview;
      // PS-207: $0.00 box review line — the shipped box could not be resolved
      // to a known package (or selected box and shipment dims disagree). The
      // FE renders a NEEDS REVIEW chip from these flags; it does no policy
      // math of its own.
      const isBoxReviewLine = lineType === 'package_cost_missing';
      const stalePackagePrice =
        lineType === 'package_cost' &&
        row.createdAt != null &&
        row.clientId != null &&
        (() => {
          const changedAt = pricingChangedByClient.get(row.clientId);
          return changedAt ? new Date(row.createdAt) < changedAt : false;
        })();
      const labelCost =
        toFiniteNumber(row.labelCost ?? fallbackShipment?.labelCost) ??
        (() => {
          const cost = toFiniteNumber(row.cost ?? fallbackShipment?.cost);
          if (cost == null) return null;
          return cost + (toFiniteNumber(row.otherCost ?? fallbackShipment?.otherCost) ?? 0);
        })();
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

      const {
        selectedRateJson: _selectedRateJson,
        labelProvider: _labelProvider,
        orderItems: _orderItems,
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
      // PS-275: this order's prep-fee waiver decision (if any), for the FE chip.
      const feeWaiver = row.orderId != null ? feeWaiverByOrderId.get(row.orderId) ?? null : null;
      const feeWaived = feeWaiver?.decision === 'waived';
      return {
        ...rest,
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
        actualLabelCost: isShippingLine ? labelCost : null,
        actual_label_cost: isShippingLine ? labelCost : null,
        shippingCostMissing: isMissingShippingLine,
        shipping_cost_missing: isMissingShippingLine,
        // PS-207: box-review flag + the generator's reason text (the review
        // line's description, e.g. "Box mismatch — selected box (12x10x3)
        // disagrees with shipment dims (12x10x1)").
        packageCostNeedsReview: isBoxReviewLine,
        package_cost_needs_review: isBoxReviewLine,
        packageCostReviewReason: isBoxReviewLine ? row.description : null,
        package_cost_review_reason: isBoxReviewLine ? row.description : null,
        refUspsRate: isShippingLine ? refUspsRate : null,
        ref_usps_rate: isShippingLine ? refUspsRate : null,
        refUpsRate: isShippingLine ? refUpsRate : null,
        ref_ups_rate: isShippingLine ? refUpsRate : null,
        // PS-068: true when this box charge was generated BEFORE the client's
        // latest package-price/config change — the stored cost may be stale and
        // the range should be regenerated. Only meaningful for box lines.
        stalePackagePrice,
        stale_package_price: stalePackagePrice,
        // PS-275: a billed shipping line of EXACTLY $0.00 — the FE shows a
        // "Review $0 shipping" affordance from this flag (it does NO policy math
        // of its own; the decision is owned by decideZeroShippingReview).
        shippingZeroNeedsReview: isZeroShippingReviewLine,
        shipping_zero_needs_review: isZeroShippingReviewLine,
        // PS-275: the order's prep-fee waiver decision (durable, reversible).
        // null = undecided; the FE badges "Prep fee waived" when true.
        feeWaived,
        fee_waived: feeWaived,
        feeWaiverDecision: feeWaiver?.decision ?? null,
        fee_waiver_decision: feeWaiver?.decision ?? null,
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
