# Audit 4.3 — sync cursor and webhook dedupe hygiene

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** ShipStation sync progress must survive a
  client rename, shipment resume cursors must interpret provider wall-clock values
  in the provider account timezone, and webhook retries without provider event IDs
  must dedupe against the event occurrence window.
- **Canonical backend/domain/read-model/policy owner:**
  `shipstation-sync-account-state.ts` owns stable ShipStation account identity and
  watermark-key migration; `v1-date.ts` owns ShipStation v1 date interpretation;
  `webhook-ledger.ts#webhookDedupeKey` owns fallback webhook idempotency.
- **Current duplicated/unsafe owners:** Order and shipment sync derived setting keys
  independently from mutable client names. Shipment sync parsed its resume cursor
  with server-timezone `Date.parse`. The webhook route omitted the normalized event
  timestamp, forcing the ledger to bucket retries by receipt time.
- **Where bad/stale/incomplete data can enter:** A client rename changes the account
  display label before a watermark read; ShipStation v1 emits a bare Pacific-time
  `createDate`; providers can retry the same payload after its original receipt
  window and may omit a stable event ID.
- **Callers that must delegate to the owner:** Order sync and shipment sync consume
  stable/legacy watermark keys from the account-state owner. Shipment cursor
  advancement consumes `parseShipStationV1Date`. The webhook route passes
  `normalized.occurredAt` to the ledger owner.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Sync services
  must not derive watermark identity from account display names. Shipment resume
  cursors must not call `Date.parse` on ShipStation v1 wall-clock text. Routes must
  not mint webhook dedupe keys or replace event time with receipt time.
- **Frontend role: display/action only; no authoritative business logic:** None.
  This is a backend sync/idempotency correction with no frontend change.
- **Backend boundary tests required:** `test:audit-sync-cursor-webhook-hygiene`
  executes stable watermark-key and dedupe contracts and pins both sync consumers
  to the canonical owners.
- **Workflow/UI proof required:** Existing ShipStation sync-window, account-state,
  upstream-shipping-safety, shipped-lockdown, typecheck, and SOT guard-pack checks.

The user typed `unlock shipped data` in this conversation. Changes under that
override are limited to sync cursor metadata and webhook idempotency; no shipped or
cancelled edit protection, shipment history, label/postage path, inventory switch,
or marketplace notification behavior is weakened. Verification is offline and
performs no provider call, database write, live label/postage purchase, marketplace
notification, or production shipped/cancelled mutation.
