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
| PS-167 | 🟡 SAFE-PARTIAL DONE | safe-partial | **Safe-partial shipped (DJ chose it over the full split 2026-06-11):** the ~1.4k-line helper/type/singleton LEAF extracted verbatim → `web/src/lib/v2-apiClient/shared.ts`; all 113 methods + the `apiClient` object stay in the barrel, which `export *`s shared so every importer is unchanged. Barrel 4,491→3,248 lines. Method region byte-identical (0 method changes); typecheck+build:web green; **0 guards regressed** (before/after exit-code matrix). Two text-blob-anchored helpers (`stableRateBrowseKey`, `parseDailyStatsSummary`) intentionally KEPT in the barrel so `recalculate-best-rate-strict`/`daily-strip-progress` stay anchored — pinned by `test:ps-167-apiclient-shared-extraction`. **STILL DEFERRED — the full per-resource METHOD split:** measured blast radius = **12 content-asserting guards** (incl. money: ps-124, recalculate-best-rate-strict, ps-099, ps-106) + the parity engine (`parity/extract.mjs`/`rules.mjs`) hardcodes this filename as a `_config` unit. Needs explicit money-guard-risk sign-off; not a "safe cosmetic" job. |
| PS-162 | ⏸ DEFER — low value | — | Keep `verify-receive-fix.ts` (rollback-safe). Archive `migrate-supabase*.ts` only after confirming already-run. |
| PS-154 / PS-155 / PS-157 / PS-165 / PS-166 | ⏸ OUT OF SCOPE | — | Cosmetic FE decomposition. **PS-166 (OrdersView 12k) DECLINED** (risk≫reward, like PS-137 #8). Available as deliberate follow-ups. |

**Guards added (5):** `test:ps-158-dead-component`, `test:ps-153-dead-symbols`, `test:ps-159-apiclient-deadmethods`, `test:ps-168-scope-sql`, `test:ps-163-backfill-owner`.
**Net:** −666 lines dead code; 2 source-of-truth surfaces collapsed to single owners; 0 behavior change; 0 locked surfaces touched.
**Pending DJ:** PS-163 + PS-156 spot-checks (above) · PS-135a UPS residential test label (separate track).

---

## 8. Out-of-range / deferred tickets resolved — 2026-06-10 (PS-110, PS-119, PS-169, PS-162, PS-150, PS-164)
Recorded here so the checklist stays the single source of truth. All SHIPPED (origin + mirror), DJ deploys
manually. No shipped/cancelled lockdown surfaces touched. Mostly behavior-preserving; the exceptions are
**PS-164** (DJ-approved insurance money-path change — needs a live spot-check) and **PS-150** (backend route
now velocity-based; UI display unchanged).

| Card | Status | Commit | Note + QA evidence |
|---|---|---|---|
| **PS-110** | ✅ DONE | `06545ec6` | Master runner: `test:master:audit` (read-only audit entrypoint) was auto-assigned to the `master`/`all-safe` profiles; the manifest guard requires `test:master*` runner commands ABSENT from default profiles (anti-recursion). Added it to `PROFILE_EXCLUDED_COMMANDS`. **QA:** `test:master:manifest` PASS; `test:master:audit` still runs standalone (exit 0). |
| **PS-119** | ✅ DONE | `53b1dcc1` | Reverted an unsafe "worker-active speedup" that gated the cached-negative live retry on `&& !workerBackfillActiveRef.current` — it persisted a NULL best-rate and stranded rows on terminal "Rate unavailable" (the exact PS-119 bug), recovering only via a worker-timing race. Restored the unconditional retry (removed condition + dead worker-status ref/effect) + strengthened the guard to pin it unconditional. Awaiting-order rate code (NOT the isReadOnly locked surface). **DJ decision:** "remove the optimization." **QA:** `typecheck` + `build:web` green; `test:ps-119-passive-best-rate-live-retry` PASS (19/19). |
| **PS-169** | ✅ DONE | `5b6b4252` | Docs-only. Added `## Backend-Owned Truth Without Backend Monoliths` to `ARCHITECTURE.md` (bad/good request-flow patterns, frontend responsibilities + forbidden authoritative decisions, backend layer split, anti-monolith rules, final-guard rule, frontend hotspot list, per-domain ownership matrix). No production code. **QA:** `git diff --check` clean; DoD grep strings present. |
| **PS-162** | ✅ DONE | `ec15b4b8` | Pruned 9 unreferenced scripts (−969 lines): 6 read-only probes + `verify-migration` + `smoke-shipstation-parity` + `verify-receive-fix.ts` (a prod inventory/ledger WRITE footgun, 0 callers — deleting it removes the footgun). Removed the stale `source-of-truth-guard` whitelist line. KEPT `secondary-order-detail-lazy-guard.mjs` (active npm script) + `verify-ground-saver-fix.ts` (guard-pinned). Resolves the §3-vs-§7 contradiction in favor of the card (delete verify-receive-fix). **QA:** `source-of-truth-guard` PASS (warning-only, unchanged); typecheck green; 0 functional refs remain. |
| **PS-150** | ✅ DONE | `9f5045f5` | Reorder policy → canonical owner `src/lib/inventory-reorder-policy.ts` (velocity model — DJ's chosen formula, = the current Dashboard FE compute → behavior-preserving display). DashboardView + the dashboard `/inventory-risk` route both delegate; removed the divergent par-level placeholder. Reporting-metrics deliberately NOT changed (feeds InventoryView — separate decision). **QA:** `test:ps-150-reorder-policy` 12/12; typecheck + build:web green. PUSHED. |
| **PS-164** | ✅ DONE | `ebdfc83b` | FE (OrdersView + RateBrowserModal) delegates confirmation/insurance normalization to canonical `src/lib/shipping-options`; hand-rolled alias maps removed. **DJ-approved money-path change:** unknown insurance provider → `none` (was `carrier`). Adversarially reviewed SAFE-TO-SHIP (label boundary re-normalizes via the same owner; no insurance silently dropped at purchase); fixed the one flagged UI defect (RB clamps confirmation to its 5 dropdown values). **QA:** `test:ps-164-fe-normalizer-delegation` 23/23; typecheck + build:web green. PUSHED. **NEEDS a live insurance spot-check after deploy** (quote each insurance option, confirm premium). |
| **PS-155** | 🟡 ~65% | `2cf93267`, `2f0c233f`, `5b7cf872`, `cd10a222` | **Done (4):** (1) PackagesView 3 modals → `packages-modals.tsx` (`2cf93267`). (2) SettingsView 6 helpers + accent tokens → `settings-ui.tsx` (`2f0c233f`). (3) SettingsView **Markups** → `MarkupsSection.tsx` (`5b7cf872`). (4) BillingView **SummaryTable** → `BillingSummaryTable.tsx` (totals parent-owned; `@ts-nocheck` to match the phantom-typed billing module; `cd10a222`). All verbatim JSX moves, behavior-preserving, typecheck+build:web green, PUSHED. **Remaining (3, all high-prop / HIGH-risk — do in a fresh focused session, confirm-before-push):** BillingView **Filters** (~27 props: generate controls + client filter; MED — build:web won't catch a parent-side prop typo on @ts-nocheck, so wire names exactly); BillingView **DetailTable** (HIGH: money cells via computeBillingDetailMetrics + the `↑SS` shipping badge, lockdown-sensitive); SettingsView **Automation** (20+ props incl. PS-057 HUGRAB carrier-protection — HIGH). [Carriers section = trivial 2-card delegation → skip.] Pattern: verbatim JSX → new component, all state/handlers/money owned by parent + passed as props; build:web + typecheck each; money/PS-057 cells byte-identical. |

**PS-165 — INVESTIGATED 2026-06-10, DEFERRED (clean backend-ownership blocked).** The per-status shipping
display is 12 FE resolvers in OrdersView (~1654-1913). carrier-code + service-code are pure DTO-field
cascades (backend-ownable, guaranteed parity), BUT every account-nickname + provider-id resolver ends in
`getV2CarrierAccountForOrder(order)` — a **frontend-only** lookup against the client-side scoped carrier
cache (`getScopedCarrierAccounts`) the serializer does not have. True backend-ownership of the account/
provider display therefore needs the orders serializer to JOIN carrier-account nickname data — a bigger
change with **parity risk on the shipped/cancelled display** (a surface under active testing). DJ chose to
DEFER to post-testing rather than risk it; the only fully-safe near-term version is cosmetic FE relocation,
which is itself deferred. Same risk class as PS-154/155/157/167.

**Deferred to a fresh focused session / post-testing (FE decomposition — DJ decision 2026-06-10).**
These are state-heavy / huge refactors on @ts-nocheck surfaces (no type-net, only build:web) with zero
functional value — best done with a clean context + own verification pass, not mid-long-session:
- **PS-155 (2/3 remaining):** BillingView SummaryTable/DetailTable/Filters + SettingsView Markups/Carriers/
  Automation — inline state-heavy JSX (extraction = new prop interfaces + state threading). PackagesView ✅ done.
- **PS-154:** InventoryView/DashboardView — same state-heavy kind; DashboardView helpers entangled with
  component-local types.
- **PS-157:** RateBrowserModal/Table/v2Hooks — also touches the rate/markup path (behavior-sensitive).
- **PS-167:** v2-apiClient barrel split — 127 methods + ~50 helpers; type-checked + barrel-viable but huge
  blast radius. Investigation map: see task notes / wfikx23uk.
- **PS-165:** displayShipping — blocked by the FE carrier registry (above).
- **PS-166 (OrdersView 12k) DECLINED.** · **PS-133 deep analytics extraction** still decision-gated (§3).

Recommended next-session order (safest→hardest): PS-155(rest) → PS-154 → PS-157 → PS-167. Each: one
unit per commit, build:web after every step, confirm-before-push on rate-adjacent ones.

**Still deferred (need a DJ decision before any code):** PS-133 full analytics-service extraction
(byte-risky; see §3 PS-133 note).

---

## 9. NEW follow-up tickets — HUGRAB insurance accuracy (PS-170, PS-171) — added 2026-06-10
Direct follow-ups to the HUGRAB insurance / Best-Rate work (PS-072 / PS-108 / PS-123 / PS-124 / PS-125)
and the 2026-06-10 rate-parity audit (PrepShip shows ALL-IN postage+ParcelGuard vs ShipStation's
postage-only display; ParcelGuard schedule today = USPS $1.09 / non-USPS $0.99 / intl $1.39 per $100,
calibrated to 31 labels). **Both are BACKEND-OWNED, rate/label-proof-safe, behavior-CHANGING (money) →
confirm-before-push + a live ShipStation read-only parity spot-check after deploy. Status: NOT STARTED.**
Branch `prepshipv4-stable`. Do NOT undo PS-072/108/123/124/125 rules. Every update starts `PS-170 update:`
/ `PS-171 update:` with Trello/branch/PR/files/capability-or-schedule summary/tests/blockers.

### PS-170 — Account-Capability HUGRAB Insurance Resolver: ParcelGuard vs Carrier $100  · P1
**Problem:** HUGRAB requires $100 declared coverage, but PrepShip blindly forces ParcelGuard on every
UPS/USPS candidate. The CORRECT provider depends on the ShipStation **carrier-account CAPABILITY**, not the
carrier code:
- ShipStation-native USPS/Stamps.com (`433542` stamps_com, "USPS Chase x7439") → **parcelguard $100** + ParcelGuard premium.
- ShipStation-native / walleted UPS (`433543` ups_walleted, "UPS by SS - Chase x7439") → **parcelguard $100** + premium.
- Direct UPS via ShipStation (`565326` GG6381, `565377` G19Y32, `596001` ORION, `604209` ROCEL, `607855` ROCEL C81F70) → may use **carrier declared value $100 with $0.00 add-on** (valid included coverage).
- UPS Ground Saver / SurePost → remain **BLOCKED** for HUGRAB insurance.

**Architecture-first:** the backend owns insurance-provider choice + premium enrichment + Best-Rate
comparison + selected-rate proof/fingerprint + label-purchase parity. The FE must NOT decide
ParcelGuard-vs-carrier (render backend state only). Centralize account/service capability — no scattered
nickname checks; a known-provider-id stopgap is OK only as a clearly-named backend **capability
registry/resolver** + tests + a TODO for DB-backed discovery.

**Canonical owner (likely):** new/extended resolver beside `src/services/shipping-workflow/insurance-cost.ts`
+ `src/lib/carrier-account-registry.ts`; consumed by `src/services/rates.ts` (Best-Rate compare) and
`src/services/labels.ts` + `src/lib/shipstation/labels.ts` (label parity). Inputs: providerAccountId/carrierId,
carrierCode, nickname/account metadata, serviceCode, client/store, insuredValue → output: allowed candidates
`{parcelguard | carrier | blocked | unknown-needs-probe}`.

**Critical rules:** a `$0` premium is VALID when capability proves coverage (direct-UPS carrier insurance);
null/missing/unresolved ≠ valid $0 (preserve PS-125 diagnosability). Unknown accounts must NOT silently buy
uninsured labels — probe valid candidates during rate-shopping when safe, or flag with diagnostics.
Best-Rate compares TRUE insured totals (base postage + provider fees + resolved premium) across eligible
candidates and persists the winning provider/value/premium/account/service into the proof; the label path
enforces the SAME provider+value (no carrier↔parcelguard swap without a fresh re-rate/proof).

**Guards:** capability resolver (USPS-native→parcelguard $100 · walleted-UPS→parcelguard $100 · direct-UPS→
carrier $100 @ $0 · GroundSaver/SurePost→blocked · non-HUGRAB operator-selected carrier insurance still
passes) · rate-selection (e.g. SS-UPS $9.00+$0.99=$9.99 vs ROCEL $9.20+$0.00=$9.20 → pick ROCEL $9.20) ·
selected-rate-proof/label-parity (direct-UPS carrier/$100/$0 and SS-native parcelguard/$100 both preserved
into the label payload; mismatched provider/value at purchase blocked or needs fresh proof). Keep
PS-072/108/124/125/126 + best-rate-saved-display + recalculate-best-rate-strict green; `typecheck`.

### PS-171 — Service-Aware ParcelGuard Premium Schedule (FedEx Ground Economy parity) · P1
Trello: https://trello.com/c/kxNo2gx7 · **Connected to PS-170** — extends the SAME canonical resolver/schedule;
do NOT build a competing insurance workflow.
**Problem:** the ParcelGuard schedule is too coarse (USPS $1.09 / non-USPS $0.99 / intl $1.39). FedEx
**Ground Economy Parcel Select** is a postal/economy service ShipStation bills at the **$1.09** tier, but
PrepShip applies the generic non-USPS **$0.99**. Evidence (HUGRAB #1440, FedEx One Balance — FedEx Ground
Economy Parcel Select, ZIP 92618-1791, residential, 2 lb 3 oz, 12×10×3, confirmation None, ParcelGuard
$100): PrepShip showed **$8.06 "Insurance incl. +$0.99"** vs ShipStation **$8.16** (ParcelGuard $100) → off
by exactly $0.10 ($1.09 vs $0.99).
**Fix:** make `parcelGuardScheduledPremium` (in `src/services/shipping-workflow/insurance-cost.ts`)
SERVICE-AWARE — classify by carrier **and serviceCode** (+ normalized aliases), not carrierCode alone.
`fedex_ground_economy_parcel_select` (+ variants) → **$1.09**. Keep USPS $1.09, normal non-USPS $0.99, intl
$1.39, and trust a positive ShipStation `insurance_amount` verbatim. Flow the corrected premium into
Best-Rate totals + Rate Browser display ("Insurance incl. +$1.09") + saved `best_rate_json`/proof; BUMP the
cache/fingerprint/schedule version so stale $0.99 FedEx-Economy cached rates invalidate. Don't let
post-purchase ParcelGuard backfill overwrite the fixed rate-time premium.
**Guards:** schedule (USPS $1.09 · standard non-USPS $0.99 · FedEx Ground Economy $1.09 · intl $1.39 ·
positive SS estimate wins) · rate-total (base $7.07 + $1.09 = $8.16, row shows +$1.09) · keep
PS-126/108/125/072 + best-rate-saved-display green; `typecheck`. **Do NOT** use a blanket "all FedEx = $1.09"
rule — service-specific only.

**Both — guardrails:** backend-owned (no FE decision); no uninsured HUGRAB labels; no Ground Saver/SurePost
re-enable; no proof/fingerprint weakening; no real labels/postage/marketplace notifications/shipped-cancelled
mutations/secret-or-PII exposure in tests; don't broadly rewrite RateBrowser/OrdersView (pass-through backend
fields only).

---

### §9 EXECUTION OUTCOMES — 2026-06-10 (committed local; awaiting push confirmation)

**PS-171 update:** Branch `prepshipv4-stable` · commit `ee9060ca` · 100% complete.
- Files: `src/services/shipping-workflow/insurance-cost.ts` (service-aware `parcelGuardPerHundred` via new
  `isPostalEconomyParcelGuardService` classifier — normalized contains-match on `groundeconomy`/`smartpost`
  across service_code/name/type; `RateLike` extended with service fields; `PARCELGUARD_SCHEDULE_VERSION` →
  `shipstation-parcelguard-2026-06-10-v2` busts stale $0.99 FedEx-economy cache), guards `ps-126` (FedEx
  Ground Economy/SmartPost/Walmart-FedEx → $1.09; normal FedEx Ground stays $0.99; $7.07+$1.09=$8.16 parity)
  + `ps-108` (fingerprint bumped).
- USPS $1.09 / non-USPS $0.99 / intl $1.39 / positive-SS-estimate-wins all unchanged. NOT a blanket "all
  FedEx = $1.09". Post-purchase backfill still reconciles to billed (only raises).
- Tests: typecheck + ps-126 (20/20) + ps-108 + ps-125 + ps-072 PASS.

**PS-170 update:** Branch `prepshipv4-stable` · 100% code complete · **carrier path SHIPPED DISABLED** behind
`DIRECT_UPS_CARRIER_INSURANCE_VERIFIED = false` (DJ "verify-first" decision).
- Capability owner: `src/lib/carrier-account-registry.ts` — `resolveAccountInsuranceCapability({providerId,
  carrierCode,serviceCode}) → {required: parcelguard|carrier|blocked, carrierPurchasable}` +
  `effectiveInsuranceProviderForAccount` + the verify-gate const. Direct `ups` → required `carrier`
  (purchasable ONLY when gate on); `ups_walleted`/`fedex*`/`stamps_com`/unknown → `parcelguard`; Ground
  Saver/SurePost → `blocked`.
- Single-owner forcing: `shipping-service-eligibility.ts` gains `resolveHugrabRequestInsurance` (request
  level) + makes `resolveEffectiveInsurance` (per-service) capability-aware; `src/services/rates.ts` DELETES
  its inline HUGRAB forcing duplicate and delegates. Per-candidate provider hook added to
  `enrichRatesWithInsuranceCost` (insurance-cost.ts) + a `carrier`→`carrier_declared_value` $0 branch in
  `resolveRateInsurancePremium`. Label path needs no builder change — it already passes the resolver's
  provider through, so it can never emit `carrier` while the gate is off.
- **Gate OFF ⇒ byte-identical runtime behavior:** every HUGRAB ground candidate + label resolves to
  ParcelGuard $100 (proven: NO `carrier`/`none`/uninsured path reachable). The hook only ever
  ParcelGuard→carrier-downgrades on a direct-UPS account once verified; operator-explicit `carrier`/
  `shipsurance` never overridden.
- **One disclosed correctness delta:** unifying onto the $100 floor means a sub-$100 operator selection on a
  HUGRAB order now PRICES at $100 (it already PURCHASED at $100 via the label) — fixes a latent
  display-vs-billed mismatch. (Rare in practice.)
- Guards: new `scripts/ps-170-account-capability-insurance-guard.ts` (49 checks: capability · verify-gate ·
  unified forcing · per-candidate gate-OFF=ParcelGuard / simulated gate-ON=carrier $0 cheapest-insured-wins ·
  label parity). Repaired pre-existing stale anchors: `ps-072` (source-regex → behavioral on the new owner),
  `ps-124` (end-anchor `fetchOrdersDailyCounts`→`fetchDashboardDailyCounts`, a prior rename had silently
  emptied the slice).
- Tests: typecheck + build:web + ps-057/072/079/083/102/108/123/124/125/126/170 + best-rate-saved-display +
  recalculate-best-rate-strict + batch-recalculate-best-rate ALL PASS (14 suites).
- **Live spot-check to enable the carrier path (separate, DJ):** read-only confirm a direct-UPS label with
  carrier declared value $100 is actually insured → flip `DIRECT_UPS_CARRIER_INSURANCE_VERIFIED = true` →
  re-run ps-170 → live verify ROCEL-type candidate wins at $0 add-on. Until then it stays ParcelGuard.

---

## 10. EPIC PS-172 — Backend-Owned Shipping Workflow (no monolith) + PS-173–190 track — added 2026-06-11

> Recorded from DJ/Hermes. **Planning + backlog only — none started.** PS-172 is an umbrella/planning
> card; PS-173–179 are its sequential execution children (work top-to-bottom). Full Codex specs live in
> Trello; this is the concise tracker. Principle: **"final guards own money safety"** → safer architecture,
> fast UI, less FE bloat, less backend overload, WITHOUT a backend monolith (thin composable services +
> thin UI callers).

### PS-172 — EPIC (umbrella/planning, NOT one implementation run)
Phased plan to move shipping/rates/labels/print-queue **safety** to backend-owned boundaries. Target:
OrdersView → fetch row DTOs + send operator intents · Rate Browser → display backend-classified rates +
apply backend `rateQuoteId`/`selectedRateKey` · Label/Print Queue → pass backend proof/quote IDs; backend
validates order state/carrier scope/selected rate/payload/side effects at purchase/queue time.
**Phase 0 deliverable:** an architecture audit + target-map doc under `docs/engineering/` or `docs/plans/`
(current call graph Awaiting→BestRate→RateBrowser→CreateLabel→PrintQueue, current owners, scattered owners,
side effects per stage, risk ranking) + child-card drafts + existing-card classification. NO behavior change.

### Phase children — execution track (do NOT start broad FE decomposition before backend DTO/proof/rate/label boundaries land)
- **PS-173 — ✅ DONE 2026-06-11 (Phase 1): backend order-row workflow DTO + action states.**
  EXTEND-NEVER-PARALLEL: the row workflow lives ON `BestRateWorkflowDto` via a pure enricher
  `withOrderRowWorkflow(dto, facts)` — no second workflow object. Adds (1) `rowState` with the full spec
  vocabulary (pending/final/blocked/needs_dims/stale_rate/missing_rate/external_shipped/local_shipped/
  missing_shipment_sync — cancelled/external/shipped trump rate states; dims gate before rates; rate
  lifecycle maps from the existing bestRateState AFTER the PS-120 pending override); (2) the six action
  verbs on `allowedActions` — **narrower-or-equal by construction** (canCreateLabel keeps fresh-only and
  can only get narrower; local_shipped may queue the EXISTING label/reprint but never create; blocked rows
  get nothing); (3) the `display` tuple (**PS-165b absorbed as classified**) — carrier/service/account/
  providerId computed from the SAME canonical picks the shipping model uses, byte-compatible with the
  PS-079 precedence (awaiting best-rate-first, shipped canonical-first, test pinned). Route enriches list
  rows from the canonical picks + PS-186 `testClientIds`; **additive guarantee guard-pinned**: legacy
  callers (/rates/browse) emit byte-identical output (no new keys). FE prefers the tuple behind existing
  fallbacks (`backendDisplayCarrierCode/ServiceCode` leading preference in resolveDisplay*). Shipped-bucket
  rows keep `bestRateWorkflow=null` (their intentional payload design) — shipped-row states wire in when a
  later phase revisits that; vocabulary + tests ready. Guard `test:ps-173-order-row-workflow` (26 checks).
  QA: typecheck + build:web + ps-102 + ps-196 + ps-165 + ps-120-producer + ps-099 + batch-recalculate +
  recalculate-strict + full cert ALL PASS. Local commit only.
- **PS-174 — ✅ DONE 2026-06-11 (Phase 2, consolidation): every backend-finalized best rate carries the
  quote ref.** Repo-verified: the phase's primitive was largely PRE-BUILT — PS-105 ships the snapshot store
  + opaque `rateQuoteId`/`selectedRateKey` per /browse rate, PS-198 makes the FE persist them through
  Apply, PS-183 adds the backend expiry; the recalculate path therefore already carries the ref via the
  browse→FE chain. **The remaining gap closed here:** the server-side `rates-backfill` persisted best rates
  WITHOUT the ref, so a reloaded "fresh" saved rate could not be snapshot-purchased until someone
  re-browsed. New single finalizer `finalizeBestRateWithQuote` in the snapshot store (reuses
  withSelectedRateKeys + storeRateQuoteSnapshot + selectedRateOpaqueKey; stamps the now-canonical
  `BACKEND_RATE_PROOF_SOURCE` constant; half-refs never invented); the backfill persists through it.
  Purchase enforcement UNCHANGED (legacy `selectedRateProof` fallback intact — enforcement is Phase 4).
  Guard `test:ps-174-quote-key-consolidation` (8 checks). QA: typecheck + build:web + ps-105 + ps-121 +
  ps-198 + ps-196 + full cert ALL PASS. Local commit only.
- **PS-175 — ✅ DONE 2026-06-12 (Phase 3 complete): strict recalculation is backend-owned end-to-end.**
  **Part 2 (2026-06-12):** the OUTCOME now persists server-side — /browse with `strictRecalculate: true` +
  an orderId writes the result inside the same request via `rates-recalculate-persist.ts` (separate io
  module so the decision module stays pure): refuses non-awaiting orders (the same shipped/cancelled lock
  the guarded routes enforce), blocked never writes, apply reuses the canonical `normalizeOrderBestRateDto`
  + the shipping-service eligibility re-check (PATCH-route parity), clear nulls rate+dims label, dims/weight
  persist on both apply and clear; order_overrides only — never orders/shipments. Response carries
  `persisted`/`reason`; the FE skips its own saveOrderDimsStrict/updateOrderBestRateSelectionStrict when
  `persisted: true` (both retained as the deploy-skew fallback). The Rate Browser's local-pick fallback
  removal stays with Phase 6 per the spec's own browser-tests-first rule. Guard extended to 23 checks. QA
  (part 2): typecheck + build:web + recalculate-strict + batch-recalculate + ps-123 + ps-197 + ps-198 +
  ps-105 + ps-082 + full cert ALL PASS.
  **PART 1 (2026-06-11): strict-recalculation DECISION backend-owned.**
  Repo-verified convergence already exists: all three rate paths (passive BestRate, Recalculate,
  RateBrowser) flow through ONE entrypoint (/rates/browse → getRates); the backend already owns
  eligibility/HUGRAB blocking/insurance capability+premium (PS-170/171 live IN the workflow, not UI
  patches)/ZIP+4/residential/confirmation/diagnostics; the Rate Browser consumes the canonical backend best
  (PS-135); every final rate carries the quote/key (PS-105/174/198). **Part 1 shipped here:** the strict
  apply/blocked/clear rule (any non-live carrier blocks; clean no-rate clears; only a clean live best with
  full identity applies) moved server-side — byte-compatible pure port in `src/services/rates-recalculate.ts`,
  computed on /browse when `strictRecalculate: true` and returned as `strictRecalculation`; the FE consumes
  the backend verdict (apply additionally requires a present best rate) and keeps its local
  planStrictBestRateRecalculate ONLY as a deploy-skew fallback. **Part 2 (next session):** move the strict
  persist orchestration server-side (the applier still drives saveOrderDimsStrict/
  updateOrderBestRateSelectionStrict — both already backend-validated endpoints) + remove the FE
  final-pick fallback in the Rate Browser (Phase 6 coordination). Guard `test:ps-175-strict-recalc-decision`
  (15 checks — the backend matrix mirrors the FE strict-guard fixtures: parity by fixtures, not trust). QA:
  typecheck + build:web + recalculate-strict + batch-recalculate + ps-123 + ps-197 + ps-198 + ps-105 + full
  cert ALL PASS. Local commit only.
- **PS-176 — 🟡 PARTS 1+2 DONE 2026-06-12 (Phase 4): routing policy backend-owned + localStorage purchase
  authority eliminated.** **Part 2:** the persisted queue job now carries IDENTIFIERS ONLY (orderId/
  orderNumber/clientId/orderStatus — the old snapshot persisted full bestRate/selectedRate/label money into
  localStorage and the resume loop REBUILT LABEL PURCHASES from it). Resume semantics now: backend-job-id
  jobs re-attach to the durable server job (unchanged); existing-labels jobs re-queue with the label URL
  re-read FRESH from the backend (no postage); interrupted batch-queue jobs WITHOUT a backend job id hand
  control back to the operator ("select them and Print to Queue again" — a fresh run with live data + full
  backend validation) instead of re-buying from stale local state. `resume NEVER buys` is guard-pinned (no
  createLabel call in the resume path). test-order-queue-label re-anchored 3→2 weight-fallback sites (the
  third path no longer purchases — a stronger guarantee than a fallback). **Part 3 (remaining):**
  payload-parity validation at purchase (needs a strictness decision — operator weight edits after rating
  are legitimate today). Guard `test:ps-176-queue-route-authority` now 17 checks. QA (part 2): typecheck +
  build:web + ps-053 + ps-104 + batch-send-proof-forwarding + ps-084 + test-order-queue-label + full cert
  ALL PASS. **LOCAL COMMITS ONLY — DJ inspects before push.**
  **PART 1 (2026-06-12): queue ROUTING policy backend-owned; validation chain
  repo-verified as already server-side.** Audit finding recorded: the spec's "validate immediately before
  side effects" list ALREADY runs in createLabelV2 (editable lock PS-190, PS-128/129 shipping safety,
  duplicate-label, PS-186 test policy, PS-105 selected-rate proof snapshot-first, PS-135a residential
  parity, service + carrier-family eligibility) and addToQueue is already idempotent — built across prior
  tickets, not re-implemented. **Part 1 shipped:** the direct-vs-backend ROUTING decision moved onto the
  row workflow DTO (`queueRoute`, computed by the same extend-never-parallel enricher from
  shipment/test/provider-id facts); the FE classifier consults it ONLY AFTER its LIVE never-buy ladder
  (operator options → test fact → existing-label fact), so a stale list-time value can never cause a
  postage re-buy (behaviorally guard-pinned). **Part 2 (next):** replace the FE localStorage
  shipping-recovery authority with backend job ids + payload-parity validation at purchase. Guard
  `test:ps-176-queue-route-authority` (12 checks: backend matrix, never-buy override matrix incl. stale
  direct-create vs live label/test, garbage falls through, wiring pins). QA: typecheck + build:web +
  ps-173 + ps-084 + ps-186 + print-queue-hygiene + batch-send-proof-forwarding + direct-carrier-queue-route
  + test-order-queue-label + full cert ALL PASS. **LOCAL COMMIT ONLY — DJ inspects before push (the
  Phase 4 discipline).**
- **PS-177 — ✅ COMPLETE 2026-06-12 (Phase 5, 3 parts): backend display models.**
  **PART 3 DONE 2026-06-12: backend-owned shipment dims/package DEFAULTS.** Audit finding: row-level
  effective dims/weight + source attribution were ALREADY backend-owned (canonicalOrder model +
  sourceMap, override-first); the real gap was the shipment panel's N-per-open /products/by-sku fetch
  loop + CLIENT-SIDE stacked-parcel derivation (max L/W, summed H×qty). Shipped: pure
  `order-dims-defaults-policy.ts` (exact FE parity incl. numeric-string parsing, all-lines-or-null),
  `order-dims-defaults.ts` io (shared `findProductDefaultsBySku` — products row first, Inventory
  completeness→global→recency fallback; /products/by-sku now delegates to it — plus
  `getOrderDimsDefaultsForOrder`: order_items→orders.items lines, single-SKU-only weight/package,
  best-effort null). Both detail handlers attach `dimsDefaults` (PS-037 comboPackageDefault pattern);
  the FE panel seeds from the payload (empty-fields-only rule unchanged) and keeps the fetch loop as
  deploy-skew fallback (Phase 6 deletes). Guard `test:ps-177-dims-defaults` (16 checks). QA:
  typecheck + build:web + combo-package-default + ps-060 + ps-082 + full cert ALL PASS.
  **PART 1 (2026-06-12): backend-derived Print Queue SKU identity.** The queue SKU
  identity (skuGroupId/primarySku/itemDescription/orderQty/multiSkuData) is now backend-derivable: pure
  `buildQueueSkuIdentityFromItems(orderId, items)` in print-queue-identity.ts mirrors the FE
  buildQueueAddPayload derivation exactly (filter adjustment lines → collapseIdentityLines →
  `${groupToken}:${qty}` sorted combo key → COMBO:/SKU:/ORDER: prefixes; no-SKU eBay lines KEPT as NOSKU
  title tokens — PS-070 parity holds since both sides call the same collapse). addToQueue now derives the
  identity from order_items whenever the caller's skuGroupId is absent or degraded (/^(ORDER:|order-)/ —
  exactly what the PS-176 identifier-only resume recovery sends as its minimal fallback), best-effort with
  caller values kept on any failure; a caller-sent REAL identity is kept verbatim (zero churn for existing
  flows). Guard `test:ps-177-queue-sku-identity` (10 checks: single→SKU:, multi→COMBO: order-insensitive,
  no-SKU kept, ORDER: fallback, adjustment filter, qty merge, degraded-only derivation, best-effort,
  both writes use resolved identity). QA: typecheck + build:web + print-queue-hygiene + ps-176 +
  test-order-queue-label + ps-052 + ps-109 + batch-names + ps-070 + full cert ALL PASS.
  **PART 2 DONE 2026-06-12: backend-owned row MONEY display.** Audit finding: the markup MATH lived
  twice — rates.ts applyMarkups (browse responses, already backend-applied with original_amount +
  markup attached) and web markups.ts applyCarrierMarkup (row Best Rate/Margin cells, applied
  CLIENT-SIDE from the FE-fetched settings map). Shipped: pure
  `shipping-workflow/rate-money.ts` owns parse (`markup.<pidOrCarrier>` normalization), the
  application math (percent/flat, cents rounding), the row rule lookup precedence (FE
  getCarrierMarkup parity: pid → carrierCode; awaiting rows look up by BEST-RATE identity, shipped
  canonical-first), insurance add-on extraction, and the assembled tuple
  {baseAmount, markedAmount, markupAmount, insuranceAddOn, marginPercent, source}. rates.ts
  delegates parse+math (behavior-identical, loadCarrierMarkups exported); /orders loads the SAME
  rules once per request (additive-safe try/catch) and passes money facts into
  withOrderRowWorkflow → DTO `money` (null for redacted viewers — canViewFinancials enforced in the
  DTO, no money key for legacy callers); FE Best Rate + Margin cells prefer DTO.money with
  applyCarrierMarkup retained ONLY as deploy-skew fallback (Phase 6 deletes). Scope note: shipped
  rows keep bestRateWorkflow=null by payload design, so shipped Selected Rate stays on the FE
  fallback until the shipped-row DTO phase. Guard `test:ps-177-row-money-display` (33 checks).
  QA: typecheck + build:web + ps-173 + ps-175 + ps-176 + ps-196 + ps-187-fixture + ps-183 +
  ps-123 + ps-135 + full cert ALL PASS. **Remaining parts:** effective package/dims/default
  source display. Read-model/additive throughout.
