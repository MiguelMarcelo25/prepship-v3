# Batch Create+Print via the Print-Queue Pipeline + Parallel Merge Fetch — Design

- **Date:** 2026-07-07
- **Status:** Approach A3 approved by DJ (chat, 2026-07-07). Spec awaiting DJ review.
- **Implementation gate:** Track 2 (and any `src/services/print-queue.ts` edit) requires DJ to type
  `unlock shipped data` in the conversation. Not yet given — S3/S4 are blocked until it is.

## Problem

Two independent slowdowns in the label→print workflow:

1. **Create + Print is a frontend loop.** `handleBatchAction('print')` (`web/src/components/Views/OrdersView.tsx`)
   buys labels strictly sequentially (one `POST /labels` at a time), runs up to a 45s strict re-rate per order
   when proof is missing, opens one browser tab per label, and loses the un-bought remainder if the tab/browser
   dies mid-batch. Send-to-Queue already has the right machinery (durable backend job, ≤8 concurrent buys,
   per-order results + retry classification, existing-label recovery) — Create + Print never got it.
2. **The merge job fetches labels serially.** `runMergeJob` (`src/services/print-queue.ts`) fetches each label
   PDF one at a time (15s timeout each). A 50-label Print All pays ~50 sequential CDN round-trips.

## Goals / success criteria

- Create + Print (flag ON): one click → backend buy job (≤8 concurrent) → ONE merged, 4×6-normalized PDF with
  group headers. 20-order batch completes in roughly ⌈20/8⌉ buy waves + one merge (target well under a minute,
  vs multi-minute sequential today). Zero double-buys. Zero `apiClient.createLabel` calls from the new path.
- Print All on a 50-label queue with fetch concurrency 4: merge fetch phase ~4× faster.
- Both changes ship **inert**: FE flag default OFF, fetch concurrency default 1 → byte-identical behavior
  until DJ flips them. Zero-new-reds vs baseline (`test:master:all-safe`, mine ⊆ base).
- `npm run typecheck` and `npm run test:rate-source-of-truth` green.

## Non-goals

- No change to rate ranking, proof semantics, or Best Rate ownership (PS-313 untouched).
- No PS-279 orchestrator cutover, no rateQuoteId-only payload migration (backlog).
- No direct-print agent / auto-print (workflow change — separate decision).
- No deletion of the legacy Create+Print loop in this ship (follow-up slice after DJ live-confirms).
- No touch of `assertOrderEditable`, `LOCKED_STATUSES`, `isReadOnly` consumers, `orders`/`shipments` schema,
  or `fulfillment-deductions.ts`.

## Track 1 — Create + Print rides the backend queue pipeline (Approach A3)

### Chosen approach and alternatives

- **A3 (chosen): FE chains the two existing backend jobs.** `/print-queue/batch-send` (buy/recover + queue)
  then `/print-queue/print` (merge) — both already durable and idempotent. No new backend job surface.
- A1 (rejected): backend `deliver:'merge'` param chaining the merge server-side — same UX but adds surface to
  locked print-queue files and ~doubles the diff; PS-279 will subsume chaining later anyway.
- A2 (rejected): dedicated create-print backend job bypassing the queue — a second parallel pipeline,
  violates the one-owner rule.

### Flow (flag ON)

1. Click **🖨️ Create + Print** → `handleBatchAction('print')`.
2. Synchronously open the print window (reuse `openQueuePrintWindow()` — popup-blocker safety).
3. Hydrate selected orders (existing `hydrateSelectedOrdersForActions`).
4. **Proof pre-pass** (new pure module): for each real (non-test) order whose saved rate can't serve as
   current proof (same `buildSelectedRateProofPayload(...) == null` check the legacy loop uses), run the
   existing `runStrictBestRateRecalculation` (45s timeout, concurrency `BATCH_QUEUE_CONCURRENCY = 2`) and
   build a label-payload override (same shape as the side-panel/PS-204 override path). Failures become
   per-order skip reasons; the rest proceed.
5. `sendOrdersToQueueBackend(orders, { kind: 'create-print', labelPayloadOverrides, batchTestMode,
   deferOrdersRefetch: true })` → existing `POST /print-queue/batch-send` (buys ≤8 concurrent under the full
   `createLabelV2` gate ladder; recovers `LABEL_EXISTS`/missing-url labels instead of failing; PS-191
   structural retry classification).
