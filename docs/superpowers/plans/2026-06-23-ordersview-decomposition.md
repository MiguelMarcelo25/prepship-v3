# OrdersView Decomposition Implementation Plan (PS-306 / PS-166 / PS-258)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `web/src/components/Views/OrdersView.tsx` from ~9,935 lines toward a ~1,500-line thin shell by extracting the remaining inline **stateful React hooks** into their own files — each extraction proven behavior-identical by a DOM byte-equality certification — so the three decomposition cards (PS-306 thin-client, PS-166 ~10 hooks + ~8 components, PS-258 hooks + DOM cert) advance together.

**Architecture:** The pure/presentational pieces are already extracted (`orders-filtered-sort.ts`, `orders-panel-state.ts`, `orders-view-filters.ts`, `OrdersTableCells.tsx`, `orders-rate-cells.tsx`, etc.). What remains inline are the `use*` hooks (state + effects + refs) that must run in React. We extract them **one at a time, verbatim**, behind a **DOM byte-equality cert** (Task 1) that fails on any rendered-output drift. Order is safest-first: pure-derivation hooks before stateful ones, lockdown-adjacent and money/label hooks last.

**Tech Stack:** React (function components + hooks), TypeScript (NOTE: `OrdersView.tsx` is `@ts-nocheck` — no type safety; verify by grep + cert), Playwright e2e (`web/e2e/*.spec.js`), the repo's `tsx`-based guard scripts, and `npm run test:master:all-safe` (490-test cert).

## Global Constraints

- **Behavior-identical only.** Every task is a *verbatim move* of existing code into a hook. No logic changes, no "improvements," no reordering of effects. The DOM parity cert (Task 1) must stay byte-identical after every task.
- **`@ts-nocheck` gotcha (repo memory):** a deleted import or a moved function that leaves a leftover call site PASSES typecheck + build and CRASHES at runtime. After every extraction run: `grep -n "<movedSymbol>" web/src/components/Views/OrdersView.tsx` and confirm zero stale references.
- **Shipped/cancelled LOCKDOWN (CLAUDE.md):** Do NOT touch the `isReadOnly` flag (OrdersView.tsx:918) or its consumers (row checkbox gate, batch-panel suppression, Select-All hidden). The passive-auto-rating effect carries an `unlock shipped data` override comment (OrdersView.tsx:1012) — that override is scoped to PS-016–021 only; a pure *move* of that effect is allowed, but changing its shipped/cancelled behavior is NOT. When a hook's logic touches `isReadOnly`, leave the `isReadOnly` read in the shell and pass its value INTO the hook as a prop; never relocate the flag itself.
- **Verification gate per task (all three must pass):** (1) `npm run typecheck`; (2) `npm run build:web`; (3) `npm run test:orders-dom-parity:browser` byte-identical; (4) `npm run test:master:all-safe` → 490/490. A task is not done until all four are green.
- **Frequent commits:** one commit per task, on branch `ps-166-ordersview-hooks` (off `prepshipv4-stable`). Commit message prefix: `PS-166/PS-306/PS-258: extract <hookName> (verbatim, DOM-parity proven)`. Do NOT push without explicit user approval.
- **Line-count is the gate metric:** after each task record `git show HEAD:web/src/components/Views/OrdersView.tsx | wc -l` in the commit body so the shrink is auditable.

---

## File Structure

**New files (one per extracted hook):**
- `web/src/components/Views/hooks/usePanelState.ts` — panel open/close + active-order/detail state.
- `web/src/components/Views/hooks/useOrdersFilterSort.ts` — the search/sku filter + ordered/grouped derivations (consumes the existing pure `orders-filtered-sort.ts` / `orders-grouping.ts` helpers).
- `web/src/components/Views/hooks/useOrdersSelection.ts` — selection set + visible-selection math (reads `isReadOnly` as an input, never owns it).
- `web/src/components/Views/hooks/usePrintQueueJobs.ts` — print-queue job state + persistent-queue polling.
- `web/src/components/Views/hooks/useOrderLabelActions.ts` — create/print/send-to-queue label action handlers.
- `web/src/components/Views/hooks/usePassiveAutoRating.ts` — the bounded passive live-rating effect + backend backfill handoff (highest risk; last).

