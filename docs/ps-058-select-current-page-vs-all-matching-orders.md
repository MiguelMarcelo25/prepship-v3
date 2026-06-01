# PS-058 - Add Select Current Page vs Select All Matching Orders Across Pages

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`
Status: New standalone task.

## Copy/Paste Codex Prompt

You are working in PrepShip V4.

Task ID: PS-058
Title: Add Select Current Page vs Select All Matching Orders Across Pages
Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`

## Context

DJ sent an Awaiting Shipment - HUGRAB screenshot where the table shows Page 1 of 2, 70 total, Per page 50. The current Select All control only selects the loaded page, so the operator can select 50 visible orders but cannot intentionally select all 70 matching orders across both pages.

DJ wants Select All to offer a clear choice:

1. Select the current page only.
2. Select the entire filtered/grouped result set across pages.

## Current Code Findings

- `web/src/components/Views/OrdersView.tsx` uses paginated `useOrders(...)`: `page` + `pageSize`, with `pageSize` default 50.
- `visibleOrderIds` is derived from `orderedFilteredOrders`, which is only the currently loaded page of orders.
- `toggleVisibleSelection()` only selects `visibleOrderIds`.
- The Select All toolbar label/check state is based on `visibleSelectedCount / visibleOrderIds.length`, so it has page-only semantics.
- `selectedOrdersForActions` is currently `orders.filter(...selectedIdSet...)`, which means off-page selected IDs would not have full order objects available for batch actions unless selection hydration/snapshots are added.
- SKU Sort/grouping also runs on `orderedFilteredOrders`, so group selection is currently page-local too.

## Core Invariant

When a filtered result has more orders than the current page, the operator must be able to intentionally select either:

1. Current page only, for example 50 visible orders.
2. All matching orders across all pages, for example all 70 HUGRAB Awaiting Shipment orders matching current filters/search/date/SKU/status/store.

The UI must make the scope unambiguous before batch actions such as Create + Print, Send to Queue, export/copy, or other selected-order workflows operate.

## Files To Inspect First

- `web/src/components/Views/OrdersView.tsx`
  - `useOrders` call and `page`/`pageSize` state
  - `orderedFilteredOrders`
  - `visibleOrderIds` / `visibleSelectedCount` / `allVisibleSelected` / `someVisibleSelected`
  - `toggleVisibleSelection`
  - `toggleSkuGroupSelection`
  - `selectedOrdersForActions`
  - `renderSelectionToolbar`
  - Select All toolbar button around `btnSelectAll`
  - pagination footer / page size controls
  - batch action paths: `handleBatchAction`, `queueExistingLabels`, Create + Print, Send to Queue
- `web/src/hooks/useOrders.ts`
  - query params and paginated response handling
- `web/src/lib/v2-apiClient.ts`
  - `fetchOrders` / `listOrders`
  - any export/list helper that already fetches all matching orders/IDs
- `src/routes/orders.ts`
  - `/orders` pagination/filter query
  - exact total handling
  - potential endpoint or mode for returning matching order IDs without full payload
- `web/src/components/Views/orders-grouping.ts`
  - SKU group semantics when SKU Sort is active
- Existing Orders browser specs/guards:
  - `web/e2e/orders-ux.spec.js`
  - `web/e2e/orders-column-integrity.spec.js`
  - any selection/batch action specs

## Implementation Requirements

1. Add explicit selection scope UX.
   - Replace or extend the current Select All checkbox/button so operators can choose between:
     - Select page (N visible / current page)
     - Select all matching results (total across pages, for example 70)
   - The screenshot case must clearly show "Select page 50" versus "Select all 70 matching orders" or equivalent.
   - If all matching results are selected, show a persistent banner/pill such as "70 matching orders selected" with a clear "Clear selection" action.
   - Indeterminate/check state must distinguish page-selected from all-matching-selected.

2. Select all matching filtered results across pages.
   - Must use the exact current filter scope:
     - order status, for example `awaiting_shipment`
     - active client/store, for example HUGRAB
     - search query
     - SKU filter
     - date filter/custom range
     - hide test orders / active store / test order visibility
     - SKU Sort/group context where applicable
   - Do not select unrelated clients/stores/statuses/dates.
   - Do not rely on only the currently loaded 50 rows.
   - Fetch matching IDs from the backend or use a safe all-pages query designed for selection. Prefer a lightweight IDs endpoint/mode over fetching huge full order payloads if the total can be large.

3. Preserve page-only selection.
   - The existing quick Select All should still allow selecting only the visible page when that is what the operator wants.
   - Page selection should continue to work with shift-click and individual checkbox selection.
   - Changing page should not silently lose an intentionally all-matching selection unless filters changed.

