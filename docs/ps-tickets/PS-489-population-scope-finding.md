# PS-489 Phase 0 — classification evidence appendix

**Status:** read-only classification evidence. No decision, no recommendation, no code change.
No chargeability, representation, remediation, or red-contract completion is claimed.

## ⚠ This document is not yet a captured runner artifact

The figures below were measured **2026-08-22 05:11–05:40 UTC** through a read-only
administrative channel, across **several separate statements**, before the current runner
existed. They are **not** the captured output of one execution of
[`scripts/ps-489-phase0-evidence.ts`](../../scripts/ps-489-phase0-evidence.ts).

Every query in this document has been individually validated against production read-only, and
the runner reproduces them. But **no single-transaction captured artifact exists yet**, because
executing the runner needs database credentials this working environment does not hold — the
local `DATABASE_URL` fails authentication (`28P01`).

**Owed before this qualifies as an accepted evidence appendix:** one run of the runner inside its
single repeatable-read read-only transaction, with the complete unedited output committed as
`docs/ps-tickets/evidence/PS-489-phase0-<UTC>.txt` plus its SHA-256, and this document reduced to
linking that artifact rather than restating tables.

Until then, treat the tables here as **individually verified measurements, not a single-snapshot
capture.**

## Run identity

| | |
|---|---|
| Measurement window | 2026-08-22 05:11–05:40 UTC (multi-statement, see above) |
| Database | `postgres`, PostgreSQL **17.6** |
| Application SHA | `5cc1ef56` → this revision |
| Runner | [`scripts/ps-489-phase0-evidence.ts`](../../scripts/ps-489-phase0-evidence.ts) |
| Isolation | `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` — one snapshot for every section; `READ ONLY` is enforced by Postgres, so any DDL/DML would abort the transaction |
| Timing | wall clock via `clock_timestamp()`; `now()`/`transaction_timestamp()` are fixed at transaction start and cannot measure elapsed time |
| Snapshot id | `pg_current_snapshot()` — a **consistent transaction snapshot identifier**, not an immutable or restorable database snapshot; meaningful only while the transaction is open |
| Exit contract | nonzero if any **integrity** assertion fails. Open boundaries may be red without invalidating the appendix. `--require-exact-population` additionally fails on unresolved open boundaries |
| Baseline policy | asserts **relationships only**; never hard-codes an observed production count, so normal drift is not mistaken for broken evidence logic |
| Row grain | one `orders` row = one order. **Never** a billing line, never a shipment. |

**Denominator caveat.** The population uses **literal `orders.order_status = 'shipped'`**. It does
**not** use the lifecycle-effective status owner (`order-lifecycle-status.ts`). Cancelled,
upstream-cancelled, and differently-projected externally-flagged orders are absent from this
denominator. The term "lifecycle-shipped" is withdrawn from this document.

---

## Headline

> **Population boundary: 18,335–18,355 literal-shipped orders lack an identity-qualified active
> ordinary outbound shipment determination.**
>
> - **18,335** under the current watchdog predicate, trusting all orphan-number exclusions.
> - **18,355** when none of the identity-ambiguous orphan exclusions is trusted.
> - The exact count within that interval requires account/client/store-qualified identity
>   resolution.

**The interval concerns an identity-qualified predicate determination — not proof of physical
shipment absence.** It must not be shortened to "18,335–18,355 orders have no shipment."

18,335 remains the exact current-watchdog result and is useful as such, but it is not the
unqualified headline.

## Open boundaries

These are honestly discovered unresolved questions, **not** integrity failures. They are reported
prominently and never weakened, but they do not invalidate the measurements.

| open boundary | state |
|---|---|
| orphan-arm exclusions are identity-qualified | **OPEN** — 20 exclusions across 10 identity decisions, every one cross-client. See §5 |
| true production cutover boundary is proven | **OPEN** — `updated_at` proxy only; see §7 |
| source-verified external evidence exists | **OPEN** — 0 orders meet the category-1 standard; provider probe not yet designed or reviewed |
| commercial policy is known | **OPEN** — client contracts not held |

---

## Withdrawn claims

