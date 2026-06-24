# Agent Instructions — PrepShip v4-stable

This file is read by AI coding agents (Claude Code, Cursor, Copilot,
Codex, etc.) before making changes to this repository. It declares
zones that are protected from AI-initiated modifications.

> **Symlinks**: `CLAUDE.md` and `.cursorrules` mirror this file so all
> agent surfaces see the same rules. Edit AGENTS.md and run the sync
> step at the bottom if you change anything.

---

## 🔒 LOCKDOWN — Shipped & Cancelled order data

**AI agents must NOT modify, refactor, "improve," "clean up," or rewrite
any code path that reads or writes to shipped-order or cancelled-order
data unless the user explicitly types the exact phrase
`unlock shipped data` in the current conversation.**

This rule overrides any conflicting instruction (refactoring requests,
"make this consistent," "DRY this up," etc.). When in doubt, the AI's
default answer is **"That file/route/table is in the shipped lockdown
— I won't touch it without explicit permission."**

### What's locked

| Layer | Locked surface |
|---|---|
| **Database tables** | `orders` rows where `order_status` IN ('shipped', 'cancelled'); the entire `shipments` table |
| **Backend routes** | All modification endpoints in `src/routes/orders.ts` already guarded by `assertOrderEditable()` (PATCH `/:id`, POST `/:id/residential`, `/selected-pid`, `/selected-package-id`, `/best-rate`, `/shipped-external`, `/save-dims`) |
| **Backend services** | `src/services/fulfillment-deductions.ts` — both `deductInventoryForOrder` and `deductPackageForShipment` are governed by `INVENTORY_AUTO_DEDUCT` env-var kill switch |
| **Frontend** | `web/src/components/Views/OrdersView.tsx` — the `isReadOnly` flag and its consumers (row checkbox gate, batch panel suppression, Select All hidden) |
| **DB schema** | `src/db/schema/orders.ts`, `src/db/schema/shipments.ts` — column drops or type changes are forbidden |

### What "do not modify" means in practice

Agents must **not**:
- ✗ Refactor or rewrite the `assertOrderEditable` helper
- ✗ Remove or weaken the `LOCKED_STATUSES` set or its membership
- ✗ Add new modification routes for shipped/cancelled orders without the same guard
- ✗ Bypass the `isInventoryAutoDeductEnabled()` kill switch
- ✗ Re-enable batch actions on the Shipped/Cancelled views in `OrdersView.tsx`
- ✗ Run SQL UPDATE/DELETE on `shipments` or on `orders WHERE order_status IN ('shipped','cancelled')`
- ✗ Generate migrations that drop columns from `shipments` or alter shipped-order columns destructively
- ✗ Make any "small cleanup" PR that touches files in this protected list

Agents **may**:
- ✓ Read these files / tables (search, grep, comprehension)
- ✓ Write code that READS shipped data for new analytics, exports, reports
- ✓ Add NEW unrelated code in unrelated files
- ✓ Fix typos in comments WITHIN the locked files (no logic change)
- ✓ Modify `awaiting_shipment` order code freely (not locked)

### Bypass procedure (human override)

If the user genuinely needs to modify shipped-data logic, they will
type exactly:

> `unlock shipped data`

