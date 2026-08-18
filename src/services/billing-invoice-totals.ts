import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roundMoney } from '../lib/money.js';
import { intArraySql } from '../lib/scope-sql.js';
import { cancelledNoChargeBillingAmountSql } from './billing-cancelled-no-charge.js';
import { billingLineEffectiveDaySql } from './billing-calendar-policy.js';
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
  grandTotal: number;
  fulfillmentFeeTotal: number;
};

type BillingTotalsExecutor = Pick<typeof db, 'execute'>;

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
  const summaryRow = await conn.execute<{
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    adjustment_total: string;
    replace_postage_total: string;
    replace_pick_pack_total: string;
    order_count: number;
    replacement_count: number;
    grand_total: string;
  }>(sql`
    select
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then ${invoiceAmount} else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then ${invoiceAmount} else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type in ('package_cost', 'package') then ${invoiceAmount} else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then ${invoiceAmount} else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when b.line_type = 'storage' then ${invoiceAmount} else 0 end), 0)::text as storage_total,
      coalesce(sum(case when b.line_type = 'billing_adjustment' then ${invoiceAmount} else 0 end), 0)::text as adjustment_total,
      coalesce(sum(case when b.line_type = 'replace_postage' then ${invoiceAmount} else 0 end), 0)::text as replace_postage_total,
      coalesce(sum(case when b.line_type = 'replace_pick_pack' then ${invoiceAmount} else 0 end), 0)::text as replace_pick_pack_total,
      count(distinct b.order_id)::int as order_count,
      count(distinct b.replacement_id)::int as replacement_count,
      coalesce(sum(${invoiceAmount}), 0)::text as grand_total
    from billing_line_items b
    left join orders o on o.id = b.order_id
    where b.client_id = ${clientId}
      and ${effectiveDay} >= ${dateFrom}::timestamptz
      and ${effectiveDay} < ${dateTo}::timestamptz
      ${notSuppressed}
  `);
  const rows = Array.isArray(summaryRow)
    ? summaryRow
    : summaryRow && typeof summaryRow === 'object' && 'rows' in summaryRow
      ? (summaryRow as { rows: Array<{
          pickpack_total: string;
          additional_total: string;
          package_total: string;
          shipping_total: string;
          storage_total: string;
          adjustment_total: string;
          replace_postage_total: string;
          replace_pick_pack_total: string;
          order_count: number;
          replacement_count: number;
          grand_total: string;
        }> }).rows
      : [];
  const s = rows[0];

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
  const grandTotal = roundMoney(Number(s?.grand_total ?? 0));
  // NO residual bucket here, deliberately. An "other" category would make the AC-18 identity
  // hold by absorbing whatever is unaccounted for — which is exactly the alarm
  // reconcileCategoryTotals exists to raise. Naming every bucket and letting the reconciler
  // scream is the repo's answer; a residual would silence it permanently, and the next
  // unbucketed line type would go unnoticed for as long as it existed.
  // PS-505 corrective: Fulfillment Fee is the FULFILLMENT SERVICE work only —
  // Pick & Pack + Additional Units + Box Cost. Shipping is a pass-through carrier
  // charge and Storage is a separate service, so neither belongs under this heading.
  // Including them made the column labelled "Fulfillment Fee" render the row total,
  // which is a different money concept under the same name.
  // PS-502: replacement handling is deliberately NOT added here. PS-505 defined this as the
  // ordinary fulfilment service on the original order; a re-ship is its own event with its
  // own category, and folding it in would make a column labelled "Fulfillment Fee" mean two
  // different things depending on whether a replacement happened.
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
    grandTotal,
    fulfillmentFeeTotal,
  };
}
