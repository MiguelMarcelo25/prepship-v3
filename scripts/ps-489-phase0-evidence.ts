/**
 * PS-489 Phase 0 — classification evidence runner. READ-ONLY.
 *
 * Every statement runs inside ONE
 *   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
 * so all sections observe a single immutable snapshot. READ ONLY is enforced by
 * Postgres, not by convention: any DDL/DML in this file would abort the transaction.
 *
 * Exits NONZERO if any assertion reports FAIL. That is the point — a reconciliation
 * check that only prints FAIL and exits 0 is not an assertion.
 *
 * Run:  npx tsx scripts/ps-489-phase0-evidence.ts
 *
 * Row grain: one `orders` row = one order. Never a billing line, never a shipment.
 *
 * DENOMINATOR CAVEAT: the population uses literal `orders.order_status = 'shipped'`.
 * It does NOT use the lifecycle-effective status owner (order-lifecycle-status.ts).
 * Cancelled, upstream-cancelled, and differently-projected externally-flagged orders
 * are therefore absent from this denominator.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

// prepare:false — Supavisor transaction pooler cannot carry prepared statements.
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

/**
 * The population predicate, adopted verbatim in shape from
 * shipment-sync-watchdog.ts:654-670: linked by shipments.order_id OR by orphan
 * shipments.order_number, in both arms excluding source='replacement', voided,
 * and is_return.
 *
 * The orphan arm is NOT a proven identity. See the ORPHAN section: every order it
 * excludes has an order_number shared by more than one order, so the match cannot
 * attribute an orphan shipment to a specific order. Reported, not silently trusted.
 */
const BASE = `
  base as (
    select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged, o.updated_at
    from orders o where o.order_status = 'shipped'
  ),
  pop as (
    select b.* from base b
    where not exists (
      select 1 from shipments s where s.order_id = b.id
        and s.source is distinct from 'replacement'
        and coalesce(s.voided,false) = false and coalesce(s.is_return,false) = false)
      and not exists (
      select 1 from shipments s where s.order_id is null and s.order_number = b.order_number
        and s.source is distinct from 'replacement'
        and coalesce(s.voided,false) = false and coalesce(s.is_return,false) = false)
  )`;

/**
 * Raw per-order shipment facts. Q4 classifies from THESE, never from a CASE ladder
 * over overlapping predicates — a ladder that tests voided-only first silently
 * absorbs voided+return and voided+replacement rows and manufactures zeros.
 */
const FACTS = `
  facts as (
    select p.id, p.flagged, p.order_number,
      (select count(*) from shipments s where s.order_id = p.id) as rows_by_order_id,
      coalesce((select bool_or(coalesce(s.voided,false))       from shipments s where s.order_id=p.id),false) as any_voided,
      coalesce((select bool_or(not coalesce(s.voided,false))    from shipments s where s.order_id=p.id),false) as any_nonvoided,
      coalesce((select bool_or(coalesce(s.is_return,false))    from shipments s where s.order_id=p.id),false) as any_return,
      coalesce((select bool_or(s.source = 'replacement')       from shipments s where s.order_id=p.id),false) as any_replacement,
      exists (select 1 from shipments s where s.order_id is null and s.order_number = p.order_number) as any_orphan_history
    from pop p
  )`;

type Row = Record<string, unknown>;
const out: Array<{ section: string; rows: Row[] }> = [];
const assertions: Array<{ name: string; pass: boolean; detail: string }> = [];

function assert(name: string, pass: boolean, detail: string) {
  assertions.push({ name, pass, detail });
}

