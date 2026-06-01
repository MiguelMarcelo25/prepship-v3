# PS-052 - Fix SKU Sort Grouping to Require Exact SKU + Quantity Composition

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Status: New standalone task. This is related to Orders SKU Sort/grouping, not label/rate work.

## Context

DJ reported that the Orders SKU Sort/grouping function is grouping the wrong orders together.

Screenshot example: the group header shows `Booster-gel-001`, `Qty 2`, `22 Orders`, but rows underneath include different compositions, such as:

- Booster Gel x2 / SKU `Booster-gel-001` x2
- Leeds Line V2 x2 / SKU `HU-10` x2
- Mixed orders like Booster Gel + Leeds Line V2

This is wrong. Grouping must require exact SKU and exact quantity per SKU, not merely total quantity, primary SKU, first matching SKU, or any order that contains the SKU.

Correct behavior examples:

- `Booster-gel-001 x2` is one group. It must include only orders whose active item composition is exactly `Booster-gel-001:2`.
- `HU-10 x2` is a different group. It must not appear under `Booster-gel-001 x2`.
- `Booster-gel-001 x2 + HU-10 x1` is a third group. It must include only orders with exactly 2 Booster Gel and exactly 1 Leeds Line V2.
- `Booster-gel-001 x1 + HU-10 x1` is different from `Booster-gel-001 x2` and different from `HU-10 x2`, even though total quantity can be 2.

Core invariant:

`SKU grouping key = exact multiset of active line-item SKUs and per-SKU quantities.`

Do not group by total quantity alone. Do not group by primary SKU alone. Do not group by "contains SKU".

## Files To Inspect First

- `web/src/components/Views/OrdersView.tsx`
  - SKU Sort state/UI, group header rendering, item extraction, `getActiveItems`, group row membership, group count.
- `web/src/hooks/v2Hooks.ts`
  - Orders query params and pagination/threading if SKU sort/grouping needs backend support.
- `web/src/hooks/index.ts`
  - Re-export path for `useOrders`.
- `src/routes/orders.ts`
  - `/orders` server-side pagination/filter/sort behavior.
  - Existing SKU filtering logic and `order_items` joins/exists predicates.
- Any tests under `web/e2e/`, `web/src/**/__tests__`, `src/**/__tests__`, or existing Orders SKU sort tests.

## Implementation Requirements

### 1. Build An Exact Composition Key

- For each order, derive active line items.
- Normalize SKU for grouping consistently with existing Orders item display/filter rules: trim whitespace, preserve actual SKU for display, and avoid grouping blank/missing SKU items with real SKU items.
- Sum quantities for duplicate lines with the same SKU on the same order.
- Sort SKU keys deterministically so item order does not affect grouping.
- The group key should look conceptually like `Booster-gel-001:2|HU-10:1`.
- Include only active/non-adjustment/non-cancelled line items according to the same semantics used by Orders display. If those semantics are ambiguous, inspect existing `getActiveItems` / backend item mapping and mirror the current visible-row item logic.

### 2. Fix Group Membership

- A row belongs to a group only if its exact composition key matches the group header composition key.
- Do not include orders just because they contain the header SKU.
- Do not include orders just because their total quantity matches the header Qty.
- Do not include mixed-SKU orders under a single-SKU header unless the header explicitly shows the exact mixed composition.

### 3. Fix Group Headers

- Group header must display enough information to make the composition clear.
- For single-SKU groups: display SKU plus exact quantity, for example `Booster-gel-001 - Qty 2`.
- For multi-SKU groups: display all SKU+qty pairs or a clear summary, for example `Booster-gel-001 x2 + HU-10 x1`.
- Group order count must count only exact-composition matches.
- Avoid misleading headers like `Booster-gel-001 Qty 2` when the group actually contains `HU-10 x2` or mixed orders.

### 4. Backend / Global Pagination Considerations