- **PS-178 — ✅ COMPLETE 2026-06-12 (Phase 6, 5 parts).**
  **FINAL PART: FE fallback deletions (gate released by DJ's live check).** Deleted from the FE:
  (a) ALL awaiting-row markup math — Best Rate cell, Margin cell, margin SORT comparator, and the
  side-panel rate price now read ONLY the backend DTO money tuple (a row without the tuple degrades
  to the plain carrier base / a dash — the FE never computes money policy); (b) the FE strict-recalc
  decision plan — planStrictBestRateRecalculate DELETED from OrdersView + orders-parity (+ its
  types); a /browse response without the backend strictRecalculation verdict is BLOCKED with an
  explicit retry message, never FE-decided; (c) the FE strict persist calls — saveOrderDimsStrict +
  updateOrderBestRateSelectionStrict calls deleted (backend persists inside /browse; FE updates
  display state only; the apiClient methods remain for PS-179's evidence-based dead-code pass);
  (d) the panel dims fallback — the per-SKU fetchProductsBySku loop + client-side stacking
  derivation deleted (backend dimsDefaults only; a payload without it leaves fields to the
  operator). RETAINED BY DESIGN (each documented in the ratchet): the SHIPPED Selected-Rate markup
  call (shipped rows carry bestRateWorkflow=null until the shipped-row DTO phase — ceiling 1), the
  display-resolver local cascades (shipped rows' only carrier/service path), the
  classifyQueueOrderRoute never-buy ladder + residual rule (live safety, drift-pinned by ps-176),
  and one fetchProductsBySku verification read (assertSavedProductDefaults — not dims policy).
  Ratchet ceilings lowered to the deleted state: markup 5→1, strict plan/persists →0, dims
  derivation →0, fetch loop →1. Guards updated to pin DELETION (never weakened):
  recalculate-best-rate-strict matrix retargeted to the canonical backend
  planStrictRecalculateDecision + a no-local-plan pin; ps-175 re-pins "local plan deleted" + "FE
  never persists"; ps-177 money re-pins "only the shipped call remains"; ps-177 dims re-pins
  "derivation deleted"; recalculate-all-live spinner count re-anchored to the merged cell branch.
  QA: typecheck + build:web + ps-175 + recalculate-best-rate-strict + ps-177×2 + ps-178 ratchet +
  recalculate-all-live + ps-196 + full cert ALL PASS.
  **PART 4: selection toolbar extraction.** renderSelectionToolbar's 156-line JSX body moved VERBATIM
  (line-range splice) to NEW render-only `OrdersSelectionToolbar.tsx` (15 typed props); a thin
  renderSelectionToolbar wrapper stays in OrdersView so the `{renderSelectionToolbar()}` call-site
  pin survives untouched. ZERO batch logic moved — selection state, busy flags, and every handler
  (handleBatchAction print/queue, handleBatchMarkAsShipped, queueExistingLabels, clearSelection)
  stay in OrdersView (batch-safety guards keep their single owner). Free-identifier scan: clean.
  OrdersView 11,727 → 11,593; ratchet ceiling lowered 11,800 → 11,650. Guard re-anchor: orders-ux
  toolbar-string pins (data-testid, Queue Existing Labels, Shipping actions disabled, cancelled
  review-only copy) → the component; the desktop batch-panel pins (handleBatchAction strings,
  Mark as Shipped) still pass against OrdersView unchanged. QA: typecheck + build:web + orders-ux +
  ratchet + full cert ALL PASS. **Remaining: final part — FE fallback deletions + ceiling lowering,
  GATED on DJ's live verification (Best Rate/Margin money, panel auto-fill, Recalculate All
  spinners, queue drawer) on prod.**
  **PART 3: Print Queue drawer extraction.** The 383-line drawer JSX block moved VERBATIM (line-range
  splice, not retyped) from OrdersView to NEW render-only `OrdersPrintQueueDrawer.tsx` (30 typed
  props). ZERO queue logic moved — all state, derived lists (groups/history/search), and handlers
  (hydrate/print/confirm/remove/clear/open-detail) stay in OrdersView and flow down as props, so the
  queue guards' behavior pins (client scope, clear gating, holds, history filter, delivered
  retirement) keep their single owner. Free-identifier scan on the new @ts-nocheck component:
  every referenced identifier resolves to a prop, an import, or a body-local — zero unresolved
  (the useAuth crash-class check). OrdersView 12,072 → 11,727; ratchet ceiling lowered
  12,150 → 11,800. Guard re-anchors (drawer-STRING pins → the component; queue-STATE pins stay on
  OrdersView, all documented in-file): test-order-queue-label ("Switch to Current client before
  clearing"), shipment-tracking-retirement (Delivered pill + auto_retired_at render; the history
  derivation pin stays on OrdersView), orders-ux ("Click Print All first" + Confirm Printed
  disabled-rule strings). One ratchet false-positive fixed at the source: a comment in
  orders-row-display named the FE markup fn and tripped the money-consumer allowlist — comment
  reworded, allowlist NOT widened. QA: typecheck + build:web + test-order-queue-label +
  shipment-tracking-retirement + orders-ux + print-queue-hygiene + ratchet + full cert ALL PASS.
  **PART 2: row-display reader extraction (first OrdersView decomposition slice).** 43 symbols moved
  VERBATIM from OrdersView to NEW `orders-row-display.tsx` (~370 lines): the DTO-reader primitives
  (toRecord/toStringValue/toNumberValue/toNumericValue/toProviderAccountId/formatMoney/
  normalizeShippingAccountName), the canonical-model readers (getCanonicalOrderModel/Record,
  getShippingModel/String/Number/ProviderAccountId, getCanonicalSource*/getLegacyClientIdForDisplay,
  getBestRateWorkflowModel), the pure carrier-account display lookups, the static
  V2_CARRIER_ACCOUNT_REFS registry + resolveV2CarrierAccount/getV2CarrierAccountForOrder (PS-185
  comments preserved), every getBestRate*/getSelectedRate* field reader, getAwaitingDisplay
  AccountNickname, getMarkupAmount/getBackendInsuranceAddOn/getBackendRowMoney (PS-177), and the 3
  stateless renderers (renderRateAmountWithMarkup/renderExtLabelBadge/renderMissingShipmentSyncBadge).
  Component-state/live-accounts/isTestOrder consumers (getShipAccountDisplay,
  getCarrierCodeForDisplay, date formatters, getQueueableLabelUrl) STAYED and import the readers —
  one-way dependency. Module is @ts-nocheck with documented reason (verbatim extraction from the
  @ts-nocheck source; strict-typing = its own later part, typing the DTO not the readers).
  OrdersView 12,430 → 12,072 lines; ratchet ceiling lowered 12,500 → 12,150 in the same PR.
  Guard re-anchors (same pins, new home, all documented in-file): batch-recalculate-best-rate
  (3 definition slices → rowDisplay + getShipAccountDisplay end-anchor → its new neighbor), ps-185
  (FE lookup/resolver pins → rowDisplay; the web/src-wide 1Z sweep already covers the new file),
  ps-184 (pass-through pin → rowDisplay), ps-173 (service-tuple consumer pin → rowDisplay; carrier
  consumer stayed). Leftover-definition sweep across all 43 names: clean (the @ts-nocheck crash-class
  check). QA: typecheck + build:web + all 4 re-anchored guards + ps-177×2 + recalculate-all-live +
  ps-176 + ps-196 + ratchet + full cert ALL PASS.
  **PART 1: FE-authority RATCHET + contracts CI-enforced.**
  **Part 1 shipped:** `test:ps-178-fe-authority-ratchet` pins a COUNT CEILING on every remaining
  FE-authority fallback site (OrdersView applyCarrierMarkup ≤5, planStrictBestRateRecalculate ≤1 +
  parity def ≤1, saveOrderDimsStrict ≤1, updateOrderBestRateSelectionStrict ≤2,
  resolveDisplayCarrier/ServiceCode ≤1 each, deriveShipmentDimsFromProductDefaults ≤2,
  fetchProductsBySku ≤2, classifyQueueOrderRoute ≤1), pins the money-math consumer file allowlist
  (exactly OrdersView + markups.ts — a new importer fails), pins pickBestRate at zero forever, and
  adds the decomposition ratchet (OrdersView ≤12,500 lines, lowered each extraction part). Counts may
  only go DOWN; deletions lower the ceiling in the same PR. ALSO: new cert checkpoint
  "PS-172 — Backend-owned truth contracts & FE-authority ratchet" in run-workflow-certification —
  ps-173/174/175/176/177×3/196/178 now run inside `test:workflow-suites`, so the full Phase 1–5
  contract gates CI/Render deploys; fallback deletions land under an enforced contract.
  **PS-167 full-split decision — deliberate non-extraction (task closed):** 29 guard scripts grep
  v2-apiClient.ts (text-blob pins on method bodies); the remaining barrel is already a thin
  transport adapter after the safe-partial shared.ts extraction. Splitting the method surface =
  29 re-anchors for a cosmetic decomposition — the PS-137 #8 standard ("minimize bugs > cosmetic
  decomposition") says leave it. Revisit only if a real SoT/test need arises in a module.
  **Remaining parts:** (2) extract OrdersView module-level row-display helpers → orders-row-display
  (needs closure analysis: helpers depend on OrdersView-internal primitives; batch-recalculate guard
  slices 2 definitions — re-anchor to the new file); (3) PrintQueueDrawer / BatchActions / toolbar
  component extractions (prop-threading surgery, one component per part, grep-after-delete
  discipline per the useAuth crash lesson); (4) FE fallback deletions + ceiling lowering — GATED on
  DJ verifying the live DTO contract (money cells + panel auto-fill + strict recalc on prod) and
  browser tests. QA (part 1): ratchet + typecheck + full cert (incl. new checkpoint) ALL PASS.
  Original scope: extract UI-only components + thin hooks (NO FE
  rate-finalization/proof/routing/money/queue-identity); remove FE fallbacks only after DTO contract
  + browser tests pass. Dep: PS-173–177 (all ✅).
- **Recalculate All live fan-out + visible progress — ✅ FIXED 2026-06-12 (DJ report: $13.00 UPS vs
  manual-browse $11.66 FedEx + no spinner).** Root causes: (a) the backfill's per-order getRates()
  served CACHED rate sets — a set cached while one carrier errored "recalculated" to a worse winner
  than manual Browse Rates; (b) rows with FRESH saved rates never received the PS-120 pending/rating
  override (the fresh-rate gate), and the FE only refetched rows when the job finished — zero visible
  activity. Fixes at the owners: rates-backfill `maxAgeHours === 0` (Recalculate All + Settings
  clear-and-refetch) now passes `getRates({forceRefresh:true})` — the SAME full live carrier fan-out
  manual Browse Rates forceLive uses (nightly/passive sweeps stay cache-allowed);
  order-rate-job-status: ACTIVE `rating` now overrides even a fresh rate (the worker is re-rating it
  NOW — operator must see it), queued `pending` still defers to fresh (leftover-stamp protection,
  ps-120 guard 2e preserved + 2e' added); OrdersView: Best Rate cell shows a watchdog-bounded
  spinner (PENDING_RATING_WATCHDOG_MS) beside the saved amount while re-rating (PS-196 value never
  wiped), and the Recalculate All poll refetches rows DURING the job (inflight-deduped) so each
  fresh best rate lands as its order resolves. Guard `test:recalculate-all-live` (6 checks). QA:
  recalculate-all-live + ps-120 (21 checks incl. new 2e') + ratchet + typecheck + build:web + full
  cert ALL PASS.
- **PS-179 — ✅ COMPLETE 2026-06-12 (Phase 7): certification closeout + evidence-based dead-code pass.**
  **Dead code deleted (evidence: zero member-access callers repo-wide + typecheck/build backstop):**
  apiClient.saveOrderDimsStrict + apiClient.updateOrderBestRateSelectionStrict (the FE strict persisters —
  last callers deleted in PS-178; added to the ps-159 REMOVED stays-deleted list) and
  orders-row-display.getMarkupAmount (last callers were the deleted FE margin math).
  recalculate-best-rate-strict's apiClient pins re-pointed to assert DELETION. Stale-anchor fix
  surfaced by the pass: ps-159's two LIVE_MODULE_FNS pins still read the barrel though PS-167 moved
  the helpers to shared.ts — re-anchored to read both (the guard isn't in the cert groups, so it had
  been silently failing since the extraction).
  **Workflow-cert coverage audit (the spec's flow → existing offline cert, no duplicate harness built):**
  Awaiting→rate: checkpoint A/O/E (rate-system-hardening, best-rate-dims, order-readiness-preflight) +
  the PS-172 contracts checkpoint (ps-173/174/175/196); RateBrowser: ps-135 re-rank + ps-123 display
  (cert via workflow suites); create-label mocked: fixture-label-smoke + direct-carrier-labels +
  test-order-queue-label; print-queue + job status: checkpoint G/H (durable/persistence/invalid-label/
  ownership/client-scope/diagnostics) + ps-176/177 queue contracts; blocked stale/dup/shipped-cancelled:
  order-editable-lockdown (checkpoint L) + ps-190 conflict codes + print-queue-hygiene decideShippingSafety
  pins. All run inside test:workflow-suites → CI-gates Render deploys.
  QA: typecheck + build:web + ps-159 + recalculate-best-rate-strict + ratchet + full cert ALL PASS.

- **Shipped-row DTO phase — ✅ COMPLETE 2026-06-12 (the closeout table's named exit for the last FE
  markup retention).** Shipped-bucket rows now carry the SAME workflow object
  (extend-never-parallel): built WITHOUT best-rate data (`buildBestRateWorkflowDto({savedBestRate:
  null, source:'none'})` — bestRatePick stays null, awaiting amounts never exposed), then the
  existing row enrichment contributes rowState (local_shipped/external_shipped/
  missing_shipment_sync — already in the enricher since PS-173), the canonical-first display tuple,
  queueRoute, and the money tuple priced from the SELECTED rate (already implemented in
  buildOrderRowMoneyDisplay since PS-177 part 2 — it was just never emitted). FE: the shipped
  Selected Rate cell reads the DTO tuple; THE LAST applyCarrierMarkup call is DELETED, along with
  useMarkups, the markups sorter param, and both effect deps — **OrdersView now contains ZERO
  markup math; the money-consumer allowlist is down to the defining module only.** A shipped row
  without the tuple degrades to the plain final label cost. Ratchet: markup ceiling 1 → 0;
  ps-177 money guard re-pins zero-markup + the shipped DTO emission. QA: typecheck + build:web +
  ps-177 + ps-178 ratchet + ps-173 + ps-176 + full cert ALL PASS. Remaining display-cascade
  deletion (resolveDisplayCarrier/ServiceCode local fallbacks) = next slice, after DJ eyeballs
  shipped-row money on prod.

- **PS-199 — ✅ CODE COMPLETE 2026-06-12 (live check pending): Walmart purchaseOrderId resolution
  ported to v4.** Walmart Shipping rates were broken for EVERY v4 order (connector requires a PO;
  the resolution chain lived only in legacy api/carriers/rates.ts:683-771 + labels.ts:606-720).
  Shipped: NEW canonical `src/services/walmart-po-resolution.ts` — faithful port of the full chain
  (① body PO → ② walmart- prefix strip → ③ store_orders cache lookup by external_order_id OR
  customer_order_id, recovering rawOrder + owning account → ④ live
  lookupWalmartOrderByCustomerOrderId), with TWO modes so quote and label can never diverge:
  'rates' (live = rescue only; misses surface the connector's clean error; the most-recent-row
  fallback ONLY without a real orderId — legacy Fix 1 no-borrow preserved) and 'labels' (money
  path, ready for PS-202: ALWAYS live-verifies when a customerOrderId candidate exists, replaces a
  stale cached PO on mismatch, THROWS on verification failure — never buys unverified; no demo
  fallback). Live hits upsert the store_orders cache (ON CONFLICT provider+external_order_id;
  skipped without account attribution — the column is NOT NULL). rawOrder usability
  (orderLines/postalAddress) + cache re-hydration ported. Wired into
  getDirectCarrierRatesForRateInput for walmart_shipping accounts: connector now receives the
  resolved PO + rawOrder; `purchaseOrderSource` stamped on the per-carrier meta (the Rate Browser
  modal already renders the badge — zero FE work). OWNERSHIP recorded in ARCHITECTURE.md: live
  Marketplace lookup owns the translation; store_orders is its cache (the stale legacy pull is
  not required for correctness). Legacy api/ endpoints deliberately untouched (PS-200/202 own
  their decommission). Guard `test:ps-199-walmart-po-resolution` (17 checks: priority order,
  no-borrow, labels strictness, hydration, wiring, ownership note, writes-only-cache safety).
  QA: typecheck + build:web + ps-032 connector boundary + full cert ALL PASS. **Acceptance
  remaining (live, DJ):** Browse Rates on a ShipStation-synced Walmart order (200014792308203
  style) returns Walmart rates with the source badge; walmart-* orders quote too.

- **PS-203 — ✅ COMPLETE 2026-06-12 (all 5 stages): "best rate" has ONE owner across the combined
  carrier universe.** **Stages 3–5:** NEW pure `src/services/rates-combined.ts` —
  `combineCarrierUniverses` owns the merge (dedupe), the SINGLE cheapest pick on the uniform
  CHARGE basis, the per-carrier statuses, and PS-111 completeness over the COMBINED universe;
  rateTotal + dedupeBrowseRates moved in (route imports back). UNIFORM MARKUPS:
  getDirectCarrierRatesForRateInput now passes direct rates through the SAME applyMarkups rules
  ShipStation rates get at read time (keyed by se-<pid>, original_amount preserved) — before this,
  /browse compared marked SS prices against raw direct prices. /browse delegates its inline
  merge/pick block to the owner (replacement-first; route keeps io + payload + PS-105/106/175/183
  concerns). BACKFILL (stage 4): delegates to the SAME owner — fetches direct rates
  (includeVisibleDirectCarriers + orderId for the PS-199 Walmart PO context), persists the COMBINED
  winner with combined fingerprint + combined completeness, and persists the RAW carrier amount
  (original_amount swap, markup fields stripped) so the PS-177 read-time money tuple never
  double-marks; a wholesale direct-fetch failure injects a synthetic failed diagnostic (never
  self-certifies SS-only). STAGE 5 boundary tests run against the pure owner in
  `test:ps-203-best-rate-universe` (19 checks): the production fixture $9.27 Shipp beats $10.44
  ORI; direct error ⇒ incomplete; charge-basis pick (raw-cheap/charge-expensive loses); + all
  stage-1/2 pins. Guard re-anchors (same pins, new home, documented): ps-124 (merge/pick →
  rates-combined), rate-system-hardening (source-tagged diagnostics → owner), ps-174 (backfill
  fingerprint → combinedRequestKey). QA: typecheck + build:web + ps-123 + ps-175 + ps-183 +
  ps-124 + ps-121 + rate-system-hardening + full cert ALL PASS.
  Symptom: saved BEST RATE $10.44 (ORI UPS Ground Saver) vs Rate Browser combined $9.27 (Shipp
  SurePost) — every persisting path compared a ShipStation-only universe and self-certified it
  complete. **Stage 1 (FE):** refreshPanelBestRate's browse call now sends
  `includeVisibleDirectCarriers: true` (the flag Recalculate + passive-live already send) — the
  panel-persisted winner is compared against direct carriers. **Stage 2 (BE):** /rates/cached/bulk
  completeness is now relative to the REQUIRED carrier universe: NEW
  `loadDirectCarrierVisibilityEvaluator()` in rates.ts (one account load per request, per-context
  closure over directCarrierVisibleForScope, failure degrades to legacy behavior); both exact and
  rough cache hits mark `requiredDirectCarriersUncovered` when the order scope has visible direct
  accounts the row never compared; cacheMetadata gates isComplete on it (+ observability field
  `requiredCarrierUniverse: 'missing-direct'`). The FE's passive fast-path already requires
  isComplete, so SS-only winners stop persisting for direct-carrier-scoped orders. Coverage check
  is stage-3-ready: a row COVERS direct carriers when its diagnostics carry synthetic se- ids
  ≥10,000,000 — stage 3's combined cache rows pass without touching the rule. Guard
  `test:ps-203-best-rate-universe` (8 checks). QA: typecheck + build:web + ps-196 + full cert ALL
  PASS. **Stages 3–5 remaining:** canonical `getCombinedRates` service (SS + direct, uniform
  markups on BOTH families, single pick, combined completeness + combined cache row; /browse
  delegates), backfill delegates + persists raw-amount DTO (kills double-markup), boundary tests
  at the owner ($9.27<$10.44 fixture, direct error ⇒ incomplete, charge-basis pick).

- **PS-202 — ✅ CODE COMPLETE 2026-06-12 (test-mode verification + live canary pending DJ): direct
  labels have ONE owner — v4 POST /labels.** Real postage for direct carrier-account rates (Shipp,
  Walmart Shipping, direct UPS, EasyPost — synthetic 10M+/20M+ ids) was being purchased on the
  LEGACY Vercel stack (forked auth verifier, separately-deployed money services, NO
  inventory/package deduction). Shipped: NEW `src/services/labels-direct.ts`
  (directLabelAccountRefFromProviderId 10M/20M mapping; loadDirectAccountForLabel with the PS-083
  assignment-scope assert + structured DIRECT_CARRIER_NOT_ASSIGNED; createDirectCarrierLabelForOrder
  porting the proven legacy connector input shapes — walmart_shipping gets the PS-199 LABELS-mode
  context (live-verified PO or throw), the orchestrator's $0 test-mode seam is reachable, a missing
  tracking number fails the purchase, and the connector result maps to CreatedExternalLabel with a
  local numeric shipment id + provider id preserved in labelId). createLabelV2 intercepts synthetic
  ids AFTER the PS-105 proof gate / PS-128-129 safety / residential parity and asserts the DIRECT
  carrier family (PS-106), then the SAME persist/markShipped/DEDUCTION/confirmation tail runs —
  closing the legacy deduction gap (direct labels now flow recordFulfillmentDeductions under
  INVENTORY_AUTO_DEDUCT, one owner). Shipments keep legacy source attribution
  (source='shipp'/'walmart_shipping'). Walmart confirmations get the live-verified PO + rawOrder +
  storeAccountId injected into the outbox payload — the PS-201 INVALID_REQUEST_CONTENT failure
  class for ShipStation-pulled orders is structurally closed. FE: apiClient.createLabel posts ONLY
  to v4 /labels (the Vercel branch deleted; PS-078's store-account protection moved to backend
  structure — non-label providers are rejected by the connector registry before postage; ps-078
  guard re-pinned to the new world with documented reasons). Legacy endpoint left alive for
  transition (PS-200 deletes it). Guard `test:ps-202-direct-label-owner` (12 checks). Noted
  follow-item: the PS-078 compatibility-matrix module still labels the endpoint 'carrier_vercel' —
  refresh its naming during PS-200. QA: typecheck + build:web + ps-202 + ps-078 +
  direct-carrier-labels + full cert ALL PASS. **Test-mode verification RUN 1 (2026-06-12,
  DJ-authorized; orders 1281639/40/41):** two findings. (1) The __carrierTestMode seam was never
  WIRED from createLabelV2's direct branch (the guard pinned the string, not the wiring) — fixed,
  double-gated, guard strengthened. (2) PS-186's test-label authority outranks the direct branch
  for is_test clients: every harness purchase produced a $0 MOCK shipment (cost 0.00, TEST
  tracking, /labels/mock/ URL, source test_offline, ZERO outbox rows, zero provider HTTP — DB
  evidence). That is a STRONGER money-safety invariant than planned: a test-client order
  physically cannot reach a real connector through v4. Consequence: the direct branch's connector
  mapping is untestable with a test client BY DESIGN, and the replay fixture store is EMPTY
  (capture never ran) — so the REMAINING PS-202 verification = the ONE live canary per carrier on
  a real order (DJ's separate approval), which doubles as the fixture-capture run (replay
  regression exists forever after). scripts/ps-202-test-mode-verification.ts re-anchored to assert
  the PS-186 reality (repeatable green check; each run leaves mock-shipped harness rows for the
  Stage-4 purge list — 3 added: 1281639/40/41).

- [~] **PS-200** — Decommission legacy Vercel api/ backend — 🔨 IN PROGRESS (parts 1+2 of 8,
  2026-06-12). **Part 1 (inventory)**: full endpoint→caller→v4-equivalent map + 8-surface cutover
  plan in `docs/ps-200-legacy-api-decommission.md`. Load-bearing findings: the two backends already
  share ONE service layer (api/carrier-accounts.ts imports src/services/credential-accounts; both
  verify shims re-export the same connector module) so cutover is deployment routing, not logic
  porting; v4 already mounts /carrier-accounts + /carriers/verify + rates-multi via
  src/lib/imported-handlers; that imported handler imports FROM api/_lib/safe-error so the _lib
  relocation (S6) must precede the api/ deletion (S8); fetchDirectCarrierRates (FE → POST
  /api/carriers/rates) is DEAD since PS-203 (zero callers); 25 guard scripts pin api/ sources and
  re-anchor per surface. **Part 2 (one-shot tools deleted)**: api/debug-env.ts, api/migrate-from.ts,
  api/admin/fix-marketplace-timestamps.ts — all self-labeled "remove after migration", zero callers;
  fix-marketplace-timestamps could UPDATE orders.order_date (incl. shipped rows) and double-shifts
  if re-run, so deleting it is lockdown-POSITIVE (a mutation path on shipped data is gone). Per user
  override unlock shipped data on 2026-06-12 (protection-strengthening deletion only; no
  shipped/cancelled data touched). raw-error-response-audit guard list trimmed with in-file note (an
  absent endpoint can't leak raw errors — intent preserved, not weakened). QA: raw-error-response
  (33 checks) + vercel-function-imports + typecheck PASS. **S1 (account-CRUD cutover, 2026-06-12)**:
  v4 /store-accounts route added (new imported handler mirroring the legacy function — synthetic
  store-client create/cascade, POST diagnostics, safe 500s) + mounted with
  requireCredentialAccountPermission; imported carrier-accounts handler drift re-synced (PATCH gate
  now accepts {credentials} Reconnect + {active} Hide/Show — the shared normalizer/service always
  supported both, only the early-400 gate blocked them on v4 — plus the incident-born POST shape
  diagnostics + post-insert JSONB verification); ALL account-CRUD FE call sites flipped
  callVercelFunction→api client (shared.ts account lists, useShippingAccounts raw fetch→api.get,
  PendingClientIntegrationsCard ×2, CarrierIntegrationsCard save/verify/delete/approve/rename/
  reconnect/setActive/assignments/lists ×9, dead callVercelFunction import dropped from
  v2-apiClient.ts). Remaining legacy FE calls = exactly the S2 set (walmart/ebay/fees pulls +
  carriers/rates probe). Auth note: v4 enforces credentials:read/write (admin/operator/warehouse
  flows covered; client_user appears nowhere in this FE; the SEPARATE portal app still posts to the
  legacy Vercel endpoint — S8 traffic check owns that cutover). Guards: credential-accounts guard
  extended to the new handler; frontend-auth-cache re-anchored (useShippingAccounts no longer holds
  auth code — negative getSession pin kept, positive pin would force auth code back in). QA:
  credential-accounts + raw-error-response + vercel-function-imports + ps-159 + ps-178 ratchet +
  ps-202 + ps-078 + typecheck + build:web + FULL shipping certification (78/78) PASS.
  **S2 (carrier ops cutover, 2026-06-12)**: v4 routes added under /carriers — walmart/orders +
  ebay/orders (verbatim imported-handler mirrors of the legacy pullers, same store_orders
  upsert/reconciliation wiring, settings:write), walmart/fees (thin route over the ALREADY-shared
  src/connectors/store/walmart-fees.ts logic, settings:write), and POST /carriers/rates (NEW
  carrier-rates-probe service: admin probe semantics — load account by id, no visibility filter, no
  markups, PS-199 'rates'-mode walmart PO settings-demo fallback, quoteCarrierRates raw prices,
  credentials:read). FE: 4 Settings call sites flipped (pull walmart/ebay orders, pull fees, test
  rates). DEAD-CODE DELETION: fetchDirectCarrierRates + its whole orphan chain
  (translateDirectRateToV2Shape, slugRateService, infer/normalizeCarrierCodeForDirectRate,
  directCarrierErrorMessage, DirectCarrierRatesResult/RateResult/RateMeta types — ~300 lines, zero
  callers since PS-203) removed from v2-apiClient/shared with tombstone; barrel import list trimmed.
  With that, callVercelFunction had ZERO callers → **web/src/lib/vercelFunction.ts DELETED — the FE
  no longer has ANY transport to the legacy Vercel functions** (S8's "no FE call path" acceptance is
  now structural). Also deleted: api/carriers/{validate-address, ups/probe, walmart/probe-carriers}
  .ts (zero-caller diagnostics; connector-side logic retained). Guard re-anchors (documented
  in-file, none weakened): ps-032 (route-side probe asserts gone with the routes; connector
  ownership pins kept), raw-error-response (3 deleted entries; 2 new imported-puller entries ADDED),
  frontend-auth-cache + frontend-failure-states (vercelFunction pins retargeted to the single api
  transport), ps-190 (one-transport note), marketplace-status-reconciliation (v4 puller mirrors
  ADDED to the reconciliation-wiring matrix). QA: all 7 touched guards + ps-159 + typecheck +
  build:web + FULL shipping certification PASS.
  **S3 (fees cron → v4 worker, 2026-06-12)**: runWalmartFeesTick added to sync-scheduler (shared pg
  client, 14-day window, totals telemetry via runHeavySchedulerJob/worker-status — ops-visible like
  every other job) and registered in BOTH scheduler paths (interval scheduler + pg-boss
  'prepship.fees.walmart-sync' with +9min stagger — the register-in-one-scheduler classic miss
  avoided). ENABLE_WALMART_FEES_SCHEDULER defaults TRUE (relocated live production behavior →
  kill-switch, not opt-in; documented vs the dark-rollout flags). vercel.json crons block REMOVED;
  api/cron/sync-walmart-fees.ts DELETED. Cadence: SYNC_CADENCE_MS.walmartFees = 24h (interval anchor
  resets on deploy — harmless, idempotent 14-day upsert window). Re-anchors: ps-032 fees-cron pin →
  scheduler tick (same connector-ownership intent, new home), raw-error + runtime-ddl list entries
  dropped with notes; walmart-fees connector header updated to the new consumer map. NOTE
  (pre-existing, NOT S3): test:runtime-ddl (audit profile, not in cert) was already failing at HEAD
  — 4 undocumented src DDL files (walmart-fees connector bootstrap, webhook-ledger,
  shipment-tracking, order-rate-job-status) + 2 stale api list entries; follow-up belongs to the
  master-audit track. QA: ps-032 + raw-error (31) + typecheck + FULL shipping certification PASS.
  **S6 (_lib relocation + store_orders Drizzle adoption, 2026-06-12)**: the src→api dependency is
  GONE. git-mv'd (history preserved): api/_lib/safe-error.ts → src/lib/safe-error.ts,
  store-orders-schema.ts → src/services/, marketplace-status-reconciliation.ts → src/services/,
  shipstation-awaiting-parity.ts → src/lib/ (script-only importers — no shim). api/_lib keeps
  .js-specifier compatibility re-export shims (the proven walmart-fees-sync pattern) so the legacy
  Vercel functions are untouched until S8 deletes them. Importer flips: 4 imported-handlers +
  credential-verification (kept .js — Vercel-walked) + 5 scripts (reconcile/backfill/guards).
  store_orders adopted into the v4 Drizzle schema (src/db/schema/store-orders.ts, READ/TYPE ONLY —
  columns mirror drizzle/0030 exactly, data never touched; registered in the schema index) — ONE
  schema owner exists; runtime readiness checking stays DDL-free in src/services. Guard re-anchors
  (documented): marketplace-status-reconciliation reads the src home; raw-error-response points at
  src/lib/safe-error + ADDS a shim-integrity pin. QA: typecheck + vercel-function-imports (103
  files walked through the shims) + raw-error (32) + reconciliation + awaiting-parity + ps-032 +
  credential-accounts + ps-205 + FULL certification PASS.
  **S4 (eBay OAuth, 2026-06-12)**: resolved WITHOUT the portal gate — eBay's token exchange uses
  the RuName (`DrprepperUSA-Drpreppe-Prepsh-qoumohks`), an eBay-side indirection whose record holds
  the actual accept URL. The callback is now ported to v4 (imported-handler mirror +
  src/routes/oauth.ts mounted PRE-JWT like /webhooks — the seller's browser arrives sessionless;
  the single-use keyset-bound eBay code is the auth). BOTH stacks serve it; the only human step:
  **eBay dev portal → User Tokens → RuName → set "auth accepted URL" to
  `https://prepshipv4-api-l5xc.onrender.com/oauth/ebay/callback`** (one field, anytime before S8;
  legacy stays live until then). SAME-DAY CATCH while reading the auth boundary: S1's
  /store-accounts route was missing from main.ts protectedPrefixes — requireAuth never ran, the
  permission middleware saw no auth vars, and EVERY /store-accounts call 403'd since the S1 deploy.
  Fixed (route was dark, not misbehaving — stores Settings list/save would have failed loudly).
  **PS-201 — ✅ CLOSED (read-only API check, 2026-06-12)**: all 5 May ship-confirm failures verified
  via the Walmart Marketplace API — every order shows **Delivered** with tracking EXACTLY matching
  our shipments rows (24399/129114065068060, 24256/119113695082845, 24252/119113695308811,
  24257/119113694548583, 24258/119113694642560 — co# in card). No Seller Center action required;
  no late-shipment exposure; confirmation_status stays 'failed' as historical truth per the card.
  **Quick looks (2026-06-12)**: PS-199 ✅ live-verified — awaiting order #200014759868070 resolved
  PO 129116451700091 via walmart_marketplace_api and walmart_shipping returned 2 real rates (USPS
  GA $9.79 / Priority $14.56, $0 spent). PS-205 ✅ — HUGRAB combo rows #1494/#1491 EFFECTIVE 31oz
  12x10x3 pkg 121 (source combo_default); #1493/#1492 carry LEGACY 35oz operator-field overrides
  (pre-PS-205 stamp) which the materializer correctly refuses to overwrite — DJ one-click fix: open
  any combo order → Save weights & dims as SKU defaults (the PS-060/121 apply re-stamps 31oz to
  both + re-rates). Ops tool: scripts/ops-ps201-ps199-ps205-check.ts (read-only; --apply gates the
  materializer backfill).
  **Remaining surfaces**: S5 labels+rates legacy deletion (DJ: live-order test), S8 final flip
  (vercel.json exclusions removed, api/ deleted, RuName flip confirmed, ps-200 guard + guard-fleet
  re-anchor).

- [x] **PS-206** — Rate Browser always fetches ALL scoped carriers — ✅ CODE COMPLETE 2026-06-12.
  Architecture placement: scoped-carrier COVERAGE is backend/DTO-owned — 'uncached' joined
  BestRateWorkflowCarrierStatusValue + CarrierRateDiagnosticStatus as the TERMINAL "no cached
  coverage, not checked, live required" state (≠ 'loading' in-flight, ≠ 'unavailable'
  checked-and-empty); rates-combined owns the rule (cached-only missing → 'uncached'; completeness
  REJECTS uncached) and the FE consumes coverage identity, never counts. Shipped: (1)
  `cachedCarrierCount <= 1` heuristic DELETED — browseRates returns {carriersWithRates,
  uncoveredPids} and the open flow live-fans-out whenever ANY scoped account is uncovered (full
  scoped fan-out per the card: correctness beats one extra request; cache paint stays instant);
  (2) cachedOnly honored across the WHOLE combined universe — getDirectCarrierRatesForRateInput
  gains {cachedOnly} and returns terminal 'uncached' diagnostics WITHOUT provider calls (the old
  path silently live-quoted direct carriers during every "instant cache paint"); (3) 'loading'
  resting state eliminated — combined owner emits 'uncached' not 'loading' for cached-only misses,
  FE cachedOnly branch matches, header in-flight derives ONLY from pendingPids, failed browse sets
  every scoped account to terminal 'error'; (4) per-carrier bounded quoting — pure
  withCarrierQuoteTimeout (25s) wraps each direct quote so one hung provider becomes that
  carrier's 'failed' diagnostic while the rest resolve; (5) misleading source ternary fixed
  ('cache'/'live'/'mixed' honestly; mixed = SS cache + live direct contribution); (6) sidebar
  renders 'uncached' as its own terminal badge (↻ "live check pending"). Proof fields
  (rateQuoteId/selectedRateKey/fingerprint) untouched. NEW guard
  test:ps-206-rate-browser-full-coverage (22 checks: coverage fixtures incl. 2-carriers-cached ≠
  complete, timeout behavior, end-to-end pins). QA: ps-206 + ps-203 + ps-124 + ps-196 +
  rate-browser click/table-sync + typecheck + build:web + FULL certification PASS. NOTE:
  test:selected-rate-proof-boundary fails on stable with the PRE-EXISTING stale count (verified at
  base a40489ad) — its re-anchor rides the PS-204 PR branch.

- [x] **PS-205** — Saved SKU/combo package defaults override imported weights/dims — ✅ CODE
  COMPLETE 2026-06-12. Architecture placement: precedence is a PURE backend policy
  (`package-facts-policy.ts`: override → combo_default → single_sku_default → imported-FALLBACK-ONLY;
  bundle semantics, no cross-rung field mixing; source honesty — an override equal to the current
  combo default reports 'combo_default', never a fake operator edit). THE structural fix:
  **import-time materialization** — `materializePackageFactsForImportedOrders` runs inside
  upsertNormalizedStoreOrders (the single persistence helper ALL order sources flow through), so a
  saved combo default lands in order_overrides the moment a matching order imports — and since
  EVERY reader (list row, panel, Rate Browser inputs, passive rating, Recalculate Selected/All,
  print-queue payloads, create-label) already resolves `overrides.rate_* ?? orders.*`, one write
  point closes every path; ShipStation re-importing 35oz can never out-rank the saved 31oz/12x10x3/
  pkg-121 again. Write scope: awaiting_shipment ONLY (lockdown gate), rows with ANY existing
  package-fact override skipped (operator edits + prior materializations sacred), live-label rows
  skipped via READ-ONLY shipments EXISTS probe, only override package-fact columns written,
  best-rate invalidation + pending stamp when a rate was saved off imported facts (mirrors the
  PS-060/121 save flow, which is untouched). NEW `resolveOrderPackageFacts(orderId)` DTO
  ({source, weightOz, dims, selectedPackageId, comboKey}) attached to BOTH detail handlers as
  `packageFacts` (additive, source-honest panel display). Single-SKU rung delegates to the existing
  qty-scoped dims-defaults owner; product-derived stacked dims sit BELOW explicit combo defaults by
  construction. Guards: NEW test:ps-205-package-facts-precedence (23 checks covering all 10 card
  proofs incl. HUGRAB 31-beats-35 fixture, qty/client scoping, shipped/labelled no-op, rate
  invalidation, reader-precedence pins); multi-sku-product-dims-rate-fallback guard RE-ANCHORED
  (was failing AT BASE since PS-177 moved the derivation backend — verified in a detached worktree
  at 5720445f; now pins the backend policy/resolver owners + the PS-205 precedence position, per
  the card's explicit instruction). QA: ps-205 + package-combo-key + combo-package-default + ps-060
  + ps-082-unshipped-only + single-sku-qty-scope + multi-sku re-anchored + recalculate-strict +
  batch-recalc + print-to-queue-proof + typecheck + build:web + FULL certification PASS.
  Remaining (DJ eyeball): one HUGRAB sibling order re-synced after deploy showing 31 oz everywhere.

### PS-172 — ✅ EPIC CLOSED 2026-06-12 (closeout table)

| Phase | Ticket | Outcome |
|---|---|---|
| 0 | PS-172 audit | Architecture audit doc; extend-never-parallel discipline set (ONE BestRateWorkflowDto) |
| 1 | PS-173 ✅ | Backend row workflow DTO: rowState (9 states) + action verbs + display tuple (PS-165b absorbed) |
| 2 | PS-174 ✅ | Rate-quote/key consolidation: backfill persists through finalizeBestRateWithQuote (proof chain) |
| 3 | PS-175 ✅ | Strict recalc decision (pure rates-recalculate) + persistence (rates-recalculate-persist) on /browse |
| 4 | PS-176 ✅ | queueRoute on the DTO; localStorage purchase authority eliminated (identifiers-only, resume never buys) |
| 5 | PS-177 ✅ | Backend display models ×3: queue SKU identity, row money tuple, dims/package defaults |
| 6 | PS-178 ✅ | FE-authority ratchet + contracts CI-gated; OrdersView decomposed (row-display readers, queue drawer, selection toolbar — 12,430→~11,400 lines); ALL awaiting FE fallbacks deleted |
| 7 | PS-179 ✅ | Cert coverage mapped to the offline workflow cert; evidence-based dead-code pass (strict persisters, getMarkupAmount) |

**What the frontend can no longer do:** pick best rates, apply markups to awaiting rows, decide or
persist strict recalcs, derive queue SKU identity, derive dims defaults, route queue purchases from
stale local state, or mint cache expiries — every one is a backend DTO field with a count-ceiling
ratchet (`test:ps-178-fe-authority-ratchet`) and the full contract runs in CI
(run-workflow-certification "PS-172" checkpoint) gating Render deploys.

**Deliberate retentions (each documented in the ratchet, with its exit ticket):** the SHIPPED
Selected-Rate markup call + display-resolver cascades (shipped rows carry bestRateWorkflow=null —
exits with the shipped-row DTO phase), classifyQueueOrderRoute's live never-buy ladder (permanent
safety), one fetchProductsBySku verification read, and the v2-apiClient barrel (PS-167 deliberate
non-extraction). **Out-of-epic follow-ups:** PS-187 part 2 (after DJ's test-order parity check),
direct-carrier tracking connectors, NewOrderModal defaultFromZip spec, PS-191–195 specs from DJ.

### Existing-card classification (to be finalized by the PS-172 plan doc)
- **PS-120 / PS-121** → coordinate w/ Phase 3 rate workflow; **keep (shipped).**
- **PS-170 / PS-171** → integrate into the Phase 3 backend rate workflow; **keep (shipped).**
- **PS-165** → backend tuple half (165b) likely **absorbed into Phase 1 (PS-173)**; FE-collapse half (165a) already shipped.
- **PS-166** → **superseded by Phase 6 (PS-178)** — do NOT decompose OrdersView standalone.
- **PS-167** → full method split **sequenced into Phase 6** (after backend contracts); safe-partial already shipped.
- **PS-154 / PS-155 / PS-157** → FE decomposition; **sequence after backend contracts (Phase 6)** per the no-broad-FE-decomp-first rule.

### PS-180–190 — board cleanup + OrdersView sweep findings (mostly independent · "No deps" unless noted)
- **PS-180 — ✅ DONE 2026-06-11 (Wave 1, repo-verified scope).** The card's claims were checked against
  THIS repo before "fixing": (a) **PS-127 guard** was NOT broken (it passes and asserts the literal's
  absence — the correct direction); strengthened it with the POSITIVE invariant the card asked for —
  `residentialForRate()` (OrdersView ~L5525) honors explicit source=false and defaults to residential
  (`return true` fallback) — guard PASS. (b) **PS-130 guard does not exist** in this repo (no file/npm
  script/content ref) — nothing to retarget. (c) **`src/shim/` is ABSENT**, no guard references it, and
  typecheck is clean (no TS2614) — the PS-139 claim doesn't reproduce. (b)+(c) likely came from an audit of
  a different snapshot/repo. (d) PS-164 closure: shipped `ebdfc83b` — the Trello board move is DJ's action.
- **PS-181 — ✅ DONE 2026-06-11 (Wave 2a): admin identity backend-owned.** The backend ALREADY served
  `GET /users/me → { id, email, isAdmin }` via the canonical `isAdminEmail` (src/lib/admin-emails.ts) —
  the FE just never used it. OrdersView's duplicate `ADMIN_EMAILS` set + client-side email comparison
  deleted; `callerIsAdmin` now loads from `/users/me` (accepts only `isAdmin === true`, defaults to
  non-admin until the backend answers; server-side route enforcement unchanged). `useAuth` import dropped
  (last consumer). Guard `test:ps-181-backend-admin-authority` (9 checks: recursive web/src sweep finds no
  ADMIN_EMAILS, OrdersView reads the backend verdict, /users/me stays on isAdminEmail, behavioral matrix on
  the canonical owner). QA: typecheck + build:web + guard PASS. Local commit only (DJ inspecting before push).
- **PS-182 — ✅ DONE 2026-06-11 (Wave 2a): no-op UI stubs removed.** Repo-verified: the 'Revert' button's
  onClick only toasted "Address reverted" — nothing was reverted and NO address-edit feature exists that
  could be reverted; the "Tax Information: 0 Tax IDs added" row (OrdersView panel AND OrderDetailDrawer)
  hardcoded a count over a tax-id concept that does not exist anywhere in the backend (plus an 'Add' stub
  toasting "Phase 3"). "Wire" was not an option for either (nothing to wire to) → both deleted with
  reintroduce-only-with-real-backend comments. Real controls survive (residential 'change' toggle,
  validation status row — guard-pinned). Guard `test:ps-182-dead-stub-ui` (5 checks, recursive web/src
  sweep). QA: typecheck + build:web + guard:site-actions PASS. Local commit only.
- **PS-183 — ✅ DONE 2026-06-11 (Wave 2b): rate freshness window backend-owned.** /rates/browse now stamps
  `cacheExpiresAt` (fetchedAt + the SAME `CACHE_TTL_MS` the rate cache itself enforces) on the response top
  level AND the best rate; both apiClient metadata blocks (browseRates + fetchRates) pass it through (never
  minted client-side); `withRateRequestMetadata` prefers the explicit metadata value, then the rate's
  backend-stamped expiry — the local now+6h mint survives ONLY as a warned, display-only last resort (a
  FE-minted window restarted the 6h clock at APPLY time instead of QUOTE time, making stale quotes look
  fresh). Purchase authority untouched: proof + the server-side snapshot TTL never read this field. ps-123's
  bestRateOut proximity window re-anchored 300→450 (assertion unchanged; my new lines sit inside the
  literal). Guard `test:ps-183-backend-cache-ttl` (9 checks). QA: typecheck + build:web + ps-196 + ps-198 +
  ps-123 + ps-105 + batch-recalculate + recalculate-strict + full cert ALL PASS. Local commit only.
- **PS-184 — ✅ DONE 2026-06-11 (Wave 2b): all FE legacy client-id remap tables deleted (more than the
  card knew about).** Repo-verified: the card said 2 tables in OrdersView; the recursive sweep found EIGHT
  maps across THREE files — OrdersView (by display name / store id / current id), AnalysisView (by store
  id / current id), and useOrders.ts (by name / store id / current id). All deleted. The backend already
  stamps `legacyClientId` on every list row AND detail payload via `resolveLegacyClientId`
  (src/routes/orders.ts canonical parity map) — the FE readers are now pure pass-throughs with a plain
  clientId fallback for pre-stamp rows (`getLegacyClientIdForDisplay`, AnalysisView `getDisplayClientId`,
  useOrders `resolvedLegacyClientId`). Guard `test:ps-184-legacy-client-id-passthrough` (5 checks incl.
  recursive web/src sweep + backend owner pins). QA: typecheck + build:web + full cert ALL PASS. Local
  commit only.
- **PS-185 — ✅ DONE 2026-06-11 (Wave 2b, repo-verified scope): FE 1Z attribution block deleted — the
  backend ALREADY owned it.** Sharper finding than the card: no "stamp at label-save + backfill" was needed —
  `resolveV2CarrierAccountRef` (src/routes/orders.ts) performs the IDENTICAL 1Z derivation (slice account
  number from tracking, match the registry, client/shared preference) at the DTO layer and its result feeds
  the canonical providerAccountId + account nickname on EVERY order's shipping model, which the FE lookup
  reads FIRST (`getShippingProviderAccountId(order) ?? ...`). The FE's duplicate block could only fire when
  the backend (same data, same registry) had already failed — pure drift risk, deleted; the FE resolver no
  longer takes a tracking number (display lookup of the backend-stamped id only). No shipment rows touched,
  no backfill required (read-side derivation covers historical rows on every request). Guard
  `test:ps-185-backend-1z-attribution` (5 checks: web/src sweep + backend owner pins + canonical-first read).
  QA: typecheck + build:web + full cert ALL PASS. Local commit only.
- **🔴 PS-186 — ✅ DONE 2026-06-11 (Wave 0): test-order classification → backend; reject untrusted
  `testLabel:true` in `createLabelV2`.** Canonical owner `src/services/fulfillment/test-label-policy.ts`
  (pure `decideTestLabel` + `TestLabelRejectedError` 409 + the single `loadClientIsTest`); createLabelV2
  resolves the flag through it BEFORE the mock branch (isTest client → forced mock as before; REAL client +
  requested mock → structured `TEST_LABEL_REJECTED` 409 — the silent fake-label path is closed); batch
  covered via delegation + structured failure codes; 3 inline isTest loads deduped. /orders rows + detail
  now carry backend-owned `isTest`; FE money paths (buildQueueSendOrderPayload / createOrQueueLabel /
  handleBatchAction / resumePersistentQueueJob / queue routing) read `isBackendTestOrder` (backend facts
  only) — the 7-heuristic `isTestOrder` is now DISPLAY-ONLY until PS-187 deletes it. Guard
  `test:ps-186-test-label-authority` (21 checks incl. the pure decision matrix). QA: typecheck + build:web +
  rate-system-hardening + ps-050-rate-exactness + test-order-queue-label + full cert suite ALL PASS.
  Original spec: FE `isTestOrder` (~L1163) uses 7 heuristics
  (orderNumber `TESTING-` prefix, client-name match, SKU sniff, hardcoded legacy client-IDs that override the
  backend value); when it fires the FE sends `testLabel:true` and `src/services/labels.ts:1080` honors it for
  **ANY** client → a REAL customer order matching a heuristic silently gets a **FAKE label + fake tracking**,
  fake rates persisted into the real `best_rate_json` column, and `assertLabelPurchaseRateSelection` bypassed.
  Fix: backend `client.isTest` authority; `createLabelV2` rejects `testLabel:true` unless
  `client.isTest===true` (→ `TEST_LABEL_REJECTED`); backend `isTestOrder(orderId)` from authoritative
  signals; delete the FE 7-signal heuristic, read `order.isTest`. **Sequence PS-187 AFTER this.**
- **PS-187 — 🟡 PART 1 DONE 2026-06-11 (Wave 2b, replacement-first): backend test-rate fixture is the
  canonical owner.** New pure module `src/services/test-rate-fixture.ts` — a FAITHFUL port of the FE
  generator (FNV-1a jitter, same 5 accounts × 3 service templates, same money formula — golden-cell
  guard-pinned, so fixture money for existing test orders is unchanged) — gated at the TOP of `getRates`
  on `clients.is_test` via the PS-186 `loadClientIsTest` authority. Fixture rates flow through the NORMAL
  pipeline (best-rate pick, /browse selectedRateKey + snapshot stamping, FE translation) with
  `testFixture:true`+`mocked:true` markers; never cached, no carrier API called; PS-186's test-label policy
  independently forces mock labels at purchase. **Part 2 (next PR, per the replacement-first rule): delete
  FE `buildTestRatesForShipment`/`buildTestMockRate` + collapse the OrdersView test-rate branches onto the
  normal backend flow once DJ verifies fixture parity live; `V2_CARRIER_ACCOUNT_REFS` deletion moves to
  PS-185 (its other consumer is the 1Z attribution block PS-185 deletes — repo-verified entanglement).**
  Guard `test:ps-187-backend-test-rate-fixture` (11 checks: determinism, seed sensitivity, 15-rate coverage,
  markers, golden money parity, gating before the live pipeline, never-cached). QA: typecheck +
  rate-system-hardening + ps-050-rate-exactness + ps-123 + ps-197 + ps-198 + full cert ALL PASS. Local
  commit only.
- **PS-188 — ✅ DONE 2026-06-11 (Wave 2a): rate-shop origin backend-owned, '90248' deleted from Views.**
  Repo-verified scope: the hardcode lived in rates-parity.ts (×2: buildLiveRatesPayload fallback + meta-label
  fallback) and RatesView's form default — the card's `orders-parity.ts:83` claim does NOT reproduce (no
  '90248' there). Sharper finding: /rates/browse never even reads the FE origin — the backend always quotes
  from the canonical `getDefaultShipFrom` (default Location row, env fallback), so the FE literal could
  silently disagree with the true quoting origin and the meta label displayed an origin that was never used.
  **Fix:** thin read `GET /locations/default-ship-from` → getDefaultShipFrom (same owner labels+rates use);
  RatesView seeds the origin field from it (never overwrites operator input; empty default); payload sends
  the operator value verbatim; meta label says 'default origin' instead of inventing a ZIP; LocationsView
  placeholder neutralized. Out of scope (documented): NewOrderModal's `defaultFromZip='90248'` param default
  (components/, not Views; feeds manual order creation — needs its own spec to change money behavior).
  Guard `test:ps-188-backend-origin-zip` (9 checks incl. recursive Views sweep + owner pin). QA: typecheck +
  build:web + ship-from-default-location + full cert ALL PASS. Local commit only.
- **PS-189 — ✅ DONE 2026-06-11 (Wave 2b): service catalog backend-owned + media-mail auto-default deleted.**
  Canonical catalog `src/lib/carrier-service-catalog.ts` (availability only — eligibility/permission stays
  with shipping-service-eligibility) served at `GET /carriers/service-catalog`; OrdersView fetches it
  (session-cached) and its `CARRIER_SERVICES` copy is deleted. **Compliance fix:** account switch no longer
  auto-defaults the FIRST service (which silently stamped restricted `usps_media_mail` on stamps_com) — it
  keeps the current service when the new account offers it, otherwise clears to '' forcing an explicit
  operator pick. Media mail remains LISTED (it exists on the account) but is never chosen by code. Guard
  `test:ps-189-backend-service-catalog` (9 checks incl. behavioral catalog import + no-auto-default pins).
  QA: typecheck + build:web + ps-051-shipping-options + rate-browser-dynamic-service-selection + full cert
  ALL PASS. Local commit only.
- **PS-190 — ✅ DONE 2026-06-11 (Wave 2a): structured label-conflict error codes.** createLabelV2 stamps
  `code: 'ORDER_NOT_EDITABLE'` (+ `{ orderStatus }` detail) on the shipped/cancelled conflict and
  `code: 'LABEL_EXISTS'` on the active-label conflict; routes/labels.ts returns `{ error, code, ...details }`
  at the SAME 400 status (legacy message-based mapping kept as fallback for older error shapes). Both FE
  transports now carry the body's `code` onto the thrown error (`ApiRequestError.code` in api.ts +
  `callVercelFunction`), and `isExistingLabelCreateConflict` branches on `error.code` only — zero substring
  conflict-detection left in web/src (recursive sweep). Deploy-skew safe: backend ships codes before/with the
  FE; messages unchanged. Guard `test:ps-190-label-conflict-codes` (9 checks). QA: typecheck + build:web +
  ps-186 + ps-084-direct-carrier-print-queue + test-order-queue-label + full cert ALL PASS. Local commit only.

> ⚠️ **PS-191 is referenced** ("PS-189/PS-190 → PS-191 depends on this") but its spec was not provided — define before sequencing.

### PS-196 / PS-197 — added + executed 2026-06-11 (DJ paused the wave track for these)
- **PS-196 — ✅ DONE: cache-first Awaiting Best Rate display after reload.** Root cause confirmed: ~29k
  awaiting orders have saved rates, but legacy rows lack requestFingerprint/isComplete/cacheExpiresAt →
  workflow classified them `unknown` and the FE display contract (orders-parity
  `savedBestRateCanDisplayForCurrentRequest`) rejected them → reload = spinners + stripped display rows +
  pointless passive live re-fetch. **Fix separates display from purchase authority at the canonical owner:**
  `BestRateWorkflowDto` gains display-only `savedRateDisplay: fresh|stale|saved_unproven|none`
  (best-rate-workflow-dto.ts — saved amount + carrier/service identity ⇒ displayable; legacy ⇒
  `saved_unproven`); `allowedActions`/proof asserts UNCHANGED (legacy still never purchase-authorized). FE:
  the display contract accepts the backend verdict (display only), the classifier renders `ready` for
  displayable stale/mismatched/unknown rows, and the single wiring point in OrdersView passes the verdict —
  which simultaneously fixes the display-order rate wipe, the spinner cells, the `--` render, AND makes the
  passive queue skip displayable rows (cache-first; explicit Recalculate still forces live). Guard
  `test:ps-196-cache-first-display` (23 checks: DTO matrix display-vs-purchase, FE verdict acceptance with
  strict no-verdict behavior preserved, classifier ready/calculating/terminal, cache-first source pins).
  Also re-anchored `batch-recalculate-best-rate` (stale since PS-165 part 2 inlined the provider-id local —
  behavior intact). QA: typecheck + build:web + ps-102 + best-rate-saved-display-contract + ps-099 +
  recalculate-strict + batch-recalculate + ps-119 + ps-120 + full cert ALL PASS.
- **PS-197 — ✅ DONE: Rate Browser shows the backend-effective HUGRAB insurance + parity diagnostics.**
  Root cause confirmed: the backend ALREADY owned + returned the effective policy
  (`GetRatesResult.effectiveInsuranceProvider/Value/Source`, PS-123/170) and the browse passthrough spread
  it to the FE — the modal just never displayed it, so "Insurance: None" + a label-safe insured total
  ($8.95) looked wrong next to ShipStation's manual no-insurance $7.93 (#1461 ROCEL UPS Ground). **Fix:**
  pure classifier `classifyEffectiveInsuranceDisplay` (orders-parity) → `effective_policy_diff` (the
  explainable mismatch) vs `matches_selection`; the modal captures the backend effective fields per browse
  + renders "Effective insurance: ParcelGuard $100 — HUGRAB default (backend policy — totals are
  label-safe)" under the dropdown (`data-rate-browser="effectiveInsurance"`), with a redacted quote-facts
  tooltip (ZIP+4 · oz · dims · residential · confirmation · cached/live — no PII/secrets). Policy NOT
  weakened: Ground Saver stays blocked, proof/fingerprint untouched (guard-pinned). Raw-manual vs
  label-safe dual-mode comparison = documented follow-up (the effective-policy visibility ships now). Guard
  `test:ps-197-effective-insurance-display` (22 checks incl. the full #1461 fixture: ParcelGuard/$100/
  hugrab-default, ZIP+4 92801-5567 exact, cache key ip/iv/r=1/w=350, Ground Saver blocked). QA: typecheck +
  build:web + ps-108/123/124/125/126/170/072 + best-rate-saved-display-contract + ps-196 +
  rate-browser-manual-selection-table-sync + full cert ALL PASS.
- **PS-197b — ✅ DONE (follow-up DJ requested 2026-06-11): per-account effective insurance + on-demand
  ShipStation manual-estimate comparison.** (1) The effective-insurance area is now ACCOUNT-AWARE: clicking
  USPS shows "ParcelGuard $100 (+$1.09)", clicking ORION/ROCEL shows "Carrier declared value $100 — free
  first $100" — derived by pure `classifyAccountEffectiveInsurance` from the backend-stamped per-rate
  fields (insuranceCost.provenance + insurance_amount); the Insurance dropdown (operator INTENT) is never
  auto-mutated (guard-pinned — mutating it would change real quotes for non-HUGRAB clients). (2) "Compare
  ShipStation manual estimate" button: one extra on-demand read-only quote with `rawManualEstimate`
  (resolveRateInput skips the HUGRAB forcing for the reference ONLY) returned as `manualEstimate` —
  structurally NON-PURCHASABLE end-to-end: route never stamps selection keys/snapshot/rate-quote id,
  apiClient translates without proof metadata, UI labels it "uninsured — not label-safe". Default selection
  stays label-safe. Guard extended to 36 checks. QA: typecheck + build:web + ps-072/108/123/124/125/126/
  170/196 + best-rate-saved-display-contract + recalculate-strict + table-sync + manifest + full cert ALL
  PASS (ps-123's payload-block anchor preserved by placing the baseline before the payload literal).
- **PS-198 — ✅ DONE (DJ requested 2026-06-11): Rate Browser quote proof preserved through Apply → Create
  Label / Print Queue.** Root cause confirmed exactly per ticket: /rates/browse stamps EVERY rate with the
  backend snapshot ref (rateQuoteId + selectedRateKey) and the legacy proof quartet, but two FE translations
  dropped them — `translateRateToV2Shape` rebuilt snake→camel without the two opaque ids (they survived only
  inside `raw`) and the modal's `toAppliedRate()`/`handleRateClick()` rebuilt the applied rate with
  display/money fields only — so the persisted `best_rate_json` had ALL proof fields null and a fresh apply
  was rejected at purchase with "Rate changed or expired". **Fix (pass-through restoration ONLY, no FE
  synthesis):** (1) `translateRateToV2Shape` carries rateQuoteId/selectedRateKey top-level (null when the
  backend issued none — manual estimate stays structurally non-purchasable); (2) modal `rateBackendProof(r)`
  lifts the six backend-issued fields in BOTH apply paths (manual click + canonical/seeded best);
  (3) `rateQuoteRefFromCandidates` accepts a candidate carrying BOTH opaque ids as a complete server-validated
  snapshot ref even when legacy proofSource/requestFingerprint were dropped (legacy fallback unchanged; {}
  when nothing backend-issued). `withRateRequestMetadata` already passed the ids through (guard-pinned now).
  Backend purchase boundary `assertLabelPurchaseRateSelection` UNTOUCHED (unchanged-or-stricter ✓); legacy
  proof-less rates still blocked. Guard `test:ps-198-rate-quote-proof-passthrough` (15 checks: ids-only ref,
  candidate order, half-ref fallback, no-synthesis pins, both apply spreads, translation pass-through,
  metadata non-strip). QA: typecheck + build:web + ps-094/095/104 + print-to-queue-proof +
  selected-rate-proof-boundary + batch-send-proof-forwarding + ps-098 + ps-079/123/135/196/197 +
  batch-recalculate + full cert ALL PASS. Pre-existing (NOT PS-198): ps-105's one OrdersView source pin
  (stale since PS-135 moved the helper to rate-proof.ts — 22/23 pass) and
  rate-browser-carrier-account-click (stale since PS-157 moved row markup into RateRowItem) fail identically
  at HEAD before this change.
>
> **Priority flags:** **PS-186** (fake-label-on-real-order) is a live money/integrity bug — recommend doing it
> BEFORE the PS-172 phase track. **PS-189** (media-mail auto-default) is a compliance risk. PS-181/182/183/
> 184/185/188/190 are small, independent backend-DTO-ownership fixes aligned with the PS-172 principle —
> good opportunistic wins. **PS-180** is pure board hygiene (no code risk).

### Tracking-driven print-queue retirement (delivered → History) — built 2026-06-11, DJ-requested (unnumbered)
- **🟡 BUILT, SHIPS DARK (env-gated):** when ShipStation v2 tracking confirms a package was DELIVERED, its
  print-queue entry automatically moves 'queued' → 'delivered' (leaves the active queue/count/Print-All,
  stays in History with an emerald "Delivered" pill + auto_retired_at date); the order side panel's Tracking
  strip shows "Delivered <date>" / "In transit" / "Tracking exception". **Architecture:** first
  implementation of the existing TrackingConnector interface (`src/connectors/tracking/shipstation.ts`, via
  the shared rate-limited ssRequest; 404/400 → 'unknown' = never retires); pure policy module
  `shipment-tracking-policy.ts` (DE/SP→delivered, AT=attempt→in_transit, return-to-sender prose detection,
  ≤160-char description truncation — events[]/raw NEVER persisted); canonical service
  `shipment-tracking.ts` (reads shipments — lockdown citation; new additive `shipment_tracking_status`
  table + drizzle/0042 + runtime ensure; candidates = queued entries only, excludes test clients +
  prepship_test, 45-day age cap, 12-min recheck, 240-check cap, 50/tick); print-queue owner's
  `retireDeliveredQueueEntries` (WHERE pins status='queued'; never touches 'printed'; never DELETEs —
  the no-op removeQueueEntriesForOrder policy still holds). Job registered in BOTH schedulers (interval +
  pg-boss 'prepship.tracking.poll', 15-min cadence, +7-min stagger). **Rollout:** ships with BOTH flags off →
  set `ENABLE_SHIPMENT_TRACKING_SCHEDULER=true` for observe-only (status fills, queue untouched; validate
  per-carrier coverage from worker telemetry) → set `TRACKING_AUTO_RETIRE_ENABLED=true` to go live;
  unsetting it is the instant kill-switch. **Follow-up:** direct-UPS/Shipp/Walmart tracking connectors on
  the same interface (the screenshotted 1ZC81F70… ROCEL label is direct UPS — v2 tracking may 404 → safe
  'unknown' until then). Guard `test:shipment-tracking-retirement` (29 checks: full retirement matrix,
  status-code mapping incl. AT≠delivered, truncation/no-raw pins, lockdown pins, both-scheduler pins,
  active-filter-unchanged pin). QA: typecheck + build:web + print-queue-hygiene + client-scope + ps-053 +
  ps-104 + ps-032 (connector classified + audit doc) + vercel-fn-esm-import-closure + full cert ALL PASS.
  Local commit only.

### PS-208 — Billing invoice ship-date calendar-day fix + Excel XLSX export (P1) — DONE 2026-06-12
- **✅ DONE (code + guards; live eyeball = DJ):** billing ship dates are now CALENDAR DAYS end-to-end — a
  row stored 2026-05-04T00:00:00Z renders "May 04, 2026" everywhere and a 05/01→05/31 selection includes
  exactly May. **Root causes fixed (SP6447 evidence):** (1) invoice SQL converted ship_date to
  America/Los_Angeles (UTC-midnight May 4 → May 3) and formatInvoiceDate's `new Date('2026-05-03')` + LA
  Intl re-shifted it (rendered May 02 = −2 days); (2) header dates were FE `T00:00:00.000Z` instants run
  through the same LA formatter (−1 day); (3) range bounds used California day coercion (07:00:00Z) which
  EXCLUDED every month's UTC-midnight first-day rows, while inclusive `<=` upper bounds leaked the next
  period's first day. **Architecture (canonical owner):** NEW `src/lib/time/billing-day.ts` —
  `billingDayOf` (leading-date extraction, accepts plain days + all legacy instant shapes), `billingDayRange`
  ({fromDay,toDay,fromUtc,toUtcExclusive} — upper bound EXCLUSIVE day-after midnight), `formatBillingDay`
  (component split, zero Date/timezone involvement). ALL billing endpoints (generate, status, summary,
  details, invoice, invoice.xlsx) normalize through it; `GenerateInput.dateTo` documented EXCLUSIVE; 9
  inclusive `<=` ship_date bounds flipped to `<` across services/billing.ts + routes/billing.ts +
  reporting-metrics.ts (incl. the generateLineItems period DELETE — `<=` there would have wiped the next
  month's first-day lines on every regenerate, and the billing_summary_metrics cache materializer);
  `billingShipDateSql` now `date_trunc('day', … at time zone 'UTC')`-normalizes source timestamps so every
  generated line lands on the UTC-midnight storage invariant; invoice ship_date extracted
  `at time zone 'UTC'`; invoiceQuery accepts plain YYYY-MM-DD; FE sends picked days VERBATIM
  (openBillingInvoice instant-coercion deleted). **XLSX export:** NEW `GET /billing/invoice.xlsx` consuming
  the SAME `billingInvoiceData` as the HTML invoice (structurally impossible to disagree — no query fork);
  exceljs (lazy-imported), Summary sheet (client/period/orders/per-category totals, $ numFmt) + Line Items
  sheet (one row per order mirroring the HTML table, REAL date cells via UTC-anchored Dates — exceljs
  serializes via pure epoch math so the day is machine-timezone-proof, frozen header, SUM formulas, bold
  totals row); attachment filename `invoice-<client>-<from>-<to>.xlsx`; FE 📊 Excel button next to 📄 Export
  (BillingSummaryTable) + `openBillingInvoiceXlsx` blob download. **Guards:**
  `test:ps-208-billing-calendar-day-invoice-xlsx` (behavioral matrix on the pure helpers — leading-date
  extraction incl. CA-day-end shape, exclusive-bound membership for the regression rows, month/year/leap
  rollovers, SP6447 display case — + source pins: no CA coercion in billing, no LA ship_date conversion, no
  inclusive upper bounds, strict DELETE, date_trunc UTC, no-query-fork ≥2 billingInvoiceData calls, frozen
  header/SUM/MIME pins, FE verbatim-days + Excel wiring, exceljs dep); `date-time-standard-guard`
  RE-ANCHORED (billing pins flipped from "must use coerceCaliforniaIsoDay" to "must use billingDayRange /
  must NOT CA-coerce / ship_date day extracted at UTC" — analytics/orders/inventory Pacific pins untouched);
  ps-069 diagnostic converted to billingDayRange. **QA:** typecheck + build:web + ps-208 guard +
  date-time-standard + billing-formula + billing-client-scope + billing-detail-ps040 + ps-134-ref-rates +
  ps-067-external-fulfilled + full shipping-roundtrip-certification ALL PASS. **Notes:** billing reads
  shipped orders only (no lockdown surface modified); existing billing_line_items rows generated under the
  old CA bounds keep their stored values — display is now faithful to storage; if DJ wants historical
  months re-priced under exact-day bounds, regenerating those months is the (DJ-approved-only) path per the
  card's no-production-regeneration guardrail. exceljs adds ~77 transitive packages (npm audit count moved —
  pre-existing tooling-dep advisories, none in the served bundle).

### PS-207 — Bill the box the shipment actually used; no SKU-default fallbacks, persistent review (P1) — DONE 2026-06-12
- **✅ CODE COMPLETE (deploy → "Update Billing" re-prices under the new policy; already-invoiced history
  untouched until DJ regenerates):** package_cost is priced from the SHIPMENT'S RECORDED BOX ONLY.
  **Deleted fallbacks (HKP audit root causes):** SKU-default/inventory package maps (packageIdFromItems +
  the inventory import — SP6755/6759 billed $0.00 off an unpriced SKU-default 8.5x8x2.5 the parcels never
  used), rounded-dims matching, rate-dims resolution, and precedence-picking when selected box ≠ shipment
  dims (SP6754 billed a 12x10x3 it never shipped in). **Architecture (canonical owner):** NEW pure
  zero-import `src/services/billing-box-policy.ts` — `resolveShippedPackageId` (operator directive →
  selected_package_id → selected_pid → exact-dims identity; both mismatch arms: dims→different package AND
  dims→custom-that-isn't-the-selected-box), `decidePackageCostLine` (gate on client having ≥1 box price;
  resolved+configured>0 → line with markup; operator override price = FINAL amount, no markup;
  resolved+unpriced/zero → free, no line no review; mismatch/unresolved → $0.00 `package_cost_missing`
  review line mirroring shipping_missing), `boxDimsKey` (identity, NOT rounding), `describeBoxReview`
  (stable text — participates in the unique key). selected_package_id outranks selected_pid because
  selected_pid is provider-account-contaminated on legacy rows (inventory/analysis key markup off it) — a
  collision + dims lands in MISMATCH review, never a silent wrong-box bill. Generator stamps the billed
  packageId on every line of the order so the Box Size column always shows the billed box.
  **Persistence:** NEW `billing_box_resolutions` (drizzle/0043, additive, RLS-no-policy, one row per order,
  runtime ensure in services/billing.ts) — regeneration deletes/recreates billing_line_items ONLY (guard
  pins zero deletes of resolutions); also fixes the old wipe-on-regeneration of manual box-line edits. The
  Edit Billing Detail PATCH detects DECISIONS by diff (modal submits everything): box change vs stamped
  box, price change vs current line — and a price equal to the chosen box's configured price is autofill →
  box stored WITHOUT pinning the price (future price changes still reflow); resolving deletes the order's
  review line immediately; resolved_by = operator email. **Dims⇄box coherence (B, mutable orders only):**
  `applyBoxDimsCoherence` in routes/orders.ts wired at PATCH /:id + /selected-package-id + /save-dims
  (NOT /selected-pid — that's the Ship Acct channel): selecting a known package persists its dims; complete
  dims exactly matching a package auto-select it; explicit package + explicit dims that disagree → 400
  `BOX_DIMS_MISMATCH`; custom dims never silently clear an existing selection (billing review is the
  cross-time net; PS-193 revisits panel auto-persist). FE: panel Size inputs run `lockstepPanelDims`
  (exact match selects the package in the dropdown; the Package dropdown already filled dims). **FE review
  flow (D):** billingDetails DTO carries `packageCostNeedsReview` + reason (the review line's description);
  billing-parity aggregation ORs the flag per order; Box Cost cell renders a clickable amber NEEDS REVIEW
  chip → opens the Edit modal, which shows an amber "Box needs review: <reason>" banner; resolution = pick
  box and/or type price + Save (no FE policy math anywhere). **Guard**
  `test:ps-207-shipped-box-billing-policy` (16-case resolver matrix incl. SP6754/SP6753 verbatim
  descriptions, provider-contamination, package-without-dims exception, unknown-code noise, operator wins,
  note-only ≠ directive + 8-case decision matrix incl. markup-on-configured / no-markup-on-override /
  zero-config-client-emits-NOTHING + source pins: banned fallbacks absent, no resolution deletes, ensure
  present, coherence at exactly 3 call sites and NOT /selected-pid, chip+modal+aggregation+lockstep wired,
  policy module stays zero-import). **READ-ONLY dry-run** (scripts/ps-207-hkp-box-resolution-dryrun.ts) on
  live HKP (client 3, 435 box prices, 0% markup), latest 40 shipped orders: 12x10x3 → $0.55 ✓, 11x9x6 →
  $0.74 ✓ (DJ's expected table), recurring customs (11.5x9x3/12x10x2/8.5x8x2.5) already exist as package
  rows → resolved-but-unpriced → free (price them to start billing); ZERO review storm in recent data; no
  writes. **QA:** typecheck + build:web + ps-207 guard + billing-formula + billing-detail-ps040 +
  billing-client-scope + billing-best-rate-ui:guard + ps-208 guard + date-time-standard + full cert ALL
  PASS. test:master:quick 16/20 — the 4 failures (carrier-enable-disable-label, awaiting-carrier-badge-
  nickname-fallback, ps-098, ps-103) fail IDENTICALLY at base e1c91793 via detached worktree = pre-existing
  stale pins, NOT PS-207 (candidates for a re-anchor pass). **Safety:** no production billing regeneration,
  invoice mutation, order/shipment mutation, postage, or marketplace notification occurred; migration is
  additive-only; lockdown untouched (order-save coherence applies to awaiting orders behind the unchanged
  assertOrderEditable guard).

### PS-191 — Auto-retry postage: structured retry-eligibility DTO; FE must not re-purchase without operator review — DONE 2026-06-13
- **✅ DONE:** Print-to-Queue can no longer silently re-purchase postage. **The bug:** on a proof failure
  the queue path regex-parsed the error MESSAGE (isSelectedRateProofError), re-rated with
  `promptForRetry: false`, and RE-FIRED the purchase with the refreshed proof — the operator could be
  charged a higher refreshed rate with zero awareness (Create+Print prompted; Print-to-Queue bypassed).
  **Backend (canonical owner):** `classifyLabelPurchaseRetry` in
  src/services/shipping-workflow/rate-fingerprint.ts (co-located with SelectedRateProofError) — derives
  `retryEligible`/`retryReason` STRUCTURALLY from the proof-error code + details.reason (guard pins the
  classifier body never reads `.message` or regexes). Eligible = reasons a rate refresh actually fixes
  (missing_selected_rate, missing_current_fingerprint, missing_fingerprint, fingerprint_mismatch,
  not_in_current_eligible_rates); NOT eligible = purchase_account_mismatch (all three PS-204 code
  spellings — refreshing the same selection just loops; operator must change the account/rate). Returned
  on BOTH purchase-failure surfaces: the labels route proof branch (which now also catches the
  DIRECT_CARRIER_ON_SHIPSTATION_PATH / SELECTED_RATE_ACCOUNT_MISMATCH codes as 400s instead of falling
  through toward 500) and the queue-send job's per-order results (+ durable snapshot samples).
  **FE:** ApiRequestError carries retryEligible/retryReason from error bodies;
  `isRetryEligibleRateFailure` is a STRUCTURAL field check (backend flag authoritative; code fallback
  only for deploy skew) — the message regexes are deleted from web/src entirely;
  sendOrdersToQueueBackend exposes `retryEligibleOrderIds` from backend results; the queue failure path
  now refreshes the rate and PROMPTS ("review it and click Print to Queue again" — same UX as
  Create+Print); the `promptForRetry` auto-continue plumbing is deleted (refreshStaleRateForOrder always
  prompts). **Guards:** NEW `test:ps-191-retry-eligibility` (classifier matrix: 5 eligible reasons, 3
  account-mismatch codes ineligible-with-reason, message-text-never-drives-eligibility incl. a poisoned
  Error message, LABEL_EXISTS-details-ignored, garbage reasons → null + source pins: no regex in
  classifier, DTO on both surfaces, regexes/auto-retry deleted from FE, prompt-only refresh);
  `print-to-queue-selected-rate-proof` guard RE-ANCHORED (its old pin literally certified the same-action
  auto-re-purchase — now pins the backend-verdict branch, the refresh-and-prompt, and the ABSENCE of the
  re-fire; override-forwarding + no-raw-toast pins unchanged). **QA:** typecheck + build:web + ps-191 +
  re-anchored print-to-queue proof guard + selected-rate-proof-boundary + batch-send-proof-forwarding +
  ps-204-account-binding + ps-202-direct-label-owner + full shipping-roundtrip-certification ALL PASS.
  **Acceptance:** no postage-error regex parsing in web/src ✓; Print-to-Queue retries require operator
  confirmation ✓; backend retryEligible on failure responses ✓; guards pass ✓. No postage purchased, no
  marketplace notifications, no order/shipment mutation.

### PS-194 — Confirm-Printed: backend persists successfulEntryIds; FE validates against the DTO — DONE 2026-06-13
- **✅ DONE:** the Confirm-Printed gate now runs on BACKEND TRUTH that survives a page refresh. **The
  bug:** runMergeJob computed `successfulEntryIds` (entries that actually merged into the batch PDF) and
  threw the array away after the count; the FE gated on a session-only useState Set seeded from the
  REQUESTED entry ids — a refresh wiped it (everything looked unconfirmable) and a mid-merge failure
  (held order, bad label URL) still got marked print-ready in-session. **Backend:** `MergeJob` carries
  `successfulEntryIds` (the live array is stamped onto the job at merge start, so progress snapshots and
  the done-persist serialize whatever has merged); `MergeJobSnapshot`/`toMergeSnapshot` persist it
  durably (capped 500 — batch max is 200; optional on the type for pre-PS-194 snapshots);
  `/print-queue/print/status/:jobId` returns `successful_entry_ids` on BOTH branches (in-memory +
  durable); NEW `GET /print-queue/print/last` returns the latest durable merge job (scope-checked via
  canViewMergeSnapshot) for refresh re-seeding. **FE:** merge-done seeding switched from the requested
  `entryIds` to `status.successful_entry_ids` (failed entries never get marked print-ready; requested-ids
  fallback only for deploy skew); a mount effect re-seeds the gate from `fetchQueuePrintLastJob()` —
  the existing pruning effect intersects with the live queue so confirmed/removed entries fall away;
  the pdfOpened gating stays (the PDF must have reached the operator). Gate shape unchanged: Confirm
  enabled only when every queued entry is print-ready. **Guard**
  `test:ps-194-confirm-printed-persistence`: job/snapshot/DTO persistence pins, /print/last + scope
  check, FE never seeds from requested ids, merge-done + refresh seeds read DTO fields, gate formula
  pinned. **QA:** typecheck + build:web + ps-194 guard + print-queue-hygiene + print-queue-client-scope +
  full shipping-roundtrip-certification ALL PASS. **Note:** multi-batch in-session unions still work (the
  Set accumulates across jobs); after refresh, the LAST job's ids re-seed (the durable layer keeps one
  last-run snapshot by design) — PS-195 (card still missing) builds on this.

### PS-193 — Write-path defaults ownership: dirty-flag gate on panel auto-persist — DONE 2026-06-13
- **✅ DONE (delta-audited first):** opening the order side panel can no longer mutate the DB without an
  operator action. **Delta audit vs the card** (its line refs predate PS-177/178): (1) the card's
  "deriveShipmentDimsFromProductDefaults auto-populates and saves" was ALREADY fixed by PS-178 — the FE
  derivation is deleted and dims suggestions are backend-owned by the PURE
  `order-dims-defaults-policy.ts` (returns the dimsDefaults DTO on the detail payload; zero db access —
  the card's "backend suggestion endpoint returns DTO without writing" acceptance was already satisfied);
  (2) the 450ms auto-package effect was STILL LIVE and ungated: on panel open with complete seeded dims
  it auto-matched or auto-CREATED a package row, persisted the order's selected package, and (saveSku:
  true) silently minted per-unit SKU PRODUCT DEFAULTS — the weight ÷ qty math at savePanelSkuDefaults —
  seeding FUTURE orders' rate inputs; (3) the 750ms auto-save effect was ungated past its last-saved-key
  check, so any programmatic post-open form fill (including the cascade from #2) persisted
  weight/dims/package with zero operator action. **Fix (surgical):** BOTH debounced effects now gate on
  `dimsUserEditedRef` — the existing operator-edit dirty flag (set only by the weight/dims/package input
  handlers, reset on order switch; the 700ms rate-refresh effect already used it); the auto-package path
  runs with `saveSku: false` — product-default minting (incl. per-unit weight) is reserved for the
  EXPLICIT Save-SKU-defaults action and the post-label-purchase followup. Suggestions stay visible in
  the form; rating and label purchase read LIVE form values, so unsaved suggestions still price and buy
  exactly as shown. **Guard** `test:ps-193-dirty-flag-auto-persist`: both effects pinned dirty-gated,
  saveSku:false pinned (saveSku:true forbidden in the auto effect), dirty-flag reset-on-order-switch +
  ≥6 input-handler setters pinned, FE derivation stays deleted (call-shape pin — the PS-178 comment
  names it), dims-policy module pinned pure (no db). **QA:** typecheck + build:web + ps-193 guard +
  single-sku-default-qty-scope + multi-sku-product-dims-rate-fallback + full
  shipping-roundtrip-certification ALL PASS. **Acceptance:** no unconditional auto-persist on panel
  open ✓; all dims/package writes require the dirty flag ✓; backend suggestion DTO exists without
  writing (PS-178, pinned) ✓; guard passes ✓.

### PS-216 — Rate Browser must not show provider IDs in carrier account names — DONE 2026-06-13
- **✅ DONE:** duplicate account nicknames now disambiguate with HUMAN labels — "GREG PAYABILITY 6/17
  (USPS)" / "(UPS)" — never "· se-442006". **Root cause:** formatSidebarAccountDisplay (added in the
  5f1c9f33 hardening, made fully visible by the 858e7315 no-clamp + PS-206 full-universe changes)
  appended `carrierId ?? directCarrierAccountId ?? shippingProviderId` to duplicate labels — right
  intent (disambiguate), wrong display fact (technical ids). **Canonical owner:** NEW pure
  `src/lib/carrier-family-label.ts` — `carrierFamilyDisplayLabel(code)` maps carrier codes to operator
  labels (stamps_com→USPS, ups/ups_walleted→UPS, fedex/fedex_walleted→FedEx, direct providers →
  provider names; unknown word-like codes prettify; ANYTHING id-like → null so an identifier can never
  become a "label"). The carriers-for-store read DTO (`getCarrierAccountsForRateContext`) stamps it as
  `display_disambiguator`; both FE normalizers carry it (`displayDisambiguator` — the direct-account
  normalizer reuses the existing DIRECT_ACCOUNT_PROVIDER_LABELS human map); the sidebar formatter
  consumes the DTO field with a same-shaped family-map fallback (deploy skew) and renders NO suffix when
  no human label is derivable. Rate rows already used suffix-free formatAccountDisplay ✓. No eligibility/
  scoping/proof/ranking changes — display/read-model only; PS-206 full scoped coverage untouched (guard
  re-run ✓). **Guard** `test:ps-216-rate-browser-account-labels`: behavioral matrix on the pure module
  (families, walleted variants, case-insensitivity, prettify, se-/numeric/synthetic → null) + source
  pins (DTO stamp, both normalizers, the formatter block references NO id fields, the old `· ${suffix}`
  template stays deleted, no-label → no-suffix, pure module stays zero-import). **QA:** typecheck +
  build:web + ps-216 guard + ps-206 full-coverage guard ALL PASS. Browser eyeball (HUGRAB sidebar shows
  "(USPS)"/"(UPS)") = DJ, next session.

### PS-212 — Dashboard Top SKUs must respect selected client filter — DONE 2026-06-13
- **✅ DONE:** selecting HUGRAB now scopes Top 5 SKUs, the Sales Performance Heatmap, the KPIs, AND the
  Daily Orders Trend together. **Root cause (data-flow, not missing plumbing):** the backend was already
  correct — /dashboard/top-skus and /dashboard/sku-trends accept clientId, pass it into
  getSkuBreakdownFromOrderItems / getSkuDailyFromOrderItems (whose SQL applies
  `o.client_id = cid` in every query), and key their analytics caches by client. The dashboard had TWO
  client filters: the canonical dashboard-wide `selectedClientId` and a chart-local `trendClientId`
  override on the Daily Orders Trend that — BY DESIGN ("scopes ONLY that chart... KPIs, SKU charts,
  inventory, and the table keep their own (global) scope") — re-fetched just the trend lines. DJ used
  the chart dropdown as "the dashboard filter": trend went HUGRAB, everything else silently stayed
  global. **Fix (intent unification):** the chart dropdown now drives `selectedClientId` — one filter,
  one already-scoped fetch pipeline. Deleted the trendClientId state, its mirror-guard, the dedicated
  3-request override fetch, and the trendDailyCounts/trendPriorDailyCounts/trendRevenueByDay states; the
  trend memo always renders the shared scoped data (counts + revenue from the same pipeline as the KPIs,
  so the panels can never disagree); the "All Clients" multi-line view gates on selectedClientId == null
  (same UX). Zero leftover references (grep-verified — the @ts-nocheck crash class). Heatmap correlates
  to the selected client automatically (it derives from the scoped sku-trends payload), per DJ's default
  expectation. KPI semantics untouched (all-orders vs fulfilled-only rules unchanged — only the client
  intent routing changed). One fewer fetch burst per client selection (the old override fired 3 extra
  requests). **Guard** `test:dashboard-client-sku-filter`: backend pins (route passes q.clientId into
  both SKU owners; ≥4 client-keyed cache keys; ≥5 client predicates in analysis SQL) + FE pins
  (trendClientId stays deleted; the trend dropdown reads/writes selectedClientId; all four dashboard
  fetches carry clientId: cid; load effect re-runs on selectedClientId; heatmap derives from the scoped
  payload; apiClient forwards clientId on both fetchers). **QA:** typecheck + build:web + ps-212 guard +
  daily-orders-trend-count + daily-orders-trend-total-line ALL PASS. Browser evidence (All Clients vs
  HUGRAB screenshot) = DJ's next dashboard look — the change is deterministic intent routing.

### PS-215 — Shipped rows show External Label or sync error, never raw Missing shipment sync — DONE 2026-06-13
- **✅ CODE DONE (one ops step = DJ/deploy):** the operator-facing Shipped table no longer rests on raw
  "Missing shipment sync". **Display model (canonical predicates unchanged):** local_label (normal
  render) / external_label (Ext. Label — PS-036 rule intact: ONLY from the persisted flag, never
  inferred from absence) / sync_error — the no-local-no-flag state now renders an ACTIONABLE amber
  "Shipment sync error" badge whose tooltip routes the operator (re-run ShipStation sync → external-
  shipped classifier → PS-215 runbook). The decision stays owned by the shared
  getIsExternallyFulfilled / getIsMissingShipmentSync predicates (the carrier column's
  shouldShowCarrierExtLabel wrapper included); orders-row-display's renderMissingShipmentSyncBadge →
  renderShipmentSyncErrorBadge; OrdersView panel copy updated to match. **Why rows were resting there
  (operational, per the card's investigation):** the PS-056 classifier is correct but NOT operational —
  ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER and ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY default false (the
  2026-06-12 dry run found 10 unflagged-external rows). **Ops layer added:** GET /health/ready + /deep now
  expose `externalShippedClassifier: {schedulerEnabled, autoApplyEnabled}` so a silently-disabled deploy
  is visible at a glance; NEW runbook docs/runbooks/ps-215-external-shipped-remediation.md (dry-run via
  certify:external-shipped → recoverable rows drain via sync/backfill → DJ-approved apply/flag-enable →
  verify zero; deploy checklist note). **Re-anchors:** the E2E orders-column-integrity spec literals (15
  sites) moved to the new badge text — its safety assertions are unchanged in MEANING (the no-flag
  fixture row must NOT render Ext. Label); ps-056-external-label-certification-guard's pinned regex
  re-anchored with the rationale; the OrdersView PS-056 comment updated. **Guard**
  `test:ps-215-shipped-display-state`: raw phrase banned as any rendered badge (comment-safe pins), new
  renderer + actionable tooltip pinned, external-before-fallback ordering pinned at all 3 columns,
  PS-036 predicate usage pinned, E2E asserts the new text AND still proves no-flag ≠ Ext. Label, /health
  exposes both flags, scheduler disabled-logging pinned, runbook content pinned. **QA:** typecheck +
  build:web + ps-215 guard + external-shipped-reconcile + ps-056-auto-external-shipped +
  ps-056-external-label-certification ALL PASS. **DJ/deploy action:** set the two env flags on Render per
  the runbook (scheduler=true; auto-apply=true when ready to flag the 10 known externals) — /health/deep
  confirms. Follow-up candidate (explicitly NOT bundled): per-row persisted classifier verdicts so the
  table can split recoverable vs lookup-failed visually; today both rest on the actionable sync-error
  badge and the classifier report distinguishes them.

### PS-195 — Explicit print-queue clear targeting — DONE 2026-06-13
- **✅ DONE (delta-audited; card mapped onto the real architecture and the gap reported):** the card
  prescribed a `DELETE /print-queue/jobs` gated on jobIds + successfulEntryIds — but there is NO deletable
  jobs store (merge jobs live in-memory with a single durable last-run settings snapshot; they expire,
  they aren't cleared). The REAL clear surface was `POST /print-queue/clear` → blanket-deleting EVERY
  queued ENTRY for the client: no per-entry targeting, and nothing protected entries sitting inside a
  pending/RUNNING merge job (operator A printing, operator B clears → labels yanked mid-merge).
  **Implementation (card intent, real surface):** the clear schema now REQUIRES
  `queue_entry_ids[] (min 1, max 500)` — id-less blanket clears are schema-rejected; `clearQueue` takes
  explicit ids and deletes ONLY `id = ANY(ids) AND status='queued'` within client/store scope
  (printed/delivered untouchable, scope predicate intact); the PS-194 merge-job record now carries its
  `entryIds`, and `inFlightMergeEntryIds()` refuses (and reports as `blocked_in_flight`) any targeted
  entry inside a pending/running merge. FE: the drawer's Clear names exactly the LISTED entries
  (`queuedEntries.map(queue_entry_id)`), the confirm dialog states the count, and an in-flight refusal
  surfaces as an info toast; `apiClient.clearQueue(clientId, entryIds)`. The typed
  `REMOVE_UNPRINTED_LABELS` confirmation literal stays. **Guard** `test:ps-195-clear-targeting`: schema
  requires ids; route passes them + reports blocked_in_flight; service pins (inArray-bounded, queued-only,
  scope predicate, empty-list-clears-nothing, in-flight set covers pending+running, MergeJob.entryIds
  recorded at start); FE pins (drawer passes the listed ids — no blanket; apiClient sends them; refusal
  surfaced). **QA:** typecheck + build:web + ps-195 + ps-194 + print-queue-hygiene +
  print-queue-client-scope ALL PASS. **Acceptance mapping:** "clear endpoint requires explicit IDs" ✓;
  "backend refuses in-flight" ✓ (running-merge membership — the live equivalent of the card's
  successfulEntryIds-empty test, reported explicitly as a card-vs-reality delta); "FE passes explicit
  IDs on every clear" ✓; guard ✓.

### PS-209 — Shipping architecture audit + first safe slice — DONE 2026-06-13 (audit + slice 1 of the track)
- **✅ AUDIT DELIVERED** (docs/engineering/ps-209-shipping-architecture-audit.md — owner maps for label
  purchase / direct marketplace import / confirmation lifecycle / print queue / confirm-printed, with
  risk ranking + follow-up cards): the headline finding is that the legacy Vercel
  `api/carriers/labels.ts` was still **REACHABLE in production** — vercel.json's rewrite exclusions keep
  `/api/carriers/*` served locally, so a complete SECOND purchase pipeline (own JWT verify, connector
  calls, persistence, outbox kick) sat live even though PS-202 moved every caller to v4 (no current
  caller — but any stale tab/script could buy postage through it). Also confirmed read-only for PS-192:
  `mark-shipped-externally.ts` hardcodes `ssMarkOrderShippedV1`, bypassing the outbox resolver — ranked
  HIGH, fix stays blocked on DJ's unlock phrase. **✅ FIRST SLICE (Option 2):** the legacy endpoint is
  now a **no-import 410 stub** (`LEGACY_LABEL_ENDPOINT_RETIRED`, operator-actionable message) — zero
  purchase capability remains in the module, trivially reversible, and the full api/ deletion stays
  PS-200 S5/S8 behind DJ's live order test. The misleading PS-078 comment in v2-apiClient/shared.ts
  ("buys via the Vercel /carriers/labels function") corrected to the post-PS-202 reality. **Guard**
  `test:ps-209-label-owner-slice` (stub shape + zero purchase imports + no legacy URL literals in the
  api client layers + createLabelV2/proof-gate intact + audit doc exists). **SEVEN guards re-anchored**
  (their pins certified the legacy fn's internals — each moved to the LIVE owner, strictly stronger):
  store-connector-source (legacy confirmation pins → stub-with-zero-confirmation),
  connector-architecture (capability-metadata pins → stub-with-zero-connector-machinery; rates pins
  unchanged), ps-032-connector-orchestrators (4 positive routing pins → labels-direct's generic
  `createCarrierLabel(provider, input)` dispatch), ps-078-connector-matrix (whitelist-parity →
  one-owner dispatch; in-request Vercel confirmation → the v4 shared tail's per-order
  `processFulfillmentOutboxOnce`), direct-carrier-label (rewritten wholesale to the v4 owners —
  persistCreatedLabel tail, generic dispatch, PS-199 PO-safety pins on walmart-po-resolution + the
  connector's exact customerOrderId match; the Walmart label-extractor behavioral cases unchanged),
  test-order-queue-label/queue-label-diagnostics (readiness pin → outbox + DB-free stub), and
  print-queue-ownership (a PS-195 call-shape catch: clear now passes explicit ids + the same scope).
  **QA:** typecheck + ps-209 + ps-202 + ps-203 + store-connector-source + ps-064-confirmation-outbox +
  shipment-confirmation-auto-recovery + print-queue-durable + print-queue-client-scope +
  connector-architecture + ps-032-boundary + ps-032-orchestrators + ps-078-connector-matrix +
  ps-176-queue-route-authority + print-queue-ownership + guard:shipping-certification + FULL
  shipping-roundtrip-certification (74→78/78 offline suites) ALL PASS. **Follow-up cards proposed (in
  the audit):** A — canonical direct Walmart/eBay persistence owner (collapse imported-handler-local
  SQL); B — queue create+queue atomicity certification (mocked crash-window recovery proof); PS-192
  (outbox-only shipped-external — awaiting unlock phrase); live certification matrix = DJ's PS-202
  canary. No postage, labels, marketplace notifications, or order/shipment mutations.

### PS-214 — HUGRAB $100 insurance on EVERY quoted + purchased rate — DONE 2026-06-13
- **✅ ROOT CAUSE (order #1476):** `resolveEffectiveInsurance` — the single label-side insurance owner —
  only forced the HUGRAB $100 default for UPS Ground + USPS Ground and passed every other service
  through as the operator's "none". A Shipp/FedEx label purchased through it shipped UNINSURED while
  the rate fingerprint said ip=parcelguard/iv=10000 (the quote side was already right: PS-170's
  `resolveHugrabRequestInsurance` had no service narrowing). **Fix at the owner:** the ground-only
  narrowing is deleted — HUGRAB + ANY service now resolves $100 (operator-higher kept), with the
  provider decided by the PS-170 capability resolver (direct UPS → carrier declared value, free ≤$100
  tier; everything else → ParcelGuard, which is THIRD-PARTY coverage and needs no carrier support).
  Ground Saver/SurePost stays excluded (PS-057 blocks the service itself). **✅ BELT-AND-BRACES:**
  createLabelV2 now refuses to buy a HUGRAB label that somehow resolved uninsured
  (`HUGRAB_INSURANCE_REQUIRED`, thrown BEFORE postage; test labels exempt). **✅ PERSIST AUDIT FIELDS
  (the #1476 forensic gap):** persistCreatedLabel still stamps insuranceProvider/insuredValue into
  shipments.selectedRateJson, and now prices the ParcelGuard schedule premium
  (`parcelGuardScheduledPremium`) when a direct connector reports no insuranceCost, with explicit
  `insuranceProvenance`: 'shipstation_v2_label' (provider-billed) / 'parcelguard_schedule' (scheduled
  premium) / 'carrier_declared_value' (free $100 tier, $0.00 BY DESIGN — recorded, not absent) /
  'none'. Quote-side premiums were already enriched on every candidate (PS-126/171
  `enrichRatesWithInsuranceCost` at the single merge point) and fingerprints already carry ip/iv
  (PS-170) — no cache invalidation needed. **Guard** `test:ps-214-hugrab-universal-insurance`: the
  card's matrix — SS-native USPS → parcelguard/100; SS-walleted FedEx → parcelguard/100; direct UPS
  2nd Day → carrier/100 + resolved premium; Shipp/FedEx (the #1476 class) → parcelguard/100 + REAL
  schedule premium (provenance parcelguard_schedule); a 5-carrier sweep (easypost/shipengine/
  walmart_shipping/unknown/ups_walleted) asserting NO HUGRAB candidate ever resolves uninsured or
  <$100; Ground Saver passthrough; non-HUGRAB untouched; operator $250 kept; over-cap carrier →
  ParcelGuard; + source pins (narrowing deleted, one resolve feeds both purchase branches, the
  pre-purchase block, schedule-premium persist, provenance literals, direct connector carries
  shippingOptions, rates.ts enrichment + request resolver). **Guards re-anchored (strictly stronger):**
  ps-072 ("UPS 2nd Day → no default" certified the GAP — now expects carrier/100 + two new Shipp
  cases), ps-108 (stale-at-base OrdersView pin → orders-row-display, where PS-177 moved the insurance
  rendering — verified absent at the base commit before re-anchoring), ps-057 (legacy
  api/carriers/labels.ts eligibility pins → the PS-209 410-stub reality). **QA:** typecheck + ps-214 +
  ps-072 + ps-057 + ps-108 + ps-126 + ps-170 + ps-203 + ps-085 + guard:shipping-certification +
  build:web + FULL shipping-roundtrip-certification (78/78 offline suites) ALL PASS. No postage, no
  live labels, no marketplace notifications, no order/shipment mutations. **DJ live check:** quote any
  HUGRAB order on a non-UPS/USPS service (e.g. FedEx/Shipp) — Rate Browser should show the +$0.99
  insurance add-on on every candidate, and a purchased label's order detail should show the insurance
  line; #1476-class labels can no longer purchase uninsured.
