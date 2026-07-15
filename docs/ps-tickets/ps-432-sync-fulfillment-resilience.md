# PS-432 — Sync and fulfillment resilience

Status: executable failure-injection closure complete locally; push, deployment,
and operator review of unresolved production purchase intents remain pending.

## Architecture placement

- **Business rules:** every shipped transition must durably request inventory
  deduction; fulfillment outbox settlement must converge atomically; provider
  label/confirmation retries must not duplicate external side effects.
- **Canonical owners:**
  - `src/services/fulfillment/inventory-deduction-outbox.ts` owns durable
    inventory-deduction intent.
  - `src/services/fulfillment/outbox.ts` owns marketplace-confirmation lifecycle
    settlement and reconvergence.
  - `src/lib/label-purchase-intent.ts` owns fail-closed label purchase intent and
    operator resolution.
  - `src/services/fulfillment-deductions.ts` remains the unchanged inventory
    movement owner and retains `INVENTORY_AUTO_DEDUCT`.
- **Imperfect-data entry points:** a process exit between shipped status and
  outbox insert; a process exit between outbox success and shipment/order
  projection; a provider purchase before durable intent; a provider ACK before
  local confirmation settlement; transient schema-readiness failure.
- **Callers delegating to the owners:** shipment sync, order status catch-up,
  shipped-only import hydration, label persistence, Shopify label purchase and
  recovery, manual external-shipped transition, and the fulfillment worker.
- **Frontend role:** none. No UI code owns inventory, label, confirmation, or
  shipped/cancelled truth in this change.
- **Duplicate logic forbidden:** no second inventory-intent table, no frontend
  retry policy, no provider-specific stock mutation, and no direct inventory
  decrement outside the ledger owner.

## Implemented findings

- **R1:** shipped transitions and `inventory_deduction_requested` insertion now
  commit in the same database transaction. The bounded recovery sweep remains
  defense-in-depth for older rows.
- **R2:** outbox success, shipment confirmation status, and order canonical
  status settle in one transaction. A bounded reconverger repairs previously
  succeeded-but-torn rows without contacting a marketplace.
- **R9:** re-enqueue preserves `succeeded` and reconverges derived state instead
  of resetting shipment/order lifecycle to pending.
- **R5:** Shopify writes the same durable label purchase intent used by other
  providers immediately before purchase, carries it through pending recovery,
  and fails closed on ambiguous outcomes.
- **R3:** direct/ShipStation purchase intent creation moved after preflights.
  Admin-only audited resolution requires either a matching active shipment or
  explicit provider verification that no label exists.
- **R6/R20:** ShipStation confirmation re-reads upstream order status before
  `markasshipped`; an already-shipped retry settles as success without sending a
  second marketplace notification.
- **R21:** already fixed before PS-432. The canonical key remains
  `inventory:ship:order:<orderId>:inventory:<inventoryId>` and the ledger schema
  retains its unique index. PS-432 pins both facts rather than adding another
  key format.
- **Billing cross-period regeneration:** already fixed before PS-432 by the
  candidate-order cross-period delete/rebuild boundary and persisted-row-only
  counters. The existing behavioral guard is part of PS-432 evidence.
- **Cluster D schema readiness:** rejected readiness promises are no longer
  permanently memoized; a later worker tick can re-check after a transient
  failure. Other Cluster D items were already covered by current abort,
  watermark, watchdog, rate-job, and Print Queue recovery owners.

## Production repair evidence

`scripts/backfill-inventory-ledger.ts` is now read-only by default. An unbounded
`--all --apply` is refused; mutation requires an audited `--since` scope plus
separate operator approval.

The PS-432 production confirmation query was run read-only on 2026-07-15:

```text
Scope: {"sku":"all","since":"2026-07-12T00:00:00.000Z"}
Before: {"shipped_orders":463,"shipped_lines":672,"shipped_units":881,
"lines_with_ledger":672,"units_with_ledger":881,"missing_lines":0,
"missing_units":0,"missing_orders":0}
Dry run only. No rows changed.
```

The previously reported 13 recent orders had already reconverged through the
deployed idempotent recovery lane, so an apply would be a no-op and was not run.
A separate unbounded diagnostic found substantial legacy history outside the
PS-432 window; it is explicitly out of scope and must not be applied as part of
this ticket.

## Executable failure-injection evidence

`npm run test:ps-432-sync-fulfillment-resilience` now runs both the original
placement guard and an offline PGlite integration suite against the real
canonical owners. The integration suite proves:

- a forced failure before transaction commit rolls back both the shipped status
  and `enqueueInventoryDeduction` insert; a successful retry commits exactly one
  intent with the shipped transition;
- an already-succeeded confirmation row with torn order/shipment projections
  reconverges once, and a second pass returns zero without a provider dispatch;
- a Shopify purchase ACK followed by simulated process death leaves a durable
  intent that blocks the retry before the provider spy can buy again;
- operator resolution rejects a shipment belonging to another order, rejects a
  `provider_verified_no_label` outcome when an active shipment exists, and
  stores the scoped linked-shipment outcome plus operator note;
- a ShipStation `markasshipped` ACK followed by simulated local-settlement death
  causes the retry to re-read upstream `shipped` and keeps the marketplace
  notification spy at exactly one call.

The test uses inert environment values and an in-memory PGlite database. No
configured database, carrier, marketplace, label, postage, customer, inventory,
or production order/shipment state is contacted or changed.

The last production review reported nine unresolved purchase intents. This
implementation does not auto-resolve them: each requires provider-side evidence
and the admin-only audited operator workflow. No production intent row was read,
resolved, retried, or mutated during this completion pass.

## Safety statement

Per user override `unlock shipped data` on 2026-07-15, the change touches shipped
workflow code only to strengthen durability and idempotency. It does not remove
or weaken `LOCKED_STATUSES`, `assertOrderEditable`, `isReadOnly`, the inventory
kill switch, shipment history, schema columns, or terminal-row preservation.
Offline verification performs no provider calls, postage purchases, live label
creation, marketplace notifications, production inventory movement, or real
shipped/cancelled order mutation.
