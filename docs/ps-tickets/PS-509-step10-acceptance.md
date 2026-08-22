# PS-509 step 10 — deployed runtime writer acceptance

Read-only production analysis. Nothing was written. No claim replay, no unlock, no
closure, no billing action, no migration.

- Original measurement: 2026-08-21 / 2026-08-22 (superseded method).
- **Corrected method published 2026-08-22 01:16–01:22 UTC** after Hermes returned this
  artifact CORRECTED on four grounds. See §0.

## Verdict: **GATE NOT PASSED — evidence exists, but not at the deployed SHA**

Unchanged. The verdict was right; the measurement method that produced its supporting
figures was not sound, and the SHA it named is already stale.

---

## §0 — Correction notice (what Hermes rejected, and what changed)

| # | Hermes finding | Status |
|---|---|---|
| 1 | Watermark `shipments.created_at >= DEPLOY_TS` cannot see an `orphan_link` evaluation performed **after** deploy against a shipment created **before** deploy. And the outcomes table is **not** append-only — it upserts, keeping only the latest boundary/outcome and incrementing `evaluation_count`. | **Fixed** — §3 rebinds on `first_evaluated_at` / `last_evaluated_at` and splits the lanes. §3.1 states what the upsert makes *unprovable*. |
| 2 | Eligibility predicate `coalesce(selected_rate_cost, cost, label_cost) > 0` is not the writer's. The writer accepts `selected_rate_cost` **only**. | **Fixed** — §2 mirrors the writer's real ladder, including the fallback-only EXCLUDED count. The old predicate was also wrong about client identity (see §2.2). |
| 3 | Equal aggregate counts of `eligible` / `has_outcome` / `has v509 tuple` do not prove they are the **same rows**. | **Fixed** — §4 replaces them with row-level anti-joins that must return **zero** uncovered shipment ids. |
| 4 | The exclusion / provenance / margin / cost-disagreement / revision / mutation-guard queries were claimed as "reproduced" but only one abbreviated query was present. | **Fixed** — §4, §5 and §6 write out **every** query in full. |

Two additions Hermes required:

- A **counterfactual missing/inactive-policy classification** (§6).
- A recorded **runtime packet**, including the operative `BILLING_PER_ACCOUNT_MARKUP`
  state (§7) — which, as §7 proves, is **not** recoverable from the frozen tuple.

**Hermes ruling carried forward:** the historical 142-row acceptance does **not** need to
be redone. What is required is a focused **current-deployment delta acceptance**.

---

## §1 — The acceptance window must bind to the SHA that is ACTUALLY LIVE

The previous version of this doc targeted `fe23b4eb`. That is already stale: merging
`d8f80f5d` triggered a new deploy.

Observed just now:

```
$ GET https://prepshipv4-api-l5xc.onrender.com/health
{
  "status": "ok",
  "runtime": {
    "commitSha": "d8f80f5da717bd393681cb538b92c44a360e56b7",
    "commitSource": "RENDER_GIT_COMMIT",
    "serviceId": "srv-d7qoar7lk1mc73cm4ma0",
    "instanceId": "srv-d7qoar7lk1mc73cm4ma0-7b597d74d7-fn2w2"
  },
  "ts": "2026-08-22T01:15:44.660Z"
}
```

```
$ git log -1 --format='%H %cI %s' d8f80f5d
d8f80f5da717bd393681cb538b92c44a360e56b7 2026-08-22T08:53:43+08:00 Merge pull request #28 from drprepperusa-org/test/ps-489-contract-fixtures
$ git log -1 --format='%H %cI %s' fe23b4eb
fe23b4eb6bb45371dc036e0a687d09a74416fa2d 2026-08-22T06:46:05+08:00 Merge pull request #25 from drprepperusa-org/fix/ps-502-apply-lane-pooler-prepare
```

**Rule: the acceptance window binds to whatever SHA `/health` reports live at measurement
time, and ends at the next deployment.** Do not hardcode a SHA into this method. Re-read
`/health` immediately before AND immediately after the measurement; if `commitSha` differs
between the two reads, the window is void and the measurement must be repeated.

### 1.1 Choosing `WINDOW_START` soundly

`d8f80f5d` was committed `2026-08-22T00:53:43Z` and was observed live at
`2026-08-22T01:15:44.660Z`. The exact deploy-live instant lies in that interval and is not
derivable from `/health`, which reports only current time.

- Take `WINDOW_START` from the Render deploy record's live timestamp for the SHA when it is
  available.
- Otherwise use the **first `/health` observation that reported the SHA** —
  `2026-08-22T01:15:44.660Z` here. This is a *lower* bound on "definitely live", so it
  **under-counts** the cohort. Under-counting is the safe direction: every row it admits is
  provably at the live SHA. Using the commit timestamp instead would wrongly admit rows
  produced by the previous SHA in the deploy gap.
- `WINDOW_END` is `'infinity'` while the SHA is still live, and the next deploy-live
  timestamp once it is not.

Both are parameters of every query below.

---

