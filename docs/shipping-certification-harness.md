# Shipping Certification Harness

Static guards are not enough for shipping critical path work. They can prove that files contain expected strings, but they do not prove that an order is eligible, that a label response contains tracking, that a shipment row exists, that marketplace confirmation is queued, or that the UI exits loading.

## Safety

No automated test may create real labels, buy postage, send real marketplace notifications, or mutate live orders. Any live-order test must be performed only with DJ present and explicitly approving that exact test.

Default modes are read-only, mocked, offline, fixture-based, or sandbox-only.

## Commands

`npm run inspect:shipping-order -- --order-id <id>`

- Read-only.
- Shows order/provider/client/store, ship-to completeness, weight, active shipment risk, shipment confirmation fields, fulfillment outbox rows, and retry safety.

`npm run smoke:shipping:preflight -- --order-id <id>`

- Read-only.
- Refuses terminal shipped/cancelled states, duplicate active labels, missing ship-to, missing weight, and missing client/store mapping.

`npm run smoke:shipping:test-label -- --fixture`

- Offline fixture only.
- Proves expected state transitions in memory.
- Refuses to create real labels.

`npm run smoke:marketplace-confirm -- --order-id <id>`

- Read-only by default.
- Reports marketplace confirmation provider/status/attempt/error/retry safety.
- `--mock-process-once` runs only an in-memory fixture.
- `--process-once` is intentionally refused for live data.

## Common Failures

- Label created but DB failed: carrier may have charged postage but no durable PrepShip shipment exists. Stop and inspect before retrying.
- DB succeeded but marketplace confirmation failed: order is locally shipped but marketplace may not know yet. Use outbox status and last error.
- Marketplace connector unsupported: provider is not wired for confirmation; do not treat label creation as marketplace shipped.
- API/DB timeout: UI may remain on "Creating label PDF..." until the request fails or recovers.
- UI hung on creating: check API health, shipment row, active label, and outbox before clicking Print Label again.
- Duplicate active shipment: do not retry label creation unless a human confirms the previous label is voided or invalid.
