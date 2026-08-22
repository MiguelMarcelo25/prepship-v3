-- PS-489 Phase 0 — classification evidence. READ-ONLY. No DDL, no DML, no writes.
--
-- Every query below is SELECT-only and safe to run against production.
-- Verbatim output committed alongside in docs/ps-tickets/PS-489-population-scope-finding.md.
--
-- Shared definitions used by every query:
--   POPULATION  = orders with order_status='shipped' that have NO active ordinary
--                 outbound shipment, per shipment-sync-watchdog.ts:654-670 —
--                 linked by shipments.order_id OR by orphan order_number, in both
--                 cases excluding source='replacement', voided, and is_return.
--   Row grain   = one orders row = one order. Never a billing line, never a shipment.

\echo '=== Q0. snapshot identity ==='
select
  to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') || ' UTC' as snapshot_utc,
  current_database()                                                  as database,
  substring(version() from 'PostgreSQL [0-9.]+')                      as engine,
  (select count(*) from information_schema.tables
     where table_schema='public')                                     as public_tables;

\echo '=== Q1. predicate transition matrix: naive (order_id only) vs correct (watchdog) ==='
-- Reconciles BOTH totals exactly. naive_missing=true totals 18,250;
-- correct_missing=true totals 18,335.
with base as (
  select o.id, o.order_number from orders o where o.order_status='shipped'
),
flags as (
  select b.id,
    not exists (select 1 from shipments s where s.order_id=b.id) as naive_missing,
    (not exists (select 1 from shipments s where s.order_id=b.id
        and s.source is distinct from 'replacement'
        and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
     and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
        and s.source is distinct from 'replacement'
        and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)) as correct_missing
  from base b
)
select naive_missing, correct_missing, count(*) as orders,
  case when naive_missing and correct_missing then 'unchanged missing'
       when naive_missing and not correct_missing then 'rescued by active orphan order_number'
       when not naive_missing and correct_missing then 'inactive-only history now recognised missing'
       else 'unaffected' end as meaning
from flags group by 1,2 order by 1 desc, 2 desc;

\echo '=== Q2. population totals ==='
with base as (
  select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
)
select
  (select count(*) from base)                        as lifecycle_shipped_total,
  (select count(*) from pop)                         as no_active_outbound,
  (select count(*) from pop where flagged)           as flagged,
  (select count(*) from pop where not flagged)       as unflagged;

\echo '=== Q3. DIMENSION 1 — lifecycle/provenance partition (mutually exclusive; sums to 18,335) ==='
with base as (
  select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
),
cls as (
  select p.id, p.flagged,
    (select count(*) from order_lifecycle_events le where le.order_id=p.id) as ev,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.transition='external_shipped') as has_ext,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.transition='void') as has_void,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.source='order_sync_status') as has_statusonly,
    exists (select 1 from shipments s where s.order_id=p.id) as any_ship_history
  from pop p
)
select
  case
    when has_ext then '1_classifier_declared_external'
    when has_void then '2_void_lifecycle_history'
    when ev>0 and has_statusonly then '3_status_only_shipped'
    when ev>0 then '4_other_event_pattern'
    when flagged then '5_flagged_no_receipt'
    else '6_unflagged_no_receipt'
  end as provenance_class,
  count(*) as orders,
  count(*) filter (where any_ship_history) as also_has_inactive_ship_history
from cls group by 1 order by 1;

\echo '=== Q4. DIMENSION 2 — shipment-history attribute (orthogonal cross-tab; sums to 18,335) ==='
-- NOT a provenance class. This dimension overlaps Q3 and must never be added to it.
with base as (
  select o.id, o.order_number from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
)
select
  case
    when not exists (select 1 from shipments s where s.order_id=p.id) then 'a_no_shipment_history'
    when exists (select 1 from shipments s where s.order_id=p.id and coalesce(s.voided,false))
     and not exists (select 1 from shipments s where s.order_id=p.id and not coalesce(s.voided,false))
      then 'b_voided_only'
    when exists (select 1 from shipments s where s.order_id=p.id and coalesce(s.is_return,false))
     and not exists (select 1 from shipments s where s.order_id=p.id and not coalesce(s.is_return,false))
      then 'c_return_only'
    when exists (select 1 from shipments s where s.order_id=p.id and s.source='replacement')
     and not exists (select 1 from shipments s where s.order_id=p.id and s.source is distinct from 'replacement')
      then 'd_replacement_only'
    else 'e_mixed_inactive_history'
  end as shipment_history_attr,
  count(*) as orders
