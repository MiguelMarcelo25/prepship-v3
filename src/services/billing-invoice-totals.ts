import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roundMoney } from '../lib/money.js';
import { intArraySql } from '../lib/scope-sql.js';
import { cancelledNoChargeBillingAmountSql } from './billing-cancelled-no-charge.js';
import { billingLineItemsHasReplacementIdColumn } from './billing-column-presence.js';
import { billingLineEffectiveDaySql } from './billing-calendar-policy.js';
import {
  billingReturnLineTypesSql,
  billingReturnPostageLineTypesSql,
  billingReturnProcessingLineTypesSql,
} from './billing-row-status.js';
import {
  nonBillableDuplicateOrderIds,
  type DuplicateOrderDecisions,
} from './billing-duplicate-order-loader.js';

export type BillingInvoiceHeaderTotals = {
  orderCount: number;
  /**
   * PS-502 AC-18. Distinct replacements billed in this period — NOT a count of orders.
   * A replacement carries the ORIGINAL order id, so `orderCount` cannot see it: two
   * replacements on one order are one order and two replacements.
   */
  replacementCount: number;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  adjustmentTotal: number;
  /** PS-502 AC-18: a re-ship's postage, its own category and never folded into shipping. */
  replacePostageTotal: number;
  /** PS-502 AC-18: a re-ship's handling, its own category and never ordinary pick/pack. */
  replacePickPackTotal: number;
  /**
   * PS-514: return money (postage + processing + legacy) as its OWN category, so the FE invoice
   * summary can render a Return card that reconciles to grandTotal. grandTotal already sums
   * return lines; this names the bucket so the category breakdown no longer under-sums the Total
   * whenever a return exists (returns are live today).
   */
  returnTotal: number;
  /**
   * The two NAMED PARTS of returnTotal, split by the same vocabulary owner the arms use
   * (PS-517). They are SUBSETS of returnTotal, never an addition to it.
   *
   * Added so a consumer that needs the breakdown — the Client Portal's customer invoice does —
   * can read it from this owner instead of running its own aggregation. That second
   * aggregation is exactly how the portal came to bill a customer for cancelled orders.
   */
  returnPostageTotal: number;
  returnProcessingTotal: number;
  grandTotal: number;
  fulfillmentFeeTotal: number;
};

type BillingTotalsExecutor = Pick<typeof db, 'execute'>;

/**
 * The aggregate row this owner reads, shared by the single-client and by-client queries.
 *
 * One shape, declared once. It was previously written out twice inside the single-client
 * function (the generic and the `rows` unwrap), which is already two places to forget a field.
 */
type BillingTotalsAggregateRow = {
  pickpack_total: string;
  additional_total: string;
  package_total: string;
  shipping_total: string;
  storage_total: string;
  adjustment_total: string;
  replace_postage_total: string;
  replace_pick_pack_total: string;
  return_total: string;
  return_postage_total: string;
  return_processing_total: string;
  order_count: number;
  replacement_count: number;
  grand_total: string;
};

/** postgres.js returns an array; drizzle wraps it. Unwrap once, for both queries. */
function aggregateRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Turn one aggregate row into the public totals shape.
 *
 * Shared so the per-client Billing list cannot round, bucket or name money differently from
 * the invoice — which is precisely the divergence this owner exists to prevent. A missing row
 * (a client with no activity in the period) maps to a well-formed all-zero total rather than
 * to undefined, because a Billing row that silently vanishes reads as "no charges" either way
 * but cannot be reconciled.
 */
function mapAggregateRow(s: BillingTotalsAggregateRow | undefined): BillingInvoiceHeaderTotals {
  const orderCount = s?.order_count ?? 0;
  const replacementCount = s?.replacement_count ?? 0;
  const pickPackTotal = roundMoney(Number(s?.pickpack_total ?? 0));
  const additionalTotal = roundMoney(Number(s?.additional_total ?? 0));
  const pickPackFeeTotal = roundMoney(pickPackTotal + additionalTotal);
  const packageTotal = roundMoney(Number(s?.package_total ?? 0));
  const shippingTotal = roundMoney(Number(s?.shipping_total ?? 0));
  const storageTotal = roundMoney(Number(s?.storage_total ?? 0));
  const adjustmentTotal = roundMoney(Number(s?.adjustment_total ?? 0));
  const replacePostageTotal = roundMoney(Number(s?.replace_postage_total ?? 0));
  const replacePickPackTotal = roundMoney(Number(s?.replace_pick_pack_total ?? 0));
  const returnTotal = roundMoney(Number(s?.return_total ?? 0));
  const returnPostageTotal = roundMoney(Number(s?.return_postage_total ?? 0));
  const returnProcessingTotal = roundMoney(Number(s?.return_processing_total ?? 0));
  const grandTotal = roundMoney(Number(s?.grand_total ?? 0));
  // NO residual bucket here, deliberately. An "other" category would make the AC-18 identity
  // hold by absorbing whatever is unaccounted for — which is exactly the alarm
  // reconcileCategoryTotals exists to raise. Naming every bucket and letting the reconciler
  // scream is the repo's answer; a residual would silence it permanently, and the next
  // unbucketed line type would go unnoticed for as long as it existed.
  // PS-505 corrective: Fulfillment Fee is the FULFILLMENT SERVICE work only —
  // Pick & Pack + Additional Units + Box Cost. Shipping is a pass-through carrier
  // charge and Storage is a separate service, so neither belongs under this heading.
  // PS-502: replacement handling is deliberately NOT added here — a re-ship is its own event
  // with its own category, and folding it in would make one heading mean two things.
  const fulfillmentFeeTotal = roundMoney(pickPackFeeTotal + packageTotal);
  return {
    orderCount,
    replacementCount,
    pickPackTotal,
    additionalTotal,
    pickPackFeeTotal,
    packageTotal,
    shippingTotal,
    storageTotal,
    adjustmentTotal,
    replacePostageTotal,
    replacePickPackTotal,
    returnTotal,
    returnPostageTotal,
    returnProcessingTotal,
    grandTotal,
    fulfillmentFeeTotal,
  };
}

