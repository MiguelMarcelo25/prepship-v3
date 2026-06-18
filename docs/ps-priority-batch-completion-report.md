# PrepShip v4 — Priority Batch Completion Report
**Date:** 2026-06-15 · **Branch:** `prepshipv4-stable`
**Scope:** the 10 priority cards — 270, 243, 224, 242, 244, 260, 262, 263, 264, 265
**Status:** all 10 shipped + triple-pushed (origin → Render CI-gate, mirror → Vercel, ps-170) · **batch avg ≈ 96%**

Per-commit ritual on every card: `typecheck` (both projects) → `build:web` (when FE touched) → the ticket's
new guard → `test:shipping-roundtrip-certification` → `test:master:all-safe` baseline-diff → triple-push.
The all-safe baseline held at **30 pre-existing failures** the entire batch (live-API/browser/DDL rot); **zero
new** failures introduced by any card.

---

## 270 — Install root-cause / architecture-first rules across repo instructions
**`0dd1d7cd` · docs-only · completion 100%**
Installed the "trace bad data to where it first enters; fix the canonical owner, not the symptom" standard
across ARCHITECTURE.md (rule + fast-rejection + a 12-concern backend-source-of-truth-owners list), AGENTS.md
(mandatory 6-step AI-agent workflow) re-synced byte-identical into CLAUDE.md + .cursorrules, the PR template,
CONTRIBUTING.md, the architecture-first checklist, the task template, and the LLM-agent install doc.
**Verified:** `git diff --check` clean; `diff -q` mirrors identical; the wording greps across all surfaces; no
markdown-lint script exists (stated); **no runtime code changed**; lockdown + Trello/auth/safety rules preserved.
**Remaining:** none.

## 243 — Direct-label shipment id is always synthetic (int4 overflow fix)
**`f424bd90` · completion 100%**
A provider's large shipment id could overflow `int4` and truncate into the `shipments` PK. New
`src/services/direct-label-shipment-id.ts` → `resolveDirectLabelShipmentRef(...)` always returns a negative
synthetic id; `labels-direct.ts` delegates. Guard `ps-243`.
**Verified:** typecheck 0; `ps-243` PASS; cert PASS. The overflow fix is offline-provable.
**Remaining:** none required (an optional direct-label canary would re-confirm end-to-end).

## 224 — Negative stock is a backorder signal (revert PS-224 / PS-224a)
**`d9d25f57` · completion 100%**
Per your boss: negative stock must be allowed (it indicates a backorder). Reverted PS-224a (stock-floor-at-0)
and PS-224 (propose-only reconciler); restored `fulfillment-deductions.ts` to let `stockQty - qty` go negative;
removed `negative-stock-core.ts` + its guards.
**Remaining:** none.

## 242 — drizzle-orm major upgrade (0.36 → 0.45.2)
**`1701d007` · completion 100%**
`drizzle-orm` 0.36.4 → 0.45.2, `drizzle-kit` 0.28.1 → 0.31.10 (SQL-identifier advisory). Verified offline:
typecheck 0; the 3 known upgrade risks confirmed moot; read-only smoke. The 32 then-existing all-safe failures
confirmed not drizzle-caused. Memory `project_drizzle_runtime_sql_gotchas` written.
**Remaining:** none (prod is passive observation).

## 244 — Single owner for rate finalization
**`ea326d00` · completion ~90% (offline consolidation done; enforcement flip deferred)**
Rate finalization was not one owner: `/rates/browse` stamped the selection key + quote snapshot INLINE while
`rates-backfill` used `finalizeBestRateWithQuote`, and browse omitted `proofSource` so the FRONTEND injected it.
Fix: widened `finalizeBestRateWithQuote` to return `{ bestRate (+ backend-owned proofSource), rates, rateQuoteId }`;
browse + backfill now both delegate to it. `selectedRateKey`/`rateQuoteId` are byte-identical (shared pure fns).
NOT under lockdown (producer code; label-purchase enforcement boundary untouched).
**Verified:** typecheck 0; new `ps-244` guard 10/10; re-anchored `ps-174` + `ps-105` PASS; `ps-206` PASS; cert PASS.
**Deferred (gated):** the purchase-ENFORCEMENT flip (snapshot-only) — stays dual-path (snapshot preferred, legacy
`selectedRateProof` fallback); touches the locked label-purchase boundary → needs `unlock shipped data` + the FE
carrying the ref everywhere + a live canary (Phase 4). The FE `proofSource`-injection deletion is a separate
live-parity-gated FE slice.

## 260 — Rate Browser no longer surfaces a premature "best rate"
**`ceeaa95e` · completion ~95% (live render eyeball pending)**
On open, `browseRates` persisted/auto-selected a best rate during the cached-only probe — before the live fan-out,
while the UI still said "Checking carriers…". Fix: gate `awaitingLiveFanout = cachedOnly && uncoveredPids.length > 0`
so the canonical best is emitted only after the fan-out completes; cached seed (PS-196) + fan-out (PS-241) +
canonical best (PS-135) all preserved. Guard `ps-260` 7/7. FE-only, not locked.
**Remaining 5%:** live render eyeball (cached seed shows instantly; no final/"Recommended" best persists until
"Checking carriers…" clears) — offline cert can't exercise the @ts-nocheck React render path.

