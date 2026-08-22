#!/usr/bin/env tsx
/**
 * PS-497 — identity-bound recovery manifest generator.  NO-APPLY. READ-ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *  THIS SCRIPT NEVER WRITES.  There is no --apply and there can never be one.
 *  It issues SELECT statements only, pins the session READ ONLY at the server, and
 *  REFUSES TO START if handed any apply-ish flag or environment variable.
 *  No claim is unlocked, replayed, applied, closed, superseded or modified.
 *  No inventory row moves.  `src/services/fulfillment-deductions.ts` is not imported.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 *
 * `docs/ps-tickets/PS-497-recovery-manifest.md` §8 assigned cohort C ("already deducted",
 * 939 claims, 2,365 units) with this test:
 *
 *     already_deducted := exists (select 1 from inventory_ledger l
 *                                  where l.order_id = claim.order_id and l.qty < 0)
 *
 * That predicate proves ONE thing: some negative movement exists somewhere on the order.
 * It does not prove the movement corresponds to
 *
 *     · this lifecycle event,          · this shipment / fulfillment occurrence,
 *     · the reconstructed line/SKU,    · the same quantity.
 *
 * Both sides of the join carry far stronger identity than `order_id`, and it was unused:
 *
 *     claims  — src/db/schema/order-lifecycle.ts:131-168
 *               lifecycle_event_id, shipment_id, line_key, sku, quantity,
 *               inventory_id, idempotency_key
 *     ledger  — src/db/schema/inventory.ts:53-85
 *               inventory_id, order_id, sku, source_entity, source_id,
 *               idempotency_key, qty
 *
 * This generator reconciles on that identity instead, reports the tier that matched for
 * every claim, and states how many of the 939 survive as genuinely already-deducted.
 *
 * ── WHY IT IS NOT scripts/ps-506-reconcile-stranded-deductions.ts ──────────────────────
 *
 * That script is a different instrument and cannot answer this question:
 *   · it reads `orders.items` (:76-105), the raw import blob, not canonical `order_items`;
 *   · it works at ORDER level — no claim, lifecycle-event or line identity anywhere;
 *   · it hard-excludes every externally-shipped order (`o.externally_shipped = false`),
 *     which is most of the PS-497 backlog;
 *   · it emits one candidate list, not the four cohorts.
 *
 * ── HOW A CANDIDATE LINE IS RECONSTRUCTED ─────────────────────────────────────────────
 *
 * 935 of the 939 cohort-C claims carry the synthetic line key
 * `review:fulfillment-lines-unavailable`, a NULL sku and a NULL inventory_id — there is no
 * stored line to replay.  Lines are therefore rebuilt from canonical `order_items`, and
 * rebuilt the way the deduction OWNER would rebuild them, so the comparison is like-for-like:
 *
 *   · grouped by lower(sku) with quantities summed
 *     — mirrors buildDeductionLines(), src/services/fulfillment-deductions.ts:57-84
 *   · inventory identity resolved client-scoped-active FIRST, then global (client_id IS NULL)
 *     active — mirrors applyClaims(), src/services/fulfillment-deductions.ts:254-286
 *
 * Both mirrorings are load-bearing, not cosmetic, and the script measures it rather than
 * asserting it.  Production holds 322 SKUs with more than one active inventory row (697 rows
 * — S12), and for 1,575 of cohort C's 1,645 candidate lines a resolver that prefers the
 * GLOBAL row instead of the client row lands on a different inventory_id (S13).  That single
 * ordering mistake mis-tiers 872 of the 939 claims and manufactures phantom
 * "never deducted" findings out of movements that plainly exist.
 *
 * ── IDENTITY TIERS (strongest first; a claim is scored by its WEAKEST line) ────────────
 *
 *   T1  ledger.idempotency_key = claim.idempotency_key            definitive
 *   T2  ledger.source_entity='fulfillment_line_claim'
 *       and ledger.source_id = claim.id                           definitive
 *   T3  ledger bound to claim.shipment_id, + sku + exact qty      occurrence-level
 *   T4  order + resolved inventory_id + exact qty                 line-level
 *   T5  order + resolved inventory_id + summed duplicate lines    line-level
 *   T6  order + sku + qty but a DIFFERENT inventory_id            identity drift
 *   ───────────────────────────── proven above / not proven below ────────────────────────
 *   T7  order + inventory_id, quantity DISAGREES                  conflict
 *   T8  order_id only — nothing at line identity                  FALSE POSITIVE of §8
 *   T9  sku resolves to no inventory row at all                   unresolvable
 *
 * ── EVIDENCE PACKET RULE (Hermes A4: measurements must not be prose-only) ──────────────
 *
 * Every statement is printed verbatim before it runs, with its row count after. The
 * transcript is the evidence: anyone can paste any statement into a read-only session and
 * get the same number without trusting this file's narration.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... npx tsx scripts/ps-497-recovery-manifest-generator.ts
 *   DATABASE_URL=... npx tsx scripts/ps-497-recovery-manifest-generator.ts --limit 100
 *   DATABASE_URL=... npx tsx scripts/ps-497-recovery-manifest-generator.ts --claim 4239
 *
 * With no DATABASE_URL it does not connect and does not crash: it prints the full statement
 * catalogue for the operator lane and exits 2 — NOT_RUN, never a clean result.
 */
