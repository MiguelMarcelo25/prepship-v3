# PS-489 Phase 0 — classification investigation of shipped orders with no active outbound shipment

**Status:** read-only classification evidence. No decision, no recommendation, no code change.

**Snapshot:** 2026-08-22, production, read-only. Application SHA `1bd67581` (`prepshipv4-stable`).

This document **replaces** the first version of this file in full. That version contained claims
that are now withdrawn; they are listed first so the withdrawal is part of the record rather than
a silent edit.

---

## Withdrawn claims from the previous version

| Withdrawn claim | Why it was wrong |
|---|---|
| "Neither writer of `order_status='shipped'` ever creates a shipment row" | The grep behind it covered **two files**. Eight shipment writers exist. Callers create the shipment first, then invoke the lifecycle command. |
| "They are the same problem" (of the 2,185 / 14,541) | Never established. `shipped with no shipment row` identifies an evidence gap, not a fulfilment type. |
| Population `18,250` | Used only `shipments.order_id`. Missed orphan `order_number` links and counted void/return/replacement rows as shipments. |
| "PS-489's scope reaches 20%" | Rests on the withdrawn equivalence above. |
| Canonical owner should key on "shipped with no PrepShip shipment record" | Withdrawn. `externally_shipped=true` was too narrow; this is too broad. |
| "12,173 become exceptions on regeneration" | Unexecuted forecast stated as outcome. |
| "859 carry affirmative evidence of external fulfilment" | Wrong twice: the classifier is absence-based, and the underlying transition was status-only. See below. |
| "95% have no provenance" | Correct statement is **no lifecycle-event receipt**. Other provenance may exist in raw payloads, receipts, tracking, print queue, source identities. |

The corrected writer inventory:

```
$ grep -rn "insert(shipments)" src/ scripts/ --include=*.ts
src/services/labels.ts:793, 1294, 2718, 3637, 4105
src/services/replacement-shipment-command.ts:250
src/services/shipment-sync.ts:1075
scripts/backfill-shipstation-fulfillments.ts:250
```

The repository already draws the distinction the withdrawn key would have erased:
`shipment-sync-watchdog.ts:637-676` monitors `order_status='shipped' AND externally_shipped=false`
with no active outbound shipment and names the result **`missing_active_shipments`** — a
synchronization-health condition, not external fulfilment.

## Lane A — population under the repository's own active-outbound predicate

Adopted from `shipment-sync-watchdog.ts:654-670`: linked by `order_id` **or** orphan
`order_number`, excluding `source='replacement'`, voided, and return rows.

```sql
with base as (
  select o.id, o.order_number, coalesce(o.externally_shipped,false) as flagged
  from orders o where o.order_status='shipped'
),
noactive as (
  select b.* from base b
  where not exists (select 1 from shipments s where s.order_id=b.id
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
    and not exists (select 1 from shipments s where s.order_id is null and s.order_number=b.order_number
      and s.source is distinct from 'replacement'
      and coalesce(s.voided,false)=false and coalesce(s.is_return,false)=false)
)
select ... ;
```

| | orders |
|---|---:|
| Lifecycle-shipped, all time | 43,415 |
| Naive "no row by `order_id`" (withdrawn figure) | 18,250 |
| **No active ordinary outbound shipment** | **18,335** |
| …flagged `externally_shipped` | 3,749 |
| …unflagged | 14,586 |
| Rescued by orphan `order_number` match | 21 |
| Had **only** void/return/replacement rows | 105 |

The withdrawn 18,250 was wrong in both directions and approximately right by coincidence.

**The only valid statement about this set:** *18,335 lifecycle-shipped orders have no active
ordinary outbound shipment.* They are **not** established to be externally fulfilled, lacking all
shipment evidence, billable, or certain to emit `shipping_missing`.

## Lane B — lifecycle provenance, full ordered history

Ordered by `effective_at`, then `created_at`, then `id`. Latest-event-only attribution is
insufficient and is not used: it concealed the origin transition for 857 of 859 orders.

| flagged | events | first transition | first source | last transition | orders |
|---|---:|---|---|---|---:|
| true | 2 | `shipped` | **`order_sync_status`** | `external_shipped` | **857** |
| true | 2 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| true | 3 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| false | 1 | `shipped` | `order_sync_status` | `shipped` | 6 |
| false | 1 | `void` | `label_void:shipstation` | `void` | 2 |
| false | 2 | `shipped` | `prepship_v2` | `void` | 1 |
| — | 0 | *(no lifecycle-event receipt)* | — | — | **17,467** |

**857 of the 859 classifier-declared orders first became `shipped` through
`order_sync_status`** — the order-level status catch-up whose own source comments call it
review-only, not shipment-line proof (`order-sync.ts:699-750`). The external classification was
applied afterwards. Reading only the latest event would report these as straightforwardly
external and hide that their origin carries no shipment-scoped evidence at all.

### The 859 are classifier-declared, not source-verified