**New test/cert files:**
- `web/e2e/orders-dom-parity.spec.js` — the DOM byte-equality cert (Task 1).
- `web/e2e/orders-dom-parity.spec.js-snapshots/` — committed baseline snapshots.

**Modified each task:** `web/src/components/Views/OrdersView.tsx` (remove the inline block, call the new hook), `package.json` (register the cert script in Task 1 only).

---

## The Extraction Recipe (every hook task follows this)

For a hook block currently inline in `OrdersView.tsx`:

1. **List the block's closure dependencies** — every component-scope value/state/ref/setter/function the block reads. These become the hook's **input parameters** (one `params` object).
2. **List the block's outputs** — every value/handler the rest of the component reads from the block. These become the hook's **return object**.
3. **Create the hook file** under `web/src/components/Views/hooks/` exporting `export function useX(params): { ...outputs }`. Move the block's `useState`/`useEffect`/`useRef`/`useMemo`/`useCallback` **verbatim** into the hook body; rename closure reads to `params.<name>`.
4. **Replace the inline block** in `OrdersView.tsx` with `const { ...outputs } = useX({ ...inputs })`.
5. **Grep for leftovers** (the `@ts-nocheck` gotcha): `grep -n "<eachMovedSymbol>"` in `OrdersView.tsx` → zero stale references.
6. **Run the per-task verification gate** (typecheck, build:web, DOM-parity byte-identical, cert 490/490).

---

### Task 1: DOM byte-equality certification (the safety net — PS-258 gate)

**This task ships NO OrdersView change. It is the prerequisite for every later task.**

**Files:**
- Create: `web/e2e/orders-dom-parity.spec.js`
- Create (generated, then committed): `web/e2e/orders-dom-parity.spec.js-snapshots/awaiting-table.txt`, `.../shipped-table.txt`
- Modify: `package.json` (add `"test:orders-dom-parity:browser"`)

**Interfaces:**
- Produces: the npm script `test:orders-dom-parity:browser` and committed baseline snapshots that every later task asserts byte-identical.

- [ ] **Step 1: Author the parity spec**, reusing the deterministic mock harness from `web/e2e/orders-column-integrity.spec.js` (same `clients`, `page.route` mocks for `apiOrigin`/supabase, base URL `http://127.0.0.1:5177`). It must render BOTH the Awaiting and Shipped tabs from a fixed fixture and snapshot the normalized orders-table DOM:

```js
import { test, expect } from 'playwright/test'

// Reuse the SAME mock setup as orders-column-integrity.spec.js (clients, orders
// fixture, page.route for apiOrigin + supabase). Copy that beforeEach verbatim so
// the rendered DOM is fully deterministic (no live calls, fixed dates via the
// fingerprint helper). Then snapshot the table HTML.

function normalize(html) {
  // Strip volatile bits so the snapshot pins STRUCTURE + content, not noise:
  return html
    .replace(/\s+data-reactid="[^"]*"/g, '')
    .replace(/ style="[^"]*"/g, '')          // inline styles are presentational, not behavior
    .replace(/\s{2,}/g, ' ')
    .trim()
}

for (const tab of [{ status: 'awaiting_shipment', snap: 'awaiting-table.txt' },
                    { status: 'shipped', snap: 'shipped-table.txt' }]) {
  test(`orders ${tab.status} table DOM is byte-stable`, async ({ page }) => {
    // ... copy the column-integrity mock/beforeEach, navigate to the tab ...
    await page.goto(`${baseUrl}/orders?status=${tab.status}`)
    await page.waitForSelector('[data-testid="orders-table"]')
    const html = await page.locator('[data-testid="orders-table"]').innerHTML()
    expect(normalize(html)).toMatchSnapshot(tab.snap)
  })
}
```