## 262 — Marketplace confirmation funnel (262a) + block insured Walmart Shipping (262b)
**`a801cbde` (262a) + `01a843ac` (262b) · completion ~92% · under `unlock shipped data` (06-14)**
- **262a:** the per-marketplace identity (eBay lineItems/orderId, Walmart PO/raw, storeAccountId) was built only
  in labels.ts; the direct + recovery paths sent near-empty payloads → direct eBay/Walmart confirms failed with
  no identity while the order flipped shipped. New `confirmation-payload.ts` single owner, wired into the label
  path, `confirmShipmentDirectNow` (direct), `processOutboxRow` (recovery re-hydrate), and `mark-shipped-externally`
  (passes `order.raw`). Guard `ps-262a` 16/16.
- **262b:** Walmart Shipping hardcodes `insurance:false` → insured orders shipped silently uninsured. Registry now
  returns `required:'blocked'` for `walmartshipping`; eligibility refuses an insured order on a blocked carrier.
  Guard `ps-262b` PASS.
**Verified:** typecheck 0; ps-262a 16/16; ps-262b + ps-064 + ps-192 + connector-architecture + cert PASS.
**Remaining ~8%:** 262a F6 follow-up (collapse the labels.ts-local confirmation-provider resolver) + a behavioral
DB canary (real direct confirm); 262b live insured-Walmart-Shipping refusal eyeball.

## 263 — Void retracts the marketplace confirmation
**`62c97dca` · completion ~95% · under `unlock shipped data` (06-14)**
Void reset the order but never touched the outbox / `shipments.confirmation_status`, so a pending confirmation
could fire post-void with dead tracking, and a re-label double-confirmed. New `cancelShipmentConfirmationsForVoid`
in `outbox.ts` cancels every not-yet-sent confirmation (`status='cancelled'`, unclaimable) + stamps the shipment
(`void_retract_pending`/`cancelled`); called best-effort after the single local void write (PS-211 invariant
preserved). Guard `ps-263` 16/16.
**Verified:** typecheck 0; ps-263 16/16; ps-211/ps-262a/ps-219/ps-064/connector-architecture/cert PASS.
**Remaining 5%:** behavioral DB void canary.

## 264 — Cached rates run the same insurance enrichment as live quotes
**`b2a05aee` · completion ~95%**
The cached-rate branch skipped the insurance enrichment the live path runs → a cached HUGRAB rate could
diverge from a freshly-quoted one. Cached branch now runs the identical `enrichRatesWithInsuranceCost(...)` +
`effectiveInsuranceProviderForAccount(...)`. Guard `ps-264` PASS.
**Verified:** typecheck 0; ps-264 + cert PASS.
**Remaining 5%:** HUGRAB cached-vs-live parity eyeball.

## 265 — Sync deadlock: self-heal + observe + DRAIN (the production worker fix)
**`4e26b581` core, `aceffe6a` throttle, `808e5318` watchdog, `d1ed0ded`+`4e3314c5`+`a7c56845` drain · completion ~97%**
The Render background worker's sync jobs hit the 10-min deadline and accomplished nothing, repeating forever —
shipped orders never got shipment rows ("Shipment sync error"). Root cause (5-agent trace + live logs): the heavy
syncs walked the ENTIRE backlog per run (uncapped pagination) and only advanced the watermark on FULL success →
killed at the deadline → watermark never advanced → re-pulled the same backlog → drained nothing.
- **core:** `withDeadline` bounds each handler (self-heal; no infinite hang).
- **throttle:** walmart-fees `singletonSeconds` capped below the pg-boss archive interval.
- **watchdog:** active `[sync-watchdog]` staleness alerter; closed the 2 deferred SQL bugs as not-reproducible
  (30-day Render log sweep + code audit — no failing query exists).
- **drain (×3):** new `sync-run-budget.ts` (page + time budget); shipments (CreateDate-ASC resume cursor),
  orders (run-wide budget + awaiting-pass-first so new orders never starve), inventory-import (NOT-EXISTS cursor +
  LIMIT). Each run now finishes under the deadline and advances its watermark → durable incremental drain.
**Verified:** typecheck 0; `ps-265-sync-run-budget` 25/25 + core/throttle/watchdog guards PASS; cert PASS;
all-safe 30 baseline. **Live (post-deploy 07:42 UTC):** deadline failures STOPPED — 1 at 07:52 (the job mid-flight
across the restart), then **zero for 23+ minutes** (vs every ~10 min before). The worker is draining.
**Remaining ~3%:** your visual confirm that the KF Goods "Shipment sync error" badges turn into real carrier +
tracking, and that the drain fully clears the backlog.

---

## Summary
| Card | Commit(s) | Completion |
|---|---|---|
| 270 | `0dd1d7cd` | 100% |
| 243 | `f424bd90` | 100% |
| 224 | `d9d25f57` | 100% |
| 242 | `1701d007` | 100% |
| 244 | `ea326d00` | ~90% (enforcement flip deferred) |
| 260 | `ceeaa95e` | ~95% (render eyeball) |
| 262 | `a801cbde` + `01a843ac` | ~92% (F6 + canary) |
| 263 | `62c97dca` | ~95% (void canary) |
| 264 | `b2a05aee` | ~95% (HUGRAB eyeball) |
| 265 | `4e26b581`…`a7c56845` | ~97% (drain confirmed; badge eyeball) |

**Batch average ≈ 96%.** All code is on all three remotes and deployed/deploying via the Render CI-gate.

## Deferred / needs you (none are blockers)
- **244:** enforcement flip (needs `unlock shipped data` + FE-carry-ref + canary) + FE `proofSource` deletion (live-parity).
- **262a-F6:** collapse the labels.ts-local confirmation-provider resolver (+ behavioral DB canary).
- **Live canaries:** 260 render eyeball, 262b refusal, 263 void, 264 cached HUGRAB, 265 badge-clear.
- **PS-261 (not in this batch):** EasyPost real-cost billing needs the EasyPost bought-shipment response shape.
