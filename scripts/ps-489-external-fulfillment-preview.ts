#!/usr/bin/env tsx
import 'dotenv/config';
import { sql } from '../src/db/client.js';

/**
 * PS-489 / PS-497 — read-only classification and repair PREVIEW.
 *
 * Built to DJ's ruling of 2026-08-11. That ruling authorises NOTHING to be mutated:
 * the 3,423 historical orders, 1,885 stranded claims and 864 manual overrides stay exactly
 * as they are. This script reports what a repair WOULD touch, so the repair can be argued
 * about before it is authorised, not after.
 *
 * It issues SELECT statements only. No UPDATE, INSERT, DELETE, DDL, claim application,
 * claim closure, inventory movement, billing regeneration or provider call.
 *
 * ── The rule this implements ──────────────────────────────────────────────────────────
 *
 * DJ's correction, and the reason this script exists at all:
 *
 *   "Inventory: deduct only when PrepShip-owned inventory actually fulfilled the order.
 *    Who purchased the label is not the deciding factor. `externally_shipped` alone is
 *    therefore insufficient evidence for inventory movement."
 *
 * So `externally_shipped` is NOT the classifier. Each order is sorted by what the data can
 * actually prove about whether PrepShip stock left the building. Anything that cannot be
 * proved is reported as AMBIGUOUS and stays in review — it is never promoted to a deduction
 * candidate to make the numbers tidier.
 */

type Row = Record<string, unknown>;
const heading = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

const EXT = sql`o.externally_shipped is true and o.order_status = 'shipped'`;