/**
 * Everything both queries need: the money expression, the day expression, the duplicate
 * suppression predicate, the replacement-count expression, and the aggregate SELECT list.
 *
 * Built ONCE. The by-client query for the Billing list must apply byte-identical rules to the
 * single-client query behind the invoice, or the list and the invoice a customer opens from it
 * disagree — which is the whole class of bug this file has been fixing.
 */
async function invoiceTotalsQueryParts(
  conn: BillingTotalsExecutor,
  duplicateDecisions: DuplicateOrderDecisions,
): Promise<{ selectList: SQL; effectiveDay: SQL; notSuppressed: SQL }> {
  // PS-491: a duplicated order number becomes two orders and therefore two sets of
  // billing lines. Suppressing the non-authoritative copies here, in the canonical totals
  // owner, is what stops the header total, the invoice line items, and the finalization
  // snapshot from disagreeing about what the customer owes. Split shipments are NOT
  // suppressed — see billing-duplicate-order-policy.ts for why that distinction is
  // load-bearing.
  const suppressedOrderIds = nonBillableDuplicateOrderIds(duplicateDecisions);
  const notSuppressed = suppressedOrderIds.length
    ? sql`and (b.order_id is null or b.order_id <> all(${intArraySql(suppressedOrderIds)}))`
    : sql``;

  // Probed on the CALLER'S connection, not the singleton. This owner is reached by ordinary
  // invoice generation on every database, and 0097 is gated behind the operator lane — an
  // unguarded reference crashed the canonical totals for every client with
  // `column b.replacement_id does not exist`, with every replacement flag off.
  const replacementCountSql = (await billingLineItemsHasReplacementIdColumn(conn))
    ? sql`count(distinct b.replacement_id)::int`
    : sql`0::int`;

  const invoiceAmount = cancelledNoChargeBillingAmountSql({
    lineType: sql`b.line_type`,
    orderStatus: sql`o.order_status`,
    canonicalStatus: sql`o.canonical_status`,
    totalCost: sql`b.total_cost`,
  });
  const effectiveDay = billingLineEffectiveDaySql(
    sql`b.billing_effective_date`,
    sql`b.ship_date`,
  );
  // PS-515: the return bucket's vocabulary comes from the ONE owner (BILLING_RETURN_LINE_TYPES
  // via billingReturnLineTypesSql). A hand-written list here was a third copy of the same fact;
  // its failure mode is silent — a spelling added to the owner but missed here would drop
  // return money out of this bucket while leaving it in grandTotal.
  const returnLineTypesSql = billingReturnLineTypesSql();
  // PS-517's split vocabulary, same owner as the invoice arms — so the two named parts cannot
  // drift from the bucket that contains them.
  const returnPostageTypesSql = billingReturnPostageLineTypesSql();
  const returnProcessingTypesSql = billingReturnProcessingLineTypesSql();

  const selectList = sql`
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then ${invoiceAmount} else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then ${invoiceAmount} else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type in ('package_cost', 'package') then ${invoiceAmount} else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then ${invoiceAmount} else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when b.line_type = 'storage' then ${invoiceAmount} else 0 end), 0)::text as storage_total,
      coalesce(sum(case when b.line_type = 'billing_adjustment' then ${invoiceAmount} else 0 end), 0)::text as adjustment_total,
      coalesce(sum(case when b.line_type = 'replace_postage' then ${invoiceAmount} else 0 end), 0)::text as replace_postage_total,
      coalesce(sum(case when b.line_type = 'replace_pick_pack' then ${invoiceAmount} else 0 end), 0)::text as replace_pick_pack_total,
      coalesce(sum(case when b.line_type in ${returnLineTypesSql} then ${invoiceAmount} else 0 end), 0)::text as return_total,
      coalesce(sum(case when b.line_type in ${returnPostageTypesSql} then ${invoiceAmount} else 0 end), 0)::text as return_postage_total,
      coalesce(sum(case when b.line_type in ${returnProcessingTypesSql} then ${invoiceAmount} else 0 end), 0)::text as return_processing_total,
      count(distinct b.order_id)::int as order_count,
      ${replacementCountSql} as replacement_count,
      coalesce(sum(${invoiceAmount}), 0)::text as grand_total`;

  return { selectList, effectiveDay, notSuppressed };
}

