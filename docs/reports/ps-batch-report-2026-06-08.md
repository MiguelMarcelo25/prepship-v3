# PrepShip V4 — PS Ticket Completion Report

**Date:** 2026-06-08
**Base branch:** `prepshipv4-stable` (serves Render `prepshipv4-api` + `prepshipv4-worker` and Vercel production)
**Deployed tip:** `c0cf49d0`
**Author:** AI coding agent (Claude)

## Index

| Ticket | Title | % | Deployed |
|---|---|---|---|
| PS-108 | ShipStation ParcelGuard cost source + insured best-rate + HUGRAB backfill | 90% | ❌ held (blocked) |
| PS-109 | Preserve multi-SKU item names in print queue batch headers | 95% | ✅ live |
| PS-110 | Master Test Runner v2 — fast parallel gates + live-test isolation | 92% | ✅ live |
| PS-111 | Backend-owned awaiting best-rate completeness (status authority) | 55% | 🟡 Vercel live / Render pending |
| PS-112 | Install architecture-first standard | 100% | ✅ live (via PS-114-117) |
| PS-113 | Architecture-first MD standards umbrella | 100% | ✅ live |
| PS-114 | Slice 1 — core docs | 100% | ✅ live |
| PS-115 | Slice 2 — AI agent instruction surfaces | 100% | ✅ live |
| PS-116 | Slice 3 — engineering checklist/template/LLM prompt | 100% | ✅ live |
| PS-117 | Slice 4 — final docs PR/verification gate | 100% | ✅ live |
| PS-118 | Architecture source-of-truth + backend-ownership certification | 0% | not started |

---

## PS-108 — ShipStation ParcelGuard Cost Source + Insured Best-Rate Totals + HUGRAB Backfill

- **Completion:** 90%
- **Branch / commit:** `ps-108-parcelguard-insured-best-rate` @ `83b29fd6` (pushed to origin; **not** merged to stable)
- **Deploy:** held back — blocked on live ShipStation confirmation

**Root cause (confirmed):** ShipStation `POST /v2/rates/estimate` accepts `insurance_provider` + `insured_value` but returns `insurance_amount: 0` for ParcelGuard. That zero flowed through `rateTotal()` → `pickBestRate()` → the saved `bestRate` and the `selectedRateAuthorityKey` (which hashes `insurance_amount`), so PrepShip selected and stored a **postage-only** total ($6.67) for an order that bills $7.76 (the $1.09 ParcelGuard premium). The HUGRAB insurance *resolver* was already correct — only the premium **amount** was missing.

**Authoritative cost source identified (Phase 1):**
- Primary (post-purchase): `GET /v2/labels/{label_id}` → `insurance_cost.amount`.
- Secondary: `GET /v1/shipments/{id}` → `otherCost`.
- Do NOT trust: `/v2/shipments/se-{id}` `amount_paid`/`shipping_paid` (observed 0); estimate `insurance_amount` (0 for ParcelGuard).

**Implemented:**
- New `src/services/shipping-workflow/insurance-cost.ts` — provider-agnostic enricher; populates the authoritative premium into each insured rate **before** best-rate selection; configurable ParcelGuard schedule (no hardcoded $1.09 in runtime); unprovable insurance → rate flagged unresolved and **blocked** (never raw-postage fallback).
- `src/services/rates.ts` — enrich in `fetchLiveRatesWithDiagnostics`; `pickBestRate` + bulk-cached sanitize skip unresolved rates; cache version includes insurance-config fingerprint.
- `src/lib/shipstation/labels.ts` — capture the v2 `insurance_cost` (was discarded).
- `src/services/labels.ts` — persist premium to `shipments.otherCost` + full `selectedRateJson` audit (cost stays postage-only → no billing double count).
- `web/src/lib/v2-apiClient.ts` — display total includes the premium.
- New `src/services/shipping-workflow/parcelguard-backfill.ts` (pure planner) + `scripts/ps-108-parcelguard-cost-backfill.ts` (dry-run; apply gated behind `unlock shipped data`).
- Docs: `docs/ps-108-shipstation-parcelguard-cost-source.md`.
- Guard: `scripts/ps-108-parcelguard-insured-best-rate-guard.ts` (24 assertions).

**Before → after:** insured HUGRAB rate compared at postage-only $6.67 → compared at insured $7.76; premium-unprovable rates were silently under-charged → now blocked with an explicit carrier error.

**Verified:** typecheck ✅, build:web ✅, ps-072/079/081/082/094/105 ✅, ps-108 ✅. Dry-run backfill ran read-only (304 HUGRAB shipments scanned, 0 writes).

**Blocked / outstanding:** 3 read-only ShipStation calls vs `se-292074298` to confirm the cost field and pin the schedule (runtime default is an unconfirmed $1.00/$100). Apply-mode and deploy held.

**Safety:** no postage/labels/marketplace/shipped mutations; apply-mode refuses without the override.

---

## PS-109 — Preserve Multi-SKU Item Names in Print Queue Batch Headers

- **Completion:** 95%
- **Commit(s):** `7fa56a90` (merged to stable via `0bad8d40`)
- **Deploy:** ✅ live