`scripts/reconcile-external-shipped-orders.ts` concludes external by **absence**:

```ts
if (input.upstream.hasShipment || input.upstream.hasFulfillment) {
  return 'recoverable';
}
return 'external';
```

written with `source: 'external_shipped_classifier'`,
`provenance: { classification: 'marketplace_fulfilled' }`.

That is a durable decision receipt. It records the conclusion, not the provider response, account
queried, query timestamp, upstream identity, response hash, negative-result completeness, or any
marketplace fulfilment receipt.

**Correct wording, used throughout:** *859 orders carry a durable `external_shipped_classifier`
decision receipt based on successful upstream negative lookups under the classifier's
then-current rules. The underlying external-fulfilment fact still requires source-evidence
validation.*

**Short label, to be used wherever the cohort is named in one line:** *locally classifier-marked
external-shipped cohort — not independently fulfilment-verified.*

The governing limit on all lifecycle evidence in this document: **an external lifecycle event
proves a local workflow/classification action. It does not prove physical fulfilment, cost
authority, or customer chargeability.** Event immutability likewise does not imply historical
completeness — append-only guarantees nothing about what was never written.

## Lane B2 — lifecycle-SOT cutover partition

`drizzle/0070_order_lifecycle_commands.sql` (PS-424) landed **2026-07-16** (`f568bc5f`) and states
it is additive only, not a historical rewrite — history was not backfilled. Events are append-only
(`0070_order_lifecycle_commands.sql:26-39`); deletion exists only via the bounded test-data purge
(`0082_test_data_purge_guards.sql:107-120`). So absence of an event before the cutover is expected
debt; absence after it would be an invariant leak.

Partitioned on `orders.updated_at` against that boundary:

| cohort | flagged | orders | earliest updated | latest updated |
|---|---|---:|---|---|
| pre-cutover legacy debt | false | 14,577 | 2026-04-24 | **2026-07-15** |
| pre-cutover legacy debt | true | 2,890 | 2026-05-29 | **2026-07-15** |
| **post-cutover invariant leak** | — | **0** | — | — |

**All 17,467 predate the cutover. The latest is 2026-07-15 — the day before the migration.
Zero post-cutover terminal transitions bypassed the lifecycle owner.**

Per the standing rule that a fourth ticket is warranted only if a post-cutover leak exists:
**no lifecycle-invariant ticket is required.** This is historical provenance debt, not a live
engineering defect.

Stated limit: `updated_at` is a proxy for the terminal transition time and can be moved by any
later write. A stricter partition using source import/sync timestamps is still owed before this
is treated as conclusive.

## Evidence taxonomy

| category | definition | count |
|---|---|---:|
| 1. Source-verified external occurrence | Provider/marketplace fulfilment receipt, retained `externallyFulfilled=true` with valid source identity, or verified operator declaration | **0 established** |
| 2. Classifier-declared external | Durable `external_shipped_classifier` receipt from negative upstream lookup | 859 |
| 3. Flagged but provenance-unattributed | `externally_shipped=true`, no lifecycle-event receipt | 2,890 |
| 4. Status-only shipped | `order_sync_status` transition, no shipment-scoped evidence | 6 |
| 5. Void/return/replacement-only history | — | 105 |
| 6. Unknown provenance | No lifecycle-event receipt, unflagged | 14,577 |

Categories 1 and 2 are deliberately **not** merged. Only category 1 enters the PS-489
architecture discussion, and it is currently empty pending source-evidence validation.

## What this does not license

- **No representation recommendation.** Not for the 859, not for the 14,586.
- **The 2,890 must be classified** before entering any historical impact population, revenue
  exposure figure, remediation, or backfill. They may inform forward policy design.
- **The 12,173 remain a candidate cohort.** "They become exceptions on regeneration" is an
  **unexecuted forecast**, not an outcome.
- **The billing generator cannot preview this.** `generateLineItems` is a money mutation by its
  own declaration — `billing.ts:886` reads "Regeneration is a money mutation" — and
  `billing.ts:1712-1793` locks candidates, deletes editable lines and inserts replacements. There
  is no `dryRun`. A surrounding rollback is insufficient because the function opens multiple
  transactions on the shared pool. Any preview requires either read-only extraction into a pure
  offline planner with parity fixtures, or an isolated discarded snapshot — each needing its own
  safety review first.
- **`shipmentCost` remains candidate evidence** pending provider-semantics proof.
- **No claim that the red contract term is satisfied.**

## Evidence confidence

Every classification above is derived from local database state observed **2026-08-22**. Upstream
negative results carry the classifier's original observation window, not this one; provider
absence is time-sensitive and a "no shipment found" from an earlier lookup is not re-verified
here. Confidence, observed-at, source event time, account identity and completeness are recorded
per lane in the tables above; where they are absent it is stated rather than implied.

## What was not done

No writes of any kind. No billing regeneration. No reclassification of any order. No provider
lookups. No postage, labels, or purchases. No locked surface modified — this document adds no
code.
