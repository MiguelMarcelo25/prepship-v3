/**
 * PS-489 Phase 0 — classification evidence runner. READ-ONLY.
 *
 * Every section runs inside ONE
 *   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
 * so all sections observe one consistent transaction snapshot. READ ONLY is enforced
 * by Postgres, not by convention: any DDL/DML here would abort the transaction.
 *
 * TWO CLASSES OF CHECK, deliberately separated:
 *
 *   INTEGRITY  — the measurement machinery is sound. These MUST pass. Any failure
 *                means the evidence is broken and controls the exit code.
 *   OPEN       — an honestly discovered unresolved boundary. These may be red without
 *                invalidating the appendix. They are reported prominently and never
 *                weakened, but they do NOT make the pack self-declare as unacceptable.
 *
 * Exit: 0 when all INTEGRITY checks pass (open findings may be red).
 *       1 when any INTEGRITY check fails, or when --require-exact-population is passed
 *         and any OPEN finding is unresolved.
 *       2 on error.
 *
 * Run:  npx tsx scripts/ps-489-phase0-evidence.ts [--require-exact-population]
 *
 * Row grain: one `orders` row = one order. Never a billing line, never a shipment.
 *
 * DENOMINATOR CAVEAT: the population uses literal `orders.order_status = 'shipped'`.
 * It does NOT use the lifecycle-effective status owner (order-lifecycle-status.ts).
 * Cancelled, upstream-cancelled, and differently-projected externally-flagged orders
 * are absent from this denominator.
 *
 * BASELINE POLICY: this runner asserts RELATIONSHIPS ONLY. It never hard-codes an
 * observed production count, because normal data drift is not broken evidence logic.
 * Observed constants live in the captured output artifact, bound to runner blob,
 * timestamps, snapshot metadata and migration head. Drift comparison is a separate
 * opt-in mode (--compare-baseline), not the integrity contract.
 */
import postgres from 'postgres';

const STRICT = process.argv.includes('--require-exact-population');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

// prepare:false — Supavisor transaction pooler cannot carry prepared statements.
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

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

const FACTS = `
  facts as (
    select p.id, p.flagged, p.order_number,
      (select count(*) from shipments s where s.order_id = p.id) as rows_by_order_id,
      coalesce((select bool_or(coalesce(s.voided,false))    from shipments s where s.order_id=p.id),false) as any_voided,
      coalesce((select bool_or(not coalesce(s.voided,false)) from shipments s where s.order_id=p.id),false) as any_nonvoided,
      coalesce((select bool_or(coalesce(s.is_return,false)) from shipments s where s.order_id=p.id),false) as any_return,
      coalesce((select bool_or(s.source = 'replacement') from shipments s where s.order_id=p.id),false) as any_replacement,
      exists (select 1 from shipments s where s.order_id is null and s.order_number = p.order_number) as any_orphan_history
    from pop p
  )`;

type Row = Record<string, unknown>;
const out: Array<{ section: string; rows: Row[] }> = [];
const integrity: Array<{ name: string; pass: boolean; detail: string }> = [];
const open: Array<{ name: string; resolved: boolean; detail: string }> = [];

const assertIntegrity = (name: string, pass: boolean, detail: string) =>
  integrity.push({ name, pass, detail });
const recordOpen = (name: string, resolved: boolean, detail: string) =>
  open.push({ name, resolved, detail });