## §2 — The writer's real eligibility ladder

### 2.1 Cost input: `selected_rate_cost` ONLY

`src/services/customer-shipping-money-sync-ingress.ts:284-285`:

```ts
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  if (selectedRateCost == null || selectedRateCost <= 0) return skip('no_billable_cost');
```

`row.selectedRateCost` is loaded by `loadCustomerShippingMoneyRow`,
`src/services/customer-shipping-money.ts:290-293`:

```sql
      s.label_shipment_id as "labelShipmentId",
      coalesce(c.is_test, false) as "clientIsTest",
      s.selected_rate_cost as "selectedRateCost",
      s.selected_rate_json as "selectedRateJson",
```

No `coalesce` with `cost` or `label_cost`. Confirmed again downstream at
`customer-shipping-money.ts:401-404`, where the policy owner refuses to resolve without it.

**Therefore:** a shipment whose only positive cost is `cost` or `label_cost` is
`no_billable_cost` — an EXCLUDED row, not an uncovered one. §4 Q3 counts them explicitly
rather than folding them into the eligible population.

### 2.2 Client identity is RESOLVED, not `shipments.client_id`

The superseded predicate used `s.client_id is not null`. The loader resolves
`coalesce(s.client_id, o.client_id, store_client.id)` — a shipment with a null
`shipments.client_id` but a resolvable order- or store-scoped client **is** eligible to the
writer. The superseded predicate would have scored such a row as ineligible while the
writer froze it. It also omitted the `clients.is_test` skip entirely.

### 2.3 The ladder, in the writer's order

`customer-shipping-money-sync-ingress.ts:278-285`. Order matters — it decides which durable
outcome label a row gets:

```
voided → return → test → no_order → no_client → billing_inactive → no_billable_cost → frozen
```

**Caveat that must accompany every use of this ladder:** it is the expectation for a
**first** evaluation of a `legacy_absent` row. Classification runs FIRST
(`sync-ingress:240-248`), so a row that already carries a valid tuple reports `frozen`
regardless of a later void or return. Any `TUPLE_ON_INELIGIBLE` hit in §4 must therefore be
individually explained as a post-freeze state change, not treated as a silent pass.

---

## §3 — Binding on EVALUATION timestamps, and separating the two lanes

### 3.1 The outcomes table is an upsert, not a history

`src/services/customer-shipping-money-sync-ingress.ts:127-153`:

```ts
async function persistSyncIngressOutcome(exec: SyncIngressExec, entry: OutcomeEntry): Promise<void> {
  await exec
    .insert(customerShippingMoneySyncOutcomes)
    .values({ /* … */ })
    .onConflictDoUpdate({
      target: [customerShippingMoneySyncOutcomes.shipmentId],
      set: {
        boundary: entry.boundary,
        outcome: entry.outcome,
        /* … */
        evaluationCount: sql`${customerShippingMoneySyncOutcomes.evaluationCount} + 1`,
        lastEvaluatedAt: new Date(),
      },
    });
}
```

One row per `shipment_id` (`csm_sync_outcomes_shipment_unq`). Consequences the acceptance
method has to respect:

1. **`boundary` and `outcome` are overwritten.** The earlier boundary is gone. You cannot
   recover from this table that a row was `sync_insert` before it became `orphan_link`.
2. **`evaluation_count` counts every re-drive**, including a replay that merely re-reports
   an already-frozen row. `evaluation_count = 2` does **not** by itself mean
   "insert then link".
3. **`first_evaluated_at` is immutable-in-practice; `last_evaluated_at` moves.** These, not
   `shipments.created_at`, are the only timestamps that say when the deployed code ran.

### 3.2 The boundary the old watermark could not see

Lane C below — `first_evaluated_at < WINDOW_START <= last_evaluated_at` — is an evaluation
performed by the live SHA against a shipment created before it. `created_at >= DEPLOY_TS`
filters it out entirely. That is the miss.

**But note honestly what lane C can and cannot prove.** Because §3.1(1) destroys the prior
outcome, a lane-C row proves a post-deploy *evaluation* at the link boundary; it does **not**
prove a post-deploy *first freeze*, since the tuple may already have been frozen pre-deploy
and the link evaluation merely re-reported it (`alreadyFrozen: true`,
`sync-ingress:246-248`). **A post-deploy freeze at the link boundary is provable only in
lane B** (`first_evaluated_at >= WINDOW_START` with `boundary = 'orphan_link'`). The
acceptance requirement "both boundaries exercised at the live SHA" must be satisfied by
lanes A and B; lane C is supporting evidence only.

---

## §4 — Corrected query set (every query, in full)

Every query is standalone and copy-pasteable. Set `WINDOW_START` / `WINDOW_END` in the
`params` CTE at the top of each. All are read-only against `shipments`, `orders`, `clients`,
`billing_config`, `customer_shipping_money_sync_outcomes`,
`customer_shipping_money_receipt_revisions`, `pg_trigger`, `pg_proc`, `pg_class`.

