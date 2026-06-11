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
- **PS-173 — Phase 1: Backend Order Row Shipping Workflow DTO + Action States.** Backend-owned row DTO:
  states (pending/final/blocked/needs_dims/stale_rate/missing_rate/external_shipped/local_shipped/
  missing_shipment_sync) + `allowedActions` (canRate/canBrowseRates/canRecalculate/canCreateLabel/
  canQueueLabel/canMarkExternalShipped) + carrier/account/service display from the backend registry.
  Additive; no label-purchase change; OrdersView prefers the DTO behind the existing fallback. **Classify
  PS-165 overlap in the PR.** Dep: after PS-172 map.
- **PS-174 — Phase 2: Backend Rate Quote Snapshot + selectedRateKey primitive.** Backend issues opaque
  `rateQuoteId`/`selectedRateKey`/proof per final rate (normalized account/service/amount-components/
  insurance/confirmation/ZIP+4/residential/weight/dims/package/ship-date-bucket/client-store-source/
  eligibility-version/expiry; sanitized only). Returned in BestRate + RateBrowser. No purchase enforcement
  yet; keep old `selectedRateProof` fallback. Dep: PS-173.
- **PS-175 — Phase 3: Best Rate + Rate Browser convergence on backend finalized rates.** One backend rate
  workflow entrypoint for passive BestRate + Recalculate + RateBrowser; backend owns eligibility/HUGRAB
  blocking/insurance capability+premium/ZIP+4/residential/confirmation/diagnostics; returns final classified
  states only (no FE "best so far"); each final rate carries the PS-174 quote/key; remove FE final-pick/
  strict-apply/clear/block. **Integrate PS-170/PS-171 into the backend workflow (not UI patches);** coordinate
  w/ PS-120/121. Dep: PS-174.
- **PS-176 — Phase 4: Backend Label Purchase + Print Queue orchestration enforcement (highest money/postage
  risk).** Composable ShippingIntent/LabelPurchase/PrintQueue services; FE sends order IDs + intent + backend
  quote/key; backend hydrates canonical data + validates shippability/duplicate-label/shipped-cancelled
  locks/external-shipped/scope/carrier-scope/selected-rate-proof/payload-parity immediately before side
  effects; backend owns direct-vs-ShipStation routing; idempotent queue insert; replace FE localStorage
  shipping-recovery authority with backend job ids. No real postage in tests. Dep: PS-174 + PS-175.
- **PS-177 — Phase 5: Backend display models (money, carrier identity, queue SKU identity, package
  defaults).** Backend DTOs for money/rate display (baseLabelCost/insuranceCost/displayRateAmount/
  markupAmount/customerShippingCharge/marginDisplay/costSource), carrier/account identity, Print Queue SKU
  identity (skuLines/groupToken/primaryDisplaySku/no-SKU eBay-safe), effective package/dims/default source.
  Read-model/additive; FE keeps shipped/cancelled fallback. Dep: after rate/proof/label boundaries; before
  broad FE decomp. May split if the PR grows too large.
- **PS-178 — Phase 6: OrdersView/RateBrowser thin-client decomposition (AFTER backend contracts).** Extract
  UI-only components (OrdersToolbar/Table/BatchActions/ShipmentPanel/PrintQueueDrawer/cells) + thin hooks
  that call backend workflow/poll job status (NO FE rate-finalization/proof/routing/money/queue-identity);
  shrink v2-apiClient to typed transport; remove FE fallbacks only after DTO contract + browser tests pass;
  add a boundary guard vs FE money/rate/label authority reappearing. Dep: PS-173–177.
- **PS-179 — Phase 7: Certification + boundary guards + safe dead-code cleanup.** Mocked/offline workflow
  cert (Awaiting→finalized rate→RateBrowser→create-label mocked→print-queue→job status + blocked stale/dup/
  shipped-cancelled), source-of-truth guards vs FE authority, perf sanity, evidence-backed dead-code deletion
  ONLY after cert passes; final PS-172 closeout table. Dep: PS-173–178.

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
- **PS-183 — Backend owns `cacheExpiresAt` TTL; FE stops minting now+6h (no deps).** `withRateRequestMetadata`
  (~L5573) prefers backend `metadata.cacheExpiresAt`; FE fallback only if absent (warn). (FE overwrite makes
  stale rates look fresh + bypasses server TTL.) Guard + parity test.
- **PS-184 — Delete 2 legacy client-ID FE remap tables (OrdersView L730-752 + L1355-1372); pass through
  backend `legacyClientId` (no deps).** Guard asserts neither table exists.
- **PS-185 — UPS 1Z tracking-prefix attribution at label-save time; delete FE `/^1Z/` regex block
  (L1406-1458) (no deps).** Backend stamps resolved carrier account on the shipment at save; FE reads DTO;
  one-time backfill for existing rows; guard asserts no 1Z regex in web/src.
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
- **PS-189 — Account→services registry DTO from backend; delete `CARRIER_SERVICES` FE table + auto-default
  (OrdersView L680-726) (no deps).** Auto-default stamps `stamps_com` → `usps_media_mail` (legal/compliance
  risk) into the purchase payload with NO backend re-check. Backend `GET /carriers/:accountId/services` (or
  `services[]` on the account DTO); FE deletes table + auto-default; guard. **Unblocks PS-165.**
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