**Root cause:** `buildQueueSendOrderPayload` re-mapped `multi_sku_data` to `{sku, qty}`, dropping the per-line `description` that `buildQueueAddPayload` had resolved. With no description, the header card title fell back to the SKU → the `spanish-100 / sku: spanish-100` duplicate. The same `.filter(item.sku)` also dropped no-SKU eBay lines that PS-070 intentionally keeps.

**Implemented:**
- `web/src/components/Views/OrdersView.tsx` — batch-send preserves `description`; filters on `sku || description`.
- `src/services/print-queue-identity.ts` — new `headerCardTitle()` + `UNNAMED_QUEUE_ITEM_LABEL`: a SKU line with no real name renders `Unnamed item` (never the SKU echoed as the product name).
- `src/services/print-queue.ts` — header card title + manifest combo use `headerCardTitle()`.
- Guard `scripts/ps-109-multi-sku-header-names-guard.ts` (17 assertions incl. a rendered-PDF proof).

**Before → after:** `spanish-100 / sku: spanish-100` → `My First 100 Spanish Words / sku: spanish-100` (and `Unnamed item / sku: X` for stripped legacy rows).

**Verified:** typecheck ✅, build:web ✅, ps-109 ✅, ps-070 ✅, ps-073 ✅, guard:print-queue-batch-names ✅.

**Gap (5%):** legacy stripped rows get the explicit `Unnamed item` fallback rather than canonical `order_items` DB name resolution (avoids a DB read on the PDF hot path).

**Safety:** fake fixtures only; no labels/postage/marketplace/shipped mutations.

---

## PS-110 — Master Test Runner v2: Fast Parallel Gates + Live-Test Isolation

- **Completion:** 92%
- **Commit:** `769a141f` (merged to stable via `cd4a4960`)
- **Deploy:** ✅ live (tooling; no runtime impact)

**Root cause:** `test:master*` recursion was already excluded, but `test:full-site-certification` + `test:full-workflow-certification` (nested aggregates duplicating typecheck/build/all browser specs) were still in the `master` profile (191 commands), and the manifest guard passed without catching it.

**Implemented:**
- `scripts/prepship-master-test-manifest.mjs` — exclude nested aggregates (explicit set + `3+ npm-run` heuristic; master 191→186); per-entry scheduling metadata (`concurrencySafe`, `resourceLocks`, `estimatedMs`, `requiresLiveData/ProviderAccess/OrderId`, `args`); `live-readonly` profile (routes `certify:external-shipped` out of default gates); safe-args wrapper (`smoke:shipping:test-label --fixture`).
- `scripts/prepship-master-test-manifest-guard.mjs` — fails on recursion, nested aggregates, or live/order/provider commands in default gates.
- `scripts/prepship-master-test.mjs` — lock-aware parallel pool (`--concurrency`); per-command shard JSON; aggregator always writes `latest.json/.md` + `run-<stamp>.*` (pass/fail/SIGINT); enriched report (group summary, slowest, locks); quick >5 min warning.
- `docs/testing/master-regression-suite.md` — tiered profile matrix, scheduler/live isolation, report interpretation.

**Before → after:** sequential `spawnSync` with nested duplication → leaf-only parallel gates; quick profile 20 cmds in **9.6s wall** (29.5s cpu, ~3× speedup), report + 20 shards written.

**Verified:** `test:master:manifest` ✅ (99 checks); all-profile dry-runs contain no `test:master*`/nested ✅; quick `--concurrency 8` 9.6s ✅; `latest.json/.md` present ✅.

**Gap (8%):** optional audit-summary command not built.

**Safety:** no labels/postage/marketplace/live mutation.

---

## PS-111 — Backend-Owned Awaiting Best Rate Pipeline + Status-First UI

- **Completion:** 55% (correctness core complete; enterprise pieces deferred)
- **Commit:** `68f4b5db` (merged to stable via `c0cf49d0`)
- **Deploy:** 🟡 Vercel auto-deploying; **Render Manual Deploy pending** (touches `routes/rates.ts`)

**Root cause:** completeness was faked on both sides — the backend `/browse` route **and** the frontend passive auto-rating hardcoded `isComplete: true` regardless of carrier diagnostics. A best rate found while a carrier was still `loading` or had `error`ed was stored/shown as a final complete rate.

**Implemented:**
- `src/services/shipping-workflow/best-rate-workflow-dto.ts` — new canonical owner `isBestRateComplete(carrierStatuses)`: complete only when every eligible carrier is terminal (no loading, no error); empty set is not complete.
- `src/routes/rates.ts` — `/browse` derives completeness from carrier diagnostics and stamps it onto the metadata + returned `bestRate`; flows into `buildBestRateWorkflowDto` so the workflow status reports `partial_carrier_failure`/`fresh`/`missing` correctly.
- `web/src/components/Views/OrdersView.tsx` — passive auto-rating consumes the backend-stamped completeness (`deriveBackendBestRateComplete`); keeps `response.bestRate` as the single source of truth (no divergent client pick).
- Resolved the pre-existing **PS-079** failure by superseding the stale assertion with stronger backend-authority coverage.
- Guard `scripts/ps-111-backend-rate-authority-guard.ts` (16 assertions).

