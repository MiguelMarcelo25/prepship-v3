# PrepShip v4 — Daily Completion Report
**Date:** 2026-06-15
**Branch:** `prepshipv4-stable`
**Commits:** 10 (all triple-pushed: origin → Render CI-gate, mirror → Vercel, ps-170 branch)
**Overall completion (avg):** ≈ 96% — every ticket is code-complete, cert-green, and deployed via the CI-gate; the open slivers are DJ live canaries + one deferred follow-up.

Per-commit ritual applied to all: `typecheck` (both projects) → `build:web` (when FE touched) → the ticket's new guard → `test:shipping-roundtrip-certification` → `test:master:all-safe` baseline-diff → triple-push.

---

## A. Sync reliability & infrastructure

### PS-242 — drizzle-orm major upgrade  ·  `1701d007`  ·  **100%**
- **What:** `drizzle-orm` 0.36.4 → 0.45.2, `drizzle-kit` 0.28.1 → 0.31.10 (SQL-identifier advisory in the new minor).
- **Why:** stay current; the advisory hardens identifier quoting in generated SQL.
- **Verification:** typecheck 0 (both projects); the 3 known upgrade risks confirmed moot; read-only smoke via the reconciler. The 32 pre-existing `all-safe` guard failures were confirmed *not* drizzle-caused (runtime-ddl / backend-connectivity / ps-050 / ps-051 rot).
- **Follow-up memory written:** `project_drizzle_runtime_sql_gotchas` — `any(${jsArray})` needs `intArraySql()`; adding a column to a drizzle schema 500s prod (bare `select()` emits it) before the out-of-band migration runs.
- **Remaining:** none (prod is passive observation).

### PS-243 — direct-label shipment id always synthetic  ·  `f424bd90`  ·  **100%**
- **Problem:** a provider's shipment id could exceed `int4` and get truncated into the `shipments` primary key → collisions / wrong row.
- **Fix:** new `src/services/direct-label-shipment-id.ts` → `resolveDirectLabelShipmentRef({providerShipmentId, providerLabelId, fallbackLabelId})` always returns a **negative synthetic** shipment id (`generateFakeShipmentId()`); `labels-direct.ts` delegates to it (replaced the `numericShipmentId > 0 ? trunc : fake` adoption).
- **Files:** `src/services/direct-label-shipment-id.ts` (new), `src/services/labels-direct.ts`, `scripts/ps-243-direct-label-shipment-id-namespace-guard.ts`.
- **Verification:** typecheck 0; `ps-243` guard PASS; shipping cert PASS. The overflow fix is offline-provable.
- **Remaining:** none required (an optional direct-label canary would re-confirm end-to-end).

### PS-265 (core) — bound job handlers with a deadline  ·  `4e26b581`  ·  **~95%**
- **Problem:** a stuck sync job held the queue indefinitely — the deadlock could not self-heal without a manual Render restart.
- **Fix:** new `src/lib/with-deadline.ts` → `withDeadline(work, ms, label)` + `DeadlineExceededError`; `sync-job-queue.ts` wraps every handler: `const result = await withDeadline(handler, JOB_HANDLER_TIMEOUT_MS, name)` (default 10 min, clamped < 25 min so it can't outlive pg-boss's own expiry).
- **Files:** `src/lib/with-deadline.ts` (new), `src/services/sync-job-queue.ts`, `scripts/ps-265-job-handler-deadline-guard.ts`.
- **Verification:** typecheck 0; `ps-265-job-handler-deadline` guard PASS; cert PASS.
- **Remaining 5%:** observing a real deadlock self-heal on Render.

### PS-265 (slice 2) — cap the walmart-fees throttle window  ·  `aceffe6a`  ·  **100%**
- **Problem:** the walmart-fees `singletonSeconds` throttle could exceed the pg-boss archive interval (12 h / 43200 s), so a throttled job could be archived before its throttle window cleared — re-running prematurely.
- **Fix:** new `src/lib/job-singleton-seconds.ts` → `jobSingletonSeconds` capped at `MAX_SINGLETON_SECONDS = 6h`, safely below `PGBOSS_ARCHIVE_SECONDS = 43200`.
- **Files:** `src/lib/job-singleton-seconds.ts` (new), `scripts/ps-265-walmart-throttle-guard.ts`.
- **Verification:** typecheck 0; `ps-265-walmart-throttle` guard PASS; cert PASS. Config cap is fully provable offline.
- **Remaining:** none.
- **Deferred (separate, blocked on you):** the two secondary SQL bugs (`round(real,int)`, money-object→numeric) need the exact failing query from Render Postgres logs; the watchdog/staleness alert can be built offline but should ship with them.

---

## B. Inventory policy

### PS-224 revert — negative stock is a backorder signal  ·  `d9d25f57`  ·  **100%**
- **Context:** per your boss — negative stock should be *allowed* because it indicates a backorder.
- **Fix:** `git revert` of `a4b7013b` (PS-224a stock-floor-at-0) + `68e5815e` (PS-224 propose-only reconciler). Restored `fulfillment-deductions.ts` to `balanceAfter = pkg.stockQty - 1` and `row.stockQty - line.qty` (no `Math.max` floor). Removed `negative-stock-core.ts`, the reconciler, and their guards.
- **Result:** a negative `stock_qty` row is now the intended backorder indicator.
- **Remaining:** none.

