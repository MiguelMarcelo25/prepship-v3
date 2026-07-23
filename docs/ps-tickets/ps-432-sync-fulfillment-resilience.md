# PS-432 — Sync and fulfillment resilience

Status: implementation and executable failure-injection proof are deployed. A
2026-07-16 read-only production classification found zero unresolved label
purchase intents. The nine deep-health provider-pending facts are stale Print
Queue sidecar states whose orders already have durable provider receipts; no
automatic retry or production metadata mutation was performed.

## Architecture placement

- **Business rules:** terminal transitions with exact fulfillment facts must
  durably request inventory deduction; explicitly unavailable facts must create
  review-only evidence and no inventory movement; fulfillment outbox settlement
  must converge atomically; provider label/confirmation retries must not
  duplicate external side effects.
- **Canonical owners:**
  - `src/services/fulfillment/inventory-deduction-outbox.ts` owns durable
    inventory-deduction intent.
  - `src/services/fulfillment/outbox.ts` owns marketplace-confirmation lifecycle
    settlement and reconvergence.
  - `src/lib/label-purchase-intent.ts` owns fail-closed label purchase intent and
    operator resolution.
  - `src/services/order-lifecycle-command.ts` owns the locked terminal-state,
    competing-shipment, exact-claim/review-only, package, and inventory-intent
    transaction boundary.
  - `src/services/fulfillment-operation-ledger.ts` plus
    `src/services/shipstation-forward-label-operation.ts` own one-effect
    provider receipts and versioned canonical recovery facts.
  - `src/lib/shipstation/label-request-body.ts` owns the shared, pure
    money-affecting ShipStation POST shape used by both dispatch and immutable
    operation hashing.
  - `src/services/shipping-client-identity.ts` owns legacy order/store client
    resolution for both label purchase and recovery.
  - `src/services/verified-forward-label-recovery.ts` consumes only those
    sealed receipt facts and delegates local writes to the lifecycle owner.
  - `src/services/fulfillment-deductions.ts` remains the unchanged inventory
    movement owner and retains `INVENTORY_AUTO_DEDUCT`.
- **Imperfect-data entry points:** a mutable Print Queue payload surviving a
  provider ACK; a process exit between shipped status and
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

- **2026-07-22 closure drift hardening:** ShipStation now seals the
  post-authorization order/client, weight, dimensions, resolved package, and
  normalized insurance facts into its durable provider receipt. Receipt replay
  never accepts those facts from the mutable queue sidecar, and exact-ID
  reconciliation must match the original operation request hash plus the
  current canonical quote/account/order intent before it can seal equivalent
  facts. Legacy or generic operator-supplied receipt JSON remains held.
- **Provider-proof and tenant hardening:** the operation hash now mirrors the
  shared provider request body (including residential, normalized addresses,
  package, confirmation, and insurance); a reserved exact-GET provenance can
  only be written through the dedicated ShipStation reconciliation transition;
  and legacy store-only orders seal the same resolved client ID at purchase and
  recovery, including marketplace-confirmation enqueue.
- **Transactional recovery fencing:** forward-label persistence revalidates
  awaiting status and competing active shipments under the lifecycle order
  lock. Its own just-inserted shipment is excluded from the competing-shipment
  query; any other active shipment or terminal status throws and rolls the
  shipment plus receipt consumption back together.
  A second recovery worker now accepts the ledger's already-consumed result
  instead of failing on the first worker's committed shipment.
- **All replay consumers fail closed:** ordinary ShipStation, direct-carrier,
  Shopify, and return-label retry paths reject generic operator-recorded
  receipts. ShipStation additionally requires sealed facts to equal the current
  authorized persistence facts before its normal retry path can consume them.

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
  notification spy at exactly one call;
- ShipStation receipt facts survive a simulated queue-weight/package mismatch,
  malformed/cross-order/legacy facts fail closed, generic operator JSON cannot
  auto-consume, and two concurrent receipt consumers produce one local effect;
- the actual verified-recovery service is exercised with two workers, returns
  the committed result to both, rolls its shipment back on lifecycle rejection,
  leaves the provider receipt unconsumed after that rollback, and passes the
  resolved client identity for a legacy store-only order to confirmation;
- the exact-reconciliation workflow performs one read-only provider lookup only
  when quote/account/intent and the shared provider-request hash match, while a
  hash mismatch is held before provider I/O;
- the lifecycle transaction accepts its own recovery shipment, rejects a
  competing active shipment, rejects a terminal status that changed after the
  outer read, and emits no inventory intent for explicit unavailable facts.

The test uses inert environment values and an in-memory PGlite database. No
configured database, carrier, marketplace, label, postage, customer, inventory,
or production order/shipment state is contacted or changed.

The last production review described nine unresolved purchase intents. The
2026-07-16 read-only query in
`docs/final-review/evidence/PS-432-provider-pending-readonly.sql` established that
the nine facts are instead stale `print_queue_batch_job_items` states across
eight orders and three inactive jobs. All nine have a durable active shipment
with label URL, tracking, and provider receipt; six also have a Print Queue
entry, and the label-purchase-intent table has zero unresolved rows. No row was
resolved, retried, or mutated. The provider outcome ambiguity is classified as
already durably successful; any later cleanup of the stale sidecar metadata is
an operator action and must not repurchase a label.

## Safety statement

Per user overrides `unlock shipped data` on 2026-07-15 and 2026-07-22, the change touches shipped
workflow code only to strengthen durability and idempotency. It does not remove
or weaken `LOCKED_STATUSES`, `assertOrderEditable`, `isReadOnly`, the inventory
kill switch, shipment history, schema columns, or terminal-row preservation.
Offline verification performs no provider calls, postage purchases, live label
creation, marketplace notifications, production inventory movement, or real
shipped/cancelled order mutation.
