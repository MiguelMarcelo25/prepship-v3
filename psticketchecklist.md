# PrepShip V4 — PS Ticket Checklist & Duplication Audit (PS-130 → PS-168)

Date: 2026-06-09 · Branch: prepshipv4-stable · Verified against the live repo (read-only).
Scope: source-of-truth cleanup track (Epic PS-131) + cert card PS-130.
NOTE: PS-127 / PS-128 / PS-129 are already SHIPPED & LIVE — they close/overlap some items below.

---

## EPIC PS-131 — Sequential Source-of-Truth Cleanup Track (LIVE PROGRESS)

> Type: EPIC / tracker only. Old child cards PS-132–PS-149 were collapsed into the smaller
> sequential track PS-132 → PS-139. **Guardrails:** sequential only (don't parallelize cards
> touching the same workflow/file family); read AGENTS/ARCHITECTURE/CONTRIBUTING + docs/engineering
> first; shipped/cancelled/shipments/OrdersView locked surfaces need DJ to type `unlock shipped
> data`; no live postage/labels/marketplace/production shipped-cancelled mutations in tests;
> every update starts `PS-### update:` with branch/PR/files/tests/blockers.

| # | Card | Status | % | Commits / notes |
|---|---|---|---|---|
| **PS-132** | Shared foundations (carrier registry + visibility/cadence/system constants) | ✅ **LIVE** | **100%** | `4831f77a` + `033a4a2d` + `ea15717c`. 433543 nickname reconciled. |
| **PS-133** | Inventory effective-stock SoT + analytics extraction | ✅ **100%** (SoT + safe slice) | **100%** | `ea38168b` (owner + dashboard drift-bug fix) + `ae7dfc4a` (admin reconcile cross-ref) + `8e0d7cd9` (route-timing helpers → `lib/route-timing.ts`). SoT goal fully met across all 5 consumers. Adversarial scoping confirmed the deep analytics-DTO extraction is guard-pinned + InventoryView-byte-critical (same wall as PS-137 #8) — only the timing helpers were safely extractable offline; the byte-risky DTO/ledger move is reclassified as a separate live-data-gated decomposition (NOT PS-133 SoT scope). Deploy pending. |
| **PS-134** | Billing reference-rate ETL + invoice SoT | ✅ **100%** (pending live confirm) | **100%** | `36232a9d` (ETL → service) + `a3f29a7e` (extract: /invoice → billingInvoiceData()+renderInvoiceHtml(), thin route) + `9b2eca11` (unify: header totals → `billingInvoiceHeaderTotals()` in the billing service, SoT). All byte-identical (verbatim SQL/HTML/derivation; verified line-for-line). `pickpack`=0 confirmed. Sibling invoice-mode (NOT literal billingSummary reuse — that's byte-divergent: client-scope + cache + single-alias). 7 guards pass. **DJ: render one invoice on the deployed build before/after to confirm $ (no test asserts rendered output).** |
| **PS-135** | Canonical Rate Browser / Best Rate / proof / eligibility | ✅ **100% (code)** | **100%** | `0264edf0`+`6ac39504`+`c0bd3e45` (rate-proof lib, re-rank leak fix, panel-live isComplete — LIVE). **(a) UPS residential** `168b0b31` **PUSHED** (awaiting DJ deploy + 1 real UPS test label — the only behavior change to confirm live): rate+label threaded server-side via PS-127 classifier, rate==label parity, CONFIRMED-SAFE, 12-check guard. **(b) eligibility** `bf9bbada`+`bf22196e` **PUSHED**: NEW `src/lib/rate-block-list.ts` is the single owner for the Policy-B block list (USPS/flat-rate) that was duplicated verbatim in `rates.ts`↔`markups.ts`; both now import+delegate. **Strictly behavior-preserving** (adversarial review SAFE: backend 675 + FE 6750 differential combos → 0 divergences; redundant `\|flat rate` regex alt dropped, identical match set; `BLOCKED_CARRIER_IDS` stays FE-applied). Guard flipped to single-source enforcement (13 checks). Policy A (HUGRAB) was already shared ✅. typecheck+build:web+5 guards+smoke-parity 21/21 PASS. |
| **PS-136** | Fulfillment confirmation + external-shipped + labels cleanup | ✅ **pushed** 🔒 | **~90%** | Under `unlock shipped data` (2026-06-09). `4c0be84a` (dead-code) + `908160d7` (Unify-2: confirmation-provider → canonical owner; fixes always-truthy `supported` bug) + `46837606` (Extract-3: `markOrderShippedExternally()` service + forward-only guard). Adversarially CONFIRMED-SAFE. **Deferred:** Decomp-1 (cosmetic labels.ts split) ; **dropped to backlog:** Unify-3 (live Walmart-sender dedupe). Deploy pending. |
| **PS-137** | Orders list/export route decomposition | ✅ **100% (SoT)** | **100%** | `a538cb1c`. Extracted pure helpers → `orders-dto-primitives.ts` + `orders-csv-format.ts` + `normalizeListBestRate`→`order-rate-dto.ts` (behavior-preserving). Also fixed stale PS-132 `orders-query-round2` guard (`e9d9af45`). **#8 list row-mapper: deliberately left inline (DJ decision 2026-06-09)** — it only ORCHESTRATES already-canonical helpers, so there's no duplicated truth to fix; extraction is cosmetic-only + needs a query-builder extraction to type `orderListSelect`'s custom projection safely under strict mode → risk on the main Orders screen not worth a zero-behavior change. Documented in-code at the mapper. #7/#9 DROPPED (net-negative). **Source-of-truth objective COMPLETE.** |
| **PS-138** | Print Queue PDF rendering extraction only | ✅ **local, verified** | **100%** | `c170b1e6` (local; confirm before push). Extracted the pure PDF cluster → new `print-queue-pdf.ts` (−897 lines from print-queue.ts), byte-exact slice. runMergeJob + PS-129 holds + label-URL validation + DB loaders all STAY. 12/12 print-queue guards pass incl. byte-identity (ps-073-adaptive exact Tf operators) + holds (ps-128-129); 2 static guards retargeted to read both files. Behavior-preserving. |
| **PS-139** | Final guard-aware dead-code sweep | ✅ **pushed** | **100%** | `3e38ff21`. 19 verified-dead symbols/files removed (−471 lines): 11 backend (fetchLiveRates, normalizeWalmartOrderIdentity, exact/zip5ShippingPostalCode, residential.ts file, parseOrderRateJson, buildHugrabLockedAutomationRule, buildQueueComboKey/Summary, listAdminEmails, getRefRatesJob) + FE rate-dedupe cluster + 4 dead apiClient methods + 3 dead web files (StoreVisibilityContext, StoresContext, utils/orders.ts). 6-agent sweep + adversarial re-verify (0 rejections); both typechecks + 9 guards PASS. Deploy pending (behavior-preserving). |

**Superseded — do NOT implement separately:** old PS-140 → PS-149 (folded into PS-132–139).

**Standalone shipped this session (outside the PS-131 track):** PS-127 ✅100%, PS-128 ✅~98%, PS-129 ✅~98% — all LIVE.

**Open decisions / your actions:**
1. **Deploy latest `46837606`** (Render API + worker). Live deploy is at `ae7dfc4a`; undeployed since: PS-130 cert `2acba89e` (CI-only, no runtime), PS-136 `4c0be84a`+`908160d7`+`46837606`. Deploying makes the PS-136 confirmation-provider change live (manual/no-marketplace direct-carrier orders → `not_required`). Tell me + I verify Render.
2. ✅ PS-136 done (pushed) — was unlocked via `unlock shipped data` on 2026-06-09. Next sequential: PS-137 (orders list/export route decomposition).
3. **PS-134:** run `select count(*) from billing_line_items where line_type='pickpack'` → unblocks the invoice unify.
4. **PS-132:** confirm the 433543 nickname (`UPS by SS - Chase x7439`) or ask for the short form.
5. **PS-135 deferred items:** approve/decline UPS direct-carrier residential threading (changes live UPS billing) + backend-stamped eligibility DTO change.

## 0. TL;DR
- Build in order (Epic PS-131): PS-132 → 133 → 134 → 135 → 136 → 137 → 138 → 139.
- Standalone: PS-130 (cert guard) — run AFTER PS-135.
- Audit children PS-150–168: modularization + dead-code; several are MOOT/ALREADY-DONE (see §5).
- Already done / moot (do NOT implement): PS-152, PS-160, most of PS-158, rb_markups half of PS-153, (verify) PS-164.
- Lockdown (need DJ `unlock shipped data`): PS-136; parts of PS-137/PS-165; PS-163 is awaiting-only.

## 1. CRITICAL — the numbers mean two different things
Two numbering schemes — always confirm "old" vs "new":
- OLD PS-132…149 = original Claude-created child cards.
- NEW PS-132…139 = regrouped sequence in PS-131; each NEW card says "REPLACES/GROUPS OLD
  SCOPES", so the SAME number means something different old vs new.
- PS-128/PS-129 collision: the rate cards (modal-bestRate, isComplete) were briefly created as
  PS-128/PS-129, then renumbered to PS-132/PS-133 (old) "to avoid a collision with existing GPT
  cards." Those existing GPT cards = the **PS-128 (Block Duplicate Walmart) and PS-129 (Upstream
  Cancellation) already SHIPPED this session.** ⇒ Rate-truth work belongs to **PS-135 / PS-130**,
  not PS-128/129.

## 2. OLD → NEW mapping
| Old card | Old scope | Folded into |
|---|---|---|
| PS-132 | Rate Browser consumes backend Best Rate | PS-135 |
| PS-133 | Backend-derive isComplete | PS-135 |
| PS-134 | Stop OrdersView double-marking markup | PS-135 |
| PS-135 | Unify shipment-confirmation provider | PS-136 |
| PS-136 | Single owner for effective-stock | PS-133 |
| PS-137 | Extract markOrderShippedExternally() | PS-136 |
| PS-138 | One carrier-account registry service | PS-132 |
| PS-139 | Invoice route → thin renderer | PS-134 |
| PS-140 | Reference-rate backfill ETL → service | PS-134 |
| PS-141 | Visibility predicate + cadence + system-client constants | PS-132 (+ billing slice → PS-134) |
| PS-142 | Backend-stamped rate eligibility | PS-135 |
| PS-143 | Split OrdersView rate-proof block → lib | PS-135 (⚠ also claimed by PS-166) |
| PS-144 | Decompose routes/orders.ts GET | PS-137 (⚠ also claimed by PS-166) |
| PS-145 | Decompose print-queue.ts | PS-138 (narrowed: PDF-only) |
| PS-146 | Decompose labels.ts + dead legacy-batch | PS-136 |
| PS-147 | Split inventory.ts analytics → service | PS-133 (⚠ PS-150 still cites old #) |
| PS-148 | Carrier connector dedup + residential threading | PS-135 |
| PS-149 | Dead-code sweep | PS-139 (+ shim/rb_markups → PS-160; outbox/label → PS-136) |

## 3. Active execution checklist (legend: ACTIVE / DONE-MOOT / VERIFY · 🔒 lockdown)

Standalone
- [x] PS-130 — ✅ **DONE** `2acba89e`. Cert hardened: 4 ACTIVE web/ owner checks added to the
      source-of-truth manifest (rate-proof lib, RateBrowserModal consumes backend bestRate +
      mustNotContain the divergent re-rank, no FE pickBestRate, OrdersView consumes backend
      best + completeness). 20 checks, 0 failures; forbidden-regex proven non-vacuous. Cert-only
      (no deploy). Residential anti-pattern already CLEAN (PS-127).

Epic PS-131 sequence (don't parallelize same file family)
- [x] PS-132 — Carrier-account registry + visibility/cadence/system constants (old 138+141). ✅ LIVE (header table).
- [x] PS-133 — Inventory effective-stock owner + analytics (old 136+147). ✅ **SoT DONE** (header table). NOTE: a later audit scored it 70% citing "missing" `getSkuOrdersReport`/`listInventoryLedger`/`getInventoryListEnrichment` — those names DO NOT exist; they label the analytics that is INLINE in `routes/inventory.ts` (sku-orders `GET /:id/sku-orders` ~678, ledger `GET /ledger` ~344, list-enrichment `GET /` decorator ~277). That block is guard-pinned (`test:ps-133-stock-math`) + InventoryView-byte-critical, and was consciously reclassified as a separate **live-data-gated decomposition** (tracked alongside PS-154), NOT PS-133 SoT scope. The SoT goal (single `computeEffectiveStockForIds` owner + all 5 consumers delegate) is fully met.
- [x] PS-134 — Billing ref-rate ETL + invoice SoT (old 140+139). ✅ 100% (header table; DJ live invoice $ confirm pending).
- [x] PS-135 — Canonical Rate Browser/Best Rate/proof/eligibility (old 132+133+134+142+143+148). ✅ 100% code (header table; PS-135a UPS residential test label pending).
- [x] PS-136 — 🔒 Fulfillment confirmation + external-shipped + labels (old 135+137+146 + 149 outbox/label). ✅ pushed ~90% (header table; deploy pending). Done under `unlock shipped data`.
- [x] PS-137 — 🔒(maybe) Orders list/export route decomposition (old 144). ✅ 100% SoT (header table; #8 row-mapper deliberately left inline).
- [x] PS-138 — Print Queue PDF rendering extraction only (old 145, narrowed). ✅ 100% (header table; local verified).
- [x] PS-139 — Final guard-aware dead-code sweep (old 149). ✅ 100% (header table; pushed).

Epic PS-131 audit children (PS-150–168)

> ▶ **FINAL STATUS for PS-150–168 is recorded in §7** (2026-06-09, LIVE on `6da46f16`): 6 shipped ·
> 3 closed-moot · 4 deferred-by-decision · 5 declined/out-of-scope. The checkboxes below are the
> ORIGINAL pre-execution audit list — §7 is the authoritative per-card outcome.

- [ ] PS-150 — Dashboard reorder-policy → backend. ACTIVE, after PS-133. ⚠ cites OLD 136/147 → PS-133.
- [ ] PS-151 — FE dead-code (apiClient+views). SUPERSEDED → fold into PS-159. ⚠ wrong: getBillingInvoiceUrl is USED.
- [ ] PS-152 — Delete OrdersLegacy.tsx. DONE/MOOT — file absent. Close (subsumed by PS-158).
- [ ] PS-153 — Schema cleanup. ACTIVE-PARTIAL: sync_meta/skuQtyDims/cancelOrder real; rb_markups/stores MOOT (files gone).
- [ ] PS-154 — Decompose Inventory/Dashboard views. ACTIVE, after PS-150.
- [ ] PS-155 — Decompose Settings/Billing/Packages views. ACTIVE (siblings may already exist untracked).
- [ ] PS-156 — Decompose CarrierIntegrationsCard. ACTIVE.
- [ ] PS-157 — Decompose RateBrowserModal+Table+v2Hooks. ACTIVE. ⚠ modal markup-recompute overlaps PS-135.
- [ ] PS-158 — Delete dead pages + Package modals. LARGELY MOOT — pages absent; PackageModal.tsx USED. Verify+close.
- [ ] PS-159 — Delete 16 dead apiClient methods + direct-carrier leaves. ACTIVE. Absorbs PS-151. ⚠ update 3 guard files.
- [ ] PS-160 — Delete src/shim/* + rb_markups. DONE/MOOT — files absent; TS2614 already gone. Confirm HANDOFF then close.
- [ ] PS-161 — Delete FE contexts/utils + src/lib exports. ACTIVE. utils/orders.ts 100% dead (safe).
- [ ] PS-162 — Prune obsolete scripts. ACTIVE. (verify-receive-fix.ts writes prod → delete, never run.)
- [ ] PS-163 — Collapse carrier_accounts CRUD into service. ACTIVE. ⚠ overlaps PS-132. Awaiting-only — keep scope.
- [ ] PS-164 — FE imports shared normalizers. VERIFY → likely MOOT (FE already imports shipping-options.ts).
- [ ] PS-165 — 🔒(display-only) Backend displayShipping tuple; collapse ~19 FE resolvers. ACTIVE.
- [ ] PS-166 — Deep OrdersView extraction (claims supersede 143/144). ACTIVE. ⚠ 143→PS-135, 144→PS-137 (§4).
- [ ] PS-167 — Split v2-apiClient into per-resource modules. ACTIVE, after PS-159.
- [ ] PS-168 — Backend primitive dedup (incl. main.ts route-registry; PS-128 added /webhooks to both lists). ACTIVE, low-pri.

## 4. Duplication & conflict report (per ticket — for posting back)

A. Stale numbering
- PS-130 cites "PS-132 (modal)/PS-133 (isComplete)" = OLD → now PS-135. Reword "after PS-127 + PS-135."
- PS-150 cites "PS-136/PS-147" = OLD → now PS-133.
- PS-151 cites "PS-130/132/142/149" = OLD mix → live owners PS-135 (fix) + PS-159 (delete) + PS-130 (guard).
- PS-157 cites "PS-132/134/142/143" = OLD → now PS-135 (+ PS-134).

B. True overlaps (coordinate or merge)
- PS-151 ⊂ PS-159 — PS-159 supersedes/extends it → MERGE into PS-159.
- PS-152 ⊂ PS-158 — both delete legacy pages; both MOOT (files absent) → CLOSE both.
- PS-153 ∩ PS-160 ∩ old-149 — rb_markups/shim consolidation; all MOOT → keep only PS-153 sync_meta/skuQtyDims/cancelOrder.
- PS-130 ∩ PS-135 ∩ PS-157 ∩ PS-159 — FE rate-truth cluster. Division: PS-135 fixes · PS-130 guards · PS-159 deletes dead · PS-157 decomposes. Don't duplicate deletes.
- PS-132 ∩ PS-163 — carrier_accounts: PS-132 builds the registry/resolver; PS-163 dedups CRUD handlers + rename backfill into it. Sequence PS-163 to consume PS-132; don't build two owners.
- PS-135 / PS-137 / PS-166 vs old 143/144 — old 143 (rate-proof lib) claimed by PS-135 AND PS-166; old 144 (orders GET) by PS-137 AND PS-166. Resolution: PS-135 owns the rate-proof lib; PS-137 owns the backend route; PS-166 owns the FE OrdersView.tsx and merely CONSUMES PS-135's lib. Drop "supersedes 143/144" from PS-166.
- PS-133 → PS-150 → PS-154 — dependency chain (owner → DTO → view), not a dup.
- PS-167 after PS-159 (don't migrate dead methods); PS-157 v2Hooks ≠ PS-167 v2-apiClient (distinct files).

C. Overlap with already-shipped PS-127/128/129
- PS-136 overlaps PS-128/129 (shipping-safety guard, webhook ledger/reconcile, externally_shipped, labels.ts confirmation). Re-scope PS-136 to the REMAINING fulfillment cleanup; do not re-architect what's live.
- PS-130/PS-135 residential threading already done by PS-127 (backend classifies + FE de-hardcoded) → mark that sub-item done.
- PS-138 vs PS-129: print-queue.ts now has merge-exclusion + listQueue hold; PS-138 extracts only draw* PDF helpers — rebase on current file.
- PS-168 route-registry: PS-128 added /webhooks to both main.ts lists — fold into the registry refactor.

## 5. Repo-verified corrections (cards wrong or already done)
- OrdersLegacy.tsx does NOT exist → PS-152 moot.
- The ~9 "dead duplicate pages" do NOT exist; live web/src/pages/* are auth/util, all route-mounted → PS-158 largely moot. PackageModal.tsx IS used → keep.
- src/shim/*, src/db/schema/rb-markups.ts, src/db/schema/stores.ts do NOT exist → PS-160 moot; TS2614 already resolved (typecheck green).
- getBillingInvoiceUrl is USED (BillingView) → PS-151 over-claims; keep it.
- ~~No hand-rolled confirmation/insurance alias maps in OrdersView/RateBrowserModal → PS-164 satisfied.~~ **CORRECTED 2026-06-10: WRONG.** Both files DO hand-roll their own maps and do NOT import the canonical normalizers; they diverge from canonical (insurance unknown→`carrier`/passthrough vs `none`). PS-164 is a money-path behavior change → DJ-gated (see §8).
- FE `combinedBestRate = combined[0]` not found → that PS-135 leak appears closed; the live FE rate leak is RateBrowserModal ~line 1457 `sort(rateDisplayTotal)[0]`.
- FE `residential: true` removed (OrdersView uses residentialForRate ×7; RateBrowserModal no hardcode) → PS-130 #1 / PS-135 residential green.
- CONFIRMED REAL: cert has 0 web/ owners + all mustNotContain empty (PS-130 valid); ps-079 inspects only OrdersView not RateBrowserModal (PS-130 valid); FE pickBestRate + dedupeRateResults/rateResultDedupeKey unused (PS-159/130 valid); utils/orders.ts fully dead (PS-161 valid); sync_meta dead (PS-153 valid); carrier_accounts rename SQL duplicated inline (PS-132/163 valid); inventory effective-stock fragmented across inventory.ts/admin.ts (PS-133 valid); billing ref-rate ETL inline (PS-134 valid); god-file sizes — OrdersView 12.3k, InventoryView 5.2k, v2-apiClient 4.8k, DashboardView 3.9k, routes/orders 3.6k, CarrierIntegrationsCard 3.6k, RateBrowserModal 2.8k, print-queue 2.4k (PS-154–157/166/167 valid).

## 6. Recommended consolidation actions (for DJ)
1. Close as done/moot: PS-152, PS-160; most of PS-158 (keep a verify pass); rb_markups half of PS-153.
2. Merge: PS-151 → PS-159.
3. Fix stale refs on PS-130, PS-150, PS-151, PS-157, PS-166 (old→new per §2).
4. Re-scope PS-136 around the live PS-128/129 work.
5. Verify-then-close PS-164.
6. Build order: 132→133→134→135→(130 guard)→136🔒→137→138→139; PS-150/154–168 alongside owners; PS-139 last.

---

## 7. PS-150–168 EXECUTION OUTCOMES — 2026-06-09 (LIVE on `6da46f16`, API + worker)
Scope run with DJ: **"SoT + safe cleanup."** 6 SHIPPED + deployed · 3 DEFERRED by explicit decision · Tier-0 closed.
Every item is RESOLVED (shipped or consciously deferred). Status to post per Trello card:

| Card | Status | Commit | Post-to-Trello note |
|---|---|---|---|
| PS-152 | ✅ CLOSE — moot | — | `OrdersLegacy.tsx` already absent (removed by PS-139). 0 refs. Close. |
| PS-160 | ✅ CLOSE — moot | — | `src/shim/*`, `rb-markups.ts`, `stores.ts` already absent. TS2614 long gone. Close. |
| PS-161 | ✅ CLOSE — moot | — | `StoreVisibilityContext`, `StoresContext`, `utils/orders.ts` already removed (PS-139). Close. |
| PS-158 | ✅ DONE | `79c09f20` | Deleted orphaned `PackageModal.tsx` (0 callers, −264) + resurrection guard. |
| PS-153 | ✅ DONE | `7e09f6b7` | Removed dead `cancelOrder?` interface method. RETAINED + documented + guarded `sku_qty_dims`/`sync_meta` (deleting them would arm a `DROP TABLE` — drizzle-kit auto-gen). |
| PS-159 (absorbs PS-151) | ✅ DONE | `c02c6c14` | Removed 19 dead apiClient object methods (−197) + guard. NOTE: `clearCachedReads`/`fetchDirectCarrierAccountRows` are LIVE module functions (bare-called) — kept. |
| PS-168 | ✅ DONE | `36ae3dca` | `normalizeScopeIds`×6 + `intArraySql`×7 (hash-identical) → one owner `src/lib/scope-sql.ts` + guard. `*ScopePredicate` left divergent (intentional). `msSince` dupe routed to route-timing (orders.ts left — locked). |
| PS-163 | ✅ DONE | `487b7deb` | Carrier label-rename backfill SQL → `credential-accounts` service owner; handler delegates; awaiting-only gate intact + guard. **DJ spot-check:** rename a carrier label → awaiting best-rate nickname updates. |
| PS-156 | ✅ DONE | `6da46f16` | `ModernCheckbox` + `ActionButton` → `web/src/components/ui/` (−205). **DJ spot-check:** Settings → Carrier Integrations renders identically. |
| PS-164 | ⏸ DEFER — decision | — | True canonical delegation = behavior change (FE 5-value allowlist vs canonical alias-superset; insurance unknown→carrier vs none). Not zero-change → left OrdersView/RateBrowser untouched. |
| PS-150 | ⏸ DEFER — business | — | FE Dashboard (velocity 14-day target) and backend (par-level `reorderLevel−stock`) use genuinely DIFFERENT reorder formulas. Reconciling = inventory-ordering decision, not a refactor. Needs DJ: pick canonical formula. |
| PS-167 | ⏸ DEFER — risk | — | apiClient split riskier than rated: 18 cross-method refs (circular-import), 2 `this.` refs, 67 shared helpers (cascade). Cosmetic-only on the customer-facing client. Same class as declined PS-166. |
| PS-162 | ⏸ DEFER — low value | — | Keep `verify-receive-fix.ts` (rollback-safe). Archive `migrate-supabase*.ts` only after confirming already-run. |
| PS-154 / PS-155 / PS-157 / PS-165 / PS-166 | ⏸ OUT OF SCOPE | — | Cosmetic FE decomposition. **PS-166 (OrdersView 12k) DECLINED** (risk≫reward, like PS-137 #8). Available as deliberate follow-ups. |

**Guards added (5):** `test:ps-158-dead-component`, `test:ps-153-dead-symbols`, `test:ps-159-apiclient-deadmethods`, `test:ps-168-scope-sql`, `test:ps-163-backfill-owner`.
**Net:** −666 lines dead code; 2 source-of-truth surfaces collapsed to single owners; 0 behavior change; 0 locked surfaces touched.
**Pending DJ:** PS-163 + PS-156 spot-checks (above) · PS-135a UPS residential test label (separate track).

---

## 8. Out-of-range / deferred tickets resolved — 2026-06-10 (PS-110, PS-119, PS-169, PS-162)
Outside the PS-130→168 scope this file was built for (plus PS-162 from the deferred set), recorded here
so the checklist stays the single source of truth. Scope: **safe fixes only** (zero production behavior
change, no shipped/cancelled surfaces). Local commits on `prepshipv4-stable` — push/deploy pending.

| Card | Status | Commit | Note + QA evidence |
|---|---|---|---|
| **PS-110** | ✅ DONE | `06545ec6` | Master runner: `test:master:audit` (read-only audit entrypoint) was auto-assigned to the `master`/`all-safe` profiles; the manifest guard requires `test:master*` runner commands ABSENT from default profiles (anti-recursion). Added it to `PROFILE_EXCLUDED_COMMANDS`. **QA:** `test:master:manifest` PASS; `test:master:audit` still runs standalone (exit 0). |
| **PS-119** | ✅ DONE | `53b1dcc1` | Reverted an unsafe "worker-active speedup" that gated the cached-negative live retry on `&& !workerBackfillActiveRef.current` — it persisted a NULL best-rate and stranded rows on terminal "Rate unavailable" (the exact PS-119 bug), recovering only via a worker-timing race. Restored the unconditional retry (removed condition + dead worker-status ref/effect) + strengthened the guard to pin it unconditional. Awaiting-order rate code (NOT the isReadOnly locked surface). **DJ decision:** "remove the optimization." **QA:** `typecheck` + `build:web` green; `test:ps-119-passive-best-rate-live-retry` PASS (19/19). |
| **PS-169** | ✅ DONE | `5b6b4252` | Docs-only. Added `## Backend-Owned Truth Without Backend Monoliths` to `ARCHITECTURE.md` (bad/good request-flow patterns, frontend responsibilities + forbidden authoritative decisions, backend layer split, anti-monolith rules, final-guard rule, frontend hotspot list, per-domain ownership matrix). No production code. **QA:** `git diff --check` clean; DoD grep strings present. |
| **PS-162** | ✅ DONE | `ec15b4b8` | Pruned 9 unreferenced scripts (−969 lines): 6 read-only probes + `verify-migration` + `smoke-shipstation-parity` + `verify-receive-fix.ts` (a prod inventory/ledger WRITE footgun, 0 callers — deleting it removes the footgun). Removed the stale `source-of-truth-guard` whitelist line. KEPT `secondary-order-detail-lazy-guard.mjs` (active npm script) + `verify-ground-saver-fix.ts` (guard-pinned). Resolves the §3-vs-§7 contradiction in favor of the card (delete verify-receive-fix). **QA:** `source-of-truth-guard` PASS (warning-only, unchanged); typecheck green; 0 functional refs remain. |

**PS-164 — INVESTIGATED 2026-06-10, confirmed DJ-gated (NOT safe to refactor).** Resolved the §5-vs-§7
contradiction: **§7 was right, §5 was wrong.** OrdersView (`normalizeConfirmationForRates`/
`normalizeInsuranceForRates` ~361-393) and RateBrowserModal (~141-146 + inline insurance ~1191) DO
hand-roll their own alias maps and do NOT import `normalizeConfirmation`/`normalizeInsurance` from
`shipping-options.ts`. They DIFFER from canonical: confirmation accepts only 5 values (canonical: 14 via
aliases → 9 silently downgraded to `none`); **insurance unknown → `carrier`** (OrdersView) / passthrough
(RateBrowser) vs canonical `none`. Delegating to canonical is therefore a **money-path behavior change**
(what insurance is charged), not a safe refactor → needs DJ approval + a live rate/insurance spot-check.
A safe partial (consolidate only the byte-identical confirmation normalizer shared by both FE files) is
available if a smaller win is wanted.

**Still deferred (need a DJ decision before any code):** PS-133 full analytics-service extraction
(byte-risky; see §3 PS-133 note) · PS-150 reorder formula (pick canonical) · PS-164 (money-path change,
above) · PS-167 apiClient split (risk) · PS-154/155/157/165/166 FE decompositions (PS-166 declined).
