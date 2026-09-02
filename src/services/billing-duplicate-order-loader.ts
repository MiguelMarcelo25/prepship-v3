import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingLineEffectiveDaySql } from './billing-calendar-policy.js';
import { intArraySql } from '../lib/scope-sql.js';
import {
  classifyDuplicateOrderCopies,
  type DuplicateOrderDecision,
} from './billing-duplicate-order-policy.js';

/**
 * PS-491: load the evidence the duplicate-order policy ranks on, for one client's
 * invoice period, and return the decision per order id.
 *
 * The rule itself lives in `billing-duplicate-order-policy.ts` and is pure, so it can be
 * tested without a database. This module is the only place that reads the rows. Same
 * split as PS-467's unattributed-shipment classifier and PS-477's disclosure reducer.
 *
 * Both the canonical totals owner (`billing-invoice-totals.ts`) and the invoice export
 * (`routes/billing.ts`) call this, so the line items and the header total cannot disagree
 * — and neither can the customer-facing invoice and the finalization snapshot.
 */

export type DuplicateOrderDecisions = Map<number, DuplicateOrderDecision>;

type EvidenceRow = {
  order_id: number | null;
  order_number: string | null;
  shipping_amt: string | null;
  shipment_id: number | null;
  billing_adjustment_id: string | null;
  invoiced_lines: number;
  ss_split: boolean | null;
};

type DuplicateLoaderExecutor = Pick<typeof db, 'execute'>;

/**
 * Decisions for every order copy in the period that needs one. Order ids absent from the
 * returned map are ordinary and must be billed normally.
 *
 * ALREADY-INVOICED COPIES ARE NEVER SUPPRESSED. If any line of an order copy has
 * `invoiced = true`, that copy is excluded from the duplicate ranking entirely, because
 * suppressing it would retroactively change an invoice a customer has already received —
 * turning a billing fix into a silent restatement of history. Measured 2026-08-07: zero
 * duplicate copies were invoiced, so this guard costs nothing today and exists to keep it
 * true later.
 */
export async function loadDuplicateOrderDecisions(
  clientId: number,
  dateFrom: string,
  dateTo: string,
  conn: DuplicateLoaderExecutor = db,
): Promise<DuplicateOrderDecisions> {
  const effectiveDay = billingLineEffectiveDaySql(
    sql`b.billing_effective_date`,
    sql`b.ship_date`,
  );

  const result = await conn.execute<EvidenceRow>(sql`
    select
      b.order_id,
      b.order_number,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_amt,
      b.shipment_id,
      b.billing_adjustment_id,
      count(*) filter (where b.invoiced)::int as invoiced_lines,
      -- PS-491 (raw payload policy v2): ShipStation's own split/merge statement, when the
      -- order was ingested after v2 started retaining it. Compared as text rather than
      -- cast to boolean so an unexpected value cannot throw inside the invoice path.
      bool_or(
        o.raw->'advancedOptions'->>'mergedOrSplit' = 'true'
        or o.raw->'advancedOptions'->>'parentId' is not null
      ) as ss_split
    from billing_line_items b
    left join orders o on o.id = b.order_id
    where b.client_id = ${clientId}
      and ${effectiveDay} >= ${dateFrom}::timestamptz
      and ${effectiveDay} < ${dateTo}::timestamptz
    group by b.order_id, b.order_number, b.shipment_id, b.billing_adjustment_id
  `);

  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: EvidenceRow[] }).rows
      : [];

  // An order copy with ANY invoiced line is out of scope — see the note above.
  const invoicedOrderIds = new Set<number>();
  for (const row of rows) {
    if (row.order_id != null && Number(row.invoiced_lines) > 0) invoicedOrderIds.add(row.order_id);
  }

  return classifyDuplicateOrderCopies(
    rows
      .filter((row) => row.order_id == null || !invoicedOrderIds.has(row.order_id))
      .map((row) => ({
        orderId: row.order_id,
        orderNumber: row.order_number,
        shippingAmount: Number(row.shipping_amt ?? 0),
        shipmentId: row.shipment_id,
        billingAdjustmentId: row.billing_adjustment_id,
        shipStationSplit: row.ss_split,
      })),
  );
}

