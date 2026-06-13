# PrepShip V4 — PS Ticket Registry

Living index of the shipping/architecture PS tickets on branch `prepshipv4-stable`.
Source of truth for *requirements* is the task board (Discord/Notion); this file is
the **code-side registry** — what each ticket requires, what's landed, the guard
that protects it, and the verification commands.

> Repo: `drprepperusa-org/prepship-v4` · Branch: `prepshipv4-stable`
> Assignee: `<@714064895963955211>`

## Status legend
- ✅ **Done** — implemented + a passing guard exists.
- 🟡 **Blocked** — designed/audited, waiting on an approval gate.
- 🆕 **New** — specced, not started.
- 🔒 **Lockdown** — touches the shipped-data / postage-purchase boundary; requires the
  exact phrase `unlock shipped data` typed in-conversation before an AI agent may edit
  the locked surfaces (per `AGENTS.md`/`CLAUDE.md`). The PS-016–021 override does **not** cover these.

## Index

| Ticket | Title | Status | Depends on | Guard | Blast radius |
|---|---|---|---|---|---|
| PS-100 | Architecture Debt + Source-of-Truth Audit | ✅ Done | — | `docs/architecture-debt/*` | n/a (docs) |
| PS-102 | Backend Best-Rate Workflow DTO + Awaiting consumption | ✅ Done | PS-100 | `test:ps-102-best-rate-workflow-dto` | medium |
| PS-103 | Remove frontend rate-fingerprint authority + mismatch UX | ✅ Done | PS-100, PS-094/095/102 | `test:ps-103-remove-frontend-fingerprint-authority` | high 🔒 |
| PS-104 | Preserve selected-rate proof through Print Queue batch-send | ✅ Done¹ | PS-100/103 | `test:batch-send-proof-forwarding` | high 🔒 |
| PS-105 | Backend-owned rate quote snapshot ID (replace carried proof) | 🟡 Blocked | PS-104 | `test:ps-105-backend-rate-snapshot-id` (todo) | high 🔒 |
| PS-106 | Direct-store vs ShipStation carrier eligibility + Settings toggle | 🆕 New | PS-083, PS-100 | `test:ps-106-*` (todo) | high 🔒 |
| PS-107 | Master regression test runner + bug-capture manifest | 🆕 New | — | `test:master:manifest` (todo) | low (test infra) |
| PS-196 | Cache-first Awaiting Shipment Best Rate display after reload | 🆕 New | PS-099, PS-102, PS-111 | `test:ps-196-*` (todo) | medium (display) — proof boundary must not weaken 🔒-adjacent |
| PS-197 | Rate Browser effective HUGRAB insurance + raw-vs-label-safe parity | 🆕 New | PS-108, PS-123–126, PS-170 | `test:ps-197-*` (todo) | medium (display/diagnostics) — HUGRAB policy must not weaken 🔒-adjacent |
| PS-221 | Package resolution single source of truth | 🆕 New | — | `test:ps-221-package-source-of-truth` (todo) | high 🔒 (label/shipment persistence) |
| PS-222 | Package pricing + catalog data (enable box billing) | 🆕 New | pairs w/ PS-221 | `test:ps-222-package-pricing-present` (todo) | low (catalog/pricing data) |
| PS-223 | Bulk packaging-default seeding (rule engine) | 🆕 New | PS-221 | `test:ps-223-packaging-rule-engine` (todo) | medium (awaiting defaults) |
| PS-224 | Package / inventory negative-stock reconciliation | 🆕 New | — | `test:ps-224-negative-stock` (todo) | medium 🔒-adjacent (deduct kill-switch) |
| PS-225 | Delete superseded packaging code | 🆕 New | **PS-221 landed+verified** | re-anchored guards (todo) | high 🔒 (dead-code on `labels.ts`) |
| PS-226 | Add HTTP security headers (CSP/XFO/nosniff/…) | 🆕 New (P1) | — | headers check (todo) | medium (deploy config) |
| PS-227 | Remediate dependency vulnerabilities (2 crit/7 high) | 🆕 New (P1) | — | `npm audit` gate (todo) | medium (supply chain) |
| PS-228 | Regression-proof RLS (sole anon-key wall) | 🆕 New (P1) | — | RLS advisor in security-readiness (todo) | medium now / HIGH if regresses |
| PS-229 | Sanitize carrier connector error messages | 🆕 New (P2) | — | (todo) | low (info leakage) |
| PS-230 | JWT defense-in-depth on Vercel serverless | 🆕 New (P2) | — | (todo) | medium (auth hardening) |
| PS-231 | Audit-log + rate-limit the `?force=1` override | 🆕 New (P2) | PS-234 | (todo) | medium (override) 🔒-adjacent |
| PS-232 | Low-severity hardening bundle (Supabase + hygiene) | 🆕 New (P2) | — | (todo) | low |
| PS-233 | **Cross-tenant access** on label/shipment routes | 🆕 New (**P0 CRIT**) | — | `test:label-shipment-scope-enforcement` (todo) | CRITICAL (multi-tenant) 🔒 |
| PS-234 | Append-only audit log table + event writers | 🆕 New (P3) | — | `test:audit-logging` (todo) | high (forensics infra) |
| PS-239 | Marketplace Fee + Profit columns (backend-computed) | 🆕 New | PS-177 | `test:ps-239-marketplace-fee` (todo) | medium (display/financials) |
| PS-240 | Scope on ORDER & CLIENT write paths (split PS-233) | 🆕 New (P1) | PS-233 | `test:*-scope-enforcement` (todo) | high (multi-tenant writes) |
| PS-241 | Rate Browser live carrier fan-out skipped on open | 🆕 New | — | `test:ps-241-rate-browser-fanout` (todo) | medium (rate browse) |