### Q1 — Lane split, bound on evaluation timestamps

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
)
select
  case
    when o.first_evaluated_at >= p.window_start and o.boundary = 'sync_insert'
         and o.evaluation_count = 1                       then 'A_post_deploy_insert_only'
    when o.first_evaluated_at >= p.window_start           then 'B_post_deploy_first_eval'
    else 'C_pre_deploy_row_re_evaluated_in_window'
  end                                                     as lane,
  count(*)                                                as rows,
  count(*) filter (where s.created_at <  p.window_start)  as shipment_predates_window,
  count(*) filter (where o.boundary = 'sync_insert')      as boundary_sync_insert,
  count(*) filter (where o.boundary = 'orphan_link')      as boundary_orphan_link,
  count(*) filter (where o.boundary = 'retry_sweep')      as boundary_retry_sweep,
  count(*) filter (where o.evaluation_count > 1)          as re_evaluated,
  count(*) filter (where o.outcome = 'frozen')            as frozen,
  count(*) filter (where o.outcome <> 'frozen')           as not_frozen,
  min(o.first_evaluated_at)                               as first_eval_min,
  max(o.last_evaluated_at)                                as last_eval_max
from customer_shipping_money_sync_outcomes o
join shipments s on s.id = o.shipment_id
cross join params p
where o.last_evaluated_at >= p.window_start
  and o.last_evaluated_at <  p.window_end
group by 1
order by 1;
```

**Pass condition:** lane A non-empty AND lane B contains at least one
`boundary = 'orphan_link'` row. Lane C is reported, not required.

### Q2 — Row-level coverage anti-join (replaces the aggregate counts)

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
),
resolved as (
  select s.id, s.created_at, s.source,
         coalesce(s.is_return,false) as is_return,
         coalesce(s.voided,false)    as voided,
         s.order_id,
         coalesce(s.client_id, o.client_id, store_client.id) as resolved_client_id,
         coalesce(c.is_test,false)   as client_is_test,
         b.client_id                 as billing_config_client_id,
         b.active                    as billing_active,
         s.selected_rate_cost, s.cost, s.label_cost, s.selected_rate_json
  from shipments s
  left join orders o on o.id = s.order_id
  left join lateral (
    select sc.id from clients sc
    where o.store_id = any(sc.store_ids) order by sc.id limit 1
  ) store_client on true
  left join clients c on c.id = coalesce(s.client_id, o.client_id, store_client.id)
  left join billing_config b on b.client_id = c.id
  cross join params p
  where s.created_at >= p.window_start and s.created_at < p.window_end
),
expected as (
  select r.*, case
    when r.source <> 'shipstation'              then 'not_sync_ingress'
    when r.voided                               then 'voided'
    when r.is_return                            then 'return'
    when r.client_is_test                       then 'test'
    when r.order_id is null                     then 'no_order'
    when r.resolved_client_id is null           then 'no_client'
    when r.billing_active is not true           then 'billing_inactive'
    when coalesce(r.selected_rate_cost,0) <= 0  then 'no_billable_cost'
    else 'frozen' end as expected_outcome
  from resolved r
)
select e.expected_outcome,
  count(*)                                                                     as rows,
  count(*) filter (where o.shipment_id is null)                                as MISSING_OUTCOME_ROW,
  count(*) filter (where o.shipment_id is not null
                     and o.outcome is distinct from e.expected_outcome)        as OUTCOME_MISMATCH,
  count(*) filter (where e.expected_outcome = 'frozen'
                     and coalesce(e.selected_rate_json->>'customerShippingMoneyPolicyVersion','')
                         <> 'ps-509-v1')                                       as MISSING_V509_TUPLE,
  count(*) filter (where e.expected_outcome <> 'frozen'
                     and e.selected_rate_json ? 'customerShippingMoneyPolicyVersion')
                                                                               as TUPLE_ON_INELIGIBLE
from expected e
left join customer_shipping_money_sync_outcomes o on o.shipment_id = e.id
where e.source = 'shipstation'
group by e.expected_outcome
order by e.expected_outcome;
```

**Pass condition:** `MISSING_OUTCOME_ROW = 0`, `OUTCOME_MISMATCH = 0`,
`MISSING_V509_TUPLE = 0` on every row. `TUPLE_ON_INELIGIBLE` must be 0, or each hit
individually explained per §2.3.

### Q2b — The uncovered ids themselves (must return zero rows)