- Existing skill notes warn that SKU Sort can be page-local if sorting happens only after server pagination.
- If current SKU Sort/grouping is still frontend-only over the current page, move the sort/group key support server-side or otherwise ensure grouping/sorting applies across all matching Awaiting Shipment orders, not just the visible page.
- Preserve default date-desc ordering when SKU Sort/grouping is off.
- Preserve existing server-side SKU filtering behavior; do not regress all-pages filtering.
- If backend sorting/grouping is added, thread explicit query params from `OrdersView.tsx` / `v2Hooks.ts` into `/orders` and apply SQL ordering before `LIMIT/OFFSET`.

### 5. UX Behavior

- Expanding/collapsing a group must only affect exact-matching rows.
- Selection checkboxes and batch actions must remain scoped to the actual rows shown in that exact group.
- No row should appear under two incompatible SKU composition groups.
- Missing/blank SKU orders should be grouped under a distinct clear group, not merged into real SKU groups.

### 6. Guardrails / Forbidden Changes

- Do not mutate live orders or order items.
- Do not alter label, rate, shipment, marketplace confirmation, billing, inventory ledger, auth/RBAC, client/store scope, financial redaction, or shipped/cancelled lockdown behavior.
- Do not hide rows to make the grouping look correct; the row set must remain correct.
- Do not rely on product name for grouping when SKU exists. SKU is the grouping key.
- Do not expose customer PII or raw provider payloads in tests, logs, screenshots, or summaries.

## Testing Applicability

This is an operator-facing Orders workflow bug. It needs focused grouping logic tests plus browser/UI or component/E2E coverage. Because it is display/sort/grouping only, tests must be mocked/offline and must not create labels, buy postage, notify marketplaces, or mutate production data.

## Required Tests / Verification

### 1. Focused Logic/Unit Tests For Composition Key Generation

- `Booster-gel-001 x2` produces a different key from `HU-10 x2`.
- `Booster-gel-001 x2` produces a different key from `Booster-gel-001 x1 + HU-10 x1`.
- `Booster-gel-001 x2 + HU-10 x1` matches only the same per-SKU quantities, regardless of item order.
- Duplicate same-SKU lines are summed correctly.
- Blank/missing SKUs do not merge into real SKU groups.

### 2. Orders Grouping Tests

Seed/mock a dataset containing at least:

- Booster x2
- `HU-10` x2
- Booster x1 + `HU-10` x1
- Booster x2 + `HU-10` x1

Verify each group header count matches only exact composition rows, and wrong rows do not appear under the `Booster-gel-001 Qty 2` group.

### 3. Pagination / Global Sort Tests If SKU Sort Is Backend-Supported

- Dataset spans multiple pages.
- SKU grouping/sorting applies globally before pagination, not page-locally.
- Page 1 and page 2 continue the same global grouping/order.
- Toggling SKU Sort off restores normal date-desc pagination.
- Existing SKU filter still returns matching orders across all pages.

### 4. Browser / UI Coverage

Add or update an Orders E2E/component test that opens SKU Sort/grouped view and asserts exact group membership/header counts. Use mocked fixtures only.

Run at minimum:

- `npm run typecheck`
- `npm run build:web`
- `npm run guard:source-of-truth`
- Focused unit/component tests added for this task, with exact command reported
- Relevant Orders browser/UI test command, for example `npm run test:orders-ux:browser` or the specific Playwright command used
- `npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line`

## Definition Of Done

- SKU Sort/grouping groups by exact SKU+quantity composition.
- Single-SKU and multi-SKU orders no longer get mixed under misleading headers.
- Group headers accurately describe the full composition and exact order count.
- Selection/batch actions operate only on exact-matching group rows.
- Existing SKU filtering and default date pagination are not regressed.
- If pagination is involved, SKU grouping/sorting is global before pagination, not current-page-only.
- All required checks pass with evidence.

## Return Format

Reply with:

1. Summary of files changed.
2. Exact composition-key logic implemented.
3. Before/after explanation for the reported example.
4. Whether sorting/grouping is frontend-only or backend/global after the fix, and why.
5. Exact tests/commands run and pass/fail results.
6. Screenshot or concise browser evidence showing separate groups for `Booster-gel-001 x2`, `HU-10 x2`, and mixed SKU compositions.
7. Explicit statement that no live orders/items/labels/postage/marketplace notifications were mutated.
