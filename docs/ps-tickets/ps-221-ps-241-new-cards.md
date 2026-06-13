# New ticket cards — PS-221 → PS-241

Recorded 2026-06-13 at DJ's request. Source of truth for *requirements* remains the
task board; this file is the **code-side registry** capture of the cards as specced.

Three tracks landed together in this batch:

- **Packaging source-of-truth epic** — PS-221 → PS-225 (evidence: `analysis/packaging-logic/*`, `analysis/hkp-packaging/*`, `analysis/billing-margin-leak/REPORT.md`).
- **Security review 2026-06-13** — PS-226 → PS-234 + PS-240 (PrepShip security review / deep-dive 2026-06-13).
- **Feature / bug** — PS-239 (marketplace fee + profit columns), PS-241 (Rate Browser fan-out bug).

> **Numbering note.** PS-233 references a `PS-235` for the order/client write-path scope
> split; that work is delivered in this batch as **PS-240** ("split from PS-233"), so 235
> was renumbered to 240. Numbers **235–238** are unused/unprovided in this batch.

> Repo: `drprepperusa-org/prepship-v4` · Branch: `prepshipv4-stable` · Assignee: `<@714064895963955211>`

## Contents
- [Packaging source-of-truth epic](#packaging-source-of-truth-epic-ps-221--ps-225)
  - [PS-221 — Package resolution single source of truth](#ps-221--package-resolution-single-source-of-truth) 🔒
  - [PS-222 — Package pricing + catalog data](#ps-222--package-pricing--catalog-data-enable-box-billing)
  - [PS-223 — Bulk packaging-default seeding (rule engine)](#ps-223--bulk-packaging-default-seeding-rule-engine-book-wide)
  - [PS-224 — Package / inventory negative-stock reconciliation](#ps-224--package--inventory-negative-stock-reconciliation) 🔒-adjacent
  - [PS-225 — Delete superseded packaging code](#ps-225--delete-superseded-packaging-code-gated-on-ps-221) 🔒
- [Security review 2026-06-13](#security-review-2026-06-13-ps-226--ps-234--ps-240)
  - [PS-233 — Cross-tenant access on label/shipment routes](#ps-233--p0-critical--cross-tenant-access-labelshipment-routes-dont-enforce-caller-scope) **P0 CRITICAL**
  - [PS-226 — HTTP security headers](#ps-226--add-http-security-headers) P1 HIGH
  - [PS-227 — Dependency vulnerabilities](#ps-227--remediate-dependency-vulnerabilities) P1 HIGH
  - [PS-228 — Regression-proof RLS](#ps-228--regression-proof-rls) P1 MEDIUM
  - [PS-240 — Scope on order & client write paths](#ps-240--enforce-caller-scope-on-order--client-write-paths-split-from-ps-233) P1 HIGH
  - [PS-229 — Sanitize carrier connector errors](#ps-229--sanitize-carrier-connector-error-messages-returned-to-clients) P2 MEDIUM
  - [PS-230 — JWT defense-in-depth (serverless)](#ps-230--jwt-defense-in-depth-on-vercel-serverless) P2 MEDIUM
  - [PS-231 — Audit-log + rate-limit ?force=1 override](#ps-231--audit-log-and-rate-limit-the-force1-lockdown-override) P2 MEDIUM
  - [PS-232 — Low-severity hardening bundle](#ps-232--low-severity-hardening-bundle) P2 LOW
  - [PS-234 — Append-only audit log table + writers](#ps-234--append-only-audit-log-table--runtime-event-writers) P3 HIGH
- [Feature / bug](#feature--bug)
  - [PS-239 — Marketplace Fee + Profit columns](#ps-239--marketplace-fee--profit-columns-configurable-per-store-backend-computed)
  - [PS-241 — Rate Browser live carrier fan-out skipped](#ps-241--rate-browser-live-carrier-fan-out-skipped-on-open)

---

# Packaging source-of-truth epic (PS-221 → PS-225)

## PS-221 — Package resolution single source of truth
**Status:** 🆕 New · **Type:** backend refactor + bug fix (forward-only) · **Lockdown:** 🔒 (label/shipment persistence)
**Depends on:** — (foundational) · **Related:** PS-222, PS-223, PS-225 · **Evidence:** `analysis/packaging-logic/MAP.md`, `analysis/packaging-logic/TASK.md` (Card 1)

**Principle (the design).** The selected package — resolved from saved SKU / SKU+qty
defaults, Prepship-authoritative — is the single source of truth. It is auto-selected by
dims (small tolerance) or auto-created if no package with those dims exists, saved as the
default (single-SKU or SKU+qty combo) for future imports, persisted on the order/shipment,
and consumed identically by **display, billing, AND inventory deduction**. A platform
source (ShipStation today; others later) supplies dims only as a *starting seed* when
Prepship has none; once changed + saved, Prepship wins and a re-sync never overwrites it.

**Problem.** "Which box" is computed by three independent resolvers at three times with no
shared anchor:
- **R1 order-time** → `order_overrides.selectedPackageId` (operator / SKU-combo default / dims).
- **R2 label-time** → `resolveLabelPackageId` (`src/services/labels.ts:62-88`): `customPackageId` else a fresh dims ±0.1″ match — **this is what deducts inventory**.
- **R3 billing-time** → `resolvePackageId` (`src/services/billing.ts:772-826`): SKU → dims → rateDims → selectedPid → selectedPackageId — **this is what bills**.

They never reconcile because the anchor `shipments.selected_package_id` is **NULL on 24,116/24,243 (99.5%)** shipments — the real label path persists `body.customPackageId` instead of the package it just resolved and deducted (`labels.ts:1273`). The test path persists it correctly (`labels.ts:1162`), proving the value was in hand and dropped. Same drop on the batch, direct-carrier (`src/services/direct-label-persistence.ts:74`), and print-queue (`src/services/print-queue.ts:648`) paths. **Net: the box deducted ≠ box billed ≠ box displayed.**

**Goal.** One package resolver; one persisted anchor (`selected_package_id`); three consumers (display, billing, deduction) that all read it.

**Scope.**
- **Unified resolver** (one service, e.g. `src/services/package-resolution.ts`, built from existing combo-default + dims-default logic):
  - derive combo key (`sku:qty`) + per-SKU context;
  - **Prepship default first** — combo default (`client_combo_package_defaults`) → single-SKU default (`product_defaults` / `inventory.package_id`); the default's stored dims are authoritative;
  - **no default but dims present** (entered or platform-imported) → find an existing package within a small tolerance, else **auto-create** (reuse `POST /packages/auto-create` find-or-create logic), then **save it as the default** (combo or single-SKU);
  - **no default, no dims** → seed from the platform source dims (ShipStation now) as a starting point, NOT saved as a default until changed + saved.
- **Persist the anchor (fixes G1):** persist the resolved package id (not `body.customPackageId`) to `shipments.selected_package_id` on every label path — real ShipStation (`labels.ts:1273`), batch, direct-carrier (`direct-label-persistence.ts:74`), print-queue (`print-queue.ts:648`). Test path (`labels.ts:1162`) is the reference. **Forward-only** — no backfill of the 24K historical NULLs without separate approval.
- **Consumers read the anchor (fixes G4):** billing's `resolvePackageId` and label-time deduction read `selected_package_id` first; the resolver runs only as the single fallback when it is absent. Resolve the `selectedPid` package-vs-provider-account semantic collision (`billing.ts:807-809`) — stop treating a provider-account id as a `packages.id` FK.
- **Platform-import auto-apply + SOT enforcement (fixes G5):** the platform-sync path runs the resolver at import so awaiting orders arrive WITH a resolved+persisted package. A saved Prepship default overrides platform dims; platform dims fill only when no default exists; a saved default is **locked** (re-sync never overwrites it). Model the seed input as a generic `PlatformDims` so future platform sources implement one interface (ShipStation is the first adapter).

**Tolerance decision (DJ).** Keep a small tolerance (~0.1″) for matching an existing package so near-dims don't spawn duplicates; treat the saved default's stored dims as exact/authoritative for what gets selected.

**Acceptance criteria.**
- Every new shipment carries a non-NULL `selected_package_id` equal to the package that was deducted (baseline today: 0.8%). Guard asserts **persisted == deducted == billed**.
- Billing and deduction for a shipment resolve to the same package as displayed — no diverging re-derivation.
- A saved SKU/combo default is auto-applied at platform import and is NOT overwritten by a later re-sync.
- An order with dims but no matching package auto-creates one and saves the default; re-import of the same SKU/combo reuses it.
- `npm run typecheck` passes; no FE owns resolution; shipped/cancelled lockdown respected (forward-only); guards re-anchored.

**Guard (todo).** `scripts/ps-221-package-source-of-truth-guard.ts` → `test:ps-221-package-source-of-truth`: persisted == deducted == billed parity; resolver default-first / dims find-or-create / platform-seed-only / lock-after-save; HKP combos as fixtures.

**Lockdown.** 🔒 Touches `labels.ts` / `shipments` persistence and `fulfillment-deductions.ts` resolution. Forward-only; requires the `unlock shipped data` override before editing the locked surfaces.

## PS-222 — Package pricing + catalog data (enable box billing)
**Status:** 🆕 New · **Type:** data / config · **Lockdown:** none (catalog + pricing tables)
**Depends on:** — (pairs with PS-221) · **Related:** PS-221, PS-223 · **Evidence:** `analysis/packaging-logic/MAP.md` (G2), `analysis/billing-margin-leak/REPORT.md`, `analysis/hkp-packaging/REPORT.md`

**Problem.** Even a correctly-resolved package bills **$0** today because the pricing inputs are empty:
- `client_package_prices` — 842 rows, but only 3 are > $0; billing skips the `package_cost` line when `basePrice <= 0` (`src/services/billing.ts:966`).
- `packages.unit_cost` and `package_ledger.unit_cost` are universally NULL — no materials cost to bill from.
- Catalog gaps (HKP audit): no `8x8x2` box (only the `8x82x2` typo, id 93), no bubble-mailer entries, no `$0` "factory set box (no charge)" entry for ship-in-own-box cases.
- Net book-wide `package_cost` billed: **~$650** across the whole book.

**Goal.** Populate the pricing/catalog inputs so a resolved package emits a correct `package_cost` line (and a billable-as-$0 line where shipping in the factory box).

**Scope.**
- Set `packages.unit_cost` on the billable packages (HKP set: ids 121, 122, 105, 506, 480, 158, plus the new entries below); decide source-of-truth for materials cost.
- Populate `client_package_prices` for active clients' real boxes (the operator-facing price; `package_cost_markup` from `billing_config` applies on top per PS-221 consumer logic).
- Create catalog entries: a `$0` "factory set box (no charge)" package (so ship-in-own-box is an explicit $0 line, not an absent one) and `bubble_mailer_10.5x15` (type mailer).
- Fix the `8x82x2` → `8x8x2` dims typo (id 93) after confirming no other client depends on the typo'd dims.

**Acceptance criteria.**
- A resolved package on an active client's shipment emits a non-zero `package_cost` line (or an explicit $0 factory-box line).
- The HKP factory-set-box case bills $0 via the dedicated package, distinguishable in data from a purchased box.
- `8x82x2` corrected; mailer + factory-box entries exist; no FK/guard breakage.

**Guard (todo).** `test:ps-222-package-pricing-present` — billable packages have non-NULL `unit_cost`; active clients have priced `client_package_prices` rows for boxes in use.

**Lockdown.** None for the catalog/pricing tables. Does not touch shipped/cancelled order rows.

## PS-223 — Bulk packaging-default seeding (rule engine, book-wide)
**Status:** 🆕 New · **Type:** backend service + data seeding · **Lockdown:** none (writes awaiting-only defaults)
**Depends on:** PS-221 (resolver consumes these defaults) · **Related:** PS-222, PS-037/PS-082 · **Evidence:** `analysis/hkp-packaging/REPORT.md` (§6), `analysis/packaging-logic/MAP.md` (G3/G6)

**Problem.** The PS-221 resolver reads saved defaults — but the defaults are almost entirely missing:
- 849 of 991 active inventory rows have `package_id` NULL.
- Only 3 `client_combo_package_defaults` rows exist book-wide (305 of 308 historical HKP combo-groups had none).

So most imports fall through the resolver's default lookup. The Heritage Kids Press audit produced a packing matrix (rules 1–9) and a 53-SKU classification that can seed these defaults in bulk, and the pattern generalizes to other clients.

**Goal.** Populate the defaults the PS-221 resolver reads, derived from packing rules — so the majority of awaiting orders resolve a saved default at import instead of falling through.

**Scope.**
- New `client_sku_classes` (`client_id, sku, item_class, units`; bundles = 3) — seed the 53 HKP SKUs from `analysis/hkp-packaging/classification.json`; SKU-suffix heuristics may *suggest* a class for new SKUs but never silently classify.
- New `client_packing_rules` (matrix rules 1–9 from `analysis/hkp-packaging/guidelines.json`) — editable per client.
- Resolution → seeding service (`src/services/packaging-rules.ts`): order items → class totals → matched rule → catalog package (with codified substitutes), upserting `client_combo_package_defaults` via the existing PS-037 save path. Add a `source` column (`rule_engine | operator`): the engine never overwrites operator rows; an operator save always wins (closes G6).
- **Dry-run seeding report first** (every default the engine would create) for DJ review before any write. **Awaiting-shipment-only** (PS-082 semantics).

**Acceptance criteria.**
- An awaiting order matching rules 1–9 receives a seeded `client_combo_package_defaults` row (`source='rule_engine'`) that PS-221 then resolves and persists — e.g. open order SP5696 resolves via rule 6.
- Outside-matrix orders get NO engine seed; an operator pick is saved as `source='operator'` and is never overwritten by the engine.
- Replaying the engine over the 308 historical HKP combo-groups reproduces the audit's expected packages (CI guard).

**Guard (todo).** `scripts/ps-223-packaging-rule-engine-guard.ts` → `test:ps-223-packaging-rule-engine`: classifier (53 SKUs incl. bundles=3), matrix matcher (rules 1–9 + count boundaries), engine-never-overwrites-operator, 308-group historical replay.

**Lockdown.** None — writes awaiting-shipment defaults only; no shipped/cancelled mutation. Respects PS-082 unshipped-only application.

## PS-224 — Package / inventory negative-stock reconciliation
**Status:** 🆕 New · **Type:** data reconciliation + guard · **Lockdown:** 🔒-adjacent (`fulfillment-deductions.ts` is governed by the `INVENTORY_AUTO_DEDUCT` kill switch)
**Depends on:** — (independent ops) · **Related:** PS-221, PS-222 · **Evidence:** `analysis/packaging-logic/MAP.md` (G7), `analysis/hkp-packaging/REPORT.md`

**Problem.** Package + inventory stock has drifted negative because auto-deduct runs from a zero baseline with no restock entries:
- 28 packages and 152 active inventory rows have `stock_qty < 0` (e.g. package id 105 = −38, id 480 = −14).
- `package_ledger` records only ship deductions (no receive/restock), so ledger balances are unreliable and can't back an invoice or a reorder signal.

**Goal.** Reconcile current package/inventory balances to reality and stop new negative rows from being created on first ship of an unknown package.

**Scope.**
- Per-item reconciliation: for each negative `stock_qty`, compute the true on-hand from ledger history + a counted/declared baseline; propose correcting receive/adjust ledger entries (reviewed, not auto-applied).
- Baseline guard: the first ship of a package/SKU with no prior baseline must not create a −1 row — require (or auto-create at 0) a baseline before deduction.
- Optional: a reorder-level signal once balances are trustworthy.

**Acceptance criteria.**
- A reviewed correcting-adjustment set brings the 28 packages + 152 inventory rows to non-negative, with each correction traceable to its originating movement.
- New shipments cannot drive `stock_qty` below 0 from a missing baseline.

**Guard (todo).** `scripts/ps-224-negative-stock-guard.ts` → `test:ps-224-negative-stock`: no active inventory/package row at `stock_qty < 0` after reconciliation; first-ship baseline guard holds.

**Lockdown.** 🔒-adjacent: `src/services/fulfillment-deductions.ts` is under the `INVENTORY_AUTO_DEDUCT` kill switch. Read freely; corrections are proposed for review, not silently applied; no shipped/cancelled order mutation.

## PS-225 — Delete superseded packaging code (gated on PS-221)
**Status:** 🆕 New · **Type:** dead-code removal · **Lockdown:** 🔒 (touches `labels.ts`; forward-only)
**Depends on:** **PS-221 must be landed + verified first** · **Related:** PS-222, PS-223 · **Evidence:** `analysis/packaging-logic/MAP.md`, `analysis/packaging-logic/TASK.md` (Card 5)

**Rationale.** Once PS-221 makes `selected_package_id` the single source of truth, the parallel package-resolution paths become dead. **Delete, do not archive** — git history is the archive; commented-out / moved-aside code is more spaghetti. The repo already works this way (PS-149 dead-code sweep, FE-authority ratchet, parity `_v4`-only audit).

**Candidates (final set confirmed by a caller-trace as step 1).**
- `resolveLabelPackageId` (`src/services/labels.ts:62-88`) — independent dims-match re-derivation, redundant once deduction reads the anchor.
- The `resolvePackageId` cascade (`src/services/billing.ts:772-826`) — collapses to "read `selected_package_id`, else the one shared resolver"; the SKU→dims→rateDims→selectedPid branch chain is removed.
- The FE deploy-skew fallback in `web/src/components/Views/OrdersView.tsx` — per-SKU `/products/by-sku` fetch loop + client-side `deriveShipmentDimsFromProductDefaults` (~3097-3101, ~3751+), already commented "Phase 6 deletes it."
- The dual ±0.1″ / ±0.15″ tolerance duplication → one shared constant.
- The `selectedPid` package-vs-provider-account ambiguity (footgun removed).

**Deletion discipline.**
- **Gate:** PS-221 live + verified (anchor persisted, consumers reading it, parity guard green) BEFORE deleting anything.
- **Step 1** = a caller-trace across the repo (all callers of the above + the guards anchored on them) to confirm the exact deletable set.
- **Grep-after-delete** for every removed symbol (the PS-181 lesson) — no lingering callers.
- Re-anchor the guard scripts that reference the old resolvers; run the full guard suite + typecheck + label / print-queue / full-site certs.
- One reviewable PR per layer (billing resolver, label resolver, FE fallback) so each is independently revertable.
- Forward-only on locked surfaces; no historical mutation.

**Acceptance criteria.**
- The candidate paths are removed (or proven still-needed and documented why); no behavior change vs PS-221's verified state.
- Full guard suite + typecheck + certs green; no orphaned references.

**Lockdown.** 🔒 Touches `labels.ts` (locked). Forward-only; requires the `unlock shipped data` override before editing the locked surfaces.

---

# Security review 2026-06-13 (PS-226 → PS-234 + PS-240)

> Source: PrepShip security review / deep-dive 2026-06-13 (Supabase advisor, static audit,
> live recon, 5-agent static trace adversarially verified). Honesty caveats preserved per card.

## PS-233 — [P0 CRITICAL] Cross-tenant access: label/shipment routes don't enforce caller scope
**Priority:** P0 · **Severity:** CRITICAL (confirmed, currently exploitable) · **Area:** Authorization / multi-tenant isolation
**Source:** PrepShip deep-dive 2026-06-13 (5-agent static trace, adversarially verified, + live auth-store data + manual code confirmation). Supersedes the original "HIGH if exploitable" framing — it **IS** exploitable. **Related:** PS-240 (order/client write-path split).

**Verdict.** A restricted `client_user` can read and act on other clients' shipments, labels, and orders via direct API calls. This is a **live horizontal privilege escalation / cross-tenant data + financial exposure** — not theoretical.

**Why it is live (the automated pass wrongly called this theoretical).**
- Restricted principals exist and are active — `auth.users` has 3 `client_user` accounts, all signed in within ~2 weeks, scoped to real clients: clientIds `[2,10]`, `[4]` (HUGRAB), `[3]` (Heritage Kids Press). Two are `@gmail.com`.
- They get a working token — login is a single unified `signInWithPassword` (no role branching); a holder can authenticate directly via Supabase auth and call the Render API. Their JWT carries `role:client_user` + their clientIds.
- The routes are reachable — `/labels`, `/shipments`, `/orders` are mounted with `requireAuth` only (`src/main.ts:127-162`); only `/admin` + `/observability` get `requireAdmin`.
- The routes don't check scope — handlers pass only id/body to the service (`src/routes/labels.ts:171-248`); services load by `eq(id)` with no clientId/storeId predicate.

**Scope enforcement map (verified).**

| Surface | Scoped? | Evidence |
|---|---|---|
| Orders LIST, Orders GET /:id, Clients/Inventory/Billing LISTs | YES | `orderScopePredicate` orders.ts:1207/2572; `filterClientsForScope` clients.ts:92 |
| GET /shipments, GET /shipments/:id | **NO** | shipments.ts:70-102 |
| GET /labels/:lookup + /retrieve (URLs, tracking) | **NO** | labels.ts:292-318; labels service loads by id |
| POST /labels, /create-batch (buy postage) | **NO** | labels.ts:171-209; createLabelV2 takes no scope |
| POST /labels/:id/void, /:id/return | **NO** | labels.ts:216-248; void/return load shipment by id |
| PATCH /orders/:id + mutation subroutes; clients PATCH/DELETE/backfill | **NO** | only assertOrderEditable status check — split to PS-240 |

**Impact** — a `client_user` scoped to client 3 (HKP) could, against HUGRAB (client 4) or anyone:
- Read other clients' shipments + label URLs/tracking → discloses recipient names + addresses (customer PII) across tenants.
- Buy real postage on another client's orders (`POST /labels`) — spends money.
- Void another client's real labels (`POST /:id/void`) — financial/operational sabotage.
- Create return labels on another client's shipments.

**Fix.**
- Thread the caller `ClientStoreScope` into the label/shipment services (`createLabelV2`, `createBatchV2`, `voidLabelV2`, `createReturnLabelV2`, `retrieveLabelV2`, `lookupLabel`): load the order/shipment with `AND (clientId IN scope OR storeId IN scope)`, return 404 when out of scope — mirroring GET /orders/:id (orders.ts:2572).
- Apply a scope predicate to GET /shipments and GET /shipments/:id (pattern from manifests.ts).
- Promote `orderScopePredicate` into a shared `assertResourceInScope(scope, {clientId, storeId})`.
- Defense-in-depth: add `requireInternalPermission` (block portal roles) on internal-only routes so a missing per-resource check can't expose them.
- Add a `test:label-shipment-scope-enforcement` guard to the security-readiness suite.

**Interim mitigation (today, before the fix ships).** Disable/ban the 3 `client_user` accounts (clients 2/10, 4, 3) — removes the live exploit path immediately (one related account is already banned). Two are gmail accounts scoped to real clients; confirm whether they're real client contacts before assuming inert.

**Honesty caveat.** NOT dynamically exploited (no `client_user` password used; no prod PII exfiltrated). Verdict = verified-absent scope checks + verified route reachability + confirmed live restricted principals + role-blind login. Definitive proof = staging two-token test.

**Acceptance / verification checklist.**
- INTERIM: disable/ban the 3 `client_user` accounts until scope enforcement ships, or confirm inert.
- Thread `ClientStoreScope` into the 6 label services (load with scope predicate, 404 if out of scope).
- Scope predicate on GET /shipments + /shipments/:id.
- Extract shared `assertResourceInScope` helper.
- Add `requireInternalPermission` on internal-only routes.
- `test:label-shipment-scope-enforcement` in the security-readiness suite.
- STAGING PROOF: `client_user(A)` GET /shipments/:id for a shipment owned by client B → expect 404/403.
- STAGING PROOF: `client_user(A)` POST /labels for an order owned by client B → expect 403 (no postage purchased).

## PS-226 — Add HTTP security headers
**Priority:** P1 · **Severity:** HIGH · **Area:** Vercel deploy config · **Source:** security review 2026-06-13 (live recon + static audit, verified).

**Problem.** The live site sends only HSTS. Missing, confirmed via response headers and `vercel.json`:
- `Content-Security-Policy` — no XSS backstop (inline/eval allowed by default)
- `X-Frame-Options` / CSP `frame-ancestors` — app is frameable (clickjacking)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`

`vercel.json:8-21` defines only `Cache-Control`. The Render API (`src/main.ts`) sets only `X-Request-Id`/`Server-Timing`.

**Fix.** Add a headers rule in `vercel.json` for non-asset routes:
- `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `Content-Security-Policy` — start in Report-Only to tune (`default-src 'self'; connect-src 'self' https://*.supabase.co https://prepshipv4-api-l5xc.onrender.com`; allow the styles/scripts the SPA needs), then enforce.

**Acceptance.** All five headers present on document responses (verify with `curl -I`); CSP enforced (not report-only) after a tuning pass with no console violations on normal use; no regression to asset caching rules.

## PS-227 — Remediate dependency vulnerabilities
**Priority:** P1 · **Severity:** HIGH · **Area:** Dependencies / supply chain · **Source:** security review 2026-06-13 (`npm audit`).

**Problem.** `npm audit` reports 16 vulnerabilities: **2 critical, 7 high, 7 moderate**. Affected: `hono`, `drizzle-orm`, `drizzle-kit`, `exceljs`, `react-router`/`react-router-dom`, `esbuild`, `vite`, `@vitejs/plugin-react`, `@esbuild-kit/*`, `tsx`, `brace-expansion`, `shell-quote`, `uuid`, `concurrently`. Several are dev/build-only (lower runtime risk); the runtime-facing ones matter: `hono` (API), `drizzle-orm` (DB), `exceljs` (new billing export, PS-208/217), `react-router-dom` (client). There is currently **no npm-audit gate** in the security-readiness suite (`scripts/security-readiness-guard.mjs`).

**Fix.** `npm audit fix` for safe upgrades; review breaking ones manually; prioritize runtime deps (`hono`, `drizzle-orm`, `exceljs`, `react-router-dom`); add `npm audit --audit-level=high` (or equivalent) as a required check in CI / the security-readiness guard so new criticals/highs block.

**Acceptance.** `npm audit` shows 0 critical / 0 high (or documented, accepted exceptions); CI fails on any new high/critical advisory; app builds + `npm run typecheck` green after upgrades.

## PS-228 — Regression-proof RLS
**Priority:** P1 · **Severity:** MEDIUM (preventive; HIGH impact if it regresses) · **Area:** Supabase / data access · **Source:** security review 2026-06-13 (Supabase advisor + live PostgREST test).

**Context (currently SAFE).** The browser bundle ships the public Supabase anon key, and PostgREST is reachable at `https://fdkseckgfuvdczzqmnac.supabase.co/rest/v1/<table>`. Verified live: anon-key reads of `clients`, `orders`, `carrier_accounts` all return `[]`. Supabase advisor confirms all ~45 public tables have RLS enabled; none are in the dangerous `rls_disabled` state. RLS deny-all is the **sole** control between a public key and customer data — and it works today. (Aligns with the auto-memory: backend = postgres owner / bypasses RLS, frontend = Supabase auth only; RLS-enabled-no-policy is intentional.)

**Risk.** Because the anon key is public and PostgREST is enabled, a single future mistake — one migration disabling RLS, or one overly-permissive policy — is an instant data breach. The app doesn't rely on PostgREST (all data goes through the Render API), so this exposure is pure downside.

**Fix (defense-in-depth + regression guard).**
- Add Supabase's `rls_disabled_in_public` advisor (and `rls_enabled_no_policy` review) to the security-readiness CI so a table can never silently go public.
- Revoke `select/insert/update/delete` grants on the public schema from the `anon` (and `authenticated`) roles, OR disable the Data API / restrict exposed schemas if PostgREST is unused by the app.
- Document that the Render backend uses a privileged DB connection (bypasses RLS) and is the only intended data path.

**Acceptance.** A migration that disables RLS on any public table fails CI; anon-key PostgREST reads remain denied (re-test clients/orders).

## PS-240 — Enforce caller scope on ORDER & CLIENT write paths (split from PS-233)
**Priority:** P1 · **Severity:** HIGH · **Area:** Authorization / multi-tenant isolation · **Source:** deep-dive 2026-06-13 (verified). Same root cause as PS-233 (reads scoped, writes not).

**Problem.** Order and client READ list/detail routes enforce caller scope (`orderScopePredicate`, `filterClientsForScope`), but the WRITE paths do not — they check only existence/lock status, never that the resource is in the caller's clientIds/storeIds. A restricted `client_user` (live accounts exist — see PS-233) can mutate other clients' data via direct API calls.

**Confirmed (file:line).**
- PATCH /orders/:id and mutation subroutes (`/residential`, `/selected-pid`, `/selected-package-id`, `/best-rate`, `/save-combo-package-default`) call only `assertOrderEditable` (status-lock) — `orders.ts:202-244, 2921-2935, 3142-3192`. No scope check.
- `applyOverridesPatch()` loads by `eq(orders.id, id)` only — `orders.ts:3116-3140`.
- POST /orders/manual creates orders with zero scope validation — `orders.ts:2744`.
- clients PATCH /:id, DELETE /:id, POST /:id/backfill-orders, POST / — all by `eq(clients.id, id)` with no scope check — `clients.ts:129-214`. A restricted caller could PATCH/DELETE any client and bulk-reassign orders.

**Fix.**
- Add the caller-scope check to `assertOrderEditable` / `applyOverridesPatch` (use the shared `assertResourceInScope` helper from PS-233): mutate only if the order's clientId/storeId is in scope, else 404.
- Gate clients write routes (PATCH/DELETE/backfill/create) on scope + the right permission (arguably admin/operator-only — confirm `client_user` can't reach them; add `requireInternalPermission` if internal-only).
- Extend the `test:*-scope-enforcement` guard to cover order + client write paths.

**Acceptance.** A `client_user` scoped to client A cannot PATCH/POST an order or client belonging to client B (staging two-token test: expect 404/403); guard covers order + client write paths.

## PS-229 — Sanitize carrier connector error messages returned to clients
**Priority:** P2 · **Severity:** MEDIUM (information leakage) · **Area:** Vercel carrier rate functions · **Source:** security review 2026-06-13 (static audit, verified).

**Problem.** The carrier rate endpoints return raw connector error text straight to the client: `error: err instanceof Error ? err.message : String(err)` at `api/carriers/rates.ts` lines 537, 571, 605, 676, 888, 942, 1017, 1070, 1167 (per-provider catch blocks). These leak upstream/credential-shaped detail to the browser, e.g. `FedEx OAuth response missing access_token` (`fedex.ts:49`), `FedEx accountNumber is required` (`fedex.ts:59`), `Amazon LWA 401: Unauthorized`, raw upstream status codes. A safe-error helper (`safeErrType()` / `src/lib/safe-error.ts`) already exists and is used by the outer catch (~1200, 1211) — but not by the per-provider handlers.

**Fix.** Route the per-provider catches through the existing safe-error helper: return a generic client message (e.g. `Rate quote failed for <carrier>`) + a stable error code; log the full message server-side only.

**Acceptance.** No raw connector/upstream message or credential hint appears in any `/api/carriers/rates*` JSON response; full detail still in server logs.

## PS-230 — JWT defense-in-depth on Vercel serverless
**Priority:** P2 · **Severity:** MEDIUM (defense-in-depth) · **Area:** Auth / serverless · **Source:** security review 2026-06-13 (static audit; "critical" auto-flag verified DOWN to medium).

**Context.** On Vercel, `SUPABASE_JWT_SECRET` defaults to empty (`src/lib/env.ts:29-32`), so JWT verification falls back to JWKS-only. **Not a bypass** — tokens must still be cryptographically signed by the configured Supabase project. So this is hardening, not an open hole.

**Gap.** `STRICT_JWT_CLAIMS` defaults to `false`, so issuer/audience claims aren't validated. `api/carrier-accounts.ts:78` and `api/store-accounts.ts:71` call `verifySupabaseJwt(token)` with no options. In a shared-Supabase scenario this weakens defense against cross-project token confusion on write endpoints (carrier/store account create/patch).

**Fix.** Set `STRICT_JWT_CLAIMS=true` in production envs (Render + Vercel); provision `SUPABASE_JWT_SECRET` on the Vercel functions (fast offline HMAC verification) OR pass explicit `{ strictClaims: true, supabaseUrl }` to `verifySupabaseJwt` in the serverless handlers; add a boot-time check that server-side secrets aren't silently empty on serverless.

**Acceptance.** A validly-signed token from a different Supabase project is rejected by `api/carrier-accounts` and `api/store-accounts`; `STRICT_JWT_CLAIMS=true` set in prod.

## PS-231 — Audit-log and rate-limit the ?force=1 lockdown override
**Priority:** P2 · **Severity:** MEDIUM · **Area:** Orders / admin override · **Source:** security review 2026-06-13 (static audit, verified). **Pairs with** PS-234.

**Context.** `assertOrderEditable` (`orders.ts:222-230`) lets an admin modify a shipped/cancelled (locked) order when `?force=1` is set AND `isAdminEmail(c.get('email'))` is true. The email comes from a cryptographically verified JWT, so the bypass is **not spoofable** — this is sound.

**Gap.** The only record of a bypass is a `console.warn('[orders] LOCKDOWN BYPASS ...')`. There is no durable audit trail, no rate limit, and no override-reason capture. A compromised admin account could mutate historical/financial records with only ephemeral log evidence.

**Fix.** Write an immutable audit-log row on every `?force=1` use (actor, order id, prior status, timestamp, IP, optional reason) — pairs with PS-234; add a per-admin rate limit (e.g. max N force-overrides/hour); optionally require an override reason and surface a monitoring alert.

**Acceptance.** Each lockdown bypass produces a persistent, queryable audit record; excessive force usage is throttled.

## PS-232 — Low-severity hardening bundle
**Priority:** P2 · **Severity:** LOW · **Area:** Auth config, error/log hygiene · **Source:** security review 2026-06-13 (Supabase advisor + static audit).

A grab-bag of low-risk hardening items; do together.
- Enable Supabase "leaked password protection" (HaveIBeenPwned check) — currently DISABLED (advisor `auth_leaked_password_protection`). One toggle in Supabase Auth settings.
- Set `search_path` on pgboss SECURITY DEFINER functions — `pgboss.create_queue`, `pgboss.delete_queue` have mutable search_path (advisor `function_search_path_mutable`). Set `search_path = pgboss, pg_catalog`.
- Serverless env-error message — `src/lib/env.ts:125` throws JSON of missing env-var NAMES on a 500. Mostly mitigated by the outer `safeErrType` catch, but return a fully generic message and log names server-side only.
- Worker stack traces — `src/worker.ts:50,58` log full stack traces to stderr; move to debug level / ensure log access is controlled.
- `/distinct-skus` query params — `orders.ts:2501-2502, 2534-2535` read `dateFrom/dateTo/status` without a zod schema. Parameterized (not injectable) but fragile; add zod validation matching GET / and the enum for status.
- Cron body size — `src/routes/cron.ts` `parseSyncBody` has no explicit body-size cap (webhooks do, 1MB). Add a limit.

**Acceptance.** Leaked-password protection ON; pgboss functions have fixed search_path; no env-var names / stack traces in client responses; `/distinct-skus` has a zod schema; cron has a body cap.

## PS-234 — Append-only audit log table + runtime event writers
**Priority:** P3 · **Severity:** HIGH (forensics / compliance) · **Area:** Audit logging · **Source:** security review 2026-06-13 + `AUDIT_LOGGING_MATRIX.md` / `ENTERPRISE_READINESS_AUDIT.md:81`.

**Problem.** Audit logging is mapped on paper but not implemented: there is no append-only audit table and no runtime event writers. Today you cannot prove who changed credentials, labels, orders, billing, or settings — a gap for incident forensics and SOC 2 / enterprise readiness. Blocks meaningful detection for the `?force=1` override (PS-231) and credential changes.

**Fix.**
- Create an immutable `audit_log` table (no UPDATE/DELETE grants; INSERT-only): `id, ts, event_type, actor_id, actor_email, resource_type, resource_id, action, details jsonb, ip`.
- Add event writers at the mutation points: credential create/patch (`carrier_accounts`, `store_accounts`), label create/void/return, order edits (incl. `?force=1`), billing generate/edits, settings writes.
- Make `test:audit-logging` verify the schema + sample events instead of just the doc.

**Acceptance.** Every credential/label/order/billing/settings mutation writes an audit row; audit rows cannot be updated or deleted (append-only enforced at the DB role level).

---

# Feature / bug

## PS-239 — Marketplace Fee + Profit columns (configurable per-store, backend-computed)
**Status:** 🆕 New · **Type:** feature (backend compute + Settings config + FE columns) · **Lockdown:** none (Shipped column is a read-only analytics display)
**Depends on:** PS-177 (per-row money DTO — extends it) · **Related:** Markups (settings `markup.*`) · **Evidence:** `analysis/marketplace-fee/MAP.md`

**Goal.** Two new toggleable columns on the Awaiting Shipment and Shipped order views:
- **MARKETPLACE FEE** — a per-client/marketplace configurable commission on the order's product subtotal (price before tax + shipping). Two rule types, set by the operator in Settings: **flat %** (e.g. eBay 12%) or **tiered** (Amazon-style: subtotal ≥ $15 → 15%, < $15 → 8%).
- **PROFIT** = Product Subtotal − Marketplace Fee − Best Rate (incl. markup). Nothing else subtracted (gross of Prepship pick/pack + COGS, per DJ).

Backend-computed (per ARCHITECTURE.md — FE only renders). Generalized so it is not Amazon-specific.

**Design (extends the existing PS-177 money workflow, no parallel path).**
1. **Fee config storage** — one settings KV row, key `marketplace_fee_rules`, value `{ version:1, rules:[Rule] }`, modeled on `shipping_automation_rules`. No schema migration. Add the key to `src/routes/settings.ts` `ALLOWED_SETTINGS`/`isAllowedSettingKey` (or PUT 400s). Rule shape:

   | Field | Notes |
   |---|---|
   | `clientId?` / `storeId?` | nullable scope. **Store-scopable is REQUIRED** — KF Goods (client 11) spans store 277422 (amazon) + 376827 (non-amazon), so client-only is insufficient. |
   | `marketplace?` | optional refinement = `raw.advancedOptions.source` (amazon / ebay_v2 / walmart …). Optional because it is null/empty for ~32k orders. |
   | `kind: 'flat' \| 'tiered'` | |
   | `percent?` | flat only |
   | `threshold?` / `belowPercent?` / `atOrAbovePercent?` | tiered only. Defaults $15 / 8% / 15%, all editable. Whole-subtotal flat-tier (≥ threshold → atOrAbovePercent on the full subtotal), not marginal/bracketed. |
   | `disabled?` / `updatedAt` / `updatedBy` | |

   Resolution **most-specific-wins**: storeId(+marketplace) → clientId → none. No match → fee null (renders —).
2. New service `src/services/marketplace-fee.ts`: `loadMarketplaceFeeRules` / `save` / `upsert` / `resolveMarketplaceFeeRule(scope)` + a pure `computeMarketplaceFee(subtotal, rule)` (parallel to `applyMarkupToAmount`).
3. **Compute location** — extend `buildOrderRowMoneyDisplay` (`src/services/shipping-workflow/rate-money.ts:148-182`) to add `marketplaceFee` + `profit`; `markedAmount` (line 155) is already best-rate-incl-markup. Invoked from `withOrderRowWorkflow` (`best-rate-workflow-dto.ts:457-481`), money branch gated by `canViewFinancials` (line 468) → redaction is automatic, no new redaction key. Facts (`productSubtotal` + resolved rule) assembled in the orders per-row mapper (`orders.ts:1961-1968`); rules loaded once per request near `orders.ts:1529-1534` (mirroring `loadCarrierMarkups`).
4. **Product subtotal source** — compute backend-side from `r.order.items` (selected at `orders.ts:1106`) as Σ non-adjustment `unitPrice × quantity`, mirroring `src/services/order-items.ts:112,134-136`. Equals `SUM(order_items.line_total)`. Do NOT use `orders.orderTotal` (tax + shipping inclusive).
5. **Marketplace/store identity** — primary key `orders.storeId` (`orders.ts:1091`); `orders.clientId` (1084); marketplace name `raw.advancedOptions.source` (1111) as optional refinement only (null for ~32k orders). Not `source_provider` (always shipstation); not `orders.selling_fee` (real settled Walmart fees — different concept, leave untouched).
6. **New DTO fields** — `OrderRowMoneyDisplay.{productSubtotal, marketplaceFee, profit}`; facts `{productSubtotalAmount, marketplaceRule}`; surfaced through `bestRateWorkflow.money`; FE `getBackendRowMoney` (`web/src/components/Views/orders-row-display.tsx:380`) returns the three new values.
7. **FE columns** — add `marketplaceFee` + `profit` to `TABLE_COLUMNS` (`OrdersView.tsx:510-536`) and the `TableColumnKey` union (`orders-parity.ts:4-29`); add `getColumnSortKey` cases (`OrdersView.tsx:1529-1604`, blanks group with -1); add two `renderTableCell` cases (`OrdersView.tsx:8459/8664`) rendering `formatMoney` (PROFIT — when null; allow + style negative). The column picker / `resolveColumnPrefs` / `visibleColumns` iterate `TABLE_COLUMNS` generically → no change.
8. **Settings UI** — `web/src/components/Views/SettingsView.tsx` drawer: new `marketplace_fees` section modeled on `MarkupsSection.tsx` (add to `DrawerSectionId` union L108, `SECTION_PATH` L781, localStorage allow-list L804; render `MarketplaceFeesSection`). Edits client/store/marketplace + flat % or tiered (threshold / below% / atOrAbove%), PUTs `/settings/marketplace_fee_rules`. FE persists/reads only — no math.

**Design decisions (recommended defaults — confirm/adjust).**
- Scope precedence: store → client, marketplace optional refinement. ✅
- Tiered semantics: whole-subtotal flat-tier; ≥ $15 → 15%, < $15 → 8% (DJ-confirmed); threshold/rates editable.
- No-rate rows: show MARKETPLACE FEE (subtotal known pre-rating) with PROFIT — until a rate exists. ⚠️ Requires `buildOrderRowMoneyDisplay` to compute the fee independently of the rate (today it early-returns null when no rate — `rate-money.ts:154`).
- Real fee vs estimate: always show the configured estimate, even if a real `orders.selling_fee` exists.
- No matching rule: render — (no fee), not a zero-default.
- Default visibility: hidden by default, operator toggles per the views they want. Scope to Awaiting + Shipped only (not Cancelled).
- Negative profit: render the negative value (red), do not clamp to 0.
- Labels: "Marketplace Fee" + "Profit" (generic; can be "AMZ FEE" if preferred).

**Acceptance criteria.**
- An operator can set, per store (and optionally per marketplace), a flat % or a tiered fee in Settings; persists to `settings.marketplace_fee_rules`.
- For a matching order, MARKETPLACE FEE = the configured rule applied to the items-derived pre-tax subtotal (tiered uses ≥ threshold on the whole subtotal); PROFIT = subtotal − fee − best-rate-incl-markup, shown on Awaiting + Shipped, toggleable, hidden by default.
- Both columns backend-computed + gated by `canViewFinancials` (hidden for non-financial viewers); no FE-side fee math.
- No matching rule → —; no rate → PROFIT —; negative profit renders (red).
- `npm run typecheck` passes; Shipped column performs no shipped-data mutation (read-only); `orders.selling_fee`/Walmart settlement untouched.

**Guard (todo).** `scripts/ps-239-marketplace-fee-guard.ts` → `test:ps-239-marketplace-fee`: pure `computeMarketplaceFee` (flat; tiered boundary at exactly $15 → 15%; below → 8%); resolution most-specific-wins incl. KF-Goods two-store case; profit math incl. negative; fee/profit redacted when `!canViewFinancials`; subtotal excludes adjustment lines + matches `SUM(order_items.line_total)`.

**Lockdown.** None. The Shipped column is a pure read for analytics/reporting (explicitly allowed). No UPDATE/DELETE on shipped/cancelled rows or shipments.

## PS-241 — Rate Browser: live carrier fan-out skipped on open
**Status:** 🆕 New · **Type:** bug fix (rate-browse path; forward-only) · **Lockdown:** none (rate browsing; no shipped/cancelled mutation)
**Depends on:** — · **Related:** Recalculate-All live fan-out (commit 158fa6da), PS-123 cache reconciliation · **Evidence:** root-caused 2026-06-12 on order #1476 (HUGRAB), verified in code.

**Symptom.** Opening the Rate Browser on an order shows most carrier accounts with no rates and the header stuck at "Checking carriers… 2 with rates | live" indefinitely. On #1476 only ROCEL (UPS, 1 rate) and Shipp Carrier (16 rates) populated; the six ShipStation-side accounts (USPS Chase, GG6381, G19Y32, ORION, UPS by SS, FedEx One Balance) never resolved. Operator workaround: click "Refresh Live Rates" (sends `forceLive`).

**Root cause (verified).** On open, the modal runs a cached-only probe and only fans out live when the probe returns ≤ 1 carrier with rates (`web/src/components/RateBrowserModal.tsx:1187`). Two bugs make that heuristic misfire:
1. **The "cached-only" probe isn't cache-only.** The backend honors `cachedOnly` for ShipStation (returns empty on a cache miss — `src/services/rates.ts:1429-1446`) but then unconditionally calls `getDirectCarrierRatesForRateInput()` live (`src/routes/rates.ts:447-451`) — the flag is never passed to the direct-carrier path. So Shipp + direct UPS return fresh rates during a supposedly cached probe → the probe reports 2 carriers with rates.
2. 2 > 1, so the live fan-out is skipped — the six ShipStation accounts are never queried this session.
3. They're then left in a dead-end status: for a cached-only lookup the backend marks carriers with no cached rates as `'loading'` (`rates.ts:478-479`), and the FE keeps that status (`RateBrowserModal.tsx:1530-1531`). Nothing ever transitions `'loading'` → terminal. The header counts `'loading'` carriers as in-flight (`RateBrowserModal.tsx:1664-1671`) → permanent "Checking carriers…". Deterministic on every open for any client with a couple of direct-carrier accounts (HUGRAB has Shipp + direct UPS). (The HUGRAB Ground Saver banner is unrelated — that blocks a service, never whole accounts.)

**Contributing defects.**
- Partial cache poisoning: a live fan-out where most carriers fail still writes the partial result with the full 6-hour TTL; only fully-empty results get the short negative TTL (`rates.ts:1392`). A partial entry then feeds bug #1 for 6h.
- No timeouts: no AbortController / request timeout in any `src/connectors/carrier/*` connector, nor on the FE fetch — one hung provider hangs the whole `/rates/browse` response.
- Silent failure UX: the FE outer catch swallows network errors with no toast/banner (`RateBrowserModal.tsx:1549-1559`).
- Misleading "live" label: the response `source` is `filtered.length ? 'live' : 'live'` — a no-op ternary (`rates.ts:683`) — so the header says "| live" even when ShipStation contributed nothing.

**Fix.**
- **Phase 1 — correctness (the actual fix):**
  1. Pass/honor `cachedOnly` in the direct-carrier path of POST /rates/browse (`rates.ts:447`) so the probe is genuinely cache-only.
  2. Replace the ≤ 1 heuristic (`RateBrowserModal.tsx:1187`) with a **coverage check**: after the probe, fan out live for exactly the scoped `carrierIds` lacking cached results (the endpoint already accepts a `carrierIds` filter). Fan out whenever coverage is incomplete — never based on a count.
  3. Eliminate `'loading'` as a resting state: when no request is in flight, every carrier holds a terminal status (live/cached/unavailable/error); the header derives "Checking carriers…" only from actual in-flight requests.
- **Phase 2 — resilience:**
  4. Per-provider timeout (AbortController, ~15–20s) in each carrier connector; a timed-out carrier → error with a visible reason rather than hanging the response.
  5. Treat partial fan-out results like empty for caching (short negative TTL, or store per-carrier coverage in the cache row so the probe reports which carriers are missing).
- **Phase 3 — UX hardening:**
  6. Surface the outer-catch failure (toast/banner) instead of silently falling back to the seeded rate; add per-carrier "Retry".
  7. Fix the `source` ternary (`rates.ts:683`) so the header doesn't claim "live" when ShipStation contributed nothing.

**Acceptance criteria.**
- Opening the Rate Browser on a HUGRAB order with a cold/partial cache ends — with no clicks — with every scoped account in a terminal state and a header like "8 of 8 carriers checked · N with rates"; no permanent "Checking carriers…".
- Killing one provider mid-fan-out yields an `!`/error badge with a reason on that carrier only; the rest resolve.
- `npm run typecheck` passes.

**Guard (todo).** `scripts/ps-241-rate-browser-fanout-guard.ts` → `test:ps-241-rate-browser-fanout`: the cached probe never live-quotes direct carriers; the modal never rests in loading; incomplete coverage always triggers a targeted live fan-out for the missing `carrierIds`.

**Runtime confirmations for the dev (before coding).** Reproduce with DevTools open: exactly one POST /rates/browse with `cachedOnly:true` and no follow-up when ≥ 2 carriers return; inspect the `rate_cache` row for this order's fingerprint to see the partial carrier set; check server logs for direct-UPS scope/OAuth errors on GG6381/G19Y32/ORION (those may also be erroring — invisible when the carrierId↔account mapping misses).

**Lockdown.** None — rate browsing only; no shipped/cancelled order or shipments mutation.
