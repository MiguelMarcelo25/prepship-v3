# PS-462 — Canonical inventory ledger quantity and immutable storage billing

PS-462 is the collision-free repository identity for the inventory work on
[the PS-462 Trello card](https://trello.com/c/9LO26Gtc).
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

1. Apply additive preparation `drizzle/0075_inventory_quantity_sot.sql` and
   fail-closed monthly storage identity `drizzle/0077_ps462_billing_storage_month.sql`.
2. Regenerate and separately approve the append-only correction packet.
3. Append corrections; prove the legacy cache equals the ledger.
4. Apply `drizzle/0076_inventory_quantity_cutover.sql` and deploy the exact PS-462 SHA to
   Render API/workers and Vercel Client Portal in the coordinated maintenance window.
5. If the post-cutover runtime must be rolled back, enter maintenance, disable inventory
   auto-deduction, apply `ops/rollback/ps-462_inventory_quantity_forward_rollback.sql`,
   deploy the prior compatible runtime, and verify cache/ledger parity before reopening.

The rollback restores a derived compatibility cache from the immutable ledger; it never
updates, deletes, truncates, or reconstructs ledger history. Production correction,
migration application, push, and deployment each require separate approval.

Use `docs/runbooks/ps-462-inventory-preparation.md` for the fail-closed phase-1
maintenance, application, verification, and pre-cutover compatibility rollback procedure.
