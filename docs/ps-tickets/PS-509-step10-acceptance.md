# PS-509 step 10 — deployed runtime writer acceptance

Measured 2026-08-22 by read-only production analysis. Nothing was written.

## Verdict: **GATE NOT PASSED — evidence exists, but not at the deployed SHA**

Every substantive acceptance property the packet asks for is **satisfied in
production data**. The gate still fails on one requirement, and it is the one
Hermes wrote in capitals: *production evidence **at the exact deployed SHA***.

- Evidence population: **142 outcome rows**, `2026-08-19 16:07` → `2026-08-21 21:34`.
- Currently deployed SHA: **`fe23b4eb`**, live `2026-08-21 22:52`.
- Outcomes produced at `fe23b4eb`: **0**. Shipments inserted since that deploy: **0**.

The evidence was produced by `dd79e02d`…`4b5c9e2c`. That would be a technicality
if the writer were unchanged across those SHAs. **It is not.**

## Why the SHA gap is material, not procedural

The ingress writer delegates policy resolution to
`decideCustomerShippingMoneyForRow` in `src/services/customer-shipping-money.ts`.
That file changed **+144 / −29** between `dd79e02d` and `fe23b4eb` (the PS-502
completion merge), and the change is in the money path:

```sql
-  coalesce(b.active, true)              as "billingActive"
-  coalesce(b.shipping_markup_pct, 0)    as "shippingMarkupPct"
+  b.client_id                           as "billingConfigClientId"
+  to_char(b.updated_at ...)             as "billingConfigUpdatedAt"
```

The new code's own comment states the defect it closes: *"A LEFT JOIN miss must
remain NULL; coalescing it to active + zero markup **minted customer money from
no policy at all**."* A shipment whose client has no `billing_config` row would
previously have frozen a zero-markup tuple; under the deployed code it fails
closed via `CustomerShippingPolicyUnavailableError`.

So eligibility outcomes and frozen amounts are **not guaranteed identical** across
the evidence window. Also changed in the same span:
`customer-shipping-money-snapshot.ts` (+225, the pricing-authority reader),
`shipment-sync.ts` (+572), `order-sync.ts` (+12).

## What IS proven (at the prior SHAs) — all green

| Property | Result |
|---|---|
| Coverage — post-watermark eligible sync rows reach 100% `valid_ps509` | **142 / 142 (100%)**, whether frozen at insert or at link |
| Both trigger boundaries exercised | `sync_insert` **133**, `orphan_link` **9** |
| Late attribution is the ordinary path, not a review state | all 9 link rows `evaluation_count = 2`, outcome `frozen`, **zero** `late_attributed` failures |
| No repricing on re-evaluation | 9 re-evaluated, all still `frozen`; DB trigger `csm_sync_outcomes_block_mutations` makes `frozen` terminal and shipment identity immutable |
| Zero malformed / unknown versions | **0** |
| Capture provenance | **142 / 142** `shipstation_sync_ingestion` |
| Rate-cost provenance | **142 / 142** `shipstation_sync_receipt_cost` |
| Customer-rate sources inside the sync-ingestion allow-list | only `carrier_markup_customer_shipping_rate`, `hugrab_shipping_rate_override` |
| Margin reconciles (`cost + margin = customer`) | **0** failures |
| Frozen cost equals the shipment's own cost | **0** disagreements |
| Non-positive customer amounts | **0** |
| Returns excluded | **0** v509 tuples on `is_return` |
| Voided excluded | **0** v509 tuples on `voided` |
| Non-ShipStation excluded | **0** |
| Unattributed excluded | **0** v509 tuples with null `order_id`/`client_id` |
| Outcome metadata never leaks outside the version key | **0** capture-source keys without a v509 tuple |
| Receipt revisions after freeze | **0** rows (base rate was 0 of 2,748 — expected) |
| Durability guards present | `csm_sync_outcomes_mutation_guard`, `csm_sync_outcomes_no_truncate` |

Money frozen in the window: **$1,205.06** customer on **$1,187.82** cost.

## What remains — and it is small

Sync inserts ~49 shipments/day (96 in 48h, 7 in the last 6h). Fresh evidence
accrues on its own; nothing needs to be forced.

1. Wait for eligible ShipStation sync inserts under `fe23b4eb`. A population
   covering **both** boundaries is required — insert-frozen and link-frozen —
   because the link lane is where the changed policy loader is most likely to
   behave differently.
2. Re-run §"What IS proven" with the watermark set to the `fe23b4eb` deploy time
   (`2026-08-21 22:52 UTC`) rather than the first-outcome time. Queries are in §Method.
3. Specifically confirm at the new SHA: coverage still 100%, **zero**
   `billing_inactive` / `needs_review` outcomes appearing where the old loader
   would have frozen a zero-markup tuple, and zero malformed versions.
4. Only then does PS-508 cutover-substrate work unblock.

## Method (reusable)

Watermark-parameterised. Replace the literal with the deploy timestamp.

```sql
-- coverage + tuple validity at a SHA watermark
with post as (
  select s.id, s.source, s.is_return, s.voided, s.order_id, s.client_id,
         coalesce(s.selected_rate_cost, s.cost, s.label_cost) as cost,
         s.selected_rate_json->>'customerShippingMoneyPolicyVersion' as ver
  from shipments s
  where s.created_at >= timestamptz '<DEPLOY_TS>'
)
select count(*) as shipments,
  count(*) filter (where source='shipstation' and not coalesce(is_return,false)
    and not coalesce(voided,false) and order_id is not null and client_id is not null
    and coalesce(cost,0) > 0)                                   as eligible,
  count(*) filter (where exists (select 1 from customer_shipping_money_sync_outcomes o
                                 where o.shipment_id = post.id)) as has_outcome,
  count(*) filter (where ver = 'ps-509-v1')                      as v509_tuples
from post;
```

Exclusion, provenance, margin-reconciliation and trigger checks are the queries
reproduced in the table above; all are read-only against `shipments`,
`customer_shipping_money_sync_outcomes`,
`customer_shipping_money_receipt_revisions`, `pg_trigger` and `pg_proc`.

## Note for PS-508

This gate is 30% of PS-508 by the card's own weighting, and it is **closer than
the card implies** — the writer is demonstrably correct in production across 142
rows and every contract property. What blocks it is a SHA alignment that time
alone resolves, not a defect. No cutover-substrate work should start until the
re-measurement passes, per the packet.
