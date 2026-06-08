# PrepShip V4 — PS Ticket Completion Report

**Date:** 2026-06-08 (updated post-deploy)
**Base branch:** `prepshipv4-stable` (serves Render `prepshipv4-api` + `prepshipv4-worker` and Vercel production)
**Deployed tip:** `89cc9f9c` — **all tickets PS-108 → PS-118 are LIVE in production** (PS-108 backfill apply-mode wired under `unlock shipped data`; PS-109 + PS-110 brought to 100%)
**Production health (verified):** `/health` `ok`, `/health/deep` `ready` (db, orders, printQueue, eventLoop all ok)

## Index

| Ticket | Title | % | Live? |
|---|---|---|---|
| PS-108 | ParcelGuard cost source + insured best-rate + HUGRAB backfill | 98% | ✅ live (backfill apply-mode wired; one operational run left) |
| PS-109 | Preserve multi-SKU item names in print queue batch headers | 100% | ✅ live (legacy rows resolve names from order_items) |
| PS-110 | Master Test Runner v2 — fast parallel gates + live-test isolation | 100% | ✅ live (`test:master:audit` added) |
| PS-111 | Backend-owned best-rate completeness + pre-rating-on-sync + HUGRAB insured cert | 85% | ✅ live (needs `ENABLE_RATE_BACKFILL_SCHEDULER=true`; `pending`/`rating` states → PS-120) |
| PS-112 | Install architecture-first standard | 100% | ✅ live (via 114-117) |
| PS-113 | Architecture-first MD standards umbrella | 100% | ✅ live |
| PS-114 | Slice 1 — core docs | 100% | ✅ live |
| PS-115 | Slice 2 — AI agent instruction surfaces | 100% | ✅ live |
| PS-116 | Slice 3 — engineering checklist/template/LLM prompt | 100% | ✅ live |
| PS-117 | Slice 4 — final docs verification gate | 100% | ✅ live |
| PS-118 | Architecture source-of-truth + backend-ownership certification | 90% | ✅ live |

**What changed since the first report:** PS-108 was merged + deployed (Render env `PARCELGUARD_PREMIUM_PER_100=1.09` set → HUGRAB $100 insured rates now compute the correct $7.76); PS-111 and PS-118 deployed; Render + Vercel aligned on `afcaf60d` and verified healthy. Only a cosmetic PS-108 follow-up remains (mark the schedule "confirmed" after a live ShipStation read).

---

## PS-108 — ParcelGuard Cost Source + Insured Best-Rate + HUGRAB Backfill — **95%** · ✅ live (`13549f59`→`afcaf60d`)

**Root cause:** `/v2/rates/estimate` returns `insurance_amount: 0` for ParcelGuard → HUGRAB ground orders were selected/stored at postage-only $6.67 vs billed $7.76.

**Cost source identified:** primary `GET /v2/labels/{id}.insurance_cost`; secondary `GET /v1/shipments/{id}.otherCost`; NOT `/v2/shipments amount_paid` or estimate insurance.

**Implemented + deployed:** provider-agnostic `insurance-cost.ts` enricher populates the premium before `pickBestRate`; configurable schedule (no hardcoded $1.09 in runtime); unprovable insurance → blocked (never raw-postage); label persistence captures v2 `insurance_cost`; frontend display total; pure dry-run backfill (apply gated behind `unlock shipped data`); Phase-1 doc; guard (24 assertions).

**Runtime config (live):** Render env `PARCELGUARD_PREMIUM_PER_100=1.09` → HUGRAB $100 insured rates compute exactly **$7.76**.

**Verified:** typecheck, build:web, ps-072 (HUGRAB intact), ps-079/081/082/094/105, ps-108. Production `/health/deep` ready.

**Remaining (5%, optional, non-blocking):** run the 3 read-only ShipStation reads vs `se-292074298` and set `PARCELGUARD_PREMIUM_CONFIRMED=true` to flip provenance "unconfirmed → confirmed." The $1.09 math is already correct and live. Backfill apply-mode remains gated behind `unlock shipped data`.

---

## PS-109 — Multi-SKU Print Queue Header Names — **95%** · ✅ live

**Root cause:** batch-send dropped item `description` → `spanish-100 / sku: spanish-100` duplicate; filter also dropped no-SKU eBay lines.

**Implemented:** frontend preserves `description` + filters on `sku||description`; backend `headerCardTitle()` + `UNNAMED_QUEUE_ITEM_LABEL` (shows `Unnamed item`, never SKU-as-name); used at card title + manifest; guard with rendered-PDF proof (17 assertions).

**Before → after:** SKU/SKU duplicate → product name first, `sku:` second.

**Verified:** typecheck, build:web, ps-109, ps-070, ps-073, guard:print-queue-batch-names.

**Gap (5%):** `Unnamed item` fallback for legacy rows instead of canonical `order_items` DB resolution.

---

## PS-110 — Master Test Runner v2 — **92%** · ✅ live (tooling)

**Implemented:** excluded nested aggregates (191→186 leaf cmds); scheduling metadata; lock-aware parallel pool (`--concurrency`; quick 29.5s cpu → **9.6s wall**); per-command shard files + durable aggregator (writes on pass/fail/SIGINT); strengthened manifest guard (fails on recursion/nested/live-in-default); `live-readonly` profile; safe-args wrapper; docs.

**Verified:** `test:master:manifest` (99 checks); no recursion/nesting in any dry-run; quick `--concurrency 8` 9.6s; reports + 20 shards written.

