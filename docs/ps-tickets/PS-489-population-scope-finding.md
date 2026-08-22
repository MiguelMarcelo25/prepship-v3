# PS-489 Phase 0 — classification evidence appendix

**Status:** read-only classification evidence. No decision, no recommendation, no code change.
No chargeability, representation, remediation, or red-contract completion is claimed.

## Snapshot identity

| | |
|---|---|
| Query window | **2026-08-22 05:11:23 UTC** |
| Database | `postgres`, PostgreSQL **17.6** |
| Application SHA | `87b2e11d` (`prepshipv4-stable`) |
| Executable SQL | [`scripts/ps-489-phase0-evidence.sql`](../../scripts/ps-489-phase0-evidence.sql) — SELECT-only, no DDL, no DML |
| Row grain | one `orders` row = one order. **Never** a billing line, never a shipment. |

Every table below is verbatim output of the correspondingly numbered query in that file.

---

## Withdrawn claims

Recorded rather than silently edited.

| Withdrawn | Why it was wrong |
|---|---|
| "Neither writer of `order_status='shipped'` ever creates a shipment row" | The grep behind it covered **two files**. Eight writers exist. Callers create the shipment first, then invoke the lifecycle command. |
| "They are the same problem" (of the unflagged cohort) | Never established. No active outbound shipment identifies an evidence gap, not a fulfilment type. |
| Population `18,250` | Used only `shipments.order_id`; missed orphan links and counted inactive rows as shipments. |
| "PS-489's scope reaches 20%" | Rests on the withdrawn equivalence. |
| Canonical owner keyed on "shipped with no PrepShip shipment record" | Withdrawn. `externally_shipped=true` too narrow; this too broad. |
| "12,173 become exceptions on regeneration" | Unexecuted forecast stated as outcome. |
| "859 carry affirmative evidence of external fulfilment" | The classifier is absence-based, and 857 of the 859 originate from a status-only transition. |
| "95% have no provenance" | Correct term is **no lifecycle-event receipt**. Other provenance may exist in raw payloads, webhooks, overrides, label receipts, tracking, print queue, source identities, historical shipment rows. |
| **"Rescued by orphan `order_number`: 21"** | **Measured value is 20.** The 21 came from a looser predicate and caused an off-by-one in the reconciliation. |
| **Six-category taxonomy totalling 18,437** | Double-counted 102 orders. Shipment history is an **orthogonal attribute**, not a provenance class. Replaced by two independent dimensions below. |
| **"Zero post-cutover terminal transitions bypassed the lifecycle owner"** | Stronger than a mutable `updated_at` proxy can support. See Q6. |

Corrected writer inventory:

```
$ grep -rn "insert(shipments)" src/ scripts/ --include=*.ts
src/services/labels.ts:793, 1294, 2718, 3637, 4105
src/services/replacement-shipment-command.ts:250
src/services/shipment-sync.ts:1075
scripts/backfill-shipstation-fulfillments.ts:250
```

`shipment-sync-watchdog.ts:637-676` already monitors this exact condition under
`externally_shipped=false` and names it **`missing_active_shipments`** — a synchronization-health
condition, not external fulfilment.

## Q1 — predicate transition matrix

Reconciles **both** totals exactly.

| naive_missing | correct_missing | orders | meaning |
|---|---|---:|---|
| true | true | 18,230 | unchanged missing |
| true | false | **20** | rescued by active orphan `order_number` |
| false | true | 105 | inactive-only history now recognised missing |
| false | false | 25,060 | unaffected |

18,230 + 20 = **18,250** (naive). 18,230 + 105 = **18,335** (correct). Sum 43,415.

## Q2 — population

| | orders |
|---|---:|
| Lifecycle-shipped, all time | 43,415 |
| **No active ordinary outbound shipment** | **18,335** |
| …flagged `externally_shipped` | 3,749 |
| …unflagged | 14,586 |

Predicate adopted from `shipment-sync-watchdog.ts:654-670`: linked by `order_id` **or** orphan
`order_number`, excluding `source='replacement'`, voided, and return rows.

**The only valid statement about this set:** *18,335 lifecycle-shipped orders have no active
ordinary outbound shipment.* They are **not** established to be externally fulfilled, lacking all
shipment evidence, billable, or certain to emit `shipping_missing`.

## Q3 — Dimension 1: lifecycle/provenance partition

Mutually exclusive. Sums to exactly 18,335.

| provenance class | orders | also has inactive shipment history |
|---|---:|---:|
| 1. classifier-declared external | 859 | 2 |
| 2. void lifecycle history | 3 | 3 |
| 3. status-only shipped | 6 | 0 |
| 4. other event pattern | 0 | 0 |
| 5. flagged, no lifecycle receipt | 2,890 | 38 |
| 6. unflagged, no lifecycle receipt | 14,577 | 62 |
| **total** | **18,335** | 105 |

**Source-verified external occurrence: 0 established.** That class is deliberately absent from
this partition because no order currently qualifies. It is *not* a claim that zero exist.

## Q4 — Dimension 2: shipment-history attribute

**Orthogonal to Q3. Never add these to Q3.** The 105 distributes across Q3's classes
(2 + 3 + 0 + 38 + 62 = 105); adding the dimensions double-counted 102 orders in the prior version.