6. On job done:
   - **Fade preserved** (DJ directive 2026-05-07): each successfully bought order gets the existing 30s
     `transitionalShippedIds` fade + timer → `scheduleOrdersRefetch(250)`. The chain skips
     `sendOrdersToQueueBackend`'s immediate `refetchOrders()` (`deferOrdersRefetch`) so rows fade instead of
     vanishing instantly.
   - **Print tail:** `printQueueEntries(queuedEntryIds, { printWindow })` → existing `POST /print-queue/print`
     merge job → signed URL → single PDF in the pre-opened tab.
7. Entries remain `queued` until the operator clicks **Confirm Printed** (universal two-phase gate; reprints
   become free). Toast summarizes bought/recovered/failed with per-order reasons and the PS-191
   "rate expired — recalculate" prompt where applicable. Never auto-repurchase.

Flag OFF → the legacy loop runs byte-identical (whole block preserved).

### Operator-visible changes (flag ON)

- ONE merged PDF instead of N tabs; labels 4×6-normalized with group headers/manifest (incidentally fixes the
  #572 SHIPP wrong-size symptom for batch prints — legacy opened raw label PDFs).
- Bought orders appear in the Print Queue and need Confirm Printed after physical printing.
- Orders that already had a label are recovered + included instead of failing with "Label already exists".

### Feature flag

Backend-owned, same pattern as PS-279's `PRINT_QUEUE_FE_DELEGATION`:

- `src/lib/env.ts`: `BATCH_PRINT_VIA_QUEUE: booleanFlag(false)`
- `src/routes/users.ts` `/users/me`: `batchPrintViaQueue: env.BATCH_PRINT_VIA_QUEUE === true`
- `OrdersView` reads it alongside `printQueueFeDelegation`. Flipping = Render env change (no FE redeploy).

### Files touched (Track 1 — none are lockdown surfaces)

| File | Change |
|---|---|
| `src/lib/env.ts` | + one boolean flag (additive config) |
| `src/routes/users.ts` | + one `/users/me` field (mirrors existing pattern) |
| `web/src/components/Views/orders-persistent-queue-job.ts` | `PersistentQueueJobKind` += `'create-print'` |
| `web/src/components/Views/batch-create-print-proof-pass.ts` | **NEW** pure module: proof pre-pass (injected recalc runner, returns overrides map + per-order failures) |
| `web/src/components/Views/OrdersView.tsx` | flag state; flag-ON branch in `handleBatchAction('print')`; `sendOrdersToQueueBackend` gains `deferOrdersRefetch` + returns `queuedEntryIds`/`successOrderIds`; `printQueueEntries` accepts a pre-opened window + explicit entry ids |
| `scripts/batch-print-via-queue-guard.ts` | **NEW** guard (see Testing) |
| `web/e2e/` | new/extended spec for the chained calls |

`queueScope` is hardcoded `'all'` (`queueClientId` always null), so entry-id-based printing has no
client-scope snag; `/print-queue/print` treats `client_id` as optional and scope-checks per entry.

### Error handling

| Failure | Behavior |
|---|---|
| Proof pre-pass recalc fails for an order | Order skipped with reason (same message family as legacy), others proceed |
| batch-send per-order failure | Toast lists reasons; `retryEligible` → existing RATE_EXPIRED prompt + `refreshStaleRateForOrder`; never auto-repurchase |
| Merge/print tail fails or popup blocked | Labels are safe in the queue; toast directs to the drawer's Print All (strictly better than legacy, which lost the remainder) |
| Browser closes mid-chain | Buys continue server-side (durable job); on return the drawer shows the entries; persistent FE job re-attaches |
| Double-click | Existing `batchBusy` guard |

## Track 2 — Pipelined merge-job label fetch (LOCKED FILE — gated on `unlock shipped data`)

### New module: `src/services/print-queue-label-prefetch.ts`

```ts
startLabelPrefetch(
  items: Array<{ id: string; url: string }>,        // resolved URLs, held entries already filtered out
  opts: { concurrency: number; timeoutMs: number; fetchImpl?: typeof fetch },
): (id: string) => Promise<PrefetchResult>

type PrefetchResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network'; message: string }
```

- Pool walks `items` in the given (already-sorted) order, ≤ `concurrency` in flight, starts immediately,
  never rejects (errors are materialized results), caches results, `Accept: application/pdf`,
  `AbortSignal.timeout(timeoutMs)` per fetch (15s, unchanged).
- `concurrency = 1` ⇒ at most one fetch in flight, same sequence as today (network stays serial; a fetch may
  overlap pdf-lib assembly of the previous label — documented, harmless).

### `runMergeJob` diff (minimal, mechanical)

- After the holds map loads: build `items` from the sorted entries (skipping held entries and entries whose
  URL fails to resolve — those keep their existing per-entry error branches at their current positions),
  start the prefetch.
- In the assembly loop, replace the inline `fetch` block with `await prefetch(e.id)` and map results onto the
  **existing** branches byte-for-byte: `http 404/410` → "Label expired…", other http → "Failed to fetch…",
  `network` → "Network error…", mock fallbacks keyed off `isMockLabel` exactly as today.
- Grouping, headers, manifest, 4×6 normalization, progress persistence, `successfulEntryIds` — untouched.

### Knob

`src/lib/env.ts`: `PRINT_QUEUE_MERGE_FETCH_CONCURRENCY` (int, default **1**, clamped 1–8). Default = serial =
current behavior. DJ sets 3–5 on Render after a canary Print All.

### Lockdown compliance

Track 2 edits `src/services/print-queue.ts` (fetch mechanics inside `runMergeJob` only): no postage, no
shipped/cancelled mutation, no schema change. Still a lockdown surface ⇒ requires the typed override; every
change carries the required `Per user override unlock shipped data on 2026-MM-DD: …` comment and the commit
mentions it, per AGENTS.md.

## Testing & verification

- **Unit (Track 1):** proof-pass module — skips test orders and orders with current proof; respects
  concurrency/timeout; maps failures to reasons.
- **Guard `scripts/batch-print-via-queue-guard.ts`:** flag OFF ⇒ legacy loop reachable and chain dormant;
  flag ON path contains no `apiClient.createLabel(` call (FE never buys in the new path); chain wires
  batch-send → print with the job's returned entry ids.
- **e2e (mock session, route interception):** Create+Print with flag ON issues `/print-queue/batch-send` then
  `/print-queue/print` with the returned `queued_entry_ids`; exactly one PDF window target; no immediate
  orders refetch before the fade timers (fade directive preserved).
- **Unit (Track 2):** pool cap honored (instrumented fake fetch); results independent of completion order;
  timeout → `network` result; http statuses mapped; no unhandled rejections.
- **Real-runtime smoke (Track 2):** local HTTP server serving small real PDFs + one 404 + one hang → module
  with real `fetch`, bytes loaded through real `pdf-lib` (per the exceljs/this-binding lesson: no
  fake-object-only guards on library boundaries).
- **Suite:** `npm run typecheck`; `npm run test:rate-source-of-truth` (proof builders are on the Track 1
  path); baseline `test:master:all-safe` zero-new-reds (mine ⊆ base).

## Rollout & rollback

1. Ship all slices dark (flag OFF, knob unset ⇒ 1). Push origin + mirror; DJ manual Render deploy; Vercel
   auto-deploys.
2. Canary Track 1 on a test client (`batchTestMode` / test orders — $0 mock labels) → DJ flips
   `BATCH_PRINT_VIA_QUEUE=true` on Render when satisfied.
3. Canary Track 2: one real Print All batch, then set `PRINT_QUEUE_MERGE_FETCH_CONCURRENCY=4`.
4. Rollback = flip the env(s) back. No code revert needed; both paths coexist.
5. After DJ live-confirms Track 1, a follow-up slice deletes the legacy loop (with leftover-reference grep,
   per the `@ts-nocheck` runtime-crash lesson).

## Slices

- **S1:** flag plumbing (env.ts, users.ts, FE state) + proof-pass module + unit tests. No behavior change.
- **S2:** chain wiring behind flag + `sendOrdersToQueueBackend`/`printQueueEntries` extensions + guard + e2e.
- **S3 (gated on override):** prefetch module + unit tests + real-runtime smoke.
- **S4 (gated on override):** `runMergeJob` consumption + env knob.
- **S5:** verification suite, ship, canary per Rollout.

## Risks

| Risk | Mitigation |
|---|---|
| Operators surprised by queue entries from Create+Print | Toast explains; drawer badge shows count; Confirm Printed flow already familiar from Send to Queue |
| Fade regression (rows vanish early) | `deferOrdersRefetch` + existing per-row timers; e2e asserts no immediate refetch on the chain path |
| Prefetch changes error text/positions | Result-mapping table pins branches byte-for-byte; zero-new-reds baseline |
| Flag plumbing drift | Mirrors the existing PS-279 `/users/me` pattern exactly |

## Backlog (explicitly out of scope)

rateQuoteId-only label payloads (PS-105 endgame); PS-279 backend route-plan cutover; direct-print agent;
merged/label byte caching in the PS-256 side-store; skipping the redundant confirmation repair for
fresh-bought entries.
