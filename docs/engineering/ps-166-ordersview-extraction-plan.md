# PS-166 — OrdersView extraction plan (11,604 → ~3,000-line shell, zero behavior change)

Drafted 2026-06-13. Status: PLAN ONLY — execution stays gated on DJ's live verification
(PS-202 canary) for Waves 2+; Wave 0/1 are zero-behavior-change and may start earlier if
DJ opts in.

## The measured facts (origin/prepshipv4-stable @ 0b5f971b)

- `web/src/components/Views/OrdersView.tsx` = **11,604 lines**, `@ts-nocheck`.
- Lines ~262–1668: **~1,400 lines of module-level PURE helpers** (formatters, item/order
  accessors, test-rate builders, persistent-queue-job localStorage machinery).
- Line 1668: `export default function OrdersView(` — one component of ~9,900 lines:
  **40 useState, 41 useEffect, 21 useMemo**, batch flows (~4,400–7,700), render helpers
  (renderOrderCell ~8,135), JSX (~8,600–11,604: batch panel, search bar, table, side panel).
- **82 guard scripts + 8 Playwright specs** pin strings/DOM in this file. This — not the
  line count — is the real constraint.
- 9 sibling modules already extracted by prior tickets (orders-row-display,
  orders-panel-state, orders-parity, orders-grouping, orders-queue, orders-view-filters,
  orders-recalculate-all, order-shipping-display, OrdersPrintQueueDrawer): the epic
  CONTINUES an established, proven pattern (PS-154/155/157 used the same playbook).

## Threat model — how this refactor breaks production if done wrong

1. **The @ts-nocheck runtime-crash class** (hit before: OrdersView/RatesView): a deleted
   or moved symbol with a leftover call site passes typecheck AND build and crashes at
   runtime. Typecheck protects NOTHING inside this file.
2. **Pin breakage**: 82 guards + 8 e2e specs assert exact source strings and exact DOM
   (#ordersTable, tr.order-row, #row-{id}, td[data-col="…"], .expedited-badge,
   .ps-shipping-pill, [data-testid="off-tab-status-pill"], #searchClear, the PS-078
   label-payload block, PS-193/194/191/210 source shapes…).