Run this whenever Q2 is non-zero, and run it anyway to show it returns empty.

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
),
resolved as (
  select s.id, s.source,
         coalesce(s.is_return,false) as is_return,
         coalesce(s.voided,false)    as voided,
         s.order_id,
         coalesce(s.client_id, o.client_id, store_client.id) as resolved_client_id,
         coalesce(c.is_test,false)   as client_is_test,
         b.active                    as billing_active,
         s.selected_rate_cost, s.selected_rate_json
  from shipments s
  left join orders o on o.id = s.order_id
  left join lateral (
    select sc.id from clients sc
    where o.store_id = any(sc.store_ids) order by sc.id limit 1
  ) store_client on true
  left join clients c on c.id = coalesce(s.client_id, o.client_id, store_client.id)
  left join billing_config b on b.client_id = c.id
  cross join params p
  where s.created_at >= p.window_start and s.created_at < p.window_end
),
freeze_eligible as (
  select r.id, r.selected_rate_json from resolved r
  where r.source = 'shipstation'
    and not r.voided and not r.is_return and not r.client_is_test
    and r.order_id is not null and r.resolved_client_id is not null
    and r.billing_active is true
    and coalesce(r.selected_rate_cost,0) > 0
)
select e.id, 'no_outcome_row' as defect from freeze_eligible e
where not exists (select 1 from customer_shipping_money_sync_outcomes o where o.shipment_id = e.id)
union all
select e.id, 'outcome_not_frozen' from freeze_eligible e
join customer_shipping_money_sync_outcomes o on o.shipment_id = e.id
where o.outcome <> 'frozen'
union all
select e.id, 'no_v509_tuple' from freeze_eligible e
where coalesce(e.selected_rate_json->>'customerShippingMoneyPolicyVersion','') <> 'ps-509-v1'
order by 1, 2;
```

**Pass condition: zero rows returned.**

### Q3 — Fallback-only EXCLUDED count (Hermes finding 2)

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
)
select
  count(*) filter (where coalesce(s.selected_rate_cost,0) > 0)          as writer_eligible_cost,
  count(*) filter (where coalesce(s.selected_rate_cost,0) <= 0
                     and coalesce(s.cost, s.label_cost, 0) > 0)         as EXCLUDED_fallback_only,
  count(*) filter (where coalesce(s.selected_rate_cost,0) <= 0
                     and coalesce(s.cost, s.label_cost, 0) <= 0)        as EXCLUDED_no_cost_at_all,
  count(*)                                                              as shipstation_rows
from shipments s
cross join params p
where s.created_at >= p.window_start and s.created_at < p.window_end
  and s.source = 'shipstation';
```

`EXCLUDED_fallback_only` rows must all carry outcome `no_billable_cost` and **no** tuple —
verified row-by-row by Q2's `OUTCOME_MISMATCH` / `TUPLE_ON_INELIGIBLE` columns.

---

## §5 — Tuple contract queries (previously "reproduced", now written out)

### Q4 — Provenance, margin reconciliation, cost disagreement, non-positive amounts

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
),
cohort as (
  select s.id, s.selected_rate_json as j, s.selected_rate_cost
  from customer_shipping_money_sync_outcomes o
  join shipments s on s.id = o.shipment_id
  cross join params p
  where o.last_evaluated_at >= p.window_start
    and o.last_evaluated_at <  p.window_end
    and o.outcome = 'frozen'
)
select
  count(*)                                                                            as frozen_cohort,
  count(*) filter (where j->>'customerShippingMoneyPolicyVersion' <> 'ps-509-v1')     as WRONG_VERSION,
  count(*) filter (where j->>'customerShippingMoneyCaptureSource'
                         <> 'shipstation_sync_ingestion')                             as BAD_CAPTURE_SOURCE,
  count(*) filter (where j->>'rateCostSource' <> 'shipstation_sync_receipt_cost')     as BAD_RATE_COST_SOURCE,
  count(*) filter (where j->>'customerRateSource' not in
                     ('carrier_markup_customer_shipping_rate',
                      'hugrab_shipping_rate_override'))                               as BAD_CUSTOMER_RATE_SOURCE,
  count(*) filter (where abs(((j->>'selectedRateCost')::numeric
                            + (j->>'shippingMarginAmount')::numeric)
                            - (j->>'cShippingRateAmount')::numeric) >= 0.005)         as MARGIN_MISMATCH,
  count(*) filter (where abs((j->>'selectedRateCost')::numeric
                            - selected_rate_cost) >= 0.005)                           as COST_DISAGREEMENT,
  count(*) filter (where (j->>'cShippingRateAmount')::numeric <= 0)                   as NON_POSITIVE_CUSTOMER,
  count(*) filter (where j->>'billingDescriptionSuffix' is null)                      as MISSING_BILLING_SUFFIX,
  round(sum((j->>'cShippingRateAmount')::numeric), 2)                                 as customer_total,
  round(sum((j->>'selectedRateCost')::numeric), 2)                                    as cost_total