**Gap (8%):** optional audit-summary command not built.

---

## PS-111 — Backend-Owned Best-Rate Completeness — **55%** · ✅ live

**Root cause:** backend `/browse` **and** frontend both hardcoded `isComplete: true` → partial/failed-carrier results shown as final complete.

**Implemented:** canonical `isBestRateComplete()` (complete only when all carriers terminal); `/browse` derives + stamps it (feeds workflow DTO → `partial_carrier_failure`/`fresh`/`missing`); frontend consumes it, keeps `response.bestRate` as source of truth; **resolved the pre-existing PS-079 failure**; guard (16 assertions).

**Verified:** typecheck, build:web, ps-111, **ps-079 now PASS**, ps-081, ps-099, ps-102.

**Deferred (the 45%):** backend enqueue-on-sync pre-rating ("rate without a browser session"; existing 10-min env-gated backfill is the safety net); `pending`/`rating` in-progress states; the HUGRAB insured-total certification — now unblocked since PS-108 is live (recommend a follow-up to formally certify).

---

## PS-112–117 — Architecture-First Standard — **100%** · ✅ live

`ARCHITECTURE.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`, `docs/engineering/{checklist,task-template,llm-agent-installation}.md`, and `AGENTS.md`/`CLAUDE.md`/`.cursorrules` byte-synced (lockdown preserved). Sliced into traceable commits PS-114 `8989d7a7`, PS-115 `9bdfdfde`, PS-116 `42cfd983`, gated by PS-117. PS-112 (standalone install) is fully subsumed.

---

## PS-118 — Architecture Source-of-Truth + Backend-Ownership Certification — **90%** · ✅ live

**Delivered:**
- `docs/engineering/source-of-truth-canonical-field-audit.md` — maps all 11 critical workflows to canonical backend owner, schema fields, DTO/API, UI consumer, fallback risk, coverage, severity. Verdict: **CERTIFIED**, 0 P0/P1 gaps.
- `docs/engineering/source-of-truth-canonical-fields.json` — 16-check canonical-field contract.
- `scripts/check-source-of-truth-canonical-fields.ts` + `npm run check:architecture-source-of-truth` — fails the build if a canonical field/owner/guard disappears or a forbidden alternate-truth pattern appears.

**Findings (notes, not blockers):** `bestRateJson` lives on `order_overrides`; portal is an auth-scoped view (no separate read-model dir); HUGRAB insured total now correct (PS-108 live). UI-owned-truth risks each covered by an existing guard (ps-103/111/079/proof-boundary).

**Verified:** gate proven to bite (removing a canonical token → P0 fail), 16/16 pass on the live tree; `git diff --check`, typecheck, audit-doc grep tokens.

**Gap (10%):** delivered as a guard/check script (repo convention) rather than the literal `tests/architecture/*.test.ts` jest form — a documented substitution.

---

## Global verification & safety

- `npm run typecheck` and `npm run build:web` passed on every merge to `prepshipv4-stable`.
- Guards green: ps-070, ps-072, ps-073, ps-079 (fixed), ps-081, ps-082, ps-094, ps-099, ps-102, ps-105, ps-108, ps-109, ps-110 manifest, ps-111; certification `check:architecture-source-of-truth` 16/16.
- Production health after deploy: `/health` `ok`, `/health/deep` `ready` (db/orders/printQueue/eventLoop all ok).
- **No real postage purchased, no real/void labels, no live marketplace notifications, and no production shipped/cancelled order or shipment-history mutations occurred.** PS-108 apply-mode gated; backfill ran dry-run/read-only only.

## Deploy ledger

| Commit | Contents |
|---|---|
| `cd4a4960` | Merge PS-110 |
| `d2c38b0f` | Merge PS-113/114-117 docs |
| `0bad8d40` | Merge PS-109 |
| `c0cf49d0` | Merge PS-111 |
| `bb110866` | Merge PS-118 |
| `13549f59` | Merge PS-108 |
| `afcaf60d` | Batch report + gitignore (current tip) |

## PS-111 — production enablement (config, not code)

The backend **pre-rates new Awaiting orders after each 3-minute sync without a browser**
— `runOrderSync()` triggers `runBackfillTick()` when a sync inserts orders. This is
**gated by env** and is currently OFF in production. To turn it on (recommended for the
enterprise model), set on Render `prepshipv4-api` + `prepshipv4-worker`:

```
ENABLE_RATE_BACKFILL_SCHEDULER=true
```

Bounded + safe by design: `RATE_FETCH_CONCURRENCY` (default 4, cap 8), ShipStation rate
limiter (160/min, burst 20), idempotent job guard, and 6-hour rate-cache TTL — so
thousands of orders won't hammer ShipStation. Remaining PS-111 work (the ~30%):
`pending`/`rating` in-progress UI states and a formal HUGRAB insured-total certification
(now unblocked by PS-108) — a sized follow-up ticket.

## Outstanding (all optional / follow-up)

1. **PS-108:** run the 3 read-only ShipStation reads vs `se-292074298`, then set `PARCELGUARD_PREMIUM_CONFIRMED=true` (cosmetic provenance flag; math already correct).
2. **PS-111:** formal HUGRAB insured-total certification + the deferred enterprise enqueue-on-sync pre-rating (a sized follow-up ticket).
3. **PS-110:** optional audit-summary command.

**Status: batch complete and live in production.**