- [ ] **Step 2: Confirm the table has a stable selector.** Grep: `grep -n 'data-testid="orders-table"' web/src/components/Views/OrdersView.tsx`. If absent, add `data-testid="orders-table"` to the existing top-level table/grid container element (the ONLY allowed OrdersView edit in this task — additive attribute, no logic). Re-run the cert after to confirm no behavior change.

- [ ] **Step 3: Generate the baseline:** `npx playwright test web/e2e/orders-dom-parity.spec.js --update-snapshots`. Expected: 2 snapshots written under `orders-dom-parity.spec.js-snapshots/`.

- [ ] **Step 4: Re-run without update to confirm determinism:** `npx playwright test web/e2e/orders-dom-parity.spec.js`. Expected: PASS (both tabs byte-identical on a clean re-run). If flaky, widen `normalize()` to strip the remaining volatile attribute and regenerate.

- [ ] **Step 5: Register the script** in `package.json`: `"test:orders-dom-parity:browser": "playwright test web/e2e/orders-dom-parity.spec.js --reporter=line",`

- [ ] **Step 6: Commit**

```bash
git add web/e2e/orders-dom-parity.spec.js web/e2e/orders-dom-parity.spec.js-snapshots package.json web/src/components/Views/OrdersView.tsx
git commit -m "PS-258: add OrdersView DOM byte-equality certification (safety net for hook extraction)"
```

---

### Task 2: Extract `usePanelState` — ⚠️ DEFERRED (mis-scoped; do LAST)

**2026-06-23 scoping finding:** this is NOT a clean isolated block. Panel "openness" is derived, not state; `panelOrder`/`panelDetail` appear ~195× (lines 1427→9872), `panelForm` ~88×, with ~48 setter call sites inside label/rate/async handlers, and the form-init effect drags in Task 6/7 (label/rate) surface. It also consumes `orderedFilteredOrders` (Task 3) and `selectedOrderIds` (Task 4). **Re-sequenced: extract Task 3 (filter/sort) and Task 4 (selection) FIRST, then revisit panel/form extraction last with a contract written against the real symbols.** Original (optimistic) scoping below, kept for reference:

#### (original) Extract `usePanelState`

**Files:** Create `web/src/components/Views/hooks/usePanelState.ts`; Modify `web/src/components/Views/OrdersView.tsx`.

**Interfaces:**
- Consumes (inputs): the panel-related `useState`/`useRef` declarations and their setters currently inline (search OrdersView for `panelOrder`, `panelDetail`, `panelOpen`, and the existing pure helpers already imported from `orders-panel-state.ts`).
- Produces (outputs): `{ panelOrder, panelDetail, panelOpen, openPanel, closePanel, ... }` — exact names taken verbatim from the current inline declarations.

- [ ] **Step 1:** Apply the Extraction Recipe to the panel-state block. The pure transitions already live in `orders-panel-state.ts`; this hook wraps only the React state/refs that call them. Inputs are minimal (no `orders`, no `isReadOnly`).
- [ ] **Step 2:** Run the verification gate (typecheck · build:web · `test:orders-dom-parity:browser` byte-identical · `test:master:all-safe` 490/490).
- [ ] **Step 3:** `grep -n "panelOrder\|panelDetail\|setPanel" web/src/components/Views/OrdersView.tsx` → only the hook-call destructure remains, no stale setters.
- [ ] **Step 4: Commit** `PS-166/PS-306/PS-258: extract usePanelState (verbatim, DOM-parity proven)` with the new `wc -l` in the body.

---

### Task 3: Extract `useOrdersFilterSort` (pure derivation)

**Files:** Create `web/src/components/Views/hooks/useOrdersFilterSort.ts`; Modify `OrdersView.tsx:1358-1419`.

**Interfaces:**
- Consumes: `{ orders, orderDetailsById, hideTestOrdersInAllAwaiting, searchQuery, skuFilter, skuSortActive, preSkuSortSnapshot, sortState, shippingAccounts }` plus the already-imported pure helpers (`computeOrderedFilteredOrders`, `groupOrdersBySku`, `getActiveItems`, `isTestOrder`, `buildSearchText`, `getPrimarySkuLabel`, `getTotalQuantity`, `isEbayOrder`, `getSortValue`, `getOrderSortTimeMs` — import these directly in the hook, do not pass).
- Produces: `{ searchedOrders, orderedFilteredOrders, skuOrderGroups, visibleOrderIds }` (verbatim from lines 1358–1419).

