# PS-306 OrdersView Parity Cutover Gate

Date: 2026-06-22

## Purpose

PS-306 is the gate that must pass before any larger OrdersView extraction or
thin-client cutover continues. It does not change runtime behavior by itself.
It proves the backend owners from PS-300 through PS-305 exist, the current
frontend fallback debt is explicit, and the shipped/cancelled lockdown caveat is
visible before the next extraction slice starts.

Important caveat: `OrdersView.tsx` currently has the shipped/cancelled UI
read-only gate disabled with `const isReadOnly = false`. Backend mutation guards
still protect shipped/cancelled orders, but PS-306 must not be called fully
Final Review-ready while the UI lockdown is disabled.

## Scope

This PS-306 slice is a pre-extraction guardrail. It covers:

- backend row workflow authority
- backend Apply Best Rate authority
- backend Print Queue authority
- backend package/carrier/account/display facts authority
- backend authority drift prevention
- OrdersView decomposition status for PS-166 and PS-258
- shipped/cancelled UI lockdown caveat guards
- frontend authority ratchet guards

It does not move code out of `OrdersView.tsx` yet.

## Required Guards

- `test:ps-300-active-lawrence-workflow`
- `test:ps-301-row-workflow-authority`
- `test:ps-302-apply-best-rate-authority`
- `test:ps-303-print-queue-authority`
- `test:ps-304-shipping-display-facts-authority`
- `test:ps-305-authority-drift`
- `test:ps-178-fe-authority-ratchet`
- `test:ps-166-orders-rate-proof`
- `test:ps-258-orders-filtered-sort`
- `test:ps-258-component-boundary`
- `test:ps-258-empty-state-props-contract`
- `test:ps-258-empty-panel-contract`
- `test:ps-258-search-bar-contract`
- `test:ps-166-ps-258-decomposition-closeout`
- `test:ps-306-ordersview-parity-cutover`

## Next Extraction Checklist

Before the next OrdersView code move, freeze one small slice and add a focused
guard first. Candidate slices:

- passive auto-rating
- panel state
- filtered order rows, starting with the already-extracted
  `computeOrderedFilteredOrders` owner
- memoized row rendering
- remaining account-display fallback removal after backend DTO coverage is
  proven

Every future extraction must:

- preserve DOM or byte-equivalent output for the moved block
- do not modify `isReadOnly` shipped/cancelled behavior without the explicit
  current-conversation override required by `AGENTS.md`
- keep the batch-panel/read-only suppression code path present until a reviewed
  shipped/cancelled UI decision is made
- keep Select All and SKU-group selection caveats visible for shipped/cancelled
  views
- consume backend DTO truth instead of recreating money/rate/label/package
  authority in the frontend
- lower the OrdersView line-count ratchet only when code is actually extracted
- run `test:ps-306-ordersview-parity-cutover` plus the focused guard for that
  slice

## Locked Surface Rule

`web/src/components/Views/OrdersView.tsx` is a locked surface for shipped and
cancelled order protections. PS-306 may read it and guard it. It must not modify
or refactor shipped/cancelled lockdown behavior without the exact current
conversation override phrase required by `AGENTS.md`.

## Safety

This gate is offline/static. It does not run live labels, postage, voids,
marketplace notifications, queue mutations, production order mutations, or
shipped/cancelled data mutations.

PS-306 is not Final Review-ready while `OrdersView.tsx` has
`const isReadOnly = false`. It remains a cutover gate and dependency map.
PS-166 and PS-258 remain broader decomposition cards until an actual guarded
extraction slice is completed.
