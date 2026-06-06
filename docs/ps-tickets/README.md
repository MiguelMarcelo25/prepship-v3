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