async function main(): Promise<void> {
  console.log('PS-489 / PS-497 external-fulfilment classification preview');
  console.log('READ-ONLY. Nothing is mutated. DJ ruling 2026-08-11.\n');

  // ── 1. scope ──────────────────────────────────────────────────────────────
  heading('1. POPULATION');
  console.table(await sql`
    select count(*)::int as ext_shipped_orders,
           count(*) filter (where s.id is not null)::int as with_shipment_row,
           count(distinct o.client_id)::int as clients,
           to_char(min(o.order_date),'YYYY-MM-DD') as oldest,
           to_char(max(o.order_date),'YYYY-MM-DD') as newest
    from orders o left join shipments s on s.order_id = o.id
    where ${EXT}
  ` as Row[]);

  // ── 2. did PrepShip inventory supply the goods? ────────────────────────────
  //
  // Buckets are ordered by strength of evidence, and each order falls in exactly one.
  // `already_deducted` is proof, not inference: a ledger movement means stock demonstrably
  // moved for that order. `client_holds_no_inventory` is near-proof in the other direction.
  // Everything in between is a CANDIDATE, never a conclusion.
  heading('2. DID PREPSHIP INVENTORY SUPPLY THE GOODS?  (DJ fact #2)');
  console.table(await sql`
    with classified as (
      select o.id,
             o.client_id,
             exists (select 1 from inventory_ledger l where l.order_id = o.id) as has_ledger,
             (select count(*) from order_items oi where oi.order_id = o.id) as item_lines,
             (select count(*) from order_items oi
                where oi.order_id = o.id
                  and exists (select 1 from inventory i
                              where lower(i.sku) = lower(oi.sku) and i.active
                                and (i.client_id = o.client_id or i.client_id is null))
             ) as matched_lines,
             (select count(*) from inventory i where i.client_id = o.client_id and i.active) as client_skus
      from orders o where ${EXT}
    )
    select case
      when has_ledger then 'A. PROVEN supplied — inventory ledger movement exists'
      when client_skus = 0 then 'B. PROVEN external — client holds no PrepShip inventory at all'
      when item_lines = 0 then 'C. AMBIGUOUS — order has no line items to classify'
      when matched_lines = 0 then 'D. LIKELY external — no line SKU exists in PrepShip inventory'
      when matched_lines = item_lines then 'E. CANDIDATE supplied — every line SKU is stocked here'
      else 'F. AMBIGUOUS — only some line SKUs are stocked here'
    end as classification,
    count(*)::int as orders,
    count(distinct client_id)::int as clients
    from classified group by 1 order by 1
  ` as Row[]);

  console.log(
    '\nOnly bucket E is a deduction CANDIDATE, and a candidate is not an authorisation.\n' +
    'C and F stay in review permanently until the underlying data gap is fixed — per DJ,\n' +
    'ambiguous claims cannot be bulk-drained.',
  );

  // ── 3. per client, because the answer differs by client ───────────────────
  heading('3. THE SAME CUT, PER CLIENT');
  console.table(await sql`
    select c.name as client,
           count(*)::int as ext_shipped,
           count(*) filter (where exists (select 1 from inventory_ledger l where l.order_id = o.id))::int as proven_supplied,
           (select count(*)::int from inventory i where i.client_id = o.client_id and i.active) as active_skus,
           count(*) filter (where (select count(*) from order_items oi where oi.order_id = o.id) = 0)::int as no_line_items
    from orders o left join clients c on c.id = o.client_id
    where ${EXT}
    group by c.name, o.client_id order by 2 desc
  ` as Row[]);

  // ── 4. what a repair would do to the stranded claims ──────────────────────
  heading('4. STRANDED CLAIM DISPOSITION PREVIEW  (nothing is applied)');
  console.table(await sql`
    with claim_orders as (
      select c.id as claim_id, c.order_id, c.status, c.last_error,
             exists (select 1 from inventory_ledger l where l.order_id = c.order_id) as has_ledger,
             (select count(*) from order_items oi where oi.order_id = c.order_id) as item_lines,
             (select count(*) from inventory i
                join orders o2 on o2.id = c.order_id
               where i.client_id = o2.client_id and i.active) as client_skus
      from fulfillment_line_claims c
      join order_lifecycle_events e on e.id = c.lifecycle_event_id
      where c.status = 'review'
        and e.source in ('order_sync_status','external_shipped_classifier')
    )
    select case
      when has_ledger then 'already deducted — claim is redundant, would CLOSE as superseded'
      when client_skus = 0 then 'external inventory — would CLOSE as not-applicable'
      when item_lines = 0 then 'AMBIGUOUS — no line items — STAYS IN REVIEW'
      else 'candidate — needs DJ authorisation before any deduction'
    end as would_become,
    count(*)::int as claims
    from claim_orders group by 1 order by 2 desc
  ` as Row[]);

  console.log('\nNo claim is applied, closed, drained or altered by this script.');

  // ── 5. shipping-cost authority, in DJ's stated order ──────────────────────
  heading("5. SHIPPING-COST AUTHORITY AVAILABLE  (DJ's tier order)");
  console.table(await sql`
    select
      count(*)::int as ext_shipped_orders,
      count(*) filter (where nullif(trim(o.raw->>'shipmentCost'),'') is not null
                          and (o.raw->>'shipmentCost') <> '0')::int as tier1_provider_cost,
      count(*) filter (where exists (
        select 1 from billing_manual_overrides m
        where m.order_id = o.id and m.line_type like '%shipping%' and m.reviewer is not null
      ))::int as tier2_operator_entry,
      0::int as tier3_client_contracted_rate
    from orders o where ${EXT}
  ` as Row[]);

  console.log(
    '\ntier3 is 0 because no client-level contracted shipping rate table exists in this schema.\n' +
    'Any order with none of the three tiers has an UNKNOWN cost and, per DJ, stays in an\n' +
    'exception queue as shipping_missing. It must never be silently billed as $0.',
  );

  console.table(await sql`
    select bli.line_type, count(*)::int as lines, round(sum(bli.total_cost)::numeric,2)::text as total
    from billing_line_items bli join orders o on o.id = bli.order_id
    where ${EXT} and bli.line_type in ('shipping','shipping_missing')
    group by 1 order by 2 desc
  ` as Row[]);

  // ── 6. override provenance — reported honestly, never reconstructed ───────
  heading('6. EXISTING MANUAL OVERRIDES — PROVENANCE IS UNKNOWN');
  console.table(await sql`
    select count(*)::int as overrides,
           round(sum(amount)::numeric,2)::text as total_usd,
           count(*) filter (where reviewer is not null)::int as has_reviewer,
           count(*) filter (where nullif(trim(note),'') is not null)::int as has_note,
           count(distinct reviewer)::int as distinct_reviewers,
           to_char(min(reviewed_at) at time zone 'UTC','YYYY-MM-DD') as first,
           to_char(max(reviewed_at) at time zone 'UTC','YYYY-MM-DD') as last
    from billing_manual_overrides
  ` as Row[]);

  // Every override carries a note, so "no provenance" would be an unfair reading. The notes
  // were read before this was written: they record the operator's INTENT, not the amount's
  // SOURCE. That distinction is the whole point, so the shapes are printed rather than
  // summarised.
  console.table(await sql`
    select regexp_replace(note, '[0-9]+', 'N', 'g') as note_shape,
           count(*)::int as overrides,
           round(min(amount)::numeric,2)::text as min_amount,
           round(max(amount)::numeric,2)::text as max_amount
    from billing_manual_overrides
    group by 1 order by 2 desc limit 10
  ` as Row[]);

  console.log(
    '\nAll 864 overrides have a reviewer, a timestamp and a note, so provenance is not absent —\n' +
    'it is INSUFFICIENT. The notes say what the operator was DOING ("Adding Box Size and\n' +
    'Shipping"), never where the amount came from: no carrier, no quote, no invoice, no rate\n' +
    'card. A reviewer and a timestamp establish WHO and WHEN, not WHAT IT WAS DERIVED FROM.\n' +
    'One reviewer entered all 864.\n\n' +
    'Per DJ these may stand provisionally and their provenance must be reported as unknown\n' +
    'rather than fabricated retrospectively. This script therefore does not infer a source,\n' +
    'and writes no retrospective provenance.',
  );

  heading('WHAT THIS SCRIPT DID');
  console.log(
    'SELECT statements only.\n' +
    'No order, shipment, claim, ledger, billing line or override was created, changed or\n' +
    'deleted. No claim applied or closed. No inventory moved. No billing regenerated.\n' +
    'No provider contacted. Production repair, write-off, claim application/closure and\n' +
    'retrospective provenance work all remain unauthorised and unperformed.',
  );

  await sql.end();
}

main().catch(async (error) => {
  console.error('[ps-489-preview] failed:', error instanceof Error ? error.message : error);
  await sql.end().catch(() => {});
  process.exitCode = 1;
});
