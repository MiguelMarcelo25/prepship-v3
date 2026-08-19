import { sql } from 'drizzle-orm';

/**
 * PS-509 packet item 3 — population classification of the ShipStation sync ingress.
 * STRICTLY READ-ONLY. SELECTs only, session pinned READ ONLY at the server.
 *
 * Answers: of the rows the sync path produces, which could carry customer money, which
 * correctly cannot, and which are already represented in billing.
 *
 * ── WHY "Ext. Label" IS NOT A BUCKET HERE ───────────────────────────────────────────────
 *
 * `external_label` is an ORDER-level DISPLAY state (shipped-label-display-state.ts): it means
 * no ACTIVE shipment row exists AND either ShipStation reported externallyFulfilled, or the
 * externally_shipped override is set. Those orders therefore have no shipment row to classify —
 * they cannot appear in a shipments population at all.
 *
 * That is why the PS-508 coverage audit honestly reported `excluded: 0` while the operator UI
 * was visibly full of Ext. Label rows, and why an earlier reading of mine — that they were
 * shipments with no cost — was wrong. They are counted here at ORDER level, separately, so the
 * two populations are never conflated again.
 *
 * ── OPERATOR GATE / WHERE THIS RUNS ─────────────────────────────────────────────────────
 *
 * A Render one-off job, dispatched from the workflow. PS509_AUDIT_OPERATOR carries the
 * authenticated github.actor. db/client is imported dynamically, AFTER the gate, so the refusal
 * is reachable rather than pre-empted by env validation at module load.
 */

const TAG = 'PS509RPT ';
function say(line = ''): void {
  console.log(String(line).split('\n').map((part) => `${TAG}${part}`).join('\n'));
}

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

type Bucket = { bucket: string; rows: string | number };

function rowsOf(result: unknown): Bucket[] {
  return (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as Bucket[];
}

async function main(): Promise<void> {
  const operator = process.env.PS509_AUDIT_OPERATOR;
  if (!operator) {
    console.error('REFUSED: set PS509_AUDIT_OPERATOR to the person running this.');
    process.exit(2);
  }
  const days = Number(arg('days') ?? '90');
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be positive');

  const { db, sql: pg } = await import('../src/db/client');
  await pg.unsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  const since = sql`now() - ${`${days} days`}::interval`;

  say('PS-509 ShipStation ingress population classification');
  say(`operator: ${operator}   window: last ${days} day(s)`);
  say('READ-ONLY: this run issued SELECTs only. No row limit — these are grouped counts.');
  say('');

  // ── Shipment-level classification, sync rows only ───────────────────────────────────
  // Mutually exclusive by construction: the CASE takes the first matching branch, so a
  // voided return counts once, as a return. Overlapping buckets would let one row inflate
  // several counts and make the totals unreadable.
  say(`SYNC SHIPMENT ROWS (source = 'shipstation', last ${days} day(s))`);
  const shipmentBuckets = await db.execute(sql`
    select
      case
        when coalesce(s.is_return, false) then 'return'
        when coalesce(s.voided, false) then 'voided'
        when s.selected_rate_cost is null then 'no_selected_cost'
        when s.selected_rate_cost <= 0 then 'zero_or_negative_cost'
        when s.order_id is null then 'unattributed_no_order'
        when s.client_id is null then 'no_client'
        else 'positive_cost_attributed'
      end as "bucket",
      count(*)::text as "rows"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
    group by 1
    order by count(*) desc
  `);
  for (const b of rowsOf(shipmentBuckets)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  Mutually exclusive: first matching branch wins, so a voided return counts once.');
  say('  positive_cost_attributed is the CANDIDATE population — candidate, not billable.');
  say('  Billability is a product-owner decision; source and cost alone cannot decide it.');
  say('');

  // ── Does a sync row already carry a tuple? ──────────────────────────────────────────
  say('TUPLE PRESENCE ON SYNC ROWS');
  const tuplePresence = await db.execute(sql`
    select
      case
        when s.selected_rate_json is null then 'no_json_at_all'
        when not (coalesce(s.selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion')
          then 'json_without_version_key'
        else coalesce(s.selected_rate_json->>'customerShippingMoneyPolicyVersion', 'unreadable')
      end as "bucket",
      count(*)::text as "rows"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
    group by 1
    order by count(*) desc
  `);
  for (const b of rowsOf(tuplePresence)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  Any policy version appearing here would be unexpected: no sync-path writer exists.');
  say('');

  // ── Already represented in billing ──────────────────────────────────────────────────
  // Matters because a row already carrying an invoiced line is financial history. PS-509
  // must not manufacture a competing freeze for it, and the historical-handling step
  // treats it as preserve-not-repair.
  say('SYNC ROWS ALREADY REPRESENTED IN BILLING');
  const billed = await db.execute(sql`
    select
      case
        when bli.id is null then 'no_billing_line'
        when coalesce(bli.invoiced, false) then 'invoiced'
        else 'line_exists_not_invoiced'
      end as "bucket",
      count(distinct s.id)::text as "rows"
    from shipments s
    left join billing_line_items bli on bli.shipment_id = s.id
    where s.source = 'shipstation' and s.create_date >= ${since}
    group by 1
    order by count(distinct s.id) desc
  `);
  for (const b of rowsOf(billed)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  invoiced rows are immutable financial history: preserve, never re-freeze.');
  say('');

  // ── Order-level external-label population ───────────────────────────────────────────
  // A DIFFERENT population, counted separately and deliberately. These orders have no
  // active shipment row, so they are absent from every count above.
  say(`ORDER-LEVEL EXTERNAL/NO-SHIPMENT POPULATION (last ${days} day(s))`);
  const orderLevel = await db.execute(sql`
    select
      case
        when active.n > 0 then 'has_active_shipment'
        when coalesce(o.externally_shipped, false) then 'external_label_override'
        when voided.n > 0 then 'only_voided_shipment'
        else 'no_shipment_row'
      end as "bucket",
      count(*)::text as "rows"
    from orders o
    left join lateral (
      select count(*) as n from shipments s
      where s.order_id = o.id and coalesce(s.voided, false) = false
    ) active on true
    left join lateral (
      select count(*) as n from shipments s
      where s.order_id = o.id and coalesce(s.voided, false) = true
    ) voided on true
    where o.order_status = 'shipped' and o.created_at >= ${since}
    group by 1
    order by count(*) desc
  `);
  for (const b of rowsOf(orderLevel)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  external_label is an ORDER display state, not a shipment property: it means no');
  say('  ACTIVE shipment row exists. Such orders cannot appear in the shipment counts above,');
  say('  which is why the PS-508 coverage audit correctly reported zero exclusions while the');
  say('  operator UI showed Ext. Label rows.');
  say('');
  say('NEXT: none of this decides BILLABILITY. That is the blocking product-owner decision.');
}

main().catch((err) => { console.error(err); process.exit(1); });