import postgres from 'postgres';

// ───────────────────────────────────────────────────────────────────────────────────────
// 0. No-apply enforcement. Refuse before anything else happens.
// ───────────────────────────────────────────────────────────────────────────────────────

const APPLY_FLAGS = [
  '--apply', '--write', '--writes', '--execute', '--exec', '--commit', '--force', '--repair',
  '--fix', '--replay', '--close', '--supersede', '--unlock', '--drain', '--deduct', '--mutate',
  '--yes', '-y', '--confirm', '--go', '--live', '--for-real', '--no-dry-run',
];
const APPLY_ENV = [
  'PS497_APPLY', 'PS497_WRITE', 'PS497_REPLAY', 'PS497_FORCE', 'APPLY', 'ALLOW_WRITES',
];

function refuseApply(argv: string[]): void {
  const flagHit = argv.find((a) => APPLY_FLAGS.includes(a.toLowerCase().split('=')[0]!));
  const envHit = APPLY_ENV.find((k) => {
    const v = process.env[k];
    return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
  if (!flagHit && !envHit) return;
  console.error('');
  console.error('REFUSED — this generator has no apply mode and never will.');
  console.error(`  offending ${flagHit ? `flag: ${flagHit}` : `env var: ${envHit}`}`);
  console.error('');
  console.error('  It produces a manifest for DJ to rule on. Applying anything in it needs');
  console.error('  DJ\'s ruling AND the `unlock shipped data` override, because');
  console.error('  src/services/fulfillment-deductions.ts is a locked surface.');
  console.error('  Nothing was read and nothing was written.');
  process.exit(3);
}

refuseApply(process.argv.slice(2));

// ───────────────────────────────────────────────────────────────────────────────────────
// 1. Arguments
// ───────────────────────────────────────────────────────────────────────────────────────

type Args = { limit: number; claimId: number | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 25, claimId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--limit') args.limit = Math.max(1, Math.min(5000, Number(argv[i + 1]) || 25));
    else if (a === '--claim') args.claimId = Number(argv[i + 1]) || null;
  }
  return args;
}

// ───────────────────────────────────────────────────────────────────────────────────────
// 2. Shared reconstruction + reconciliation CTE
//
//    One definition, reused by every statement below, so no report can quietly disagree
//    with another about what a candidate line or an identity tier is.
// ───────────────────────────────────────────────────────────────────────────────────────

const MANIFEST_CTE = `
with review_claim as (
  -- every parked claim; cohort membership is decided further down, not here
  select c.id, c.order_id, c.shipment_id, c.lifecycle_event_id, c.line_key, c.sku,
         c.quantity, c.inventory_id, c.idempotency_key, c.last_error, c.direction
    from fulfillment_line_claims c
   where c.status = 'review'
),
order_facts as (
  select rc.*,
         o.client_id, o.order_number, o.order_status, o.externally_shipped,
         (select count(*) from order_items oi where oi.order_id = rc.order_id)::int
           as canonical_line_count,
         (select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = rc.order_id)::numeric
           as canonical_units,
         (select count(*) from shipments s
           where s.order_id = rc.order_id
             and coalesce(s.is_return, false) = false
             and coalesce(s.voided, false) = false)::int
           as live_outbound_shipments,
         (select count(*) from fulfillment_line_claims sib
           where sib.order_id = rc.order_id and sib.status = 'review')::int
           as sibling_review_claims,
         (select count(*) from fulfillment_line_claims ap
           where ap.order_id = rc.order_id and ap.status = 'applied')::int
           as applied_claims_on_order,
         exists (select 1 from inventory_ledger l
                  where l.order_id = rc.order_id and l.qty < 0)
           as order_level_negative_ledger
    from review_claim rc
    join orders o on o.id = rc.order_id
),
candidate_group as (
  -- CANONICAL order_items, grouped by lower(sku) with quantities summed.
  -- Mirrors buildDeductionLines() — src/services/fulfillment-deductions.ts:57-84.
  select f.id as claim_id, f.order_id, f.shipment_id, f.idempotency_key, f.client_id,
         lower(oi.sku) as sku_key, min(oi.sku) as sku,
         sum(oi.quantity)::numeric as qty, count(*)::int as source_item_rows
    from order_facts f
    join order_items oi on oi.order_id = f.order_id
   where nullif(trim(oi.sku), '') is not null
   group by f.id, f.order_id, f.shipment_id, f.idempotency_key, f.client_id, lower(oi.sku)
),
candidate_line as (
  -- Inventory identity resolved the way the deduction owner resolves it:
  -- client-scoped active row FIRST, then the global (client_id IS NULL) active row.
  -- Mirrors applyClaims() — src/services/fulfillment-deductions.ts:254-286.
  select g.*,
         coalesce(
           (select i.id from inventory i
             where i.client_id = g.client_id and lower(i.sku) = g.sku_key and i.active
             order by i.id limit 1),
           (select i.id from inventory i
             where i.client_id is null and lower(i.sku) = g.sku_key and i.active
             order by i.id limit 1)
         ) as inventory_id
    from candidate_group g
),
line_identity as (
  select l.*,
    case
      -- T1 definitive: this exact claim's idempotency key produced a movement
      when exists (select 1 from inventory_ledger g
                    where g.idempotency_key = l.idempotency_key and g.qty < 0) then 1
      -- T2 definitive: a movement names this claim id as its source entity
      when exists (select 1 from inventory_ledger g
                    where g.source_entity = 'fulfillment_line_claim'
                      and g.source_id = l.claim_id::text
                      and g.qty < 0
                      and g.inventory_id = l.inventory_id) then 2
      -- T3 occurrence-level: movement bound to THIS shipment, same sku, same qty
      when l.shipment_id is not null and exists (
             select 1 from inventory_ledger g
              where g.qty < 0
                and (g.source_id like ('shipment:' || l.shipment_id || ':%')
                     or (g.source_entity = 'shipment' and g.source_id = l.shipment_id::text))
                and (g.inventory_id = l.inventory_id or lower(g.sku) = l.sku_key)
                and abs(g.qty) = l.qty) then 3
      -- T4 line-level: same order, same resolved inventory row, same quantity
      when l.inventory_id is not null and exists (
             select 1 from inventory_ledger g
              where g.order_id = l.order_id and g.qty < 0
                and g.inventory_id = l.inventory_id and abs(g.qty) = l.qty) then 4
      -- T5 line-level: same order + inventory row, quantity matches once duplicate
      --     order_items rows for the SKU are summed the way the deduction path sums them
      when l.inventory_id is not null and (
             select coalesce(sum(abs(g.qty)), 0) from inventory_ledger g
              where g.order_id = l.order_id and g.qty < 0
                and g.inventory_id = l.inventory_id) = l.qty then 5
      -- T6 identity drift: the sku and quantity match, but the movement landed on a
      --     different inventory row than today's resolver picks (duplicate active SKU rows)
      when exists (select 1 from inventory_ledger g
                     left join inventory i2 on i2.id = g.inventory_id
                    where g.order_id = l.order_id and g.qty < 0
                      and lower(coalesce(g.sku, i2.sku)) = l.sku_key
                      and abs(g.qty) = l.qty) then 6
      -- T7 conflict: right inventory row, wrong quantity — NOT proof
      when l.inventory_id is not null and exists (
             select 1 from inventory_ledger g
              where g.order_id = l.order_id and g.qty < 0
                and g.inventory_id = l.inventory_id) then 7
      -- T9 the reconstructed sku resolves to no inventory row at all
      when l.inventory_id is null then 9
      -- T8 a negative movement exists on the order and NOTHING about this line matches it.
      --     This is exactly what the PS-497-recovery-manifest.md §8 predicate counted as
      --     "already deducted".
      else 8
    end as tier
    from candidate_line l
),
claim_verdict as (
  select f.id as claim_id, f.order_id, f.shipment_id, f.lifecycle_event_id, f.client_id,
         f.order_number, f.externally_shipped, f.quantity as claim_quantity,
         f.canonical_line_count, f.canonical_units, f.live_outbound_shipments,
         f.sibling_review_claims, f.applied_claims_on_order, f.order_level_negative_ledger,
         count(li.claim_id)::int as candidate_lines,
         coalesce(max(li.tier), 0) as worst_tier,
         coalesce(min(li.tier), 0) as best_tier,
         coalesce(sum(li.qty), 0)::numeric as candidate_units
    from order_facts f
    left join line_identity li on li.claim_id = f.id
   group by f.id, f.order_id, f.shipment_id, f.lifecycle_event_id, f.client_id,
            f.order_number, f.externally_shipped, f.quantity, f.canonical_line_count,
            f.canonical_units, f.live_outbound_shipments, f.sibling_review_claims,
            f.applied_claims_on_order, f.order_level_negative_ledger
),
cohorted as (
  select v.*,
         -- CORRECTED cohort assignment. The difference from §8 is one clause:
         -- membership of C now requires an identity match at tier <= 6, not merely a
         -- negative ledger row somewhere on the order.
         case
           when v.canonical_line_count = 0 or v.candidate_lines = 0 then 'D_no_line_data'
           when v.worst_tier <= 6                                   then 'C_already_deducted'
           when v.claim_quantity is distinct from v.canonical_units then 'B_qty_conflict'
           else                                                          'A_clean_replayable'
         end as cohort,
         -- the discredited §8 test, kept alongside so the two can be crosswalked
         case
           when v.canonical_line_count = 0                          then 'D_no_line_data'
           when v.order_level_negative_ledger                       then 'C_already_deducted'
           when v.claim_quantity is distinct from v.canonical_units then 'B_qty_conflict'
           else                                                          'A_clean_replayable'
         end as legacy_cohort
    from claim_verdict v
)`;

const TIER_LABEL = `case worst_tier
    when 1 then 'T1  ledger.idempotency_key = claim.idempotency_key   [definitive]'
    when 2 then 'T2  ledger.source_id = claim.id                      [definitive]'
    when 3 then 'T3  shipment occurrence + sku + exact qty            [occurrence]'
    when 4 then 'T4  order + inventory_id + exact qty                 [line]'
    when 5 then 'T5  order + inventory_id + summed duplicate lines    [line]'
    when 6 then 'T6  order + sku + qty, DIFFERENT inventory row       [identity drift]'
    when 7 then 'T7  order + inventory_id, QTY MISMATCH               [conflict - NOT proven]'
    when 8 then 'T8  order_id only                                    [FALSE POSITIVE of §8]'
    when 9 then 'T9  sku resolves to no inventory row                 [unresolvable]'
    else        'T-  no candidate line reconstructed'
  end`;

// ───────────────────────────────────────────────────────────────────────────────────────
// 3. Statement catalogue
// ───────────────────────────────────────────────────────────────────────────────────────

type Stmt = { id: string; title: string; sql: string; params: unknown[] };

function buildStatements(args: Args): Stmt[] {
  const stmts: Stmt[] = [
    {
      id: 'S01',
      title: 'Preflight — where this ran, and that the session cannot write',
      params: [],
      sql: `select current_database()::text as database,
       current_user::text as db_user,
       now()::text as read_at,
       current_setting('transaction_read_only') as session_read_only`,
    },
    {
      id: 'S02',
      title: 'Population — every claim in review, by lifecycle source',
      params: [],
      sql: `select e.source,
       count(*)::int as review_claims,
       count(distinct c.order_id)::int as orders,
       count(*) filter (where c.sku is null)::int as no_sku_on_claim,
       count(*) filter (where c.inventory_id is null)::int as no_inventory_id_on_claim
  from fulfillment_line_claims c
  join order_lifecycle_events e on e.id = c.lifecycle_event_id
 where c.status = 'review'
 group by e.source
 order by 2 desc`,
    },
    {
      id: 'S03',
      title: 'Baseline — the four cohorts EXACTLY as PS-497-recovery-manifest.md §8 computed them',
      params: [],
      sql: `${MANIFEST_CTE}
select legacy_cohort as cohort,
       count(*)::int as claims,
       count(distinct order_id)::int as orders
  from cohorted
 group by 1
 order by 1`,
    },
    {
      id: 'S04',
      title: 'Why claim-side identity alone cannot answer it — what the legacy cohort C carries',
      params: [],
      sql: `${MANIFEST_CTE}
select count(*)::int as legacy_cohort_c_claims,
       count(*) filter (where c.line_key = 'review:fulfillment-lines-unavailable')::int
         as synthetic_placeholder_line_key,
       count(*) filter (where c.sku is null)::int          as null_sku,
       count(*) filter (where c.inventory_id is null)::int as null_inventory_id,
       count(*) filter (where c.quantity is null)::int     as null_quantity,
       count(*) filter (where c.shipment_id is null)::int  as null_shipment_id,
       count(*) filter (where exists (select 1 from inventory_ledger g
                                       where g.idempotency_key = c.idempotency_key))::int
         as t1_claim_idempotency_key_in_ledger,
       count(*) filter (where exists (select 1 from inventory_ledger g
                                       where g.source_entity = 'fulfillment_line_claim'
                                         and g.source_id = c.id::text))::int
         as t2_claim_id_named_by_a_movement
  from cohorted co
  join fulfillment_line_claims c on c.id = co.claim_id
 where co.legacy_cohort = 'C_already_deducted'`,
    },
    {
      id: 'S05',
      title: 'Ledger-side identity available on negative movements',
      params: [],
      sql: `select coalesce(source_entity, '(null - legacy, pre-PS-439)') as source_entity,
       type,
       count(*)::int as negative_rows,
       count(idempotency_key)::int as with_idempotency_key,
       count(sku)::int             as with_sku,
       count(source_id)::int       as with_source_id,
       count(order_id)::int        as with_order_id,
       min(created_at)::text as first_seen,
       max(created_at)::text as last_seen
  from inventory_ledger
 where qty < 0
 group by 1, 2
 order by 3 desc`,
    },
    {
      id: 'S06',
      title: 'CORRECTED reconciliation — identity tier per reconstructed candidate line',
      params: [],
      sql: `${MANIFEST_CTE},
lines as (select li.*, co.legacy_cohort from line_identity li join cohorted co on co.claim_id = li.claim_id)
select tier,
       count(*)::int as candidate_lines,
       count(distinct claim_id)::int as claims,
       count(distinct order_id)::int as orders,
       sum(qty)::numeric as units
  from lines
 where legacy_cohort = 'C_already_deducted'
 group by 1
 order by 1`,
    },
    {
      id: 'S07',
      title: 'CORRECTED reconciliation — identity tier per CLAIM (scored by its WEAKEST line)',
      params: [],
      sql: `${MANIFEST_CTE}
select worst_tier as tier,
       ${TIER_LABEL} as identity_tier,
       count(*)::int as claims,
       count(distinct order_id)::int as orders,
       sum(candidate_units)::numeric as units
  from cohorted
 where legacy_cohort = 'C_already_deducted'
 group by 1, 2
 order by 1`,
    },
    {
      id: 'S08',
      title: 'THE ANSWER — of the 939, how many are provably the same movement',
      params: [],
      sql: `${MANIFEST_CTE}
select case when worst_tier between 1 and 6
            then 'PROVEN already deducted at line identity or stronger'
            else 'NOT PROVEN — false positive of the order-level §8 test' end as verdict,
       count(*)::int as claims,
       count(distinct order_id)::int as orders,
       sum(candidate_units)::numeric as units,
       round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2)::text || ' %' as share
  from cohorted
 where legacy_cohort = 'C_already_deducted'
 group by 1
 order by 2 desc`,
    },
    {
      id: 'S09',
      title: 'Crosswalk — where every legacy cohort claim lands under the corrected classifier',
      params: [],
      sql: `${MANIFEST_CTE}
select legacy_cohort, cohort as corrected_cohort,
       count(*)::int as claims,
       count(distinct order_id)::int as orders
  from cohorted
 group by 1, 2
 order by 1, 2`,
    },
    {
      id: 'S10',
      title: 'CORRECTED four cohorts',
      params: [],
      sql: `${MANIFEST_CTE}
select cohort,
       count(*)::int as claims,
       count(distinct order_id)::int as orders,
       sum(candidate_units)::numeric as units_if_applied,
       count(*) filter (where externally_shipped)::int as externally_shipped,
       count(*) filter (where not externally_shipped)::int as prepship_fulfilled
  from cohorted
 group by 1
 order by 1`,
    },
    {
      id: 'S11',
      title: 'RESIDUAL AMBIGUITY the tier ladder cannot remove — occurrence, not line',
      params: [],
      sql: `${MANIFEST_CTE}
select count(*)::int as proven_claims,
       count(*) filter (where sibling_review_claims > 1)::int
         as claims_whose_proof_is_shared_with_a_sibling_review_claim,
       count(distinct order_id) filter (where sibling_review_claims > 1)::int
         as orders_carrying_those_siblings,
       count(*) filter (where applied_claims_on_order > 0)::int
         as claims_on_an_order_that_also_has_an_APPLIED_claim,
       count(*) filter (where live_outbound_shipments = 1)::int
         as claims_whose_order_has_exactly_one_live_outbound_shipment,
       count(*) filter (where live_outbound_shipments <> 1)::int
         as claims_whose_order_is_split_or_shipmentless
  from cohorted
 where legacy_cohort = 'C_already_deducted' and worst_tier between 1 and 6`,
    },
    {
      id: 'S12',
      title: 'Inventory identity drift exposure — duplicate active rows for one SKU',
      params: [],
      sql: `select count(*)::int as sku_keys_with_more_than_one_active_inventory_row,
       coalesce(sum(n), 0)::int as inventory_rows_involved
  from (select lower(sku) as k, count(*) as n
          from inventory where active group by 1 having count(*) > 1) d`,
    },
    {
      id: 'S13',
      title:
        'Counterfactual — what a resolver that did NOT mirror the deduction owner would report',
      params: [],
      sql: `with review_claim as (select c.* from fulfillment_line_claims c where c.status = 'review'),
     cohort_c as (
       select rc.id, rc.order_id, o.client_id
         from review_claim rc join orders o on o.id = rc.order_id
        where (select count(*) from order_items oi where oi.order_id = rc.order_id) > 0
          and exists (select 1 from inventory_ledger l where l.order_id = rc.order_id and l.qty < 0)),
     g as (
       select c.id as claim_id, c.order_id, c.client_id, lower(oi.sku) as sku_key
         from cohort_c c join order_items oi on oi.order_id = c.order_id
        where nullif(trim(oi.sku), '') is not null
        group by 1, 2, 3, 4),
     resolved as (
       select g.*,
         coalesce(
           (select i.id from inventory i where i.client_id = g.client_id and lower(i.sku) = g.sku_key and i.active order by i.id limit 1),
           (select i.id from inventory i where i.client_id is null and lower(i.sku) = g.sku_key and i.active order by i.id limit 1)
         ) as owner_resolution,
         coalesce(
           (select i.id from inventory i where i.client_id is null and lower(i.sku) = g.sku_key and i.active order by i.id limit 1),
           (select i.id from inventory i where i.client_id = g.client_id and lower(i.sku) = g.sku_key and i.active order by i.id limit 1)
         ) as global_first_resolution
       from g)
select count(*)::int as cohort_c_candidate_lines,
       count(*) filter (where owner_resolution is distinct from global_first_resolution)::int
         as lines_a_global_first_resolver_points_at_the_WRONG_inventory_row,
       count(distinct claim_id) filter (where owner_resolution is distinct from global_first_resolution)::int
         as claims_that_would_be_mis_tiered`,
    },
    {
      id: 'S14',
      title: `Per-claim manifest rows (worst tier first, limit ${args.limit})`,
      params: [args.limit],
      sql: `${MANIFEST_CTE}
select claim_id, order_id, order_number, shipment_id, lifecycle_event_id,
       legacy_cohort, cohort as corrected_cohort,
       worst_tier, best_tier, candidate_lines, candidate_units,
       claim_quantity, canonical_units, live_outbound_shipments,
       sibling_review_claims, applied_claims_on_order, externally_shipped
  from cohorted
 where legacy_cohort = 'C_already_deducted'
 order by worst_tier desc, sibling_review_claims desc, claim_id asc
 limit $1`,
    },
  ];

  if (args.claimId != null) {
    stmts.push({
      id: 'S15',
      title: `Full evidence for claim ${args.claimId} — every reconstructed line and its tier`,
      params: [args.claimId],
      sql: `${MANIFEST_CTE}
select li.claim_id, li.order_id, li.shipment_id, li.sku, li.sku_key, li.qty,
       li.source_item_rows, li.inventory_id, li.tier
  from line_identity li
 where li.claim_id = $1
 order by li.sku_key`,
    });
    stmts.push({
      id: 'S16',
      title: `Full evidence for claim ${args.claimId} — every negative ledger row on its order`,
      params: [args.claimId],
      sql: `select l.id as ledger_id, l.inventory_id, l.sku, l.qty, l.type,
       l.source_entity, l.source_id, l.idempotency_key, l.note, l.created_at::text
  from inventory_ledger l
 where l.qty < 0
   and l.order_id = (select order_id from fulfillment_line_claims where id = $1)
 order by l.id`,
    });
  }

  return stmts;
}

// ───────────────────────────────────────────────────────────────────────────────────────
// 4. Output helpers — deterministic, paste-able tables
// ───────────────────────────────────────────────────────────────────────────────────────

const RULE = '─'.repeat(96);

function banner(title: string): void {
  console.log(`\n${'═'.repeat(96)}\n${title}\n${'═'.repeat(96)}`);
}

function render(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('    (no rows)');
    return;
  }
  const cols = Object.keys(rows[0]!);
  const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => text(r[c]).length)));
  const line = (cells: string[]): string =>
    `    ${cells.map((cell, i) => cell.padEnd(width[i]!)).join('  ')}`.trimEnd();
  console.log(line(cols));
  console.log(line(width.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(cols.map((c) => text(row[c]))));
}