3. **The shipped/cancelled lockdown surface**: the `isReadOnly` line (~1992) with its
   override comment (DJ's 2026-05-06 unlock state) and its five consumer sites, plus the
   batch-panel lockdown comment (~8685). LOCKED per AGENTS.md.
4. **State/effect cluster interdependence**: 40 states + 41 effects sharing refs;
   freshly-built gates live here (PS-193 dirty-flag persist gate, PS-194 mergedEntryIds
   seeding, PS-191 prompt-only retry, PS-210 search scope). Splitting a cluster across
   files reorders renders and silently changes behavior.

## Non-negotiable execution rules

- **R1 — micro-slices, never a rewrite.** One extraction per commit. Each commit is
  individually shippable and individually revertible. If a slice fights back, STOP and
  split it smaller — never push through.
- **R2 — the leftover-grep rule (the @ts-nocheck antidote).** After EVERY move: grep the
  remaining OrdersView for every moved/deleted symbol name → must be only the new import.
  Mechanical, every slice, no exceptions. New modules are born **strict** (no
  @ts-nocheck) — the refactor monotonically INCREASES type safety; only the shrinking
  shell stays unchecked until the end.
- **R3 — DOM contract freeze.** Markup moves VERBATIM. Every id/class/data-attr the e2e
  suites pin renders byte-identical from its new home. No "while I'm here" markup edits.
- **R4 — guard re-anchor in the SAME commit.** Before each slice: grep scripts/ +
  web/e2e/ for every string in the moving region; re-anchor each pin to the new home,
  same strength, documented rationale (the PS-209/PS-214 discipline). A slice is not
  done while any guard is red.
- **R5 — lockdown surfaces do not move.** The isReadOnly line + comment + consumers and
  the batch-panel lockdown comment stay in OrdersView verbatim unless DJ separately
  approves a move. No semantics change either way.
- **R6 — per-slice QA battery:** build:web + typecheck + R2 grep + the orders guard
  battery (ps-191, ps-193, ps-194, ps-210, ps-078-connector-matrix, ps-057, ps-036/056
  display guards, print-queue set) + FULL shipping-roundtrip-certification. Playwright
  e2e at every WAVE boundary (DJ's local/CI flow).
- **R7 — clusters move whole.** A state + its effects + its refs + its handlers move
  together into one custom hook, or not at all.
- **R8 — zero logic changes ride along.** Any cleanup/bugfix discovered mid-slice gets
  its own ticket. Extraction commits contain ONLY moves + imports + pin re-anchors.

## Wave plan (blast-radius order)

| Wave | What moves | New homes | Est. lines out | Risk |
|---|---|---|---|---|
| **0** | Nothing — pin inventory + baseline | Script dumps every guard/e2e string referencing OrdersView internals into a checklist; freeze the DOM-contract list; record baseline cert run | 0 | none |
| **1** | Module-level pure helpers (262–1668): formatters (dates/weight/age/palette/carrier/service), item+order accessors (normalizeItems/getPrimaryItem/getMergedItems/getShipTo/searchText), test-rate builders, persistent-queue-job localStorage machinery | `orders-formatting.ts`, `orders-items.ts`, `orders-test-fixtures.ts`, `orders-persistent-queue-job.ts` (all strict) | ~1,300 | LOW — zero hooks, zero JSX, pure moves |
| **2** | Function-shaped render helpers + leaf JSX: renderOrderCell + cell renderers; batch panel JSX; search bar + pills | `OrdersTableCells.tsx`, `OrdersBatchPanel.tsx`, `OrdersSearchBar.tsx` | ~1,500–2,000 | MEDIUM — prop threading; heavy e2e pins (R3/R4 critical) |
| **3** | Self-contained hook clusters (R7): column prefs+resize; daily-stats rollover; selection + select-all-matching (PS-195/210 pins!); queue job + drawer state (PS-194 pins!) | `use-orders-column-prefs.ts`, `use-orders-daily-stats.ts`, `use-orders-selection.ts`, `use-orders-queue-job.ts` | ~2,000–2,500 | MEDIUM-HIGH — one cluster per commit, nothing else |
| **4** | THE SIDE PANEL — panel JSX + its state/effects together (PS-193 dirty-gate, PS-191 retry, dims→rate→label workflow heart) | `OrdersSidePanel.tsx` + `use-orders-panel.ts` | ~2,000+ | HIGH — the riskiest slice; alone in its commit; full e2e after |
| **5** | The table body (header + rows) | `OrdersTable.tsx` | ~1,000–1,500 | MEDIUM-HIGH — e2e hammers this DOM |
| **6** | Closeout: shell = composition + orchestration (~2,500–3,500 lines). STRETCH (own ticket if heavy): remove @ts-nocheck from the shell | — | — | LOW |

Estimated total: **12–16 commits**, each pushed ×3, each cert-green. End state:
~3,000-line orchestration shell + ~10–12 new strict modules, byte-identical behavior
and DOM.

## Sequencing vs the PS-202 gate

The epic was parked pending DJ's live verification — that gate STAYS for Waves 2+
(they touch rendered workflow surfaces). Wave 0 and Wave 1 are zero-behavior-change
pure moves and may run earlier at DJ's option for momentum.

## Decisions needed from DJ before execution

1. Approve the wave order (or reorder).
2. Start Wave 0+1 now, or hold everything for the PS-202 canary?
3. Confirm lockdown surfaces stay in-place (R5) — moving them would need a separate
   explicit approval.
4. Cadence confirmation: one slice = one commit = triple push, report per wave (not per
   slice) unless something goes red.