/**
 * Canonical totals for SEVERAL clients over one period, keyed by client id.
 *
 * Exists so the Client Portal's Billing LIST reads the same money its invoice does. The list
 * used to run the portal's own aggregation, which implements neither PS-491 duplicate
 * suppression nor cancelled-no-charge — measured on HUGRAB's August 2026 period, that showed
 * a customer 8 cancelled orders and a duplicate copy they were never charged for. Once the
 * invoice was moved onto this owner, a list still on the old aggregation would disagree with
 * the invoice a customer opens from it.
 *
 * ONE query, grouped — not a loop over the single-client function. A staff Billing list can
 * span dozens of clients, and N round trips on a summary page is a different bug.
 *
 * Clients with no activity in the period are ABSENT from the map, not zero-filled: the caller
 * knows which clients it asked about and `?? ` on a missing key is clearer than a fabricated
 * row. Use `billingInvoiceHeaderTotalsFor` to get the zero-filled shape.
 */
export async function billingInvoiceHeaderTotalsByClient(
  clientIds: number[],
  dateFrom: string,
  dateTo: string,
  conn: BillingTotalsExecutor = db,
  /** Same REQUIRED suppression contract as the single-client owner. See its doc comment. */
  duplicateDecisions: DuplicateOrderDecisions,
): Promise<Map<number, BillingInvoiceHeaderTotals>> {
  const ids = [...new Set(clientIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const { selectList, effectiveDay, notSuppressed } = await invoiceTotalsQueryParts(
    conn,
    duplicateDecisions,
  );
  const result = await conn.execute<BillingTotalsAggregateRow & { client_id: number }>(sql`
    select
      b.client_id as client_id,
      ${selectList}
    from billing_line_items b
    left join orders o on o.id = b.order_id
    where b.client_id = any(${intArraySql(ids)})
      and ${effectiveDay} >= ${dateFrom}::timestamptz
      and ${effectiveDay} < ${dateTo}::timestamptz
      ${notSuppressed}
    group by b.client_id
  `);
  const out = new Map<number, BillingInvoiceHeaderTotals>();
  for (const row of aggregateRows<BillingTotalsAggregateRow & { client_id: number }>(result)) {
    out.set(Number(row.client_id), mapAggregateRow(row));
  }
  return out;
}

/** The zero-filled totals for one client, for callers that want a row either way. */
export function billingInvoiceHeaderTotalsFor(
  byClient: Map<number, BillingInvoiceHeaderTotals>,
  clientId: number,
): BillingInvoiceHeaderTotals {
  return byClient.get(clientId) ?? mapAggregateRow(undefined);
}

/**
 * Canonical total of one client's frozen invoice period. Both invoice exports
 * and the close workflow call this owner so a finalization cannot snapshot a
 * different amount from the customer-facing invoice.
 */
export async function billingInvoiceHeaderTotals(
  clientId: number,
  dateFrom: string,
  dateTo: string,
  conn: BillingTotalsExecutor = db,
  /**
   * PS-491: which order copies this period may charge for, from
   * `loadDuplicateOrderDecisions`. REQUIRED, deliberately.
   *
   * An earlier version defaulted this by loading inside this function. That put a second
   * query — and a dependency on four more `billing_line_items` columns — inside a hot
   * owner that three separate integration fixtures call with a reduced table, and it made
   * the suppression invisible at the call site. Requiring it instead means the COMPILER
   * refuses a new caller that has not thought about duplicates, which is a stronger
   * guarantee than any guard, and callers already inside a transaction (the close
   * workflow) can load on that same `tx`.
   *
   * Pass an empty Map to state explicitly that no suppression applies.
   */
  duplicateDecisions: DuplicateOrderDecisions,
): Promise<BillingInvoiceHeaderTotals> {
  // Delegates to the SAME query parts the by-client list uses, so the invoice and the Billing
  // list cannot apply different rules to the same period. This function is the one-client case
  // of that query, not a second implementation of it.
  const byClient = await billingInvoiceHeaderTotalsByClient(
    [clientId],
    dateFrom,
    dateTo,
    conn,
    duplicateDecisions,
  );
  // A client with no lines in the period is a real answer: an all-zero invoice, not an error.
  return billingInvoiceHeaderTotalsFor(byClient, clientId);
}
