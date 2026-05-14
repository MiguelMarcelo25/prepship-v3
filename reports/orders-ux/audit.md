# Orders UI/UX Audit

Scope: Awaiting Shipment, Shipped, and Cancelled order views.

## Findings

1. Row click and row selection were using the same mental model. Clicking a row selected it, which made the old global "1 selected / Print Labels / X" state appear even when the operator was just trying to inspect the order.
2. Selected-row actions were detached from the table. A global topbar selection pill competed with filters, sync, columns, queue, and zoom controls.
3. Awaiting Shipment needs bulk shipping actions, but Shipped and Cancelled need review-safe actions. Shipped should offer existing-label queueing/reprint behavior; Cancelled should not expose print/ship actions.
4. The detail drawer is still the right place for single-order shipping fields and Create + Print Label. Bulk-selected rows now have their own table-adjacent action bar.
5. Tablet/mobile layouts need wrapping controls instead of a single cramped row. The new selection toolbar wraps its actions into touch-sized controls.

## Recommended Layout

- Keep the global topbar stable for page title, sync, columns, queue, panel toggle, and zoom.
- Keep filters/search/export/new-order in the filterbar.
- Put selected-row actions immediately above the table header.
- Keep single-order actions in the right drawer only.
- Make selected-row actions status aware:
  - Awaiting Shipment: Create + Print, Send to Queue, Mark as Shipped, Test mode, Copy IDs, Clear.
  - Shipped: Queue Existing Labels, Copy IDs, Clear.
  - Cancelled: Shipping actions disabled, Copy IDs, Clear.

## Screenshots

- Desktop awaiting list: `reports/orders-ux/desktop-01-awaiting-list.png`
- Desktop row click opens detail without selection toolbar: `reports/orders-ux/desktop-02-row-click-detail.png`
- Desktop awaiting selected toolbar: `reports/orders-ux/desktop-03-awaiting-selected.png`
- Desktop shipped selected toolbar: `reports/orders-ux/desktop-04-shipped-selected.png`
- Desktop cancelled selected toolbar: `reports/orders-ux/desktop-05-cancelled-selected.png`
- Tablet awaiting selected toolbar: `reports/orders-ux/tablet-03-awaiting-selected.png`
- Mobile awaiting selected toolbar: `reports/orders-ux/mobile-03-awaiting-selected.png`
- Mobile shipped selected toolbar: `reports/orders-ux/mobile-04-shipped-selected.png`
- Mobile cancelled selected toolbar: `reports/orders-ux/mobile-05-cancelled-selected.png`

## Verification

- `npm run test:orders-ux`
- `npm run test:orders-ux:browser`
- `npm run typecheck`
- `npm run build:web`