function printStatement(stmt: Stmt): void {
  console.log(`\n${RULE}`);
  console.log(`${stmt.id}  ${stmt.title}`);
  if (stmt.params.length) console.log(`params: ${JSON.stringify(stmt.params)}`);
  console.log(RULE);
  for (const l of stmt.sql.split('\n')) console.log(`  | ${l}`);
}

function header(): void {
  console.log(RULE);
  console.log('PS-497 — IDENTITY-BOUND RECOVERY MANIFEST GENERATOR');
  console.log('mode      : NO-APPLY, READ-ONLY. SELECT statements only.');
  console.log('guarantee : no claim unlocked/replayed/applied/closed/superseded, no inventory');
  console.log('            movement, no billing action, no migration, no provider call.');
  console.log('corrects  : docs/ps-tickets/PS-497-recovery-manifest.md §8, whose cohort-C test');
  console.log('            `exists(negative inventory_ledger row for order_id)` proves only that');
  console.log('            SOME movement exists on the order — not that it is THIS lifecycle');
  console.log('            event, THIS shipment, THIS line/SKU, or THIS quantity.');
  console.log(RULE);
}

// ───────────────────────────────────────────────────────────────────────────────────────
// 5. Main
// ───────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const statements = buildStatements(args);
  const url = process.env.DATABASE_URL;

  header();

  if (!url) {
    console.log('\nDATABASE_URL is not set — NOT CONNECTED, NOTHING MEASURED.');
    console.log('This is NOT_RUN, not a clean result. The statement catalogue below is printed');
    console.log('verbatim so the operator lane (Render one-off, read-only role) can reproduce');
    console.log('every number by hand.\n');
    for (const stmt of statements) printStatement(stmt);
    console.log(`\n${RULE}`);
    console.log(`NOT_RUN — ${statements.length} statements printed, 0 executed, 0 rows read.`);
    console.log(RULE);
    process.exit(2);
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const counts: { id: string; rows: number }[] = [];

  try {
    // Server-enforced: the database itself refuses a write regardless of what this asks for.
    await sql.unsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const results = new Map<string, Record<string, unknown>[]>();
    for (const stmt of statements) {
      printStatement(stmt);
      const rows = (await sql.unsafe(stmt.sql, stmt.params as never[])) as unknown as Record<
        string,
        unknown
      >[];
      results.set(stmt.id, rows);
      counts.push({ id: stmt.id, rows: rows.length });
      console.log(`rows: ${rows.length}`);
      render(rows);
    }

    // ── headline, computed from S08's rows only ────────────────────────────────────────
    banner('CORRECTED COHORT C — THE HEADLINE');
    const verdicts = results.get('S08') ?? [];
    const proven = verdicts.find((r) => String(r.verdict).startsWith('PROVEN'));
    const notProven = verdicts.find((r) => String(r.verdict).startsWith('NOT PROVEN'));
    const provenClaims = Number(proven?.claims ?? 0);
    const falseClaims = Number(notProven?.claims ?? 0);
    console.log(`  legacy cohort C (§8, order-level test) : ${provenClaims + falseClaims} claims`);
    console.log(`  provably the SAME movement (T1-T6)     : ${provenClaims} claims`);
    console.log(`  false positives of the §8 test (T7-T9) : ${falseClaims} claims`);

    banner('WHAT IS STILL NOT PROVEN, EVEN AFTER THIS CORRECTION');
    console.log('  Line identity answers "was this SKU and quantity deducted on this order".');
    console.log('  It does NOT answer "which lifecycle event owns that movement". S11 measures');
    console.log('  the residue: claims whose proof is a movement set shared with a sibling');
    console.log('  review claim, and claims sitting on an order that also carries an APPLIED');
    console.log('  claim — direct evidence the movement was created by a different claim.');
    console.log('  Those cannot be closed as superseded on this evidence alone.');

    banner('WHAT THIS SCRIPT DID');
    console.log(`  ${counts.length} SELECT statements, printed verbatim above with row counts:`);
    console.log(`    ${counts.map((c) => `${c.id}=${c.rows}`).join('  ')}`);
    console.log('  No INSERT / UPDATE / DELETE / DDL. No temp table. No claim applied, closed,');
    console.log('  drained, unlocked or altered. No inventory moved. No billing regenerated.');
    console.log('  No provider contacted. Session pinned READ ONLY at the server.');
    console.log('  Applying anything in this manifest still requires DJ\'s ruling AND the');
    console.log('  `unlock shipped data` override — fulfillment-deductions.ts is locked.');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[ps-497-manifest] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