> **PS-221 → PS-241 full cards:** `docs/ps-tickets/ps-221-ps-241-new-cards.md` (packaging
> source-of-truth epic, security review 2026-06-13, marketplace-fee + rate-browser cards).
> `PS-235`–`PS-238` are unused (the PS-233 write-path split shipped as **PS-240**).

¹ PS-104 shipped this session as the `/print-queue/batch-send` proof-forwarding fix.
Its guard is currently named `test:batch-send-proof-forwarding` (not `ps-104-*`).
A rename/alias to `test:ps-104-print-queue-selected-rate-proof-pass-through` is a small follow-up.

---

## PS-100 — Architecture Debt + Source-of-Truth Audit ✅
**Type:** audit / mapping only — no runtime behavior change.
**Landed:** `docs/architecture-debt/` — `README.md`, `hotspot-baseline.md`,
`source-of-truth-matrix.md`, `workflow-traces.md`, `duplication-register.md`,
`refactor-backlog.md`.
**Output:** measured hotspot baseline, domain source-of-truth matrix, high-risk
workflow traces, duplication register, and the ranked follow-up backlog that
PS-102…105 are drawn from.
**Guardrails:** read-only; no postage/labels/marketplace/live mutations; no secrets/PII in docs.

## PS-102 — Backend Best-Rate Workflow DTO + Awaiting consumption ✅
**Goal:** move Best-Rate display authority out of the frontend into a backend-owned,
read-only DTO; consume it on the Awaiting Shipment table only. No purchase-behavior change.
**Key surfaces:** `src/services/shipping-workflow/best-rate-workflow-dto.ts`
(`buildBestRateWorkflowDto`), `orders` list/detail DTO, `web/.../orders-parity.ts`
(`classifyAwaitingRateCellStateWithWorkflow`).
**DTO states:** `missing | fresh | stale | mismatched_request | partial_carrier_failure | blocked | unknown`;
`sourceConfidence`; `carrierStatuses`; `allowedActions` (display hints only).
**Guard:** `npm run test:ps-102-best-rate-workflow-dto`.
**Session note:** extended this session — `fresh` only maps to `ready` when the frontend can
actually render the rate; otherwise it shows a spinner (reload re-rate fix).

