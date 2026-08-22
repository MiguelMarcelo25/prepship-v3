# PS-497 — no-write recovery manifest

Produced 2026-08-21 by read-only production analysis, at Hermes's direction
("partition all stuck claims by claim source and refusal reason; produce a
no-write recovery manifest; calculate inventory deltas before any replay").

**Nothing in this document has been executed.** No claim was unlocked, replayed,
closed or modified. No inventory row moved. `fulfillment-deductions.ts` was not
touched. This is the input DJ needs to rule, not the ruling.

> **Revision 2026-08-22 — corrective, per Hermes audit.** Four corrections were
> applied to this document's *claims and language*. The measurements were left
> untouched and are being re-derived separately (§7). In summary:
> (1) cohort A is renamed **clean re-resolution candidate** — the earlier
> "replayable" contradicted §2, which established these claims contain nothing to
> replay; (2) **cohort C is not proven safe and is NOT YET AUTHORIZED** — the
> already-deducted test is not identity evidence; (3) the §5 sentence about the
> +1,000 adjustment overclaimed and is rewritten to leave the economic overlap
> explicitly unresolved; (4) a new §7 records that every figure here is
> prose-only and **asserted, not independently confirmed**. Per Hermes, the first
> decision DJ faces is **not** cohort C but the canonical external-fulfilment
> representation question (§6.1).

---

## 1. The backlog is larger than the card states, and still growing

| Measure | Card (2026-08-10) | Measured 2026-08-21 | Δ |
|---|---:|---:|---|
| claims in `review` | 2,731 | **3,800** | +1,069 |
| `order_sync_status` | 1,153 | **1,850** | +697 |
| `external_shipped_classifier` | 511 | **859** | +348 |
| `shipment_sync` (card: "FIXED, holding") | 1,004 | **1,028** | +24 |
| `prepship_v2` (card: "FIXED, holding") | 61 | 61 | 0 |

Last 7 days alone: `order_sync_status` +346, `external_shipped_classifier` +174,
`shipment_sync` **+8**.

> **Correction to the card.** `shipment_sync` is recorded as FIXED and holding. It
> is still producing review claims — 8 in the last 7 days. The rate is two orders
> of magnitude below the open sources, so the fix clearly worked, but "holding"
> overstates it. `prepship_v2` is genuinely static (0 new since 2026-07-21).

## 2. The refusal reason is not a policy refusal

99.3% of the backlog carries ONE reason, and it is not "external fulfillment":

| Refusal reason | Claims | SKU present? |
|---|---:|---|
| `fulfillment_lines_unavailable` | **3,774** | **none — `sku` is NULL on every one** |
| `fulfillment_line_missing_sku` | 13 | no |
| `missing_sku` | 9 | no |
| `zero_quantity` | 3 | yes |
| `invalid_quantity` | 1 | yes |

Every claim in the dominant class was written with **no SKU, no inventory link,
and no resolvable line**. The card frames PS-497 as awaiting a policy answer —
"when an order ships OUTSIDE PrepShip, should PrepShip deduct its own stock?" —
and that question is still real for part of the population. But it is **not why
these 3,774 claims are parked**. They are parked because the writer could not
read the order's fulfillment lines at claim time.

**Consequence that changes the recovery design:** these claims **cannot be
"replayed"**. There is nothing in them to apply. Any recovery must **re-resolve
lines from canonical `order_items`**, which is a different operation with a
different risk profile than replaying a stored deduction.

**This binds every cohort below, including cohort A.** Any future operation on
this backlog must **create a NEW identity-bound recovery movement** — a movement
constructed from canonical data and bound to the lifecycle event, shipment, line
key, SKU and inventory row it was derived from — and must **not** be modelled,
described or implemented as replaying work held inside the claim. The SKU-less
claim contains no such work. A claim that has been re-resolved is a record that a
recovery was *constructed for* it, never a record that was *executed from* it.

## 3. The line data exists now

| Source | Review claims | Order has items now | Every SKU matches inventory | Still no items |
|---|---:|---:|---:|---:|
| `order_sync_status` | 1,850 | 1,770 | **1,770 (100%)** | 80 |
| `shipment_sync` | 1,002 | 946 | **946 (100%)** | 56 |
| `external_shipped_classifier` | 859 | 822 | **822 (100%)** | 37 |
| `prepship_v2` | 61 | 61 | **61 (100%)** | 0 |

3,601 of 3,774 (95.4%) are resolvable today, and **zero** carry a SKU that is
absent from `inventory`. The data arrived after the claim was written.

## 4. Recovery cohorts — the actual decision surface

Every `review` claim carries exactly one cohort label, and the labels reconcile to
3,800. That is a **syntactic** property of the `case` expression in §9, not
evidence that a claim's label describes its real inventory state — see the
partition-status note under cohort C.

| Cohort | Claims | Orders | Units if applied | Externally shipped | PrepShip-fulfilled |
|---|---:|---:|---:|---:|---:|
| **A — clean re-resolution candidate** | 1,664 | 967 | 1,664 | 890 | 774 |
| **B — quantity conflict** | 1,003 | 553 | 1,903 | 755 | 248 |
| **C — some negative ledger row on the order** | 939 | 790 | 2,365 | **0** | 939 |
| **D — no line data** | 194 | 117 | n/a | 74 | 120 |

"Units if applied" is a **hypothetical** column throughout: it is what a
constructed recovery movement would move, not work that exists anywhere today.

**A — clean re-resolution candidate.** Line data present, claim quantity equals
the order's current unit total, and the order has **no existing negative ledger
row**. A re-resolution, if ever authorized, would touch **262 inventory rows** and
move **1,664 units**.

*Candidate* is the operative word, and the reason for the rename. Per §2 these
claims carry no SKU, no inventory link and no resolvable line, so there is
nothing stored in them to replay — calling the cohort "replayable" contradicted
the finding this manifest is built on. Cohort A means only that **canonical
`order_items` can today support constructing a recovery movement, and no
order-level negative ledger row is in the way**. Any authorized operation must
mint a **NEW identity-bound recovery movement** per §2 rather than present itself
as replaying the claim's contents.

The cohort's negative-ledger test inherits the same order-scoped weakness as
cohort C's, in the opposite direction: `inventory_ledger.orderId` is **nullable**,
and legacy movements may predate the PS-439 identity fields
(`src/db/schema/inventory.ts:53-85`). A deduction recorded without an `order_id`
would not appear to the test, so "no existing negative ledger row" is a weaker
statement than "this line was never deducted". The same per-claim / per-line
reconciliation that gates cohort C should therefore be run across cohort A before
any movement is constructed.

**B — quantity conflict.** The claim's stored quantity disagrees with the order's
current `order_items` total. Two sources describe the same fulfillment and do not
agree. Must not be auto-resolved: picking either number silently is how a wrong
deduction becomes permanent.

**C — some negative ledger row exists on the order — NOT PROVEN SAFE, NOT YET
AUTHORIZED.** The cohort test is order-scoped and nothing more:
`exists (select 1 from inventory_ledger l where l.order_id = claim.order_id and
l.qty < 0)` (§9). That predicate proves exactly one thing — **some** negative
movement exists **somewhere on the order**. It does **not** prove that the
movement corresponds to:

- this **lifecycle event**,
- this **shipment**,
- the **line / SKU** a recovery would reconstruct,
- the same **quantity**, or
- the same **fulfillment occurrence**.

**MEASURED 2026-08-22 — the cohort was 100% false positives.** The reconciliation
Hermes required has now been run read-only against production, joining on the
identity the ledger actually carries (`source_entity` / `source_id`):

| Test | Claims |
|---|---:|
| old order-scoped predicate (what this manifest used) | **939** |
| ledger movement bound to **this claim** (`source_entity='fulfillment_line_claim' AND source_id = claim.id`) | **0** |
| explained by a **sibling claim** on the same order being applied | 326 |
| explained by `historical_fulfillment_backfill` (a different mechanism) | 613 |

326 + 613 = 939, and **not one** of them is this claim's own work. The ledger
records 994 `fulfillment_line_claim` movements and every one belongs to an
`applied` claim, never to a row still in `review`. So the disposition this
manifest originally proposed — supersede 939 claims as already-done — would have
closed 939 units of genuinely outstanding work on the strength of movements made
by something else. **Withdrawn in full.**

An order with two shipments, a partial, a relabel, a re-ship or a split line
satisfies the predicate on the strength of one unrelated movement. The identity
columns required to do that reconciliation properly **already exist on both
sides**, and the cohort query simply did not join on them:
`fulfillment_line_claims` carries `lifecycleEventId`, `orderId`, `shipmentId`,
`lineKey`, `sku` and `quantity`
(`src/db/schema/order-lifecycle.ts:131-168` — whose own comment states a claim
"is never keyed only by order"), and `inventory_ledger` carries `orderId`, `sku`,
`sourceEntity`, `sourceId`, `effectiveAt` and a
`(source_entity, source_id, inventory_id, type)` identity index
(`src/db/schema/inventory.ts:53-85`).

**Both directions are therefore unproven.** Constructing recovery movements could
double-deduct up to **2,365 units**; superseding could **discard a genuinely owed
deduction** whose apparent counterpart belongs to a different shipment, line or
occurrence. "Close 939 as superseded with zero stock movement" is a
**hypothesis, not a disposition, and it is NOT YET AUTHORIZED.** It requires
**per-claim / per-line movement reconciliation first** — every claim matched to a
specific ledger movement on event / shipment / line / SKU / quantity identity,
with unmatched and ambiguously-matched claims reported separately — before any
closure is proposed for authorization.

The shape of the cohort (**100% PrepShip-fulfilled, 0% externally shipped**)
remains consistent with another path having deducted these orders. Consistency is
not identity evidence, and this manifest previously treated it as though it were.

> **Hermes:** "Do not authorize the 939 cohort-C closures yet."

**Partition status.** The four cohorts are **syntactically exclusive** — the
`case` expression in §9 assigns each claim exactly one label, and the totals
reconcile to 3,800. They are **not semantically validated**. Syntactic
exclusivity guarantees only that no claim was counted twice; it says nothing
about whether a claim's assigned cohort describes its actual inventory state.

**D — no line data.** Order still has no `order_items`. Not recoverable from
current evidence; needs provider re-fetch or explicit write-off.

## 5. The 2026-07-22 manual adjustment — and why it is ambiguous

The card warns that replay would collide with a manual `+1000` reconciliation
applied on 2026-07-22. Measured:

- **49 positive ledger rows on 2026-07-22, totalling exactly +1,000 units.**
- **37 of those rows (841 units) touch cohort A's inventory rows.**
- Their note reads: **`PS-462 reviewed legacy opening-balance correction`**.

The adjustment was **not explicitly constructed or labeled as PS-497
missed-deduction recovery** — it was PS-462's opening-balance correction packet.
**Its economic overlap with these missed deductions remains unresolved, because
the provenance of the legacy cache is unknown.** Abstaining from that overlap is
the right call; the earlier flat assertion that the adjustment "was not a
reconciliation for these missed deductions" went further than the evidence
supports, since a correction can offset a deduction it was never labelled for.

What PS-462's packet demonstrably did was reconcile the immutable ledger against
the legacy `inventory.stock_qty` cache. Its rollout gate reads "Append
corrections; prove the legacy cache equals the ledger"
(`docs/ps-tickets/ps-462-inventory-quantity-rollout.md:22-26`); the reconciliation
owner reads `stock_qty` as `legacy_quantity`
(`src/services/inventory-reconciliation.ts:99-105`) and diffs it against the
ledger-derived quantity (`src/services/inventory-reconciliation.ts:128-143`); and
the packet generator emits corrections from exactly those mismatches
(`scripts/ps-462-inventory-correction-packet.ts:103-117`). What none of that can
tell us is **where the legacy cache's own numbers came from** — and that is
precisely the unknown that leaves the overlap open.

That leaves two readings, and **this manifest does not choose between them**:

1. **The correction aligned the ledger to a cached on-hand figure that was itself
   computed without the missing deductions.** Then the missing deductions are
   still owed, and applying cohort A moves stock toward truth.
2. **The cached figure reflected a physical count.** Then the correction already
   set truth, and applying cohort A would drive stock *below* reality by up to
   841 units on the overlapping rows.

**Evidence that would settle it:** whether the PS-462 correction packet was
derived from a physical count or from the pre-existing application cache. That
provenance lives with whoever approved the packet on 2026-07-22.

## 6. What DJ actually has to decide

The card poses one question. The data shows more than one — but they are **not**
equally ready to be ruled on, and they are **not** independent in the order this
manifest previously claimed. Two are gated on reconciliation work that has not
been done.

1. **FIRST — the canonical external-fulfilment representation question.** Per
   Hermes, this decision precedes all the others. What is the canonical
   representation of a fulfilment that happens outside PrepShip: a
   **shipment / lifecycle-row model** (the fulfilment is represented as a
   shipment row plus its lifecycle event — what the current claim writer
   assumes), or a **fulfilment-occurrence model** (the occurrence is the
   first-class record, and shipment/lifecycle rows are projections of it)?
   Everything downstream inherits the answer: what identity a recovery movement
   must be bound to, what "already deducted" is even permitted to mean, and
   whether a claim and a ledger row can be matched at all. Ruling on cohorts
   before this is settled bakes today's ambiguity into permanent stock movements.
2. **Cohort C — NOT ready for authorization.** This manifest previously presented
   it as the low-risk, independent first authorization. It is neither. The
   already-deducted test is order-scoped and carries no identity evidence (§4),
   so **neither** superseding **nor** applying is proven safe. It requires
   per-claim / per-line movement reconciliation first, and it must not be signed
   off in this manifest's current state.
3. **The PS-462 provenance question** (§5) — gates cohort A's 841 overlapping
   units, not the whole cohort.
4. **The original policy question** — should stock deduct when an order ships
   outside PrepShip? This governs the externally-shipped share only: **890 of
   cohort A**, 755 of cohort B, 74 of cohort D. It does **not** govern cohort A's
   774 PrepShip-fulfilled claims, where PrepShip shipped the goods itself. Its
   scope is itself partly a function of question 1.

**Withdrawn from this manifest.** The earlier claims that cohort C was "lowest
risk in the manifest and independent of everything else", that its "likely
correct disposition" was closure as superseded, and that doing so "retires 939 of
the 3,800 with no stock movement" are all withdrawn. None is supported by the
evidence gathered, and the first of them inverted the actual decision order.

## 7. Measurement status — asserted, not independently confirmed

Every number in this manifest was produced by ad-hoc read-only SQL run
interactively on 2026-08-21 and then **transcribed into prose**. No query packet,
no committed query file and no output artifact was retained. **Nothing in this
repository lets a reader reproduce these figures**, and no reviewer can re-run
them to check.

They are **pending re-derivation** by the identity-bound generator
`scripts/ps-497-recovery-manifest-generator.ts`, added in this same corrective PR.
Until that generator has run and its packet is attached, every figure listed
below is **asserted, not independently confirmed**:

| § | Figure | Status |
|---|---|---|
| §1 | **3,800** claims in `review` — with the +1,069 / +697 / +348 / +24 deltas and the 7-day rates | pending re-derivation |
| §2 | **3,774** `fulfillment_lines_unavailable` — and the 13 / 9 / 3 / 1 minor reasons | pending re-derivation |
| §3 | **3,601** resolvable today — with the 1,850 / 1,002 / 859 / 61 per-source split, the 1,770 / 946 / 822 / 61 match counts and the 80 / 56 / 37 / 0 remainder | pending re-derivation |
| §4 | cohort sizes **1,664 / 1,003 / 939 / 194** — with their order counts and the **262** touched inventory rows | pending re-derivation |
| §4 | **2,365** cohort-C units | pending re-derivation |
| §4, §6 | cohort A's **890 / 774** externally-shipped vs PrepShip-fulfilled split (and 755 / 248, 74 / 120) | pending re-derivation |
| §5 | **49** positive ledger rows totalling **+1,000** on 2026-07-22 | pending re-derivation |
| §5 | **37** of those rows / **841** units overlapping cohort A | pending re-derivation |

Three internal non-reconciliations are visible without re-running anything. They
are recorded here rather than silently corrected, because correcting a
prose-transcribed number by arithmetic would manufacture a measurement nobody
took:

- §3's per-source claim counts sum to **3,772**, not the **3,774** of §2.
- §3's "order has items now" column sums to **3,599**, not the **3,601** its own
  surrounding text states.
- §1 reports `shipment_sync` at **1,028** review claims; §3 uses **1,002** for the
  same source.

Small, but exactly the drift that prose-only measurement conceals. The
generator's packet supersedes every figure above on arrival, including these.

## 8. Engineering work this manifest authorizes (still no writes)

- Fixtures per evidence class (`fulfillment_lines_unavailable` with items now
  present; quantity conflict; already-deducted; no line data).
- A re-resolution routine that reads canonical `order_items` rather than
  replaying a stored quantity — the only mechanism that can act on this backlog —
  emitting NEW identity-bound recovery movements per §2, never a replay.
- A dry-run reporter emitting the per-inventory-row delta for any authorized
  cohort before a single row moves.
- **Per-claim / per-line movement reconciliation** joining
  `fulfillment_line_claims` to `inventory_ledger` on event / shipment / line /
  SKU / quantity identity — the missing evidence that gates cohort C (§4), with
  unmatched and ambiguously-matched claims reported as their own classes.
- The identity-bound manifest generator of §7, so these figures stop being prose.

Applying anything still requires DJ's ruling **and** the `unlock shipped data`
override, because `src/services/fulfillment-deductions.ts` is a locked surface.

## 9. Queries

Every figure above came from read-only SQL against production
(`information_schema`, `fulfillment_line_claims`, `order_lifecycle_events`,
`orders`, `order_items`, `inventory`, `inventory_ledger`). Cohort assignment:

```sql
case
  when line_count is null or line_count = 0   then 'D_no_line_data'
  when already_deducted                       then 'C_already_deducted'
  when claim_qty is distinct from order_units then 'B_qty_conflict'
  else 'A_clean_replayable'
end
```
where `already_deducted` = `exists (select 1 from inventory_ledger l where
l.order_id = claim.order_id and l.qty < 0)`.

Two notes on this block, both load-bearing:

- **`A_clean_replayable` is left verbatim.** It is the label the query emitted
  **as it was actually run**, and this block is a record of executed SQL, not a
  description of the cohort. The cohort is named **"clean re-resolution
  candidate"** everywhere else in this document, and the §7 generator will emit
  the corrected name.
- **`already_deducted` is order-scoped only.** It joins on `order_id` alone and
  on none of the identity columns that exist for this purpose in
  `fulfillment_line_claims` and `inventory_ledger`. That limitation is why
  cohort C is not proven safe — see §4.