async function main() {
  await sql.begin(async (tx) => {
    // One snapshot for every section below.
    await tx.unsafe('set transaction isolation level repeatable read read only');

    const [snap] = await tx.unsafe(`
      select to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')||' UTC' as started_utc,
             current_database() as database,
             substring(version() from 'PostgreSQL [0-9.]+') as engine,
             pg_export_snapshot() as snapshot_id,
             (select hash from drizzle.__drizzle_migrations
               order by created_at desc limit 1) as migration_head,
             (select count(*) from drizzle.__drizzle_migrations) as migrations_applied`);
    out.push({ section: '0. snapshot identity', rows: [snap] });

    // --- Q1 transition matrix. Both totals are DERIVED from these four buckets.
    const q1 = await tx.unsafe(`
      with ${BASE},
      flags as (
        select b.id,
          not exists (select 1 from shipments s where s.order_id=b.id) as naive_missing,
          (b.id in (select id from pop)) as correct_missing
        from base b
      )
      select naive_missing, correct_missing, count(*)::int as orders
      from flags group by 1,2 order by 1 desc, 2 desc`);
    out.push({ section: '1. predicate transition matrix', rows: q1 });

    const n = (nm: boolean, cm: boolean) =>
      Number(q1.find((r) => r.naive_missing === nm && r.correct_missing === cm)?.orders ?? 0);
    const unchanged = n(true, true), excludedByOrphan = n(true, false);
    const inactiveOnly = n(false, true), unaffected = n(false, false);
    const naiveTotal = unchanged + excludedByOrphan;
    const correctTotal = unchanged + inactiveOnly;

    // --- Q2 population
    const [q2] = await tx.unsafe(`
      with ${BASE}
      select (select count(*)::int from base) as literal_shipped_total,
             (select count(*)::int from pop)  as no_active_outbound,
             (select count(*)::int from pop where flagged)     as flagged,
             (select count(*)::int from pop where not flagged) as unflagged,
             (select count(distinct id)::int from pop)         as distinct_ids`);
    out.push({ section: '2. population', rows: [q2] });

    assert('population rows are distinct orders',
      Number(q2.no_active_outbound) === Number(q2.distinct_ids),
      `${q2.no_active_outbound} vs ${q2.distinct_ids}`);
    assert('transition matrix sums to literal shipped denominator',
      unchanged + excludedByOrphan + inactiveOnly + unaffected === Number(q2.literal_shipped_total),
      `${unchanged + excludedByOrphan + inactiveOnly + unaffected} vs ${q2.literal_shipped_total}`);
    assert('corrected population is derived from the matrix',
      correctTotal === Number(q2.no_active_outbound),
      `${unchanged} + ${inactiveOnly} = ${correctTotal} vs ${q2.no_active_outbound}`);
    assert('naive total is derived from the matrix',
      naiveTotal === unchanged + excludedByOrphan,
      `${unchanged} + ${excludedByOrphan} = ${naiveTotal}`);
    assert('flagged + unflagged = corrected population',
      Number(q2.flagged) + Number(q2.unflagged) === Number(q2.no_active_outbound),
      `${q2.flagged} + ${q2.unflagged} vs ${q2.no_active_outbound}`);

    // --- Q3 provenance. Classifier-declared requires the EXACT event source, and any
    // other external_shipped writer gets its own bucket rather than being absorbed.
    const q3 = await tx.unsafe(`
      with ${BASE},
      cls as (
        select p.id, p.flagged,
          (select count(*) from order_lifecycle_events le where le.order_id=p.id)::int as ev,
          exists (select 1 from order_lifecycle_events le where le.order_id=p.id
                  and le.transition='external_shipped'
                  and le.source='external_shipped_classifier') as ext_classifier,
          exists (select 1 from order_lifecycle_events le where le.order_id=p.id
                  and le.transition='external_shipped'
                  and le.source is distinct from 'external_shipped_classifier') as ext_other,
          exists (select 1 from order_lifecycle_events le where le.order_id=p.id
                  and le.transition='void') as has_void,
          exists (select 1 from order_lifecycle_events le where le.order_id=p.id
                  and le.source='order_sync_status') as has_status_only
        from pop p
      )
      select
        case
          when ext_classifier and ext_other then '1b_external_mixed_sources'
          when ext_classifier then '1_classifier_declared_external'
          when ext_other      then '1c_external_other_source'
          when has_void       then '2_void_lifecycle_history'
          when ev>0 and has_status_only then '3_status_only_shipped'
          when ev>0           then '4_other_event_pattern'
          when flagged        then '5_flagged_no_receipt'
          else                     '6_unflagged_no_receipt'
        end as provenance_class,
        count(*)::int as orders
      from cls group by 1 order by 1`);
    out.push({ section: '3. provenance partition (mutually exclusive)', rows: q3 });

    const q3sum = q3.reduce((a, r) => a + Number(r.orders), 0);
    assert('provenance partition sums to population',
      q3sum === Number(q2.no_active_outbound), `${q3sum} vs ${q2.no_active_outbound}`);

    const [srcContract] = await tx.unsafe(`
      with ${BASE}
      select
        count(*) filter (where exists (select 1 from order_lifecycle_events le
          where le.order_id=p.id and le.transition='external_shipped'))::int as any_external_event,
        count(*) filter (where exists (select 1 from order_lifecycle_events le
          where le.order_id=p.id and le.transition='external_shipped'
            and le.source='external_shipped_classifier'))::int as classifier_sourced,
        count(*) filter (where exists (select 1 from order_lifecycle_events le
          where le.order_id=p.id and le.transition='external_shipped'
            and le.source is distinct from 'external_shipped_classifier'))::int as other_sourced
      from pop p`);
    out.push({ section: '3b. external-event source contract', rows: [srcContract] });
    assert('every classifier-declared order carries a source-specific receipt',
      Number(srcContract.any_external_event) === Number(srcContract.classifier_sourced)
        + Number(srcContract.other_sourced) - 0
        && Number(srcContract.other_sourced) === 0,
      `any=${srcContract.any_external_event} classifier=${srcContract.classifier_sourced} other=${srcContract.other_sourced}`);

    // --- Q4 shipment history, from the raw truth table. No CASE precedence.
    const q4raw = await tx.unsafe(`
      with ${BASE}, ${FACTS}
      select rows_by_order_id>0 as has_orderid_rows, any_voided, any_nonvoided,
             any_return, any_replacement, any_orphan_history, count(*)::int as orders
      from facts group by 1,2,3,4,5,6 order by orders desc`);
    out.push({ section: '4. shipment-history RAW combination cross-tab', rows: q4raw });

    const q4 = await tx.unsafe(`
      with ${BASE}, ${FACTS}
      select
        case
          when rows_by_order_id = 0 and not any_orphan_history then 'a_no_shipment_history'
          when rows_by_order_id = 0 and any_orphan_history     then 'f_orphan_number_history_only'
          when any_voided and not any_nonvoided and not any_return and not any_replacement
            then 'b_ordinary_voided_only'
          when any_return and not any_replacement and not any_nonvoided then 'c_return_only'
          when any_replacement and not any_return and not any_nonvoided then 'd_replacement_only'
          else 'e_mixed_inactive_history'
        end as shipment_history_attr,
        count(*)::int as orders
      from facts group by 1 order by 1`);
    out.push({ section: '4b. shipment-history attribute (orthogonal to Q3)', rows: q4 });

    const q4sum = q4.reduce((a, r) => a + Number(r.orders), 0);
    assert('shipment-history attribute sums to population',
      q4sum === Number(q2.no_active_outbound), `${q4sum} vs ${q2.no_active_outbound}`);
    assert('raw combination cross-tab sums to population',
      q4raw.reduce((a, r) => a + Number(r.orders), 0) === Number(q2.no_active_outbound),
      `${q4raw.reduce((a, r) => a + Number(r.orders), 0)} vs ${q2.no_active_outbound}`);

    // --- ORPHAN identity. The watchdog arm is collision-prone; prove or disprove it.
    const [orphan] = await tx.unsafe(`
      with ${BASE},
      excluded as (
        select b.id, b.order_number from base b
        where not exists (select 1 from shipments s where s.order_id=b.id)
          and b.id not in (select id from pop)
      )
      select
        (select count(*)::int from excluded) as excluded_by_orphan_arm,
        (select count(*)::int from excluded e
           where (select count(*) from orders o2 where o2.order_number=e.order_number) > 1)
          as order_number_ambiguous_across_orders,
        (select count(*)::int from excluded e
           where (select count(*) from shipments s
                  where s.order_id is null and s.order_number=e.order_number) > 1)
          as matches_multiple_orphan_rows,
        (select count(*)::int from base where order_number is null) as null_order_number,
        (select count(*)::int from shipments where order_id is null) as orphan_shipment_rows_total`);
    out.push({ section: '5. orphan-identity qualification', rows: [orphan] });
    assert('orphan-arm exclusions are identity-qualified (unique order_number)',
      Number(orphan.order_number_ambiguous_across_orders) === 0,
      `${orphan.order_number_ambiguous_across_orders} of ${orphan.excluded_by_orphan_arm} exclusions rest on a non-unique order_number`);

    // --- Q5 full ordered lifecycle history
    const q5 = await tx.unsafe(`
      with ${BASE},
      withev as (select p.* from pop p
                 where exists (select 1 from order_lifecycle_events le where le.order_id=p.id)),
      seq as (
        select w.id, w.flagged,
          (select count(*) from order_lifecycle_events le where le.order_id=w.id)::int as event_count,
          (select le.transition from order_lifecycle_events le where le.order_id=w.id
             order by le.effective_at asc, le.created_at asc, le.id asc limit 1) as first_transition,
          (select le.source from order_lifecycle_events le where le.order_id=w.id
             order by le.effective_at asc, le.created_at asc, le.id asc limit 1) as first_source,
          (select le.transition from order_lifecycle_events le where le.order_id=w.id
             order by le.effective_at desc, le.created_at desc, le.id desc limit 1) as last_transition
        from withev w
      )
      select flagged, event_count, first_transition, first_source, last_transition, count(*)::int as orders
      from seq group by 1,2,3,4,5 order by orders desc`);
    out.push({ section: '6. full ordered lifecycle history', rows: q5 });

    const [cov] = await tx.unsafe(`
      with ${BASE}
      select count(*) filter (where exists (select 1 from order_lifecycle_events le
               where le.order_id=p.id))::int as event_bearing,
             count(*) filter (where not exists (select 1 from order_lifecycle_events le
               where le.order_id=p.id))::int as no_receipt
      from pop p`);
    out.push({ section: '6b. lifecycle coverage', rows: [cov] });
    assert('event-bearing + no-receipt = population',
      Number(cov.event_bearing) + Number(cov.no_receipt) === Number(q2.no_active_outbound),
      `${cov.event_bearing} + ${cov.no_receipt} vs ${q2.no_active_outbound}`);
    assert('Q5 grouped output sums to event-bearing count',
      q5.reduce((a, r) => a + Number(r.orders), 0) === Number(cov.event_bearing),
      `${q5.reduce((a, r) => a + Number(r.orders), 0)} vs ${cov.event_bearing}`);

    // --- Q6 coverage partition. PROXY ONLY. updated_at is mutable row metadata and
    // 2026-07-16 is a COMMIT date, not a proven production migration/deploy timestamp.
    // This cannot prove absence of post-cutover bypass.
    const q6 = await tx.unsafe(`
      with ${BASE},
      noevent as (select p.* from pop p
                  where not exists (select 1 from order_lifecycle_events le where le.order_id=p.id))
      select flagged,
        case when updated_at < timestamp '2026-07-16'
             then 'updated_at_before_proposed_boundary'
             else 'updated_at_on_or_after_proposed_boundary' end as cohort,
        count(*)::int as orders, min(updated_at)::date as earliest, max(updated_at)::date as latest
      from noevent group by 1,2 order by 1,2`);
    out.push({ section: '7. lifecycle-SOT coverage partition (PROXY)', rows: q6 });

    const [ended] = await tx.unsafe(
      `select to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')||' UTC' as ended_utc`);
    out.push({ section: '8. snapshot close', rows: [ended] });
  });

  for (const s of out) {
    console.log(`\n=== ${s.section} ===`);
    console.table(s.rows);
  }
  console.log('\n=== assertions ===');
  console.table(assertions.map((a) => ({ assertion: a.name, result: a.pass ? 'PASS' : 'FAIL', detail: a.detail })));

  const failed = assertions.filter((a) => !a.pass);
  await sql.end();
  if (failed.length) {
    console.error(`\n${failed.length} assertion(s) FAILED — this evidence pack is not acceptable.`);
    process.exit(1);
  }
  console.log('\nAll assertions PASS.');
}

main().catch(async (e) => { console.error(e); await sql.end(); process.exit(2); });