## PS-103 — Remove frontend rate-fingerprint authority ✅
**Goal:** backend is the only authority for rate request fingerprint/proof; frontend passes
backend-issued proof unchanged and never fabricates one. Replace vague "fingerprint mismatch"
with the actionable re-rate message.
**Operator message:** `Rate changed or expired. Re-rate this order before creating the label.`
**Guard:** `npm run test:ps-103-remove-frontend-fingerprint-authority`.
**Lockdown:** 🔒 touches label-purchase proof enforcement.

## PS-104 — Preserve selected-rate proof through Print Queue batch-send ✅
**Root cause (confirmed):** `/print-queue/batch-send` Zod schema (`queueSendLabelBody`) did not
accept `selectedRateProof`, and the per-order reconstruction omitted it → durable worker called
`createLabelV2` with `selectedRateProof: undefined` → `missing_current_fingerprint`.
**Fix:** schema now accepts `selectedRateProof` (`.passthrough()`); route forwards
`order.label.selectedRateProof` into `QueueSendOrderInput.label`; existing-label queue/reprint
stays proof-free.
**Files:** `src/routes/print-queue.ts`.
**Guard:** `npm run test:batch-send-proof-forwarding` *(rename to `ps-104-*` is a follow-up)*.
**Lockdown:** 🔒 (label-purchase boundary).

## PS-105 — Backend-owned rate quote snapshot ID 🟡 Blocked
**Goal:** stop the frontend carrying full `selectedRateProof` internals; backend returns an
opaque ID; backend resolves + validates it before any provider call. Keep server-side proof the
final authority; keep `selectedRateProof` as a compatibility fallback during migration.
**Designed approach (pending confirmation):**
- **ID name:** `rateQuoteId` (opaque hash of the snapshot key) + `selectedRateKey` (rate authority key).
- **Storage:** reuse the existing **`rateCache`** table (PK `cacheKey` = request fingerprint, holds all
  `rates` + `bestRate` + `fetchedAt`) as the snapshot store; add `expiresAt` + an opaque-hash column.
- **Validation:** resolve `rateQuoteId` → snapshot → find rate by `selectedRateKey` → require snapshot fresh
  **and** the *current label payload's* recomputed fingerprint `=== cacheKey`. Else block with the re-rate message.
- **Compatibility:** label APIs accept `rateQuoteId` **or** legacy `selectedRateProof`; prefer the ID.
**Blocked on:** the `unlock shipped data` override for PS-105 (touches `labels.ts`, `print-queue.ts`,
`api/carriers/labels.ts`, `orders.ts` best-rate route) **and** confirmation of the ID name + storage choice.
**Guard (todo):** `scripts/ps-105-backend-rate-snapshot-id-guard.ts` → `test:ps-105-backend-rate-snapshot-id`.
**Lockdown:** 🔒.

## PS-106 — Direct-store vs ShipStation carrier eligibility + Settings toggle 🆕
**Business rule:** ShipStation carrier accounts may only be used when the order/store is
**ShipStation-sourced**. Direct-store orders (Walmart/eBay/direct connectors) must be blocked from
ShipStation carriers at rate listing, `/rates/browse`, Best Rate, Create Label, and Print Queue —
unless explicit source linkage proves ShipStation sourcing. ShipStation credentials / `rateSourceClientId`
alone do **not** make ShipStation carriers eligible for a direct-store order.
**Configurable:** Settings-tab control; default safe/ON. Modes: `enforce | audit_only | disabled`
(backend is authoritative; frontend toggle alone is not).
**Primitive:** one canonical backend `carrier-family eligibility` function applied at every boundary;
block reason e.g. `shipstation_carrier_blocked_for_direct_store_order`.
**Pre-run guard evidence (from spec):** most adjacent guards PASS; **known blocker**
`test:ps-098-shipping-purchase-boundary` fails on frontend proof pass-through (related but not the same invariant).
**Files:** `src/services/rates.ts`, `src/routes/rates.ts`, `src/services/labels.ts`,
`src/lib/shipstation/credentials.ts`, `api/carriers/rates.ts`, print-queue batch-send, Settings schema/UI,
`web/.../OrdersView.tsx`.
**Guard (todo):** `test:ps-106-*`.
**Lockdown:** 🔒 (purchase boundary) + Settings persistence.