- [ ] **Step 1:** Move the four `useMemo`s (1358–1419) verbatim into the hook; their dependency arrays are unchanged. This is pure derivation — no refs, no effects, no `isReadOnly`.
- [ ] **Step 2:** Verification gate (4 checks green).
- [ ] **Step 3:** `grep -n "searchedOrders\|orderedFilteredOrders\|skuOrderGroups" OrdersView.tsx` → only the hook destructure + downstream reads remain.
- [ ] **Step 4: Commit** with new `wc -l`.

---

### Task 4: Extract `useOrdersSelection` (LOCKDOWN-ADJACENT — read `isReadOnly`, never own it)

**Files:** Create `web/src/components/Views/hooks/useOrdersSelection.ts`; Modify `OrdersView.tsx` (the selection block: `selectedOrderIds`, `selectedIdSet`, `updateSelection`, `visibleSelectedCount`, `allVisibleSelected` ≈ lines 1416–1424 + the `updateSelection(...)` handlers ≈ 2355–2449).

**Interfaces:**
- Consumes: `{ visibleOrderIds, isReadOnly }` + the snapshot helpers. **`isReadOnly` stays declared at OrdersView.tsx:918 and is passed IN** — do not move it (lockdown).
- Produces: `{ selectedOrderIds, selectedIdSet, updateSelection, clearSelection, visibleSelectedCount, allVisibleSelected, ... }` (verbatim names).

- [ ] **Step 1:** Apply the recipe. Keep every Select-All / checkbox gate that branches on `isReadOnly` byte-identical — the hook receives `isReadOnly` and the branches are unchanged.
- [ ] **Step 2:** Verification gate + run `npm run test:order-editable-lockdown` and `npm run test:orders-ux:browser` explicitly (selection/lockdown coverage) in addition to the cert.
- [ ] **Step 3:** `grep -n "isReadOnly" OrdersView.tsx` → the declaration at :918 and the prop pass-in remain; confirm no lockdown consumer moved into the hook file unintentionally.
- [ ] **Step 4: Commit** with new `wc -l`.

---

### Task 5: Extract `usePrintQueueJobs`

**Files:** Create `web/src/components/Views/hooks/usePrintQueueJobs.ts`; Modify `OrdersView.tsx` (queue state + the persistent-queue polling effect; the pure parsers already live in `orders-queue-parsers.ts` / `orders-persistent-queue-job.ts`).

**Interfaces:**
- Consumes: the queue-related state/refs + the already-extracted parser/job helpers (import directly).
- Produces: `{ queueEntries, queueJobId, enqueue, ... }` (verbatim names from the inline block).

- [ ] **Step 1:** Apply the recipe; the polling `useEffect` and its cleanup move verbatim (preserve the interval/cleanup exactly).
- [ ] **Step 2:** Verification gate + `npm run test:carrier-print-to-queue:browser`.
- [ ] **Step 3:** Leftover grep.
- [ ] **Step 4: Commit** with new `wc -l`.

---

### Task 6: Extract `useOrderLabelActions` (MONEY/LABEL — extra scrutiny)

**Files:** Create `web/src/components/Views/hooks/useOrderLabelActions.ts`; Modify `OrdersView.tsx` (create/print/send-to-queue handlers ≈ 3500–3620).

**Interfaces:**
- Consumes: `{ orders, orderDetailsById, queue API from usePrintQueueJobs, ... }` (exact set determined by recipe Step 1).
- Produces: `{ handleCreateLabel, handlePrint, handleSendToQueue, ... }` (verbatim handler names).

