# PS-166 / PS-258 OrdersView decomposition certification

Date: 2026-06-22

## Status

Current completion estimate: PS-166 74%, PS-258 80%.

These cards are still not Final Review-ready. The current state is stronger
than the prior 70% / 76% checkpoint because the known extraction slices now have
an explicit certification guard, leaf-level server-render parity proof, and safety
packet. The broad decomposition objective still needs the next guarded extraction
or larger OrdersView shell/row parity proof before review.

## Certified evidence

- `test:ps-166-orders-rate-proof`
- `test:ps-258-daily-stats-rollover`
- `test:ps-258-non-critical-scheduler`
- `test:ps-258-orders-queue-parsers`
- `test:ps-258-orders-filtered-sort`
- `test:ps-258-orders-column-prefs-local`
- `test:ps-258-orders-table-density-prefs`
- `test:ps-258-component-boundary`
- `test:ps-258-empty-state-props-contract`
- `test:ps-258-empty-panel-contract`
- `test:ps-258-search-bar-contract`
- `test:ps-166-ps-258-orders-leaf-render-parity`
- `test:ps-166-ps-258-decomposition-certification`
- `test:ps-166-ps-258-decomposition-closeout`

## What this certifies

- The Awaiting orders filtered/sorted row order delegates to the pure
  `computeOrderedFilteredOrders` owner instead of keeping inline sort logic in
  the OrdersView memo.
- Search bar, empty-results state, empty side-panel, column preferences,
  density preferences, queue parsers, daily stats rollover, and non-critical
  scheduler behavior each have focused offline guards.
- The already-extracted search bar, empty-results state, and empty side-panel
  also have server-rendered parity proof for their public DOM anchors and
  conditional branches.
- Shipped/cancelled selection lockdown consumers are still pinned by a static
  guard, and the PS-306 caveat remains visible because `OrdersView.tsx`
  currently has `const isReadOnly = false`.
- The certification is offline/static only. It reads source files and guards; it
  does not change runtime UI behavior, labels, postage, queues, orders,
  shipments, marketplaces, or shipped/cancelled data.

## Still missing

- A real DOM-render or byte-equivalent parity certification for the next larger
  OrdersView shell or row-rendering extraction slice. Current render proof covers
  only already-extracted leaves.
- One additional guarded extraction slice, chosen and frozen before coding:
  passive auto-rating, panel state, filtered order row rendering, memoized row
  rendering, or backend-account-display fallback removal after DTO proof.
- PS-306 remains blocked from full Final Review while the shipped/cancelled UI
  read-only gate is explicitly disabled.

## Next action

Keep PS-166 and PS-258 in progress. The next safe move is to choose one small
non-money, non-label, non-shipped/cancelled extraction slice, write its parity
guard first, then make the smallest code move that satisfies that guard.

No Trello comment or move is authorized by this document.