/**
 * The same decisions for SEVERAL clients, in one query.
 *
 * PARTITIONED BY CLIENT, and that is the whole reason this is not just a wider `where`.
 * Duplicate detection groups by ORDER NUMBER, and two different clients can legitimately carry
 * the same order number — "1001" is not rare. Classifying a mixed set in one pass would read
 * those as copies of each other and suppress one client's real money. So the rows are bucketed
 * by client id first and each bucket is classified on its own, exactly as the single-client
 * loader would have.
 *
 * Exists so the Billing LIST can apply the same suppression as the invoice without N round
 * trips per page. The returned map is keyed by order id, which is globally unique, so the
 * per-client results merge without collision.
 */
export async function loadDuplicateOrderDecisionsForClients(
  clientIds: number[],
  dateFrom: string,
  dateTo: string,
  conn: DuplicateLoaderExecutor = db,
): Promise<DuplicateOrderDecisions> {
  const ids = [...new Set(clientIds.filter((id) => Number.isInteger(id) && id > 0))];
  const merged: DuplicateOrderDecisions = new Map();
  if (!ids.length) return merged;

  const effectiveDay = billingLineEffectiveDaySql(
    sql`b.billing_effective_date`,
    sql`b.ship_date`,
  );
  const result = await conn.execute<EvidenceRow & { client_id: number }>(sql`
    select
      b.client_id as client_id,
      b.order_id,
      b.order_number,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_amt,
      b.shipment_id,
      b.billing_adjustment_id,
      count(*) filter (where b.invoiced)::int as invoiced_lines,
      bool_or(
        o.raw->'advancedOptions'->>'mergedOrSplit' = 'true'
        or o.raw->'advancedOptions'->>'parentId' is not null
      ) as ss_split
    from billing_line_items b
    left join orders o on o.id = b.order_id
    where b.client_id = any(${intArraySql(ids)})
      and ${effectiveDay} >= ${dateFrom}::timestamptz
      and ${effectiveDay} < ${dateTo}::timestamptz
    group by b.client_id, b.order_id, b.order_number, b.shipment_id, b.billing_adjustment_id
  `);

  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: Array<EvidenceRow & { client_id: number }> }).rows
      : [];

  const byClient = new Map<number, Array<EvidenceRow & { client_id: number }>>();
  for (const row of rows) {
    const key = Number(row.client_id);
    const bucket = byClient.get(key);
    if (bucket) bucket.push(row);
    else byClient.set(key, [row]);
  }

  for (const bucket of byClient.values()) {
    // An order copy with ANY invoiced line is out of scope — same rule as the single-client
    // loader, applied within the client so an invoiced copy elsewhere cannot leak across.
    const invoicedOrderIds = new Set<number>();
    for (const row of bucket) {
      if (row.order_id != null && Number(row.invoiced_lines) > 0) invoicedOrderIds.add(row.order_id);
    }
    const decisions = classifyDuplicateOrderCopies(
      bucket
        .filter((row) => row.order_id == null || !invoicedOrderIds.has(row.order_id))
        .map((row) => ({
          orderId: row.order_id,
          orderNumber: row.order_number,
          shippingAmount: Number(row.shipping_amt ?? 0),
          shipmentId: row.shipment_id,
          billingAdjustmentId: row.billing_adjustment_id,
          shipStationSplit: row.ss_split,
        })),
    );
    for (const [orderId, decision] of decisions) merged.set(orderId, decision);
  }
  return merged;
}

/** The order ids the invoice must not charge for. */
export function nonBillableDuplicateOrderIds(decisions: DuplicateOrderDecisions): number[] {
  const ids: number[] = [];
  for (const [orderId, decision] of decisions) {
    if (decision.kind === 'duplicate') ids.push(orderId);
  }
  return ids;
}