| Withdrawn | Why |
|---|---|
| "Neither writer of `order_status='shipped'` ever creates a shipment row" | Grep covered **two files**. Eight writers exist. |
| "They are the same problem" (unflagged cohort) | Never established. No active outbound shipment is an evidence gap, not a fulfilment type. |
| Population `18,250` | Used only `order_id`; missed orphan links, counted inactive rows as shipments. |
| "PS-489's scope reaches 20%" | Rests on the withdrawn equivalence. |
| Canonical owner keyed on "no PrepShip shipment record" | `externally_shipped=true` too narrow; this too broad. |
| "12,173 become exceptions on regeneration" | Unexecuted forecast stated as outcome. |
| "859 carry affirmative evidence of external fulfilment" | Classifier is absence-based; 857 of 859 originate from a status-only transition. |
| "95% have no provenance" | Correct term is **no lifecycle-event receipt**. |
| "Rescued by orphan `order_number`: 21" | Measured value is **20**, and see below — "rescued" is itself withdrawn. |
| Six-category taxonomy totalling 18,437 | Double-counted 102. Shipment history is an orthogonal attribute. |
| "Zero post-cutover terminal transitions bypassed the lifecycle owner" | Stronger than a mutable `updated_at` proxy supports. |
| **"Rescued by active orphan `order_number`"** | **Now "excluded by the watchdog's orphan-`order_number` predicate."** The match is not proven to attribute an orphan shipment to a specific order — it is disproven for all 20. |
| **"All 105 are voided-only" / "no return-only, replacement-only or mixed exist"** (as previously produced) | The claim happens to be **true**, but the CASE ladder that produced it tested voided-only first and could absorb voided+return and voided+replacement rows. Now derived from a raw truth table instead. |
| **"Q7 assertions fail if totals differ"** | They returned a `FAIL` row and exited 0. Now a runner exits nonzero, and every count is recomputed from the source CTE rather than hard-coded. |
| **"Lifecycle-shipped"** as the denominator label | Replaced with literal `order_status='shipped'`. |

## §1 — predicate transition matrix

Both totals are **derived** from these four buckets, not asserted separately.

| naive_missing | correct_missing | orders | meaning |
|---|---|---:|---|
| true | true | 18,230 | unchanged missing |
| true | false | **20** | **excluded by the watchdog's orphan-`order_number` predicate** |
| false | true | 105 | inactive-only history now recognised missing |
| false | false | 25,060 | unaffected |

18,230 + 20 = **18,250** (naive). 18,230 + 105 = **18,335** (corrected). Sum **43,415**.

## §2 — population

| | orders |
|---|---:|
| Literal `order_status='shipped'` | 43,415 |
| **No active ordinary outbound shipment** | **18,335** |
| …flagged `externally_shipped` | 3,749 |
| …unflagged | 14,586 |

**The only valid statement:** *18,335 orders with literal `order_status='shipped'` have no active
ordinary outbound shipment under the watchdog predicate, whose orphan arm is not
identity-qualified.* They are **not** established to be externally fulfilled, lacking all shipment
evidence, billable, or certain to emit `shipping_missing`.

## §3 — Dimension 1: lifecycle/provenance partition

Mutually exclusive. Classifier-declared now requires the **exact event source**; any other
`external_shipped` writer gets its own class rather than being absorbed.

| provenance class | orders |
|---|---:|
| 1. classifier-declared external (`transition='external_shipped' AND source='external_shipped_classifier'`) | 859 |
| 1b. external, mixed sources | 0 |
| 1c. external, other source | **0** |
| 2. void lifecycle history | 3 |
| 3. status-only shipped | 6 |
| 4. other event pattern | 0 |
| 5. flagged, no lifecycle receipt | 2,890 |
| 6. unflagged, no lifecycle receipt | 14,577 |
| **total** | **18,335** |

**Source contract, measured:** any `external_shipped` event = 859; classifier-sourced = 859;
other-sourced = **0**. So the previous count was correct — but the previous *predicate* did not
establish it, and would have mislabelled operator, webhook, store-import or future external
writers as classifier-declared. It now does establish it, and 1c is an observed zero rather than
an unexamined one.

