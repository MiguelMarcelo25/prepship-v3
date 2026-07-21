# PS-462 — Canonical inventory ledger quantity and immutable storage billing

PS-462 is the collision-free repository identity for the inventory work on
[the Trello card still titled duplicate PS-439](https://trello.com/c/9LO26Gtc).
PS-439 remains assigned to pool-safe worker advisory-lock ownership.

Historical `ps-439-inventory-*` script names and error codes are retained as
compatibility breadcrumbs for the already-reviewed implementation. New release,
correction-packet, and forward-rollback evidence uses PS-462.

## Placement

- Business rule: inventory quantity is the sum of immutable signed ledger movements.
- Canonical read owner: `src/services/inventory-stock-math.ts`.
- Canonical mutation owner: `src/services/inventory-movement.ts`.
- Imperfect-data entry point: pre-ledger and direct `inventory.stock_qty` history.
- Reconciliation owner: `src/services/inventory-reconciliation.ts` (report-only).
- Frontend role: render backend `inventoryQuantity` and `stockStatus` only.

## Rollout and rollback gates

1. Apply additive preparation `drizzle/0073_inventory_quantity_sot.sql`.
2. Regenerate and separately approve the append-only correction packet.
3. Append corrections; prove the legacy cache equals the ledger.
4. Apply `drizzle/0074_inventory_quantity_cutover.sql` and deploy the PS-462 runtime.
5. If the post-cutover runtime must be rolled back, enter maintenance, disable inventory
   auto-deduction, apply `ops/rollback/ps-462_inventory_quantity_forward_rollback.sql`,
   deploy the prior compatible runtime, and verify cache/ledger parity before reopening.

The rollback restores a derived compatibility cache from the immutable ledger; it never
updates, deletes, truncates, or reconstructs ledger history. Production correction,
migration application, push, and deployment each require separate approval.
