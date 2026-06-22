# PS-166 / PS-258 OrdersView decomposition status

Date: 2026-06-22

## Current status

Current completion estimate: PS-166 75%, PS-258 81%.

These cards are not Final Review-ready. The current code has multiple proven extraction slices and
component-boundary guards, and the current slice set now has an explicit certification guard plus
server-render parity proof for extracted leaves and selected-order toolbar branches. Batch-panel
read-only/no-label-action branches are statically pinned. The umbrella goal is still broader than
the slices currently pinned.

## Evidence now wired

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
- `test:ps-166-ps-258-orders-selection-render-parity`
- `test:ps-166-ps-258-decomposition-certification`
- `test:ps-166-ps-258-decomposition-closeout`

## What is proven

- Backend best-rate proof reading is isolated in a small PS-166 owner.
- Awaiting order sort/order logic delegates to the extracted pure owner.
- Daily stats rollover math, non-critical scheduling, queue payload parsing, local column
  preferences, and table-density preferences are extracted and guarded.
- Search bar, empty panel, empty-results region, and batch-panel/read-only boundaries have static
  contract guards.
- Search bar, empty-results region, and empty panel now have server-rendered branch parity proof, so
  those already-extracted leaves cannot silently drift from their public DOM anchors.
- Selected-order toolbar awaiting/shipped/cancelled branches now have server-rendered parity proof.
- Batch-panel read-only and no-label-action fallbacks are statically pinned without importing its
  Vite-only helper chain into the Node guard.
- Shipped/cancelled selection lockdown is still pinned by `test:ps-258-component-boundary`.
- The current extraction slice set is documented in
  `docs/ps-tickets/ps-166-ps-258-decomposition-certification.md`.

## Missing before Final Review

- Real DOM-render or byte-equivalent parity certification for the next larger OrdersView shell or
  row-rendering extraction slice. Current render proof covers extracted leaves plus the selection
  toolbar, but not the full table shell or row renderer.
- Continue one small extraction at a time: passive auto-rating, panel state, filtered order rows,
  memoized row rendering, or another low-risk leaf.
- Keep each extraction backed by a focused guard before moving to the next slice.
- Do not change shipped/cancelled lockdown behavior without the required user override.

## Recommendation

Keep PS-166 and PS-258 in progress. They are healthier than the older audit percentages, but still
too broad to move to Final Review based only on the current slice guards and static certification.