**Source-verified external occurrence: 0 established** — deliberately absent from the partition
because no order qualifies. Not a claim that zero exist.

## §4 — Dimension 2: shipment-history attribute

**Orthogonal to §3. Never add these to §3.** Classified from raw per-order facts, not a CASE
ladder over overlapping predicates.

### Raw combination cross-tab — only three combinations exist

| order_id rows | any voided | any non-voided | any return | any replacement | any orphan | orders |
|---|---|---|---|---|---|---:|
| false | false | false | false | false | false | 18,229 |
| true | true | false | false | false | false | 105 |
| false | false | false | false | false | **true** | **1** |

### Derived attribute

| attribute | orders |
|---|---:|
| a. no shipment history (neither linkage) | **18,229** |
| b. ordinary voided-only (excludes return and replacement) | 105 |
| c. return-only | 0 (observed) |
| d. replacement-only | 0 (observed) |
| e. mixed inactive history | 0 (observed) |
| f. **orphan `order_number` history only** | **1** |
| **total** | **18,335** |

The 105 **are** genuinely ordinary voided-only — no return, no replacement, no non-voided row —
now proven from raw facts rather than produced by branch precedence. The `no shipment history`
bucket is **18,229, not 18,230**: one order has orphan-number history and was previously
misfiled, exactly the linkage inconsistency this dimension was rebuilt to expose.

## §5 — orphan identity qualification

| | |
|---|---:|
| excluded orders | 20 |
| **distinct `order_number` values among them** | **10** |
| **excluded orders per ambiguous number** | **2 (max and uniform)** |
| **orphan shipment rows per ambiguous number** | **1 (max)** |
| numbers carrying more than one excluded order | 10 |
| **excluded orders whose sharer disagrees on client** | **20** |
| …disagrees on store | 20 |
| …disagrees on source account | 20 |
| `order_number` with whitespace / lowercase variance | 0 / 0 |
| shipped orders with NULL `order_number` | 0 |
| orphan shipment rows in table | 4,004 |

**20 excluded orders are not 20 independent identity decisions. They are 10.**

Each of the 10 ambiguous `order_number` values carries **exactly one** orphan shipment row and is
shared by **exactly two** literal-shipped orders — and in all 20 cases the two orders belong to
**different clients, different stores, and different source accounts.**

So a single orphan shipment row is currently excluding two orders from two different clients.
**At most one of each pair can be correct; at least one of each pair is wrong.** The watchdog's
orphan arm matches across client boundaries, which no correct linkage rule would do.

Consequences:

- At most **10** of the 20 exclusions can be legitimate; at least **10** are not.
- The population interval is therefore **18,335 – 18,355**, with **18,345** the value if exactly
  one exclusion per pair is correct. None of the three is currently provable.
- `orders.order_number` carries indexes but **no global unique constraint**, so the arm cannot
  attribute an orphan shipment to a specific order by number alone.

Resolving it needs account/client/store-qualified linkage, which belongs to the classification
successor's identity partitioning. This finding is a concrete input to that work.

Not established: no normalisation variants (whitespace, case) were found, but punctuation,
leading-zero and marketplace-prefix collision classes were **not** tested and are owed.

## §6 — full ordered lifecycle history

Ordered `effective_at`, `created_at`, `id`. Latest-event-only conceals the establishing event.

| flagged | events | first transition | first source | last transition | orders |
|---|---:|---|---|---|---:|
| true | 2 | `shipped` | **`order_sync_status`** | `external_shipped` | **857** |
| true | 2 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| true | 3 | `shipped` | `shipment_sync` | `external_shipped` | 1 |
| false | 1 | `shipped` | `order_sync_status` | `shipped` | 6 |
| false | 1 | `void` | `label_void:shipstation` | `void` | 2 |
| false | 2 | `shipped` | `prepship_v2` | `void` | 1 |

**857 of the 859 first became `shipped` through `order_sync_status`** — the order-level catch-up
whose own comments call it review-only, not shipment-line proof (`order-sync.ts:699-750`) — and
were classified external afterwards. Only 2 originate from `shipment_sync`.

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

