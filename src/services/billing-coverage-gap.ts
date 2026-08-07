import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Canonical owner: which shipped orders were never billed at all?
 *
 * PS-495. Not `shipping_missing` at $0.00 — those orders at least reached billing. These
 * have ZERO rows in `billing_line_items`: no shipping, no pick/pack, no package. The
 * customer was never charged anything for a parcel that went out.
 *
 * ── Why it happens ─────────────────────────────────────────────────────────
 * Billing generation is a point-in-time snapshot of a period. Measured 2026-08-07: 448 of
 * 450 gap orders had their shipment sync in MORE THAN A WEEK after the ship date —
 * averaging 207 days late for one store, ~41 for the others, most arriving in a single
 * 2026-04-23 bulk sync. By then the period had already been generated, and nothing
 * regenerates a period when a late shipment lands inside it.
 *
 * The evidence is that the gaps are whole DAYS, not scattered orders: 31 of 33 affected
 * shipping days had ZERO billed orders, sitting between days that billed completely. For
 * one store the split is exact — 03-02..03-04 fully billed, 03-05..03-20 entirely
 * unbilled, 03-23 onward fully billed again.
 *
 * ── Why this is a detector and not a repair ────────────────────────────────
 * None of the 450 fall inside a FINALIZED period, so nothing is blocked and a plain
 * regeneration of those windows would produce the missing lines. But regeneration writes
 * money against orders shipped as long ago as 2024-01-29, which is a customer-facing
 * decision, not an automatic one. This module makes the gap visible and leaves the
 * billing decision to an operator.
 */

export type BillingCoverageGapRow = {
  clientId: number;
  storeId: number | null;
  orderId: number;
  orderNumber: string | null;
  shipDate: string | null;
  shipmentId: number;
  /** Postage cost on the shipment. NOT the customer price — markup sits on top. */
  postageCost: number;
  /** Days between the ship date and the shipment first appearing in PrepShip. */
  syncedDaysLate: number | null;
};

export type BillingCoverageGapSummary = {
  orders: number;
  postageCost: number;
  earliestShipDate: string | null;
  latestShipDate: string | null;
};

type GapExecutor = Pick<typeof db, 'execute'>;

/**
 * Shipped orders with a live shipment and no billing lines, EXCLUDING two shapes that are
 * not defects:
 *
 *  1. Orders after the client's billing frontier (their most recent billed ship date).
 *     Billing is generated per period after the fact, so today's shipments are always
 *     briefly unbilled. Counting those would make the number permanently non-zero and
 *     therefore useless as an alert. Measured: 6 of 454 orders were this ordinary lag.
 *  2. Clients that have NEVER been billed for anything. Two stores in production carry
 *     26,495 and 226 orders with zero billing rows between them — they are not billing
 *     clients, and their orders are expected to be unbilled.
 */
export async function loadBillingCoverageGaps(
  conn: GapExecutor = db,
): Promise<BillingCoverageGapRow[]> {
  const result = await conn.execute<{
    client_id: number; store_id: number | null; order_id: number; order_number: string | null;
    ship_date: string | null; shipment_id: number; postage_cost: string | null;
    synced_days_late: string | null;
  }>(sql`
    with frontier as (
      -- The client's most recent BILLED shipping day. Anything at or after this is
      -- ordinary generation lag, not a gap.
      select o.client_id, max(s.ship_date::date) as last_billed_day
      from orders o
      join shipments s on s.order_id = o.id
      where s.voided = false
        and exists (select 1 from billing_line_items b where b.order_id = o.id)
      group by o.client_id
    )
    select
      o.client_id, o.store_id, o.id as order_id, o.order_number,
      to_char(s.ship_date at time zone 'UTC', 'YYYY-MM-DD') as ship_date,
      s.id as shipment_id,
      coalesce(s.cost, 0)::text as postage_cost,
      extract(epoch from (s.created_at - s.ship_date))::numeric / 86400 as synced_days_late
    from orders o
    join shipments s on s.order_id = o.id
    join frontier f on f.client_id = o.client_id
    where o.order_status = 'shipped'
      and s.voided = false
      and o.client_id is not null
      and s.ship_date::date < f.last_billed_day
      and not exists (select 1 from billing_line_items b where b.order_id = o.id)
    order by s.ship_date, o.id
  `);

  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: Array<Record<string, unknown>> }).rows
      : [];

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    clientId: Number(row.client_id),
    storeId: row.store_id == null ? null : Number(row.store_id),
    orderId: Number(row.order_id),
    orderNumber: (row.order_number as string | null) ?? null,
    shipDate: (row.ship_date as string | null) ?? null,
    shipmentId: Number(row.shipment_id),
    postageCost: Number(row.postage_cost ?? 0),
    syncedDaysLate: row.synced_days_late == null
      ? null
      : Math.round(Number(row.synced_days_late)),
  }));
}

/** Roll the gap rows up for the operator-facing "how bad is it" answer. */
export function summarizeBillingCoverageGaps(rows: readonly BillingCoverageGapRow[]): BillingCoverageGapSummary {
  const dates = rows.map((r) => r.shipDate).filter((d): d is string => !!d).sort();
  return {
    orders: rows.length,
    // Rounded at the boundary: summing floats then displaying is how a total ends up
    // one cent off the rows that produced it.
    postageCost: Number(rows.reduce((sum, r) => sum + r.postageCost, 0).toFixed(2)),
    earliestShipDate: dates[0] ?? null,
    latestShipDate: dates[dates.length - 1] ?? null,
  };
}

/** Per-client rollup, since remediation is decided one client at a time. */
export function groupBillingCoverageGapsByClient(
  rows: readonly BillingCoverageGapRow[],
): Array<BillingCoverageGapSummary & { clientId: number }> {
  const byClient = new Map<number, BillingCoverageGapRow[]>();
  for (const row of rows) {
    const list = byClient.get(row.clientId) ?? [];
    list.push(row);
    byClient.set(row.clientId, list);
  }
  return [...byClient.entries()]
    .map(([clientId, list]) => ({ clientId, ...summarizeBillingCoverageGaps(list) }))
    .sort((a, b) => b.postageCost - a.postageCost);
}