## PS-107 — Master regression test runner + bug-capture manifest 🆕
**Goal:** one master runner (`scripts/prepship-master-test.*` + a manifest) that runs the ~195 safe
`test:*`/`guard:*`/`smoke:*`/`certify:*` commands between commits, **continues past failures** (no `&&`
hiding later gates), and classifies each by coverage type (`static_guard | unit_or_logic | mocked_smoke |
browser_e2e | workflow_certification | manual_live_gated`) and safety level.
**Excluded by default:** any `:apply`, real-label smoke, live marketplace/SQL repair — marked
`manual_live_approval_required`, never run by default.
**Scripts (todo):** `test:master:quick`, `test:master`, `test:master:browser`, `test:master:shipping`,
`test:master:all-safe`, `test:master:manifest`.
**Bug-capture policy:** every future bug fix adds/updates a manifest regression entry; a guard
(`test:master:manifest`) verifies manifest command names exist in `package.json`.
**Artifacts:** `test-results/master/latest.{json,md}` + timestamped history; doc at
`docs/testing/master-regression-suite.md`.
**Lockdown:** none (test infra) — but must never run live/mutating commands by default.

## PS-196 — Cache-first Awaiting Shipment Best Rate display after reload 🆕
**Reported:** DJ, 2026-06-10 — reloading Awaiting Shipment makes all Best Rates reload
instead of showing saved rates immediately; caching appears broken.
**Root cause (from read-only DB check 2026-06-10):** saved rates are NOT gone
(29,150 of 29,292 awaiting orders have `best_rate_json`), but most legacy saved rows lack
newer proof/freshness metadata (only 41 have `requestFingerprint`/`cacheKey`, 29 have
`rateQuoteId`/`selectedRateKey`) → display gating rejects them → spinner/live re-rate.
**Core fix:** separate two decisions the gating currently conflates —
1. **displayable saved rate** (render last saved amount/carrier/account immediately;
   legacy rows with positive amount + display fields qualify, shown as saved/stale/refreshing), vs
2. **purchase-authorized selected rate** (Create Label / Print Queue still require
   current backend-issued proof/fingerprint/`rateQuoteId` — unchanged, never weakened).
Backend DTO (`BestRateWorkflowDto` or adjacent) exposes the distinction; all four
awaiting cells (Best Rate / Carrier / Shipping Account / Ship Margin) consume the same
canonical state; cache-first on reload, bounded background refresh, explicit
Recalculate still forces live; terminal states never spin forever.
**Key surfaces:** `src/routes/orders.ts`, `best-rate-workflow-dto.ts`,
`order-rate-dto.ts`, `rates.ts`, `rates-backfill.ts`, `web/.../orders-parity.ts`,
`web/.../OrdersView.tsx`.
**Guards (todo):** backend displayable-vs-purchase guard, frontend reload display guard,
cache-first no-forced-live guard; run alongside `test:ps-102-best-rate-workflow-dto`,
`test:best-rate-saved-display-contract`, `test:ps-099-orders-rate-cache-first`,
`test:recalculate-best-rate-strict`, `test:batch-recalculate-best-rate`,
`test:shipping-roundtrip-certification`.
**Full task packet:** `docs/ps-196-cache-first-awaiting-best-rate-display.md`.
**Lockdown:** 🔒-adjacent — display-only change; selected-rate proof enforcement and the
label-purchase boundary must remain untouched.

