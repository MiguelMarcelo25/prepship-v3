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
        when active.n > 0 then 'active_label'
        when voided.n > 0 and coalesce((o.raw->>'externallyFulfilled')::boolean, false) = false
          then 'voided_label'
        when coalesce((o.raw->>'externallyFulfilled')::boolean, false) = true
          or coalesce(o.externally_shipped, false) then 'external_label'
        else 'missing_shipment_sync'
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

  // ── Item 5: purchase → ingestion lag ────────────────────────────────────────────────
  // shipments has TWO timestamps: create_date (ShipStation's label-creation time, from the
  // payload) and created_at (DB insertion, defaultNow). Their difference IS the purchase→
  // ingestion gap — the fact that decides whether "policy at ingestion" can honestly stand
  // in for "policy at purchase". Reported for the whole window AND for the last 7 days,
  // because created_at on rows predating the column's migration reflects the backfill
  // moment, not real ingestion; recent rows carry the true steady-state lag.
  say('PURCHASE -> INGESTION LAG (created_at minus create_date, seconds)');
  for (const [label, extra] of [
    [`whole ${days}d window`, sql``],
    ['last 7 days only', sql` and s.create_date >= now() - interval '7 days'`],
  ] as const) {
    const lag = await db.execute(sql`
      select
        count(*)::text as "rows",
        round(percentile_cont(0.5) within group
          (order by extract(epoch from (s.created_at - s.create_date))))::text as "p50",
        round(percentile_cont(0.9) within group
          (order by extract(epoch from (s.created_at - s.create_date))))::text as "p90",
        round(percentile_cont(0.99) within group
          (order by extract(epoch from (s.created_at - s.create_date))))::text as "p99",
        round(max(extract(epoch from (s.created_at - s.create_date))))::text as "max"
      from shipments s
      where s.source = 'shipstation' and s.create_date >= ${since}
        and s.created_at is not null and s.create_date is not null${extra}
    `);
    const l = rowsOf(lag)[0] as unknown as Record<string, string>;
    say(`      ${String(label).padEnd(22)} rows ${l.rows}  p50 ${l.p50}s  p90 ${l.p90}s  p99 ${l.p99}s  max ${l.max}s`);
  }
  say('  The sync scheduler runs every 3 minutes (SYNC_CADENCE_MS.shipments), so steady-state');
  say('  lag should be minutes. Large values on the whole window can be column-backfill');
  say('  artefacts; the 7-day figures are the honest steady-state measure.');
  say('');

  // ── Item 5: carrier distribution (house eligibility) ────────────────────────────────
  say('CARRIER DISTRIBUTION ON SYNC ROWS (house eligibility check)');
  const carriers = await db.execute(sql`
    select coalesce(s.carrier_code, '(null)') as "bucket", count(*)::text as "rows"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
    group by 1 order by count(*) desc limit 12
  `);
  for (const b of rowsOf(carriers)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  House pricing requires a SHIPP-DIRECT purchase (directProviderKey === shipp). A');
  say('  ShipStation-synced row is by construction not a SHIPP-direct purchase, so house');
  say('  eligibility for this ingress should be NEVER; a shipp carrier code appearing here');
  say('  would challenge that and needs investigating, not assuming.');
  say('');

  // ── Item 5: purchased-provider identity is POST-HOC ─────────────────────────────────
  say('PROVIDER-ACCOUNT IDENTITY ON SYNC ROWS');
  const provider = await db.execute(sql`
    select
      case when s.provider_account_id is not null
        then 'provider_account_resolved' else 'provider_account_null' end as "bucket",
      count(*)::text as "rows"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
    group by 1 order by count(*) desc
  `);
  for (const b of rowsOf(provider)) {
    say(`      ${String(b.bucket).padEnd(26)} ${String(b.rows).padStart(6)}`);
  }
  say('  The v1 payload carries NO provider/payer identity. provider_account_id arrives via a');
  say('  LATER best-effort V2 enrichment pass (enrichProviderAccountIds), keyed on tracking');
  say('  number, only for accounts with a V2 key — the same written-later-by-a-task-allowed-');
  say('  to-fail shape as the PS-508 house sidecar. It is NOT available at the insert.');
  say('');

  // ── Item 6: redacted samples per eligibility class ──────────────────────────────────
  // Shape, not identity: internal ids, carrier/service codes, money and flags only. No
  // order numbers, no tracking numbers, no names, no addresses.
  say('REDACTED SAMPLES (3 newest per class — shape only, no order/tracking identifiers)');
  const samples = await db.execute(sql`
    with classed as (
      select s.*,
        case
          when coalesce(s.is_return, false) then 'return'
          when coalesce(s.voided, false) then 'voided'
          when s.selected_rate_cost is null then 'no_selected_cost'
          when s.selected_rate_cost <= 0 then 'zero_or_negative_cost'
          when s.order_id is null then 'unattributed_no_order'
          when s.client_id is null then 'no_client'
          else 'positive_cost_attributed'
        end as bucket
      from shipments s
      where s.source = 'shipstation' and s.create_date >= ${since}
    ), ranked as (
      select c.*, row_number() over (partition by c.bucket order by c.id desc) as rn
      from classed c
    )
    select r.bucket as "bucket", r.id as "id", r.client_id as "clientId",
      coalesce(r.carrier_code, '-') as "carrier", coalesce(r.service_code, '-') as "service",
      coalesce(r.cost::text, 'null') as "cost",
      coalesce(r.other_cost::text, 'null') as "otherCost",
      coalesce(r.selected_rate_cost::text, 'null') as "selCost",
      (r.order_id is not null) as "hasOrder",
      (r.provider_account_id is not null) as "hasProvider",
      coalesce(round(extract(epoch from (r.created_at - r.create_date)))::text, '?') as "lagS",
      exists (select 1 from billing_line_items bli where bli.shipment_id = r.id) as "hasLine"
    from ranked r where r.rn <= 3
    order by r.bucket, r.rn
  `);
  const sampleRows = (Array.isArray(samples)
    ? samples
    : ((samples as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
  let lastBucket = '';
  for (const r of sampleRows) {
    if (r.bucket !== lastBucket) { say(`    ${String(r.bucket)}:`); lastBucket = String(r.bucket); }
    say(`      id ${String(r.id).padEnd(7)} client ${String(r.clientId ?? '-').padEnd(5)} `
      + `${String(r.carrier)}/${String(r.service)}  cost ${r.cost}  other ${r.otherCost}  `
      + `sel ${r.selCost}  order ${r.hasOrder ? 'y' : 'N'}  provider ${r.hasProvider ? 'y' : 'N'}  `
      + `lag ${r.lagS}s  line ${r.hasLine ? 'y' : 'N'}`);
  }
  say('');

  // ── Evidence correction B: prove the no_selected_cost claim with grouped facts, not ids ─
  // The earlier conclusion ("all 2,277 are pre-PS-381 positive-cost history") rested on the
  // bucket's max id — and this packet itself ruled that ids are not clocks. Grouped min/max
  // on BOTH date columns is the fact. PS-381 landed a0ab4b0c, committed 2026-07-06T03:04:44Z.
  say('NO_SELECTED_COST BUCKET — GROUPED EVIDENCE (ids are not clocks)');
  const legacy = await db.execute(sql`
    select
      count(*)::text as "total",
      count(*) filter (where coalesce(s.cost, 0) + coalesce(s.other_cost, 0) > 0)::text as "positiveReceipt",
      count(*) filter (where coalesce(s.cost, 0) + coalesce(s.other_cost, 0) <= 0)::text as "zeroNullReceipt",
      count(*) filter (where s.order_id is not null and s.client_id is not null)::text as "attributed",
      min(s.create_date)::text as "minCreateDate", max(s.create_date)::text as "maxCreateDate",
      min(s.created_at)::text as "minCreatedAt", max(s.created_at)::text as "maxCreatedAt",
      min(s.id)::text as "minId", max(s.id)::text as "maxId",
      count(*) filter (where exists
        (select 1 from billing_line_items b where b.shipment_id = s.id))::text as "withLine"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
      and coalesce(s.is_return, false) = false and coalesce(s.voided, false) = false
      and s.selected_rate_cost is null
  `);
  const g = (Array.isArray(legacy)
    ? legacy
    : ((legacy as { rows?: unknown[] }).rows ?? []))[0] as Record<string, string>;
  say(`      total ${g.total}  positive-receipt ${g.positiveReceipt}  zero/null-receipt ${g.zeroNullReceipt}`);
  say(`      attributed ${g.attributed}  with-billing-line ${g.withLine}`);
  say(`      create_date  ${g.minCreateDate}  ->  ${g.maxCreateDate}`);
  say(`      created_at   ${g.minCreatedAt}  ->  ${g.maxCreatedAt}`);
  say(`      id           ${g.minId}  ->  ${g.maxId}`);
  say('  PS-381 (a0ab4b0c) was committed 2026-07-06T03:04:44Z. The pre-PS-381 claim holds only');
  say('  if max(created_at) here precedes the PS-381 DEPLOY; the commit time is the earliest');
  say('  bound on that deploy, so read max(created_at) against it.');
  say('');

  // ── Blocker-5 groundwork: receipt vs stamped selected cost disagreement ────────────────
  // The future receipt_revised_after_freeze class compares the receipt against the FROZEN
  // tuple; no sync tuples exist yet, so today's measurable precursor is receipt vs the
  // stamped selected_rate_cost column on rows that have one.
  say('RECEIPT vs SELECTED_RATE_COST DISAGREEMENT (precursor of receipt_revised_after_freeze)');
  const drift = await db.execute(sql`
    select
      count(*)::text as "stamped",
      count(*) filter (where round((coalesce(s.cost, 0) + coalesce(s.other_cost, 0))::numeric, 2)
        <> s.selected_rate_cost)::text as "disagree"
    from shipments s
    where s.source = 'shipstation' and s.create_date >= ${since}
      and s.selected_rate_cost is not null
  `);
  const d = (Array.isArray(drift)
    ? drift
    : ((drift as { rows?: unknown[] }).rows ?? []))[0] as Record<string, string>;
  say(`      stamped rows ${d.stamped}   receipt-disagrees ${d.disagree}`);
  say('  A non-zero count here measures how often ShipStation revises cost after ingestion —');
  say('  the rate at which the correction review class will fire once tuples exist.');
  say('');
  say('NEXT: none of this decides BILLABILITY. That is the blocking product-owner decision.');
}

main().catch((err) => { console.error(err); process.exit(1); });