from cohort;
```

All `BAD_*` / `WRONG_*` / `MISMATCH` / `DISAGREEMENT` / `NON_POSITIVE` / `MISSING_*`
columns must be **0**.

### Q5 — Exclusions and metadata-leak check

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
),
scope as (
  select s.* from shipments s cross join params p
  where (s.created_at >= p.window_start and s.created_at < p.window_end)
     or s.id in (select o.shipment_id
                 from customer_shipping_money_sync_outcomes o, params p2
                 where o.last_evaluated_at >= p2.window_start
                   and o.last_evaluated_at <  p2.window_end)
)
select
  count(*)                                                                          as scope_rows,
  count(*) filter (where selected_rate_json ? 'customerShippingMoneyPolicyVersion'
                     and coalesce(is_return,false))                                 as TUPLE_ON_RETURN,
  count(*) filter (where selected_rate_json ? 'customerShippingMoneyPolicyVersion'
                     and coalesce(voided,false))                                    as TUPLE_ON_VOIDED,
  count(*) filter (where selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-509-v1'
                     and source <> 'shipstation')                                   as V509_NON_SHIPSTATION,
  count(*) filter (where selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-509-v1'
                     and (order_id is null or client_id is null))                   as V509_UNATTRIBUTED,
  count(*) filter (where selected_rate_json ? 'customerShippingMoneyCaptureSource'
                     and coalesce(selected_rate_json->>'customerShippingMoneyPolicyVersion','') = '')
                                                                                    as CAPTURE_KEY_WITHOUT_VERSION,
  count(*) filter (where selected_rate_json ? 'customerShippingMoneyPolicyVersion'
                     and selected_rate_json->>'customerShippingMoneyPolicyVersion'
                         not in ('ps-509-v1','ps-508-v1','ps-437-v1'))              as UNKNOWN_VERSION
from scope;
```

All must be **0**. `V509_UNATTRIBUTED` deliberately uses the raw `shipments.client_id`
here — a frozen v509 tuple is expected to have had its client attributed onto the shipment
row itself; a hit is a real defect, not a resolution artefact.

### Q6 — Receipt revisions after freeze

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
)
select
  count(*)                                                            as revision_rows_in_window,
  count(*) filter (where reconciliation_state = 'open')               as open_rows,
  count(*) filter (where review_class <> 'receipt_revised_after_freeze') as UNEXPECTED_REVIEW_CLASS,
  count(*) filter (where detection_count > 1)                         as re_detected,
  round(sum(delta_abs), 2)                                            as total_abs_delta,
  min(first_detected_at)                                              as first_detected_min,
  max(last_detected_at)                                               as last_detected_max
from customer_shipping_money_receipt_revisions r
cross join params p
where r.first_detected_at >= p.window_start
  and r.first_detected_at <  p.window_end;
```

Non-zero rows are not automatically a failure — the class exists because ShipStation may
revise a receipt. Each row must be triaged; `UNEXPECTED_REVIEW_CLASS` must be 0.

### Q7 — Review / retry backlog

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
)
select outcome, failure_classification, count(*) as rows,
       min(first_evaluated_at) as first_eval_min,
       max(last_evaluated_at)  as last_eval_max
from customer_shipping_money_sync_outcomes o
cross join params p
where o.last_evaluated_at >= p.window_start
  and o.last_evaluated_at <  p.window_end
  and o.outcome in ('needs_review','needs_retry')
group by 1, 2
order by 1, 2;
```

**Pass condition: zero rows.**

### Q8 — Durability / mutation guards

```sql
select t.tgname, c.relname, p.proname, pg_get_triggerdef(t.oid) as def
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc  p on p.oid = t.tgfoid
where not t.tgisinternal
  and c.relname in ('customer_shipping_money_sync_outcomes',
                    'customer_shipping_money_receipt_revisions')
order by c.relname, t.tgname;

select p.proname, p.prosrc
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('csm_sync_outcomes_block_mutations',
                    'csm_receipt_revisions_block_mutations');
```

Observed 2026-08-22 01:19 UTC — verbatim:

```
csm_receipt_revisions_mutation_guard | BEFORE DELETE OR UPDATE ON public.customer_shipping_money_receipt_revisions FOR EACH ROW EXECUTE FUNCTION csm_receipt_revisions_block_mutations()
csm_receipt_revisions_no_truncate    | BEFORE TRUNCATE ON public.customer_shipping_money_receipt_revisions FOR EACH STATEMENT EXECUTE FUNCTION csm_receipt_revisions_block_mutations()
csm_sync_outcomes_mutation_guard     | BEFORE DELETE OR UPDATE ON public.customer_shipping_money_sync_outcomes FOR EACH ROW EXECUTE FUNCTION csm_sync_outcomes_block_mutations()
csm_sync_outcomes_no_truncate        | BEFORE TRUNCATE ON public.customer_shipping_money_sync_outcomes FOR EACH STATEMENT EXECUTE FUNCTION csm_sync_outcomes_block_mutations()
```

```
csm_sync_outcomes_block_mutations:
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outcome = 'frozen' AND NEW.outcome IS DISTINCT FROM 'frozen' THEN
      RAISE EXCEPTION 'customer_shipping_money_sync_outcomes: frozen is terminal (shipment %)', OLD.shipment_id;
    END IF;
    IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id THEN
      RAISE EXCEPTION 'customer_shipping_money_sync_outcomes: shipment identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'customer_shipping_money_sync_outcomes rows are durable: % is not allowed', TG_OP;
END;
```