| shipment-history attribute | orders |
|---|---:|
| a. no shipment history | 18,230 |
| b. **voided-only** | **105** |
| c. return-only | 0 |
| d. replacement-only | 0 |
| e. mixed inactive history | 0 |
| **total** | **18,335** |

All 105 are voided-only. No return-only, replacement-only, or mixed-history orders exist in this
population.

## Q5 — full ordered lifecycle history

Ordered `effective_at`, `created_at`, `id`. Latest-event-only attribution is insufficient: it
conceals the establishing event.

| flagged | events | first transition | first source | last transition | orders |
|---|---:|---|---|---|---:|
| true | 2 | `shipped` | **`order_sync_status`** | `external_shipped` | **857** |
| true | 2 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| true | 3 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| false | 1 | `shipped` | `order_sync_status` | `shipped` | 6 |
| false | 1 | `void` | `label_void:shipstation` | `void` | 2 |
| false | 2 | `shipped` | `prepship_v2` | `void` | 1 |

**857 of the 859 first became `shipped` through `order_sync_status`** — the order-level catch-up
whose own source comments call it review-only, not shipment-line proof (`order-sync.ts:699-750`)
— and were classified external afterwards. Only 2 originate from `shipment_sync`. Reading the
latest event alone reports all 859 as plainly external and hides that origin.

### The 859 are classifier-declared, not source-verified

`scripts/reconcile-external-shipped-orders.ts:121-165,278-327` concludes external by **absence**:

```ts
if (input.upstream.hasShipment || input.upstream.hasFulfillment) {
  return 'recoverable';
}
return 'external';
```

persisted as `source: 'external_shipped_classifier'`,
`provenance: { classification: 'marketplace_fulfilled' }`. It records the conclusion — not the
provider response, account queried, query timestamp, upstream identity, response hash,
negative-result completeness, or any marketplace fulfilment receipt.

**Short label:** *locally classifier-marked external-shipped cohort — not independently
fulfilment-verified.*

**Governing limit on all lifecycle evidence here:** an external lifecycle event proves a local
workflow/classification action. It does **not** prove physical fulfilment, cost authority, or
customer chargeability. Append-only immutability does not imply historical completeness — it
guarantees nothing about what was never written.

## Q6 — lifecycle-SOT coverage partition (proxy measurement)

`drizzle/0070_order_lifecycle_commands.sql` (PS-424, `f568bc5f`, committed 2026-07-16), additive
only, history not backfilled. Events append-only (`:26-39`); deletion only via the bounded
test-data purge (`0082_test_data_purge_guards.sql:107-120`).

| flagged | cohort | orders | earliest | latest |
|---|---|---:|---|---|
| false | `updated_at` before proposed boundary | 14,577 | 2026-04-24 | 2026-07-15 |
| true | `updated_at` before proposed boundary | 2,890 | 2026-05-29 | 2026-07-15 |
| — | `updated_at` on or after proposed boundary | **0** | — | — |

**Correct conclusion, and the limit of it:**

> No no-receipt order in the measured cohort has `orders.updated_at` on or after the proposed
> 2026-07-16 boundary; the latest is 2026-07-15. This is **consistent with** legacy provenance
> debt. But `orders.updated_at` is mutable row metadata, not terminal-transition provenance, and
> the boundary is a **commit** date, not a proven production migration or deployment timestamp.
> **Zero post-cutover bypasses are therefore not proven.**

Closing the invariant requires the later of the production migration-application timestamp for
`0070` and the production deployment timestamp for the lifecycle-owner code, then inspection of
source import/sync timestamps, webhook occurrence times, terminal status observation times,
lifecycle effective times, durable command receipts, and deployment/account/store boundaries.

Until then **"no fourth ticket required" is provisional, not closed.**

## Q7 — reconciliation assertions

Fail if totals differ.

| assertion | result | detail |
|---|---|---|
| provenance partition sums to population | **PASS** | 18335 vs 18335 |
| naive + inactive-only − rescued = correct | **PASS** | 18250 − 20 + 105 = 18335 vs 18335 |

## Evidence confidence and observation time

Evidence kind, source, observed-at, source event timestamp, account/store identity, completeness
status, confidence, and whether evidence is affirmative / negative / operator-declared / inferred
are **not yet captured in this document, and are required in the next evidence artifact.**

What can be said now: all figures derive from local database state at the snapshot above.
Upstream negative results carry the classifier's **original** observation window, not this one.
Provider absence is time-sensitive; a historical "no shipment found" is not re-verified here and
cannot prove what occurred historically.

## What this does not license

- No representation recommendation, for any cohort.
- The 2,890 must be classified before entering any historical impact population, revenue exposure
  figure, remediation, or backfill. They may inform forward policy design.
- The 17,467 are set aside from PS-489's current impact and recommendation — **not permanently.**
  They belong to the classification successor unless affirmative external evidence is found.
- The billing generator cannot preview anything: `billing.ts:886` declares regeneration a money
  mutation and `billing.ts:1712-1793` deletes and inserts. No `dryRun` exists. A surrounding
  rollback is insufficient — multiple transactions on the shared pool.
- `shipmentCost` remains candidate evidence pending provider-semantics proof.
- No claim that the red contract term is satisfied.

## What was not done

No writes of any kind. No billing regeneration. No reclassification. No provider lookups. No
postage, labels, or purchases. No locked surface modified — this adds one SELECT-only SQL file
and this document.
