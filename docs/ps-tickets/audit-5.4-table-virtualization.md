# Audit 5.4 - Orders and Inventory table virtualization

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Large Orders and Inventory result
  pages must mount only the visible table rows plus a small overscan window,
  while retaining the existing sort, selection, grouping, keyboard, action,
  and read-only behavior.
- **Canonical backend/domain/read-model/policy owner:** Backend Orders and
  Inventory DTO/read-model owners remain unchanged and authoritative. This is
  presentation-only performance work; `web/src/components/ui/table-virtualization.ts`
  owns the shared UI window threshold and spacer calculation, while TanStack
  Virtual owns visible-range measurement.
- **Current duplicated/unsafe owners:** `OrdersTable.tsx` and the shared
  `Table.tsx` currently map every row in the loaded page into the DOM. Inventory
  opts into `Table.tsx`; Orders retains its specialized grouped table.
- **Where bad/stale/incomplete data can enter:** No business data is corrected
  here. The performance defect is injected at the final render boundary when a
  correct backend page is expanded into an unbounded DOM row set.
- **Callers that must delegate to the owner:** `OrdersTable.tsx` and the shared
  `Table.tsx` use the same threshold/spacer owner; Inventory Stock Levels opts
  into the shared Table capability. Small tables keep their legacy DOM path.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Do not slice
  backend truth, re-sort inside the virtual layer, duplicate filters, change
  pagination semantics, or move selection/read-only/action decisions into the
  virtualizer.
- **Frontend role: display/action only; no authoritative business logic:** The
  frontend windows already-resolved rows and forwards the same row objects and
  callbacks. No rate, label, inventory, billing, lifecycle, or scope decision
  changes.
- **Backend boundary tests required:** None; backend facts and endpoints are
  unchanged. Existing API/source-of-truth guards must remain green.
- **Workflow/UI proof required:** A focused guard proves both tables use TanStack
  Virtual only above the shared threshold, spacer math is correct, Inventory
  opts in, Orders keeps the read-only gate, and keyboard navigation can target
  an unmounted row. Browser proof verifies bounded DOM rows and scroll-to-last
  behavior for large Orders and Inventory fixtures.

## Scope decision

Virtualization activates only for more than 40 render entries. This preserves
the exact small-table DOM used by existing parity tests and avoids adding
measurement overhead to short pages. Orders flattens SKU group headers and
orders into one presentation list; Inventory virtualizes only its normal Stock
Levels table, not bulk-edit or expandable table modes.

Per the current-conversation user override `unlock shipped data`, the Orders
view may receive a presentation-only scroll ref. The existing `isReadOnly`
selection gates remain unchanged, and no shipped/cancelled data or mutation
path is modified.

## Verification

- `npm run test:audit-table-virtualization`
- `npm run typecheck`
- `npm run build:web`
- `npx playwright test web/e2e/orders-dom-parity.spec.js web/e2e/inventory-ux.spec.js --workers=1 --reporter=line` (8 passed)
- `npm run test:orders-ux`
- `npm run test:ps-058-select-all-matching`
- `npm run test:ps-258-component-boundary`
- `npm run test:ps-258-orders-filtered-sort`
- `npm run test:ps-258-orders-table-density-prefs`
- `npm run test:inventory-history-table-pagination`
- `npm run test:order-editable-lockdown`
- `npm run test:ps-245-lockdown-fence`
- `npm run test:sot-guard-pack` (33 passed)

The small-table DOM snapshots had already drifted from committed July 14
order-number/return-marker rendering before this slice. They were regenerated
in a separate local test commit and then passed normally with an explicit
five-row fixture-count assertion; virtualization remains disabled for those
five-row parity fixtures.