**What this guard actually enforces — stated precisely, because the superseded doc implied
more.** It blocks DELETE and TRUNCATE outright, refuses to demote a `frozen` outcome, and
pins `shipment_id`. It **permits** UPDATE of `boundary`, `outcome` (non-demoting),
`evaluation_count`, `last_evaluated_at`, `detail` and `failure_classification` — which is
exactly the upsert of §3.1. It is not an append-only guarantee and must not be cited as one.

---

## §6 — Required counterfactual: missing / inactive billing policy

Hermes requires each missing- or inactive-policy row to be classified **counterfactually**:
*the old loader would have frozen a zero-markup tuple; the new loader produces
`billing_inactive` and writes no tuple.*

The behavioural difference sits in `loadCustomerShippingMoneyRow`
(`customer-shipping-money.ts:296-299`), whose own comment names the defect it closed:

```sql
      -- Per user override unlock shipped data on 2026-08-19: preserve the exact active
      -- billing-policy identity on shipped/replacement money. A LEFT JOIN miss must remain NULL;
      -- coalescing it to active + zero markup minted customer money from no policy at all.
      b.client_id as "billingConfigClientId",
```

Old: `coalesce(b.active, true)` + `coalesce(b.shipping_markup_pct, 0)` → a client with **no**
`billing_config` row passed the gate and froze a **zero-markup** tuple (customer amount =
cost, margin = 0). New: `b.active` stays NULL → `!row.billingActive` →
`skip('billing_inactive')` (`sync-ingress:283`) → durable outcome, **no tuple**.

### Q9 — Counterfactual classification

```sql
with params as (
  select timestamptz '<WINDOW_START>' as window_start,
         timestamptz '<WINDOW_END>'   as window_end
),
resolved as (
  select s.id, s.source,
         coalesce(s.is_return,false) as is_return,
         coalesce(s.voided,false)    as voided,
         s.order_id,
         coalesce(s.client_id, o.client_id, store_client.id) as resolved_client_id,
         coalesce(c.is_test,false)   as client_is_test,
         b.client_id                 as billing_config_client_id,
         b.active                    as billing_active,
         b.billing_mode              as billing_mode,
         b.updated_at                as billing_updated_at,
         coalesce(b.shipping_markup_pct, 0)  as old_loader_markup_pct,
         coalesce(b.shipping_markup_flat, 0) as old_loader_markup_flat,
         s.selected_rate_cost, s.selected_rate_json
  from shipments s
  left join orders o on o.id = s.order_id
  left join lateral (
    select sc.id from clients sc
    where o.store_id = any(sc.store_ids) order by sc.id limit 1
  ) store_client on true
  left join clients c on c.id = coalesce(s.client_id, o.client_id, store_client.id)
  left join billing_config b on b.client_id = c.id
  cross join params p
  where s.created_at >= p.window_start and s.created_at < p.window_end
),
reaches_billing_gate as (
  select * from resolved r
  where r.source = 'shipstation'
    and not r.voided and not r.is_return and not r.client_is_test
    and r.order_id is not null and r.resolved_client_id is not null
)
select
  case
    when r.billing_config_client_id is null                    then '1_no_billing_config_row'
    when r.billing_active is not true                          then '2_billing_config_inactive'
    when r.billing_updated_at is null or r.billing_mode is null then '3_policy_incomplete_THROWS'
    else '4_policy_present_and_active'
  end                                                          as policy_state,
  count(*)                                                     as rows,
  count(*) filter (where o.outcome = 'billing_inactive')       as outcome_billing_inactive,
  count(*) filter (where o.shipment_id is null)                as NO_OUTCOME_ROW,
  count(*) filter (where r.selected_rate_json ? 'customerShippingMoneyPolicyVersion')
                                                               as TUPLE_WRITTEN,
  count(*) filter (where r.old_loader_markup_pct = 0
                     and r.old_loader_markup_flat = 0)         as old_loader_would_be_zero_markup
from reaches_billing_gate r
left join customer_shipping_money_sync_outcomes o on o.shipment_id = r.id
group by 1
order by 1;
```

**Pass conditions:**

- States `1` and `2` → `outcome_billing_inactive` = `rows`, `NO_OUTCOME_ROW` = 0,
  **`TUPLE_WRITTEN` = 0**. `old_loader_would_be_zero_markup` is the counterfactual count:
  how many customer-money tuples the old loader would have minted from no policy.
- State `3` **must be 0 rows.** This is a genuine invariant, not a preference: such a row
  reaches `decideCustomerShippingMoneyForRow`, which throws
  `CustomerShippingPolicyUnavailableError` (`customer-shipping-money.ts:387-397`); the
  sync-ingress writer does **not** catch it, so the INSERT transaction aborts and no
  shipment row commits (`sync-ingress:30-42`). A state-`3` row existing in `shipments`
  means something committed a row that the freeze path could not have committed.
- State `3` failures that never committed are **invisible to SQL by construction**. They
  must be counted from the runtime log instead — see the `[ps-509]` row in §7.

---

## §7 — Runtime packet (required, and NOT recoverable from data)