## PS-197 — Rate Browser effective HUGRAB insurance + raw-vs-label-safe parity 🆕
**Reported:** DJ/Hermes investigation, 2026-06-10. **Not covered by PS-196** (that's
Awaiting-table reload display; this is Rate Browser parity diagnostics).
**Symptom:** order `#1461` (HUGRAB, ROCEL C81F70, UPS Ground) shows **$8.95** in PrepShip
Rate Browser vs **$7.93** in ShipStation's manual estimate for identical inputs
(ZIP `92801-5567`, residential, 35 oz, 12×10×3, no confirmation) → operators assume
PrepShip is wrong.
**Root cause (confirmed read-only):** PrepShip's UI shows `Insurance: None` while the
backend request/cache key applies the HUGRAB default **ParcelGuard $100**
(`ip=parcelguard`, `iv=10000` in the matching cache key) — so PrepShip shows a
**label-safe HUGRAB-policy rate** while ShipStation shows a plain no-insurance manual
estimate. The price difference is correct policy; the UI just doesn't say so.
**Core fix:**
1. Rate Browser displays the **backend-effective insurance** (e.g. "Effective insurance:
   ParcelGuard $100 — HUGRAB default"), never bare `Insurance: None` when policy applies.
2. Rate row exposes amount components + provenance (`shipping/confirmation/insurance/
   other_amount`, effective provider/value, final total) from backend DTO.
3. Operator-safe parity diagnostic (redacted request facts: ZIP+4, residential, weight,
   dims, confirmation, effective insurance, account nickname, service code, cache/live,
   rate source) classifying mismatches as `effective_policy_diff` rather than generic.
4. Optional/preferred: explicit raw-manual vs label-safe comparison mode (label-safe stays
   the operational default); document as follow-up if too large.
**Must not change:** HUGRAB $100 coverage requirement, Ground Saver/SurePost block,
selected-rate proof/fingerprint enforcement; no secrets/PII/raw provider payloads in
diagnostics; live ShipStation reads (if any) are `/rates/estimate` read-only.
**Key surfaces:** `src/services/rates.ts`, `src/lib/shipping-service-eligibility.ts`,
`src/services/shipping-workflow/{insurance-cost,rate-fingerprint}.ts`,
`src/routes/rates.ts`, `web/src/components/RateBrowserModal.tsx`,
`web/src/lib/v2-apiClient.ts`.
**Guards (todo):** `test:ps-197-*` (HUGRAB fixture request facts + effective-insurance
DTO/UI + `effective_policy_diff` parity classification); run alongside
`test:ps-108/123/124/125/126/170` insurance guards + `test:best-rate-saved-display-contract`.
**Full task packet:** `docs/ps-197-rate-browser-effective-insurance-parity.md`.
**Lockdown:** 🔒-adjacent — display/diagnostics only; HUGRAB insurance policy and the
label-purchase boundary must remain untouched.

---

## Recent bug-fix regression guards on this branch (for PS-107 manifest seeding)
- `test:ebay-nosku-title-fallback-grouping` — eBay no-SKU lines group/label by title.
- `test:batch-header-package-size` — Print Queue batch header shows selected package size.
- `test:daily-orders-trend-count` — Daily Orders Trend plots order count, not value.
- `test:daily-orders-trend-total-line` — Trend includes a "Total (all stores)" aggregate line.
- `test:single-sku-default-qty-scope` — single-SKU weight/dims default scoped to the saving order's qty.
- `test:awaiting-carrier-badge-nickname-fallback` — Carrier column resolves EasyPost/Shipp from nickname.
- `test:inventory-history-table-pagination` — Inventory History uses the shared Table (sort/resize/paginate/sticky bar).
- `test:carrier-enable-disable-label` — carrier toggle reads Enable/Disable.
- `test:batch-send-proof-forwarding` — PS-104 proof forwarding.

## Standing guardrails (all tickets)
No real postage/labels/voids/marketplace notifications; no live shipped/cancelled mutations or
`shipments` SQL writes in tests; no force/bypass/override proof flags; do not weaken auth/RBAC/
client-store/carrier scope, secret redaction, duplicate-label, or the shipped/cancelled lockdown;
never expose secrets/tokens/raw provider payloads/raw labels/customer PII/cross-client data.
