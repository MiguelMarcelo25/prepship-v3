# PS-497 — no-write recovery manifest

Produced 2026-08-21 by read-only production analysis, at Hermes's direction
("partition all stuck claims by claim source and refusal reason; produce a
no-write recovery manifest; calculate inventory deltas before any replay").

**Nothing in this document has been executed.** No claim was unlocked, replayed,
closed or modified. No inventory row moved. `fulfillment-deductions.ts` was not
touched. This is the input DJ needs to rule, not the ruling.

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

Every `review` claim falls in exactly one cohort. Totals reconcile to 3,800.

| Cohort | Claims | Orders | Units if applied | Externally shipped | PrepShip-fulfilled |
|---|---:|---:|---:|---:|---:|
| **A — clean, replayable** | 1,664 | 967 | 1,664 | 890 | 774 |
| **B — quantity conflict** | 1,003 | 553 | 1,903 | 755 | 248 |
| **C — already deducted** | 939 | 790 | 2,365 | **0** | 939 |
| **D — no line data** | 194 | 117 | n/a | 74 | 120 |

**A — clean, replayable.** Line data present, claim quantity equals the order's
current unit total, and the order has **no existing negative ledger row**.
Touches **262 inventory rows**, moves **1,664 units**.

**B — quantity conflict.** The claim's stored quantity disagrees with the order's
current `order_items` total. Two sources describe the same fulfillment and do not
agree. Must not be auto-resolved: picking either number silently is how a wrong
deduction becomes permanent.

**C — already deducted — DO NOT REPLAY.** These orders already carry a negative
`inventory_ledger` row. Replaying would **double-deduct 2,365 units**. Note the
shape: **100% are PrepShip-fulfilled and 0% externally shipped** — consistent
with another path having correctly deducted them already. The likely correct
disposition is to **close them as superseded**, recording why, not to apply them.
That alone retires 939 of the 3,800 with no stock movement.

**D — no line data.** Order still has no `order_items`. Not recoverable from
current evidence; needs provider re-fetch or explicit write-off.

## 5. The 2026-07-22 manual adjustment — and why it is ambiguous

The card warns that replay would collide with a manual `+1000` reconciliation
applied on 2026-07-22. Measured:

- **49 positive ledger rows on 2026-07-22, totalling exactly +1,000 units.**
- **37 of those rows (841 units) touch cohort A's inventory rows.**
- Their note reads: **`PS-462 reviewed legacy opening-balance correction`**.

So the adjustment was **not** a reconciliation for these missed deductions — it
was PS-462's opening-balance correction packet. `docs/ps-tickets/ps-462-inventory-quantity-rollout.md`
describes that packet's purpose as to *"prove the legacy cache equals the ledger"*.

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

The card poses one question. The data shows **three**, and they are separable —
which means DJ can authorize part of the recovery without answering all of it.

1. **Supersede cohort C?** (939 claims, no stock movement, no policy content.)
   Lowest risk in the manifest and independent of everything else.
2. **The PS-462 provenance question** above — gates cohort A's 841 overlapping
   units, not the whole cohort.
3. **The original policy question** — should stock deduct when an order ships
   outside PrepShip? This governs the externally-shipped share only: **890 of
   cohort A**, 755 of cohort B, 74 of cohort D. It does **not** govern cohort A's
   774 PrepShip-fulfilled claims, where PrepShip shipped the goods itself.

## 7. Engineering work this manifest authorizes (still no writes)

- Fixtures per evidence class (`fulfillment_lines_unavailable` with items now
  present; quantity conflict; already-deducted; no line data).
- A re-resolution routine that reads canonical `order_items` rather than
  replaying a stored quantity — the only mechanism that can act on this backlog.
- A dry-run reporter emitting the per-inventory-row delta for any authorized
  cohort before a single row moves.

Applying anything still requires DJ's ruling **and** the `unlock shipped data`
override, because `src/services/fulfillment-deductions.ts` is a locked surface.

## 8. Queries

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