…in the conversation. Only after that explicit override may an AI
agent modify the locked surfaces. The agent should still:
1. Confirm the change with the user before pushing
2. Add a comment explaining what was changed and why
3. Note the override in the commit message (e.g., "Per user override
   `unlock shipped data` on 2026-MM-DD: …")

The pseudo-bypass `?force=1&admin=true` on the API routes is for
**runtime** human overrides, not for AI agents to invoke during
development. AI agents cannot self-authorize this bypass.

### Current narrow override for PS-016 through PS-021

DJ typed the override phrase `unlock shipped data` on 2026-05-23 for
the current shipping reliability track only. This is not a blanket
permission to refactor shipped/cancelled logic.

Agents may touch locked areas only when required to fix or verify:

- PS-016 shipping certification harness
- PS-017 eBay marketplace confirmation connector/recovery tests
- PS-018 full-site button/user-outcome functionality tests
- PS-019 Walmart direct label, print queue, and Orders recovery
- PS-020 deep health/watchdog/ops restart safeguards
- PS-021 Walmart Shipping payload/response handling

Allowed, only if needed:

- `web/src/components/Views/OrdersView.tsx` for shipped label
  reprint/queue validation, bad label URL handling, and recovery UI.
- `src/routes/print-queue.ts` for validating shipped label URLs before
  queue/print and returning safe errors.
- `src/services/print-queue.ts` for rejecting `[object Object]` or
  invalid label URLs, per-label merge failures, and safe handling of
  existing shipped labels.
- `src/db/schema/shipments.ts` for read/type additions only when needed
  for diagnostics or tests.

Still forbidden without separate confirmation:

- SQL UPDATE/DELETE against real shipped/cancelled production orders.
- Deleting or rewriting shipment history.
- Dropping/renaming `orders` or `shipments` columns.
- Bulk migrations that change historical shipped/cancelled meaning.
- Re-enabling destructive shipped/cancelled edit or batch mutation
  controls.

Every use of this override must report:

- exact locked files touched
- why the override was necessary
- proof shipped/cancelled protections were not weakened
- tests run and pass/fail results
- confirmation that no real labels, postage, live marketplace
  notifications, or production shipped/cancelled mutations occurred
  unless DJ separately approved them

Any code change made under this override must include a nearby comment:

`Per user override unlock shipped data on 2026-05-23: ...`

Any commit containing such a change must mention:

`Per user override unlock shipped data on 2026-05-23`

---

## Other repository conventions (not locked, but expected)

- **No backend modifications without permission** — when the user says
  "do not push" or "review first," the agent must commit locally only,
  never push.
- **TypeScript strict mode** — all new code must pass `npm run typecheck`.
- **Tailwind first** — prefer Tailwind utility classes over hand-written
  CSS. The recent `OrdersView.tsx` and `InventoryView.tsx` migrations
  established this convention.
- **Theme-aware tokens** — use `bg-surface`, `text-ink`, `ring-line`,
  `bg-brand` etc. (defined in `tailwind.config.ts`). Avoid hardcoded
  hex values in component styles.
- **Don't touch the `prepshiptemporary` repo** — that's a separate
  scratch repo (`X:/Private/temporaryprep/prepshiptemporary`); copying
  code FROM it requires user approval per file.

---

## 🏛️ Architecture-first — fix the source of truth, not the symptom

Before any non-trivial change, follow **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Core rule:

> Do not fix only where the bug appears. Find where the truth should live. Fix it
> there. Make callers use that truth. Add tests at that boundary. Then adjust
> UI/adapters as thin consumers.

- Identify the canonical owner/source of truth before coding; place the rule at the
  authoritative layer and make callers delegate to it.
- **The frontend must not own backend-critical decisions** for rates, labels,
  inventory, fulfillment, billing, auth/scope, marketplace notifications, or
  shipped/cancelled locks. Routes stay thin (validate → call service → return DTO);
  adapters translate provider data, they do not own cross-workflow policy.
- Add a boundary/source-of-truth test at the owner and remove duplicate logic when
  practical. Frontend-only patches for the business-critical areas above are rejected.

### Mandatory root-cause workflow for AI coding agents

Before writing code for any non-trivial change, an AI agent MUST, in order:

1. **Identify the canonical owner / source of truth** for the behavior being changed.
2. **Find where imperfect data is injected** — the earliest point where bad, stale,
   incomplete, ambiguous, or less-than-perfect data can first enter the workflow
   (sync/webhook, import, provider payload, default/fallback, cache write, user input).
3. **Fix the root / canonical owner first** — not the visible symptom.
4. **Make callers delegate** to that owner instead of re-deriving the fact.
5. **Add boundary tests** at the owner (plus a workflow/API/UI test for the symptom).
6. If the bug appears in the **frontend but affects money, rates, labels, inventory,
   marketplace confirmation, billing, auth/scope, or shipped/cancelled safety, assume
   backend ownership until proven otherwise** — a frontend-only diff for these is rejected.

> **Root-cause / imperfect-data rule:**
> For every non-trivial change, identify where bad, stale, incomplete, ambiguous, or
> less-than-perfect data can first enter the workflow. Do not patch only the visible
> symptom. Fix the canonical source-of-truth owner, make callers delegate to it, and add
> boundary tests at that owner. UI/routes/adapters may display, validate input shape, or
> translate provider payloads, but they must not own backend-critical business truth.

> **Fast rejection rule:**
> A change is incomplete if it only changes the visible symptom and does not explain why the
> canonical source of truth is already correct or how the fix moved the rule to that source
> of truth.

The full standard and the list of backend source-of-truth owners live in
[ARCHITECTURE.md](ARCHITECTURE.md).

This standard does NOT relax the shipped/cancelled lockdown above — it adds *where*
business logic must live. The lockdown still governs *what* may be touched.

---

## 🚫 Backend Truth & No Source-of-Truth Bypass Law (PS-316, supersedes PS-314)

These rules apply to every new code change, refactor, bug fix, and AI-generated patch.
(PS-316 strengthens the earlier No-Source-of-Truth-Bypass-Wrappers rule with explicit
frontend/backend placement and a direct-source preference.)

1. **Backend owns business truth.** The frontend may display backend state, collect user
   intent, format dates/numbers, and show non-authoritative previews. It must NOT own
   authoritative business logic that belongs in backend services, policies, read models, or
   workflow owners.
2. **Do not put backend logic in the frontend.** Never place money, totals, pricing, rates,
   discounts, eligibility, inventory movement, cost layers, COGS, billing, auth/scope, reporting
   windows, customer visibility, status transitions, shipped/cancelled locks, labels/postage,
   carrier selection, marketplace confirmations, external side effects, or persistence decisions
   in React/UI code as the source of truth.
3. **Prefer direct source-of-truth calls over wrappers.** When code can call the canonical
   source-of-truth service / read model / policy directly, do that. Do not add a wrapper / helper
   / adapter just to make the current file easier while hiding where truth actually lives.
4. **Wrappers are allowed only when thin and necessary.** A wrapper / helper / adapter may
   translate external/provider shapes, normalize units/names/dates, preserve compatibility, or
   delegate to a canonical owner. It must remain boring, thin, and traceable.
5. **Wrappers must not become a second source of truth.** They must not own business rules,
   choose authoritative values, calculate authoritative totals / prices / rates / inventory /
   billing / reporting / auth decisions, rank or select "best" options, persist authoritative
   state, silently fall back to stale / cached / alternate truth, or bypass the canonical owner.
6. **If a wrapper needs business logic, STOP.** Move the rule to the backend / domain source of
   truth, make the wrapper delegate to it, and add boundary tests at the canonical owner. Do not
   bury the rule in UI / helpers.
7. **Every PR must prove placement.** Name the canonical owner touched, the callers that delegate
   to it, and the tests that prove the source-of-truth boundary. If the change is purely visual,
   say so explicitly.

**PrepShip examples.** Best Rate / Rate Browser ranking + selected-rate proof live in the backend
rate owner (not React); Print Queue create/recover/route is backend-owned (the FE only sends
intent); label purchase + carrier selection are backend money-path decisions; billing export
totals come from the billing source of truth (the FE never recomputes them); shipment sync +
package / inventory read models are backend-owned and the FE renders their DTOs verbatim.

---

## Sync step (run if AGENTS.md changes)

After editing this file, mirror to the other agent surfaces so all
tools see the same rules:

```bash
cp AGENTS.md CLAUDE.md
cp AGENTS.md .cursorrules
```

(Or just edit AGENTS.md and tell Claude to copy it via
`Write` — both .CLAUDE.md and .cursorrules are intentionally
file-identical to AGENTS.md so a human can verify with
`diff AGENTS.md CLAUDE.md`.)