**Before → after:** a partial/failed-carrier result displayed as a final complete best rate → it now reports partial and requires re-rate; PS-079 was failing → now passes.

**Verified:** typecheck ✅, build:web ✅, ps-111 ✅, **ps-079 now PASS** ✅, ps-081 ✅, ps-099 ✅, ps-102 ✅.

**Deferred:** backend enqueue-on-sync pre-rating ("rate without a browser session"; existing 10-min env-gated backfill is the safety net); `pending`/`rating` in-progress states (need an async queue); HUGRAB insured-total certification (gated on PS-108).

**Safety:** awaiting best-rate updates only; no shipped/cancelled mutation.

---

## PS-112 — Install Architecture-First Development Standard

- **Completion:** 100% (delivered via the PS-114-117 sliced track — same files)
- **Deploy:** ✅ live

The standalone PS-112 deliverable (ARCHITECTURE.md, CONTRIBUTING.md, PR template, `docs/engineering/*`, synchronized AGENTS/CLAUDE/.cursorrules) is fully produced by PS-114 through PS-117. No separate work required.

---

## PS-113 — Umbrella: Architecture-First MD Standards Upload Track

- **Completion:** 100%
- **Branch:** `ps-113-architecture-first-md-standards` (merged to stable via `d2c38b0f`)
- **Deploy:** ✅ live (docs/instruction only)

Executed as four traceable slices on one branch with one commit per slice:
- PS-114 `8989d7a7`, PS-115 `9bdfdfde`, PS-116 `42cfd983`, PS-117 verification gate.

---

## PS-114 — Slice 1: Core docs

- **Completion:** 100% · commit `8989d7a7`
- **Files:** `ARCHITECTURE.md` (Architecture-First Development Standard: core rule, canonical layer ownership, decision tree, anti-patterns, PR placement notes, DoD, safety boundaries), `CONTRIBUTING.md` (links ARCHITECTURE.md; requires placement notes + boundary tests + evidence; preserves safety rules).
- **Verified:** file/grep checks (`Architecture-First Development Standard`, `Do not fix only where the bug appears`, `Canonical owner`, `ARCHITECTURE.md`).

## PS-115 — Slice 2: AI agent instruction surfaces

- **Completion:** 100% · commit `9bdfdfde`
- **Files:** `AGENTS.md` (architecture-first rule added; shipped/cancelled lockdown preserved unchanged), mirrored **byte-for-byte** to `CLAUDE.md` + `.cursorrules` (also re-synced a prior `.cursorrules` drift), `.github/pull_request_template.md` (summary, **Architecture Placement**, safety checklist, testing, boundary tests, debt).
- **Verified:** `diff -q AGENTS.md CLAUDE.md` and `diff -q AGENTS.md .cursorrules` clean; `Architecture Placement` present in PR template; lockdown phrase intact.

## PS-116 — Slice 3: Engineering docs

- **Completion:** 100% · commit `42cfd983`
- **Files:** `docs/engineering/architecture-first-checklist.md` (pre-coding questions, PR review checklist, fast rejection signals), `task-template.md` (architecture placement, guardrails, verification, DoD, return format), `llm-agent-installation.md` (per-tool install guidance + exact copy/paste `Architecture-first instruction` prompt).
- **Verified:** grep checks (`What business decision or invariant is changing`, `Architecture placement`, `Architecture-first instruction`).

## PS-117 — Slice 4: Final verification gate

- **Completion:** 100%
- **Verified:** `git diff --check` clean; exactly the 9 docs/instruction files changed (zero runtime product code); AGENTS/CLAUDE/.cursorrules byte-identical; all 9 expected files present. PR step replaced by a direct push to `prepshipv4-stable` per DJ's "no PR" instruction.

---

## PS-118 — Architecture Source-of-Truth + Backend-Ownership Certification

- **Completion:** 0% — **not started.**
- The only remaining batch ticket. Self-contained runtime audit + machine-checkable certification + focused backend boundary tests. Ready to start on request.

---

## Global verification & safety

- `npm run typecheck` and `npm run build:web` passed on every merge to `prepshipv4-stable`.
- Guards green: ps-070, ps-072, ps-073, ps-079 (fixed), ps-081, ps-082, ps-094, ps-099, ps-102, ps-105, ps-108, ps-109, ps-110 manifest, ps-111.
- Production health after the PS-109 deploy: `/health` `ok`, `/health/deep` `ready` (db/orders/printQueue/eventLoop all ok).
- **No real postage purchased, no real/void labels, no live marketplace notifications, and no production shipped/cancelled order or shipment-history mutations occurred.** PS-108 apply-mode is gated; backfill ran dry-run/read-only.

## Outstanding actions

1. **Render Manual Deploy** `c0cf49d0` on `prepshipv4-api` + `prepshipv4-worker` (PS-111 backend) → verify `/health`.
2. **PS-108 ShipStation reads** vs `se-292074298` → pin ParcelGuard schedule → ship PS-108.
3. **Start PS-118** (architecture certification).