- [ ] **Step 1:** Apply the recipe. These handlers may call label/postage endpoints — move verbatim, change NO request payload or guard. Do not alter duplicate-label prevention or selected-rate-proof calls.
- [ ] **Step 2:** Verification gate + `npm run test:print-queue-invalid-label` + `npm run test:expedited-shipping`.
- [ ] **Step 3:** Leftover grep.
- [ ] **Step 4: Commit** with new `wc -l`.

---

### Task 7: Extract `usePassiveAutoRating` (HIGHEST RISK — last; lockdown-override-adjacent)

**Files:** Create `web/src/components/Views/hooks/usePassiveAutoRating.ts`; Modify `OrdersView.tsx` (the constants 412–426, refs 944–950, the gate 1211–1219, and the effect `runPassiveAutoRating` ≈ 4900–5150).

**Interfaces:**
- Consumes: `{ orders, currentStatus, passiveRatingAccountsEnabled, planSettledAutoRate, startRecalculateAllBestRates, <the rate-setter handlers>, ... }` (full set per recipe Step 1 — there are several refs and setters; enumerate ALL of them before moving).
- Produces: nothing the table reads synchronously beyond the rate updates it already dispatches; expose `{ retryPassiveRating }` if a handler is read by the shell (verify).

- [ ] **Step 1:** Apply the recipe with maximum care: move `PASSIVE_LIVE_BEST_RATE_*` constants, `passiveLiveBestRateCountRef`, `passiveBackfillStartedRef`, the timeout/error handling (note the `unlock shipped data` comment at 1012 — preserve it verbatim in the moved code), and the `runPassiveAutoRating` effect including its `cancelled` guard and `void runPassiveAutoRating()` invocation. Preserve effect dependency array EXACTLY.
- [ ] **Step 2:** Verification gate. The DOM-parity cert + the full 490 cert are the safety net here; if either drifts, REVERT and re-do — do not "adjust" the snapshot.
- [ ] **Step 3:** `grep -n "passive\|Passive\|runPassiveAutoRating" OrdersView.tsx` → only the hook call remains.
- [ ] **Step 4: Commit** with new `wc -l`.

---

### Task 8: Re-measure + thin-shell assessment (PS-306 closeout checkpoint)

- [ ] **Step 1:** Record final `git show HEAD:web/src/components/Views/OrdersView.tsx | wc -l`. Compare to the 9,935 baseline and the ~1,500 target.
- [ ] **Step 2:** If still well above ~1,500, list the next inline blocks to extract (data-fetch hook, column-prefs hook, remaining sub-components) as follow-up tasks — do NOT over-claim PS-166/PS-306 done until the shell meets the gate.
- [ ] **Step 3:** Update the three Trello cards (PS-306/166/258) with the real new line count + which hooks landed; promote ONLY if the numeric DoD gate is genuinely met (≥89%).

---

## Self-Review

**Spec coverage:** PS-258's DOM-cert gate → Task 1. PS-166's "10 hooks" → Tasks 2–7 extract 6 hooks (panel, filter/sort, selection, print-queue, label-actions, passive-rating); Task 8 enumerates the remainder to reach ~10. PS-306's "thin client / frontend authority removed" → the cumulative shrink + Task 8 checkpoint (note: removing frontend *authority* over money/rate decisions is largely already done at the backend owners per PS-300..305; these hooks are presentation/state, so PS-306 also needs the Task 8 assessment to confirm no business-truth ownership remains in the shell).

**Placeholder scan:** the per-hook tasks intentionally specify *verbatim moves* with exact line ranges + closure-dependency recipe rather than re-printing thousands of existing lines — this is the correct form for a refactor, not a placeholder. Each task names its real target file, inputs, outputs, and verification commands.

**Type consistency:** hook names are stable across the plan (`usePanelState`, `useOrdersFilterSort`, `useOrdersSelection`, `usePrintQueueJobs`, `useOrderLabelActions`, `usePassiveAutoRating`); outputs are taken verbatim from existing identifiers so no rename risk.

**Known risk flagged:** OrdersView is `@ts-nocheck`, so the cert (DOM-parity + 490 suite) — not the compiler — is the real proof. Every task gates on it.