The frozen v509 tuple carries exactly nine keys. Observed 2026-08-22 01:18 UTC over all
142 v509 rows:

```
billingDescriptionSuffix              142
cShippingRateAmount                   142
customerRateSource                    142
customerShippingMoneyCaptureSource    142
customerShippingMoneyPolicyVersion    142
rateCostSource                        142
selectedRateCost                      142
shippingMarginAmount                  142
shippingMarginPct                     142
```

There is **no** `pricingAuthority` / `markupAuthority` key. The markup authority that
produced the number is therefore **not** reconstructible from the tuple, and the operative
flag state cannot be inferred after the fact. It must be recorded at measurement time.

`customer-shipping-money.ts:411-419`:

```ts
  const perAccountMarkupEnabled = process.env.BILLING_PER_ACCOUNT_MARKUP === 'on';
  const perAccountMarkups = perAccountMarkupEnabled
    ? options.exec
      ? await loadCarrierMarkups(options.exec, { useCache: false })
      : await loadCarrierMarkups()
    : null;
```

DEFAULT-OFF. `'on'` switches the resolved markup from client-billing-config to a
per-carrier-account override, which changes `cShippingRateAmount`.

**Record all of the following in the acceptance packet, at measurement time:**

| Field | Source | Recorded |
|---|---|---|
| Live `commitSha` | `GET /health` before AND after the run | `d8f80f5da717bd393681cb538b92c44a360e56b7` (single read, 2026-08-22T01:15:44.660Z) |
| `serviceId` / `instanceId` | `GET /health` | `srv-d7qoar7lk1mc73cm4ma0` / `srv-d7qoar7lk1mc73cm4ma0-7b597d74d7-fn2w2` |
| `WINDOW_START` | Render deploy-live timestamp for the SHA | **NOT YET OBTAINED** — see §1.1 |
| `BILLING_PER_ACCOUNT_MARKUP` | running service env | **NOT RECORDED — REQUIRED** |
| `INVENTORY_AUTO_DEDUCT` | running service env | not required for this gate; record for completeness |
| `[ps-509]` error lines | runtime log over the window | **NOT RECORDED — REQUIRED** (counts the §6 state-3 aborts) |

An acceptance run missing the `BILLING_PER_ACCOUNT_MARKUP` row or the `[ps-509]` log count
is incomplete and must not be reported as passing.

---

## §8 — Proven properties

> ⚠️ **The figures in this table were measured with the SUPERSEDED queries** (`created_at`
> watermark, `coalesce(selected_rate_cost, cost, label_cost)` predicate, aggregate counts
> rather than anti-joins). They are retained for continuity. Their re-verification status
> under the corrected queries is in §8.1. **Neither the original measurement nor the
> re-verification is at the live SHA, so neither is gate evidence.**

| Property | Result (superseded method) |
|---|---|
| Coverage — post-watermark eligible sync rows reach 100% `valid_ps509` | 142 / 142 (100%) |
| Both trigger boundaries exercised | `sync_insert` 133, `orphan_link` 9 |
| Late attribution is the ordinary path, not a review state | all 9 link rows `evaluation_count = 2`, outcome `frozen`, zero `late_attributed` failures |
| No repricing on re-evaluation † | 9 re-evaluated, all still `frozen` |
| Zero malformed / unknown versions | 0 |
| Capture provenance | 142 / 142 `shipstation_sync_ingestion` |
| Rate-cost provenance | 142 / 142 `shipstation_sync_receipt_cost` |
| Customer-rate sources inside the sync-ingestion allow-list | only `carrier_markup_customer_shipping_rate`, `hugrab_shipping_rate_override` |
| Margin reconciles (`cost + margin = customer`) | 0 failures |
| Frozen cost equals the shipment's own cost | 0 disagreements |
| Non-positive customer amounts | 0 |
| Returns excluded | 0 v509 tuples on `is_return` |
| Voided excluded | 0 v509 tuples on `voided` |
| Non-ShipStation excluded | 0 |
| Unattributed excluded | 0 v509 tuples with null `order_id` / `client_id` |
| Outcome metadata never leaks outside the version key | 0 capture-source keys without a v509 tuple |
| Receipt revisions after freeze | 0 rows |
| Durability guards present | `csm_sync_outcomes_mutation_guard`, `csm_sync_outcomes_no_truncate` |

Money frozen in the window: **$1,205.06** customer on **$1,187.82** cost.

† **Overstated in the superseded doc, corrected here.** The outcomes table stores **no
money**, so it cannot prove that amounts did not change on re-evaluation. What the data
proves is that the outcome stayed `frozen`. Non-repricing is guaranteed by *code* — the
classification-first branch returns the existing tuple without re-deciding
(`sync-ingress:240-248`) and the write is a one-shot key-presence predicate
(`sync-ingress:343-348`) — not by the durable record. Cite the code, not the table.

### 8.1 Re-verification status under the corrected queries

The corrected queries were re-run on **2026-08-22 01:16–01:22 UTC** over the same
**historical** window (`WINDOW_START = 2026-08-19 16:00:00+00`, `WINDOW_END = infinity`) to
validate the method itself. Results:

| Corrected query | Result over the historical window |
|---|---|
| Q1 lane split | 133 lane A (`sync_insert`, `evaluation_count = 1`), 9 lane B (`orphan_link`, `evaluation_count = 2`), **0 lane C**; `shipment_predates_window = 0` in every lane |
| Q2 row-level anti-join | single group `frozen`, 142 rows, `MISSING_OUTCOME_ROW = 0`, `OUTCOME_MISMATCH = 0`, `MISSING_V509_TUPLE = 0`, `TUPLE_ON_INELIGIBLE = 0` |
| Q2b uncovered ids | zero rows |
| Q3 fallback-only | `writer_eligible_cost = 142`, `EXCLUDED_fallback_only = 0`, `EXCLUDED_no_cost_at_all = 0` |
| Q4 tuple contract | 142 frozen; every `BAD_*` / `WRONG_*` / `MISMATCH` / `DISAGREEMENT` / `NON_POSITIVE` / `MISSING_*` column = 0; totals reproduce **$1,205.06 / $1,187.82** |
| Q5 exclusions + leak | all six columns = 0 |
| Q6 receipt revisions | 0 rows in window; 0 rows in the table overall |
| Q7 review / retry backlog | zero rows (`needs_review` 0, `needs_retry` 0, `billing_inactive` 0) |
| Q8 guards | four triggers present, definitions and function bodies as quoted in §5 |
| Q9 counterfactual | all 142 rows in state `4_policy_present_and_active`; state `1` = 0, state `2` = 0, **state `3` = 0** |

**Reading this correctly:** the corrected method reproduces every historical figure, so the
superseded queries happened to land on the same numbers for this particular population —
including the eligibility predicate, because `EXCLUDED_fallback_only = 0` and every
resolved client id was already present on `shipments.client_id`. That is a property of the
data in this window, **not** a defence of the method. On a window containing a
fallback-only cost row, a store-resolved client, a test client, an inactive billing config,
or a post-deploy `orphan_link` against a pre-deploy shipment, the two methods diverge.

Per Hermes's ruling, this historical re-run **is not** the gate and the 142-row acceptance
does not need to be redone.

---

## §9 — Current-deployment delta (the actual gate), measured 2026-08-22 01:16 UTC

| Measurement | Value |
|---|---|
| Live SHA at measurement | `d8f80f5da717bd393681cb538b92c44a360e56b7` |
| Outcome rows in table, total | 142 |
| `max(first_evaluated_at)` | `2026-08-21 21:34:44.496487+00` |
| `max(last_evaluated_at)` | `2026-08-21 21:34:44.496487+00` |
| Evaluations at/after the `fe23b4eb` commit (`2026-08-21 22:46:05Z`) | **0** |
| Evaluations at/after the `d8f80f5d` commit (`2026-08-22 00:53:43Z`) | **0** |
| Eligible shipments created after either commit | **0** |

The last evaluation anywhere in the table predates the `fe23b4eb` **commit** by 72 minutes,
so the result is independent of either deploy-live timestamp — no choice of `WINDOW_START`
within §1.1's bounds admits a single row.

**The delta cohort is empty.** No outcome row in production has a `last_evaluated_at` at or
after either candidate `WINDOW_START`. There is therefore no evidence at all — not partial
evidence — for the currently live SHA. The gate cannot pass on the present data.

## §10 — What remains

Sync inserts run roughly 49 shipments/day. Fresh evidence accrues on its own; nothing needs
to be forced, and nothing may be forced (no replay, no sweep trigger, no production write).

1. Obtain `WINDOW_START` for the live SHA per §1.1 and record the §7 runtime packet —
   including `BILLING_PER_ACCOUNT_MARKUP`, which is required and currently unrecorded.
2. Wait for eligible ShipStation sync inserts under the live SHA. A population covering
   **lane A and lane B** of Q1 is required — insert-frozen and link-frozen — because the
   link lane is where the changed policy loader is most likely to behave differently, and
   because §3.2 shows lane C cannot substitute for lane B.
3. Run Q1–Q9 in full. Confirm the anti-joins (Q2, Q2b) return zero uncovered ids, Q7
   returns zero rows, and Q9 state `3` is zero — plus the `[ps-509]` runtime log count for
   the aborts SQL cannot see.
4. Re-read `/health`. If `commitSha` changed during the run, the window is void; repeat.
5. Only then does PS-508 cutover-substrate work unblock.

## Note for PS-508

This gate is 30% of PS-508 by the card's own weighting. The writer's contract properties
hold across 142 production rows under both the superseded and the corrected queries, which
is real evidence that the implementation is sound — but it is evidence about *earlier*
SHAs, measured for the first two of those SHAs by a method that could not have detected a
post-deploy link-boundary evaluation, a fallback-only cost row, or a store-resolved client.
What blocks the gate is an empty cohort at the live SHA. No cutover-substrate work should
start until the §10 re-measurement passes, per the packet.