from pop p group by 1 order by 1;

\echo '=== Q5. full ordered lifecycle history (effective_at, created_at, id) ==='
-- Latest-event-only attribution is INSUFFICIENT: it conceals the establishing event.
with base as (
  select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
),
withev as (select p.* from pop p where exists (select 1 from order_lifecycle_events le where le.order_id=p.id)),
seq as (
  select w.id, w.flagged,
    (select count(*) from order_lifecycle_events le where le.order_id=w.id) as event_count,
    (select le.transition from order_lifecycle_events le where le.order_id=w.id
       order by le.effective_at asc, le.created_at asc, le.id asc limit 1) as first_transition,
    (select le.source from order_lifecycle_events le where le.order_id=w.id
       order by le.effective_at asc, le.created_at asc, le.id asc limit 1) as first_source,
    (select le.transition from order_lifecycle_events le where le.order_id=w.id
       order by le.effective_at desc, le.created_at desc, le.id desc limit 1) as last_transition
  from withev w
)
select flagged, event_count, first_transition, first_source, last_transition, count(*) as orders
from seq group by 1,2,3,4,5 order by orders desc;

\echo '=== Q6. lifecycle-SOT coverage partition on orders.updated_at (PROXY — see caveat) ==='
-- orders.updated_at is MUTABLE row metadata, NOT an immutable terminal-transition
-- timestamp, and the boundary date is a COMMIT date, not a proven production
-- migration/deployment timestamp. This query CANNOT prove absence of post-cutover
-- bypass. It establishes consistency with legacy debt and nothing stronger.
with base as (
  select o.id, o.order_number, o.updated_at, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
),
noevent as (
  select p.* from pop p
  where not exists (select 1 from order_lifecycle_events le where le.order_id=p.id)
)
select flagged,
  case when updated_at < timestamp '2026-07-16' then 'updated_at_before_proposed_boundary'
       else 'updated_at_on_or_after_proposed_boundary' end as cohort,
  count(*) as orders, min(updated_at)::date as earliest, max(updated_at)::date as latest
from noevent group by 1,2 order by 1,2;

\echo '=== Q7. reconciliation assertions — every row must read PASS ==='
with base as (
  select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
pop as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
),
cls as (
  select p.id, p.flagged,
    (select count(*) from order_lifecycle_events le where le.order_id=p.id) as ev,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.transition='external_shipped') as has_ext,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.transition='void') as has_void,
    exists (select 1 from order_lifecycle_events le where le.order_id=p.id
            and le.source='order_sync_status') as has_statusonly
  from pop p
),
parts as (
  select
    count(*) filter (where has_ext) as c1,
    count(*) filter (where not has_ext and has_void) as c2,
    count(*) filter (where not has_ext and not has_void and ev>0 and has_statusonly) as c3,
    count(*) filter (where not has_ext and not has_void and ev>0 and not has_statusonly) as c4,
    count(*) filter (where ev=0 and flagged) as c5,
    count(*) filter (where ev=0 and not flagged) as c6,
    count(*) as total
  from cls
)
select 'provenance partition sums to population' as assertion,
       case when c1+c2+c3+c4+c5+c6 = total then 'PASS' else 'FAIL' end as result,
       (c1+c2+c3+c4+c5+c6)::text || ' vs ' || total::text as detail
from parts
union all
select 'naive + inactive-only - rescued = correct',
       case when 18250 - 20 + 105 = (select total from parts) then 'PASS' else 'FAIL' end,
       '18250 - 20 + 105 = ' || (18250-20+105)::text || ' vs ' || (select total from parts)::text;
