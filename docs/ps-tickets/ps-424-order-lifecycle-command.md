# PS-424 — Order lifecycle command and reversible fulfillment claims

## Placement gate

- Business rule: an awaiting-to-shipped, externally shipped, cancelled, or
  shipment-void transition must record terminal state, provenance, exact
  fulfillment lines, package work, SKU work, and durable retry intent as one
  lifecycle command.
- Canonical owner: `src/services/order-lifecycle-command.ts`, backed by
  `order_lifecycle_events` and `fulfillment_line_claims`.
- Imperfect-data entry points: provider shipment payloads, marketplace/store
  imports, webhooks, status catch-up, and manual external-shipment intent.
- Former duplicated owners: label persistence, shipment sync, order sync,
  store import, marketplace reconciliation, deleted-awaiting reconciliation,
  webhook reconciliation, the manual external-shipment service, and the
  generic order PATCH.
- Callers now delegate normalized terminal facts to the canonical owner.
- Forbidden bypasses: direct terminal `orders` writes, direct external flag or
  provenance writes, and order-only inventory intent for new transitions.
- Frontend role: unchanged; it sends operator intent and renders backend state.

## Durable model

`order_lifecycle_events` is an immutable, command-keyed receipt. Its line
snapshot is captured before mutable order/provider data can change.
`fulfillment_line_claims` stores one deduct claim per shipment/fulfillment line.
The inventory ledger key comes from that exact claim, not only the order.
External classification of an already-cancelled row records provenance and
the reversible external flag without reopening it or creating SKU claims.

A void supersedes claims that have not executed. Applied claims receive linked,
idempotent reverse claims. Package reversal remains shipment-keyed through the
PS-413 package owner. A relabel receives a new shipment event and new exact
quantity; it cannot reuse or silently overwrite the voided claim.

If ShipStation omits `shipmentItems`, sync records an explicit review claim
instead of guessing the entire mutable order quantity. This fails safely and
prevents silent split-shipment over-deduction.
Missing, invalid, fractional, or non-positive quantities likewise remain in
review and never enqueue a stock movement.

A ShipStation status-only `shipped` observation records state and provenance
but no SKU claim. The later shipment event owns the exact line quantities, so
status catch-up followed by shipment sync cannot deduct twice.

## Lockdown and safety

Per user override `unlock shipped data` on 2026-07-16, the locked label,
shipment-sync, fulfillment-deduction, webhook, and order-route paths were
changed only to delegate to this owner. Existing edit guards remain. The
validated `INVENTORY_AUTO_DEDUCT` switch remains the single execution gate;
when disabled, claims stay pending and no inventory or inventory-ledger write
occurs.

Migration `0069_order_lifecycle_commands.sql` is additive and performs no
historical repair or production data mutation.

## Offline proof

`npm run test:ps-424-order-lifecycle` runs a placement guard and an in-memory
PGlite integration suite covering:

- atomic transition/event/claim/outbox commit;
- injected crash rollback;
- command and worker retry idempotency;
- cumulative split shipments;
- status-only shipped evidence followed by exact shipment facts;
- void-before/after claim behavior and exact reversal;
- repeated void;
- changed-quantity relabel;
- cancellation; and
- external provenance in `order_overrides`.

No provider connector, real label, postage, marketplace notification, or
production database is reachable from the integration fixture.