async function main() {
  await sql.begin(async (tx) => {
    await tx.unsafe('set transaction isolation level repeatable read read only');

    // now()/transaction_timestamp() are fixed at transaction start — they cannot
    // measure elapsed time. clock_timestamp() is the actual wall clock.
    const [started] = await tx.unsafe(`
      select to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.MS')||' UTC' as wallclock_start_utc,
             to_char(transaction_timestamp() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')||' UTC' as transaction_start_utc,
             current_database() as database,
             substring(version() from 'PostgreSQL [0-9.]+') as engine,
             -- A consistent transaction snapshot identifier. NOT an immutable or
             -- restorable database snapshot: it is only meaningful while this
             -- transaction remains open.
             pg_current_snapshot()::text as current_snapshot,
             pg_export_snapshot() as exported_snapshot_id,
             (select hash from drizzle.__drizzle_migrations order by created_at desc limit 1) as migration_head,
             (select count(*) from drizzle.__drizzle_migrations) as migrations_applied`);
    out.push({ section: '0. run identity', rows: [started] });

    // --- 1. transition matrix. Both totals DERIVED from these buckets.
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

    // Independently computed direct naive count — NOT re-derived from the matrix,
    // so this comparison can actually fail.
    const [directNaive] = await tx.unsafe(`
      select count(*)::int as naive_direct from orders o
      where o.order_status='shipped'
        and not exists (select 1 from shipments s where s.order_id=o.id)`);
    out.push({ section: '1b. independent naive-predicate count', rows: [directNaive] });

    const [q2] = await tx.unsafe(`
      with ${BASE}
      select (select count(*)::int from base) as literal_shipped_total,
             (select count(*)::int from pop)  as no_active_outbound,
             (select count(*)::int from pop where flagged)     as flagged,
             (select count(*)::int from pop where not flagged) as unflagged,
             (select count(distinct id)::int from pop)         as distinct_ids`);
    out.push({ section: '2. population', rows: [q2] });

    assertIntegrity('population rows are distinct orders',
      Number(q2.no_active_outbound) === Number(q2.distinct_ids),
      `${q2.no_active_outbound} vs ${q2.distinct_ids}`);
    assertIntegrity('transition matrix sums to literal shipped denominator',
      unchanged + excludedByOrphan + inactiveOnly + unaffected === Number(q2.literal_shipped_total),
      `${unchanged + excludedByOrphan + inactiveOnly + unaffected} vs ${q2.literal_shipped_total}`);
    assertIntegrity('corrected population derived from matrix equals measured population',
      unchanged + inactiveOnly === Number(q2.no_active_outbound),
      `${unchanged} + ${inactiveOnly} vs ${q2.no_active_outbound}`);
    assertIntegrity('matrix naive total equals independent direct naive count',
      unchanged + excludedByOrphan === Number(directNaive.naive_direct),
      `${unchanged} + ${excludedByOrphan} vs ${directNaive.naive_direct}`);
    assertIntegrity('flagged + unflagged = corrected population',
      Number(q2.flagged) + Number(q2.unflagged) === Number(q2.no_active_outbound),
      `${q2.flagged} + ${q2.unflagged} vs ${q2.no_active_outbound}`);

    // --- 3. provenance. Fixed class domain via VALUES, so absent classes emit real
    // zero rows from the query rather than being hand-inserted into the document.
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
      ),
      labelled as (
        select case
          when ext_classifier and ext_other then '1b_external_mixed_sources'
          when ext_classifier then '1a_classifier_declared_external'
          when ext_other      then '1c_external_other_source'
          when has_void       then '2_void_lifecycle_history'
          when ev>0 and has_status_only then '3_status_only_shipped'
          when ev>0           then '4_other_event_pattern'
          when flagged        then '5_flagged_no_receipt'
          else                     '6_unflagged_no_receipt'
        end as provenance_class from cls
      ),
      domain(provenance_class) as (values
        ('0_source_verified_external'),('1a_classifier_declared_external'),
        ('1b_external_mixed_sources'),('1c_external_other_source'),
        ('2_void_lifecycle_history'),('3_status_only_shipped'),
        ('4_other_event_pattern'),('5_flagged_no_receipt'),('6_unflagged_no_receipt'))
      select d.provenance_class, coalesce(count(l.provenance_class),0)::int as orders
      from domain d left join labelled l using (provenance_class)
      group by d.provenance_class order by d.provenance_class`);
    out.push({ section: '3. provenance partition (fixed class domain)', rows: q3 });

    const q3sum = q3.reduce((a, r) => a + Number(r.orders), 0);
    assertIntegrity('provenance partition sums to population',
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
    assertIntegrity('classifier-declared class is source-qualified, not transition-only',
      Number(srcContract.classifier_sourced) + Number(srcContract.other_sourced)
        >= Number(srcContract.any_external_event),
      `any=${srcContract.any_external_event} classifier=${srcContract.classifier_sourced} other=${srcContract.other_sourced}`);

    // --- 4. shipment history from raw facts, fixed class domain.
    const q4raw = await tx.unsafe(`
      with ${BASE}, ${FACTS}
      select rows_by_order_id>0 as has_orderid_rows, any_voided, any_nonvoided,
             any_return, any_replacement, any_orphan_history, count(*)::int as orders
      from facts group by 1,2,3,4,5,6 order by orders desc`);
    out.push({ section: '4. shipment-history RAW combination cross-tab', rows: q4raw });

    const q4 = await tx.unsafe(`
      with ${BASE}, ${FACTS},
      labelled as (
        select case
          when rows_by_order_id = 0 and not any_orphan_history then 'a_no_shipment_history'
          when rows_by_order_id = 0 and any_orphan_history     then 'f_orphan_number_history_only'
          when any_voided and not any_nonvoided and not any_return and not any_replacement
            then 'b_ordinary_voided_only'
          when any_return and not any_replacement and not any_nonvoided then 'c_return_only'
          when any_replacement and not any_return and not any_nonvoided then 'd_replacement_only'
          else 'e_mixed_inactive_history'
        end as shipment_history_attr from facts
      ),
      domain(shipment_history_attr) as (values
        ('a_no_shipment_history'),('b_ordinary_voided_only'),('c_return_only'),
        ('d_replacement_only'),('e_mixed_inactive_history'),('f_orphan_number_history_only'))
      select d.shipment_history_attr, coalesce(count(l.shipment_history_attr),0)::int as orders
      from domain d left join labelled l using (shipment_history_attr)
      group by d.shipment_history_attr order by d.shipment_history_attr`);
    out.push({ section: '4b. shipment-history attribute (orthogonal to §3)', rows: q4 });

    assertIntegrity('shipment-history attribute sums to population',
      q4.reduce((a, r) => a + Number(r.orders), 0) === Number(q2.no_active_outbound),
      `${q4.reduce((a, r) => a + Number(r.orders), 0)} vs ${q2.no_active_outbound}`);
    assertIntegrity('raw combination cross-tab sums to population',
      q4raw.reduce((a, r) => a + Number(r.orders), 0) === Number(q2.no_active_outbound),
      `${q4raw.reduce((a, r) => a + Number(r.orders), 0)} vs ${q2.no_active_outbound}`);

    // --- 5. ORPHAN identity. One orphan row can exclude several duplicate orders,
    // so the count of excluded orders is NOT the count of identity decisions.
    const [orphan] = await tx.unsafe(`
      with ${BASE},
      excluded as (
        select b.id, b.order_number from base b
        where not exists (select 1 from shipments s where s.order_id=b.id)
          and b.id not in (select id from pop)
      )
      select
        (select count(*)::int from excluded) as excluded_orders,
        (select count(distinct order_number)::int from excluded) as distinct_order_numbers,
        (select count(*)::int from excluded e
           where (select count(*) from orders o2 where o2.order_number=e.order_number) > 1)
          as order_number_ambiguous_across_orders,
        (select coalesce(max(c),0)::int from (select count(*) c from excluded group by order_number) t)
          as max_excluded_orders_per_number,
        (select coalesce(max(c),0)::int from (select (select count(*) from shipments s
            where s.order_id is null and s.order_number=e.order_number) c from excluded e) t)
          as max_orphan_rows_per_number,
        (select count(*)::int from excluded e where exists (select 1 from orders o2
            where o2.order_number=e.order_number and o2.id<>e.id
              and o2.client_id is distinct from (select client_id from orders where id=e.id)))
          as sharers_disagree_on_client,
        (select count(*)::int from base where order_number is null) as null_order_number,
        (select count(*)::int from shipments where order_id is null) as orphan_shipment_rows_total`);
    out.push({ section: '5. orphan-identity qualification', rows: [orphan] });

    const ambiguous = Number(orphan.order_number_ambiguous_across_orders);
    const lower = Number(q2.no_active_outbound);
    const upper = lower + ambiguous;
    out.push({ section: '5b. population boundary interval', rows: [{
      lower_trusting_all_orphan_exclusions: lower,
      upper_trusting_none: upper,
      identity_decisions: Number(orphan.distinct_order_numbers),
      note: 'interval concerns an identity-qualified predicate determination, NOT proof of physical shipment absence',
    }] });

    // OPEN finding, not an integrity failure. Never weakened.
    recordOpen('orphan-arm exclusions are identity-qualified',
      ambiguous === 0,
      ambiguous === 0
        ? 'all orphan-arm exclusions rest on a unique order_number'
        : `${ambiguous} of ${orphan.excluded_orders} exclusions rest on a non-unique order_number across `
          + `${orphan.distinct_order_numbers} identity decisions; population is an interval ${lower}-${upper}`);

    // --- 6. full ordered lifecycle history
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
    assertIntegrity('event-bearing + no-receipt = population',
      Number(cov.event_bearing) + Number(cov.no_receipt) === Number(q2.no_active_outbound),
      `${cov.event_bearing} + ${cov.no_receipt} vs ${q2.no_active_outbound}`);
    assertIntegrity('§6 grouped output sums to event-bearing count',
      q5.reduce((a, r) => a + Number(r.orders), 0) === Number(cov.event_bearing),
      `${q5.reduce((a, r) => a + Number(r.orders), 0)} vs ${cov.event_bearing}`);

    // --- 7. coverage partition. PROXY ONLY — cannot prove absence of post-cutover bypass.
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

    recordOpen('true production cutover boundary is proven', false,
      'orders.updated_at is mutable row metadata and 2026-07-16 is a COMMIT date; '
      + 'production migration-application and lifecycle-owner deployment timestamps are not yet captured');
    recordOpen('source-verified external evidence exists', false,
      'no order currently satisfies the category-1 evidence standard; provider probe not yet designed or reviewed');

    const [ended] = await tx.unsafe(
      `select to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.MS')||' UTC' as wallclock_end_utc`);
    out.push({ section: '8. run close', rows: [ended] });
  });

  for (const s of out) { console.log(`\n=== ${s.section} ===`); console.table(s.rows); }

  console.log('\n=== INTEGRITY assertions (must all pass; control exit code) ===');
  console.table(integrity.map((a) => ({ assertion: a.name, result: a.pass ? 'PASS' : 'FAIL', detail: a.detail })));

  console.log('\n=== OPEN evidence findings (may be unresolved without invalidating this appendix) ===');
  console.table(open.map((o) => ({ finding: o.name, state: o.resolved ? 'RESOLVED' : 'OPEN BOUNDARY', detail: o.detail })));

  const failed = integrity.filter((a) => !a.pass);
  const unresolved = open.filter((o) => !o.resolved);
  await sql.end();

  if (failed.length) {
    console.error(`\nEVIDENCE INTEGRITY FAILURE: ${failed.length} assertion(s) failed. This pack is not usable.`);
    process.exit(1);
  }
  if (STRICT && unresolved.length) {
    console.error(`\n--require-exact-population: ${unresolved.length} open boundary/boundaries unresolved.`);
    process.exit(1);
  }
  console.log(`\nAll ${integrity.length} integrity assertions PASS.`
    + ` ${unresolved.length} open boundary/boundaries reported and unresolved — see above.`);
}

main().catch(async (e) => { console.error(e); await sql.end(); process.exit(2); });