4. Handle selected order objects for batch actions.
   - If selected IDs include off-page orders, batch actions must not silently operate only on current page orders.
   - Either hydrate selected order snapshots/details as needed, or update batch APIs to safely operate by selected order IDs.
   - The selection toolbar count must reflect the true selected count, not only `selectedOrdersForActions.length` from the current page.
   - Queue/Create+Print must receive all selected IDs when all-matching selection is active.
   - If some selected IDs are no longer valid/editable, show an explicit result/error per order instead of dropping them.

5. SKU Sort / group selection behavior.
   - SKU Sort grouping is currently page-local. If SKU group headers are selectable, add clear scope behavior:
     - select this group on current page; and/or
     - select this whole SKU group across all matching pages, if supported.
   - In the screenshot case, the operator must not confuse a page-local HU-10 group with all HU-10/HUGRAB orders across the 70-result set.
   - If full cross-page group selection is not implemented in this task, the UI must label group selection as page-only and the main Select All Matching Results must still select all 70 filtered orders.

6. Filter-change safety.
   - If filters/search/date/store/status/SKU/page size changes while all-matching selection is active, either:
     - clear the selection with a toast explaining why; or
     - recompute selected IDs for the new filter only after explicit operator confirmation.
   - Never keep stale off-filter selected IDs hidden in the selection set.

7. Performance and limits.
   - Avoid loading thousands of full orders into the browser just to select IDs.
   - Use a backend endpoint/mode with reasonable max limits, pagination, or server-side job support if needed.
   - If the matching total is above a safe threshold, prompt/confirm and show the count before selecting.

## Guardrails

- Do not create labels, buy postage, send marketplace notifications, or mutate orders while testing selection.
- Do not weaken auth/RBAC/client/store scope/source-of-truth/shipped-cancelled protections.
- Do not re-enable unsafe shipped/cancelled mutation paths.
- Do not let a crafted frontend request select or mutate orders outside the current user's allowed client/store scope.
- Do not make this a frontend-only illusion where the toolbar says 70 selected but batch action only processes 50.
- Do not expose customer PII in test screenshots/logs.

## Required Verification

1. Unit/API tests prove:
   - all-matching selection ID fetch uses the same filters as `/orders` list.
   - active client/store/status/date/search/SKU filters are enforced.
   - unauthorized/cross-client IDs cannot be returned.
   - page-only selection remains page-only.

2. Browser/E2E tests prove the screenshot scenario:
   - Mock/fixture HUGRAB Awaiting Shipment has 70 matching orders and pageSize 50.
   - Page 1 shows 50 rows and footer shows 70 total / Page 1 of 2.
   - Operator can choose Select page 50.
   - Operator can choose Select all 70 matching orders.
   - Selection toolbar/banner shows 50 or 70 correctly depending on choice.
   - Navigating to page 2 keeps all-matching selection visible/accurate, or clearly shows selected state.
   - Changing filters clears/recomputes selection safely.

3. Batch action dry-run/mock tests prove:
   - When all 70 are selected, Create + Print / Send to Queue receives all 70 selected IDs or processes all 70 through the intended backend path.
   - It does not silently process only the current page's 50.
   - If a subset fails validation, the result reports exact failed IDs/counts.

4. SKU Sort/group tests prove:
   - Current-page group selection remains accurate.
   - Cross-page all-matching selection still works while SKU Sort is active.
   - UI labels do not imply page-local group selection is global unless it actually is.

5. Run at minimum and report exact output:
   - `npm run typecheck`
   - `npm run build:web`
   - `npm run test:orders-ux:browser`
   - `npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line` or the closest maintained Orders table spec
   - new focused selection/all-pages tests
   - any new API/contract tests added for matching-ID retrieval

## Definition Of Done

- On a result set with 70 total and page size 50, operator can select either 50 visible orders or all 70 matching orders.
- Selection counts and checkbox/banner state accurately reflect the chosen scope.
- Batch actions operate on the full chosen selection, including off-page orders, or explicitly block with a clear reason.
- Selection never leaks across filters/status/client/store/search/SKU/date scope.
- SKU Sort/group UI is clear about page-local vs cross-page selection.
- Required verification passes without live postage, labels, marketplace notifications, or unsafe order mutations.

## Return Format

Reply with:

1. Summary of files changed.
2. Exact UX added for Select page vs Select all matching.
3. How all matching order IDs are retrieved and scoped.
4. How off-page selected orders are passed to batch actions.
5. SKU Sort/group selection behavior.
6. Exact commands run and pass/fail results.
7. Confirmation that no live labels/postage/marketplace notifications or unsafe order mutations occurred.