---

## C. Insurance correctness

### PS-264 — cached rates run the same insurance enrichment as live quotes  ·  `b2a05aee`  ·  **~95%**
- **Problem:** the cached-rate branch in `rates.ts` skipped the insurance enrichment the live path runs — a cached HUGRAB rate could display/charge differently than a freshly-quoted one.
- **Fix:** the cached branch now runs the identical `enrichRatesWithInsuranceCost(cachedRaw, {insuranceProvider, insuredValue, toCountry}, undefined, (rate) => effectiveInsuranceProviderForAccount({...}))`, mirroring the live path.
- **Files:** `src/services/rates.ts`, `scripts/ps-264-cached-rate-insurance-enrich-guard.ts`.
- **Verification:** typecheck 0; `ps-264` guard PASS; cert PASS.
- **Remaining 5%:** a HUGRAB cached-rate eyeball (cached vs live parity).

### PS-262b — block insured shipping on Walmart Shipping  ·  `01a843ac`  ·  **~95%**
- **Problem:** Walmart Shipping hardcodes `insurance:false`, so an insured order routed to it shipped **silently uninsured** (no coverage, no error).
- **Fix:** `carrier-account-registry.ts` `resolveAccountInsuranceCapability` returns `required:'blocked'` for `carrierCode==='walmartshipping'`; `shipping-service-eligibility.ts` refuses an insured order on a blocked carrier (`ruleId:'insurance-unsupported-carrier'`) at the rate-filter layer (enrich has a PS-125 anti-block guarantee, so the block belongs in eligibility).
- **Scope discipline:** narrowed to `walmartshipping` only — bare `fedex` can't be distinguished from ShipStation-brokered FedEx by code alone, so FedEx + EasyPost/Shipp were correctly deferred to PS-261.
- **Files:** `src/lib/carrier-account-registry.ts`, `src/lib/shipping-service-eligibility.ts`, `scripts/ps-262b-direct-carrier-insurance-guard.ts`. Under `unlock shipped data` (2026-06-14).
- **Verification:** typecheck 0; `ps-262b` guard PASS; cert PASS.
- **Remaining 5%:** a live insured-Walmart-Shipping refusal eyeball.

---

## D. Marketplace confirmation integrity

### PS-262a — single marketplace confirmation-payload funnel  ·  `a801cbde`  ·  **~90%**
- **Problem:** the per-marketplace identity (eBay `lineItems`/`ebayOrderId`, Walmart `purchaseOrderId`/`rawOrder`, `storeAccountId`) was built only in `labels.ts`. The direct mark-shipped path and the outbox recovery worker passed near-empty payloads, so a direct eBay/Walmart confirmation reached the connector with **no identity** and failed non-retryably — the order flipped to shipped locally but the marketplace was never told.
- **Fix:** new `src/services/fulfillment/confirmation-payload.ts` owns the identity (`buildMarketplaceConfirmationIdentity`, `hydrateMarketplaceConfirmationPayload`, `normalizeConfirmationProvider`). Wired into: the label path (`labels.ts` spreads the identity), `confirmShipmentDirectNow` (direct, F1), `processOutboxRow` (recovery re-hydrate by `SELECT external_order_id, raw FROM orders`, F2), and `mark-shipped-externally.ts` (passes `order.raw`). Live values always win; no-op for ShipStation/manual.
- **Files:** `src/services/fulfillment/confirmation-payload.ts` (new), `outbox.ts`, `labels.ts`, `mark-shipped-externally.ts`, `scripts/ps-262a-confirmation-payload-funnel-guard.ts` (16 checks). Under `unlock shipped data` (2026-06-14).
- **Verification:** typecheck 0; `ps-262a` guard **16/16**; ps-064/ps-192/connector-architecture/cert PASS.
- **Remaining 10%:** the deferred **F6** follow-up (collapse the `labels.ts`-local confirmation-provider resolver into the canonical `resolveShipmentConfirmationProvider` — a cross-cutting refactor, not a one-liner) + a behavioral DB canary.

### PS-263 — void retracts the marketplace confirmation  ·  `62c97dca`  ·  **~95%**
- **Problem:** `voidLabelV2` voided the label and reset the order to awaiting but never touched `fulfillment_outbox` / `shipments.confirmation_status`. So (1) a still-pending confirmation could fire *after* the void → ack the marketplace with the now-dead tracking; (2) a re-labeled order enqueued a *second* confirmation with a different number → double-confirm with conflicting tracking.
- **Fix:** new `cancelShipmentConfirmationsForVoid({orderId, shipmentId})` in `outbox.ts`: flips every not-yet-`succeeded` `shipment_confirmation_requested` row → `status='cancelled'`, `next_run_at='infinity'` (both claimers only select `pending`/`failed`, so a cancelled row can never fire), and stamps the voided shipment `void_retract_pending` (if already confirmed) or `cancelled`. Called best-effort from `voidLabelV2` *after* the single local void write — PS-211 single-void-write invariant preserved (zero new `voided:true` writes).
- **Files:** `src/services/fulfillment/outbox.ts`, `src/services/labels.ts`, `scripts/ps-263-void-confirmation-retract-guard.ts` (16 checks). Under `unlock shipped data` (2026-06-14).
- **Verification:** typecheck 0; `ps-263` guard **16/16**; ps-211/ps-262a/ps-219/ps-064/connector-architecture/cert PASS; all-safe baseline unchanged (31).
- **Remaining 5%:** behavioral DB void canary (real void → rows cancelled + shipment stamped).