**Governing limit:** an external lifecycle event proves a local workflow/classification action. It
does **not** prove physical fulfilment, cost authority, or customer chargeability. Append-only
immutability does not imply historical completeness.

## §7 — lifecycle-SOT coverage partition (proxy only)

`drizzle/0070_order_lifecycle_commands.sql` (PS-424, `f568bc5f`, **committed** 2026-07-16),
additive, history not backfilled.

| flagged | cohort | orders | earliest | latest |
|---|---|---:|---|---|
| false | `updated_at` before proposed boundary | 14,577 | 2026-04-24 | 2026-07-15 |
| true | `updated_at` before proposed boundary | 2,890 | 2026-05-29 | 2026-07-15 |
| — | `updated_at` on or after proposed boundary | 0 | — | — |

> No no-receipt order has `orders.updated_at` on or after the proposed boundary; the latest is
> 2026-07-15. **Consistent with** legacy provenance debt. But `updated_at` is mutable row
> metadata, not terminal-transition provenance, and the boundary is a **commit** date, not a
> proven production migration or deployment timestamp. **Zero post-cutover bypasses are not
> proven.**

**"No fourth ticket required" remains provisional, not closed.**

## Integrity assertions

These say the measurement machinery is sound. They must all pass, and they alone control the exit
code. Every count is recomputed from the source CTE; no observed production constant is
hard-coded, so ordinary data drift cannot be mistaken for broken evidence logic.

| integrity assertion | result |
|---|---|
| population rows are distinct orders | PASS |
| transition matrix sums to literal shipped denominator | PASS |
| corrected population derived from matrix equals measured population | PASS |
| **matrix naive total equals independent direct naive count** | PASS |
| flagged + unflagged = corrected population | PASS |
| provenance partition sums to population | PASS |
| classifier-declared class is source-qualified, not transition-only | PASS |
| shipment-history attribute sums to population | PASS |
| raw combination cross-tab sums to population | PASS |
| event-bearing + no-receipt = population | PASS |
| §6 grouped output sums to event-bearing count | PASS |

The previous *"naive total is derived from the matrix"* check was **tautological** — it compared a
variable against the expression that had just assigned it, so it could never fail. Replaced with a
comparison against an independently computed direct naive-predicate count.

Open boundaries are listed at the top of this document. They do **not** appear here and do **not**
fail the run: an appendix that discovers an unresolved boundary is doing its job, and a runner
that declares itself unacceptable over an honest finding would discourage recording them.

### Explicit zeros

The zero rows in §3 and §4b are emitted by the queries themselves, via a fixed class domain
(`VALUES` left-joined to measured counts). They are **query output, not hand-inserted rows**. A
plain `GROUP BY` cannot emit an absent category, and presenting a manually added zero as verbatim
output would be a false claim.

## Evidence confidence and observation time

Evidence kind, source, observed-at, source event timestamp, account/store identity, completeness
status, confidence, and affirmative/negative/operator-declared/inferred labelling are **not yet
captured, and are required in the next evidence artifact.**

Upstream negative results carry the classifier's **original** observation window, not this one.
Provider absence is time-sensitive; a historical "no shipment found" is not re-verified here and
cannot prove what occurred historically. A provider `not found` never moves an order into an
external-occurrence class.

## What this does not license

- No representation recommendation, for any cohort.
- The 2,890 must be classified before entering any historical impact population, revenue exposure
  figure, remediation, or backfill.
- The 17,467 are set aside from PS-489's current impact and recommendation — **not permanently.**
- The billing generator cannot preview anything: `billing.ts:886` declares regeneration a money
  mutation; `billing.ts:1712-1793` deletes and inserts. No `dryRun`. Rollback is insufficient —
  multiple transactions on the shared pool.
- `shipmentCost` remains candidate evidence pending provider-semantics proof.
- No claim that the red contract term is satisfied.

## What was not done

No writes of any kind. No billing regeneration. No reclassification. No provider lookups. No
postage, labels, or purchases. No locked surface modified.
