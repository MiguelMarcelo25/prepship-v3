import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roundMoney } from '../lib/money.js';
import { cancelledNoChargeBillingAmountSql } from './billing-cancelled-no-charge.js';
import { billingLineEffectiveDaySql } from './billing-calendar-policy.js';

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
): Promise<BillingInvoiceHeaderTotals> {
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
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then ${invoiceAmount} else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then ${invoiceAmount} else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type in ('package_cost', 'package') then ${invoiceAmount} else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then ${invoiceAmount} else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when b.line_type = 'storage' then ${invoiceAmount} else 0 end), 0)::text as storage_total,
      count(distinct b.order_id)::int as order_count,
      coalesce(sum(${invoiceAmount}), 0)::text as grand_total
    from billing_line_items b
    left join orders o on o.id = b.order_id
    where b.client_id = ${clientId}
      and ${effectiveDay} >= ${dateFrom}::timestamptz
      and ${effectiveDay} < ${dateTo}::timestamptz
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
          order_count: number;
          grand_total: string;
        }> }).rows
      : [];
  const s = rows[0];

  const orderCount = s?.order_count ?? 0;
  const pickPackTotal = roundMoney(Number(s?.pickpack_total ?? 0));
  const additionalTotal = roundMoney(Number(s?.additional_total ?? 0));
  const pickPackFeeTotal = roundMoney(pickPackTotal + additionalTotal);
  const packageTotal = roundMoney(Number(s?.package_total ?? 0));
  const shippingTotal = roundMoney(Number(s?.shipping_total ?? 0));
  const storageTotal = roundMoney(Number(s?.storage_total ?? 0));
  const grandTotal = roundMoney(Number(s?.grand_total ?? 0));
  const fulfillmentFeeTotal = roundMoney(
    shippingTotal + pickPackFeeTotal + packageTotal + storageTotal,
  );

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