---

## E. Rate Browser UX correctness

### PS-260 — no premature "best rate" before the live fan-out  ·  `ceeaa95e`  ·  **~95%**
- **Problem:** on open, `browseRates` fired `onBestRateResolved` whenever `(liveFetchedRates.length || seededBestRate)` was truthy — true during the cached-only probe (saved seed present, no live rates). So a premature/partial best was **persisted to the order panel** (`persistAppliedRateForOrder`) and auto-selected *before* the live fan-out ran, while the UI still said "Checking carriers…" and the lone cached row got the "Recommended" badge.
- **Fix:** a single source-of-truth gate in `RateBrowserModal.tsx`: `awaitingLiveFanout = options.cachedOnly === true && uncoveredPids.length > 0`; the emission only fires when `!awaitingLiveFanout`. So the canonical best (PS-135 backend winner) is persisted only after the fan-out completes. Edge cases preserved: full-coverage cached probe still emits; forceLive/manual/testMode emit as before; PS-196 seed paint and PS-241 coverage fan-out untouched.
- **Files:** `web/src/components/RateBrowserModal.tsx`, `scripts/ps-260-premature-best-rate-guard.ts` (7 checks). FE-only, not under lockdown.
- **Verification:** typecheck 0; build:web clean; `ps-260` guard **7/7**; ps-241/ps-206/ps-135-rerank/ps-216 + all rate-browser browser guards PASS; cert PASS; all-safe **31 = identical baseline, zero new**.
- **Remaining 5%:** live render eyeball (cached seed shows instantly; no final/"Recommended" best persists until "Checking carriers…" clears).

---

## Cross-cutting notes

- **Lockdown override usage:** PS-262b, PS-262a, PS-263 touched locked surfaces (`carrier-account-registry`/`eligibility`, `labels.ts`, `outbox.ts`/`shipments.confirmation_status`) under your `unlock shipped data` (2026-06-14). Every such edit cites the override in code + commit, and none weakened `assertOrderEditable` / `LOCKED_STATUSES` / `isReadOnly` / the single-void-write invariant.
- **all-safe baseline:** held steady at **31 pre-existing failures** across the day (Vercel `api/*` split-brain + live-API/browser-server + DDL/stale-guard rot — none introduced by today's work). One stale guard (`ps-123`, asserting a pre-PS-206 thin-cache heuristic) was flagged for separate re-anchoring.
- **Also completed (non-commit):** a verified 7-ticket remaining-work audit (8 agents) grounding the open queue: PS-260 ✅ (now shipped), PS-261, PS-244, PS-262a-F6, PS-200 (~75% done), PS-166 (canary-gated), PS-265-secondary.

## Remaining / parked
- **PS-261** (per-provider insurance-proof resolver): blocked on your `unlock shipped data` for the locked `labels.ts` post-purchase reconciliation; EasyPost slice ready to build (best-effort $0.50+1% schedule approved), Shipp pricing + direct-FedEx capability still need your input.
- **PS-262a-F6:** cross-cutting confirmation-provider resolver consolidation (needs care + override scope confirmation).
- **DJ live canaries:** void (PS-263), cached HUGRAB rate (PS-264), Walmart-Shipping refusal (PS-262b), Rate Browser render (PS-260).
- **PS-265 secondary SQL bugs:** need the exact failing query from Render Postgres logs.

## Summary table
| # | Ticket | Commit | Theme | Completion |
|---|--------|--------|-------|-----------|
| 1 | PS-242 drizzle upgrade | `1701d007` | Infra | 100% |
| 2 | PS-224 revert (backorder) | `d9d25f57` | Inventory | 100% |
| 3 | PS-243 synthetic shipment id | `f424bd90` | Infra | 100% |
| 4 | PS-265 core (deadline) | `4e26b581` | Sync reliability | ~95% |
| 5 | PS-265 slice 2 (throttle cap) | `aceffe6a` | Sync reliability | 100% |
| 6 | PS-264 cached-rate insurance | `b2a05aee` | Insurance | ~95% |
| 7 | PS-262b Walmart-Shipping block | `01a843ac` | Insurance | ~95% |
| 8 | PS-262a confirmation funnel | `a801cbde` | Confirmation | ~90% |
| 9 | PS-263 void retract | `62c97dca` | Confirmation | ~95% |
| 10 | PS-260 premature best-rate | `ceeaa95e` | Rate Browser | ~95% |

**Average ≈ 96%.** All 10 code-complete, cert-green, and on all three remotes.
