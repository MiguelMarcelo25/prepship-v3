# PS-064 - Fix Print Queue Label Creation Missing ShipStation/Marketplace Confirmation Outbox

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`
Status: New official task. This is self-contained and should be treated as the source of truth.

## Copy/Paste Codex Prompt

You are working in `drprepperusa-org/prepship-v4` on branch `prepshipv4-stable`.

Implement PS-064: fix the Print Queue / batch-send label path so a locally-created shipped label always creates/records the correct source/marketplace confirmation lifecycle. Specifically, ShipStation-sourced orders must enqueue/process ShipStation mark-as-shipped confirmation with tracking, so ShipStation can notify the upstream sales channel such as Shopify.

## Context

A real HUGRAB order proved the bug.

Read-only inspection of order `#1149` showed:

```text
order_number: 1149
local_order_id: 1191799
source_provider: shipstation
external_order_id: 290770091
source_order_id: 290770091
order_status: shipped
canonical_status: shipped
shipment_id: 24970
tracking: present
label_url: present
```

But marketplace/source confirmation was completely missing:

```text
shipments.confirmation_provider: null
shipments.confirmation_status: null
shipments.confirmation_attempts: 0
shipments.marketplace_confirmed_at: null
fulfillment_outbox: []
```

`npm run inspect:shipping-order -- --order-number 1149` also reported:

```text
duplicateActiveLabelRisk: true
retryingLabelCreationAppearsSafe: false
```

So the label exists locally and must not be bought again. The missing piece is the upstream confirmation/outbox lifecycle.

## Expected Behavior

For this source shape:

```text
Shopify/HUGRAB order imported through ShipStation
-> PrepShip source_provider = shipstation
-> PrepShip buys/prints label
-> PrepShip persists shipment/tracking locally
-> PrepShip enqueues fulfillment_outbox provider=shipstation
-> outbox calls ShipStation /orders/markasshipped with upstream ShipStation order id
-> notifySalesChannel=true
-> ShipStation pushes tracking/status back to Shopify/sales channel
-> PrepShip records confirmation status on shipment
```

Current live result for `#1149`:

```text
Label created: yes
Local shipment persisted: yes
PrepShip local status shipped: yes
Print Queue label likely queued: yes
fulfillment_outbox row: no
ShipStation confirmation status: no
Marketplace/source confirmation status: no
```

## Important Existing Code

Inspect these first:

- `src/services/print-queue.ts`
  - `processQueueSendOrder(...)`
  - `startQueueSendJob(...)`
  - existing-label recovery path
  - timeout behavior around queue-send order processing
- `src/routes/print-queue.ts`
  - `POST /print-queue/batch-send`
  - job status routes
- `src/services/labels.ts`
  - `createLabelV2(...)`
  - `enqueueShipmentConfirmation(...)`
  - `processFulfillmentOutboxOnce(...)`
  - `confirmationProviderForOrder(...)`
  - `marketplaceConfirmationPayload(...)`
- `src/services/fulfillment/outbox.ts`
  - `enqueueShipmentConfirmation(...)`
  - `processFulfillmentOutboxOnce(...)`
  - `processFulfillmentOutboxById(...)`
  - shipment confirmation status writes
- `src/connectors/store/shipstation.ts`
  - `confirmShipment(...)`
- `src/lib/shipstation/labels.ts`
  - `asSSUpstreamOrderId(...)`
  - `ssMarkOrderShippedV1(...)`
- Existing tests/guards:
  - `smoke:marketplace-confirm`
  - `inspect:shipping-order`
  - marketplace reconciliation / eBay / Walmart confirmation guards
  - print queue invalid-label / ownership / client-scope tests

If filenames differ, search for:

```text
processQueueSendOrder
createLabelV2
enqueueShipmentConfirmation
fulfillment_outbox
confirmation_status
ssMarkOrderShippedV1
asSSUpstreamOrderId
notifySalesChannel
```

## Root Cause To Investigate

Do not assume. Prove which path caused the missing outbox row.

Likely candidates:

- `createLabelV2(...)` did enqueue/process outbox for normal label creation, but the Print Queue / batch-send path times out or returns after local shipment persistence before `enqueueShipmentConfirmation(...)` completes.
- The Print Queue path catches/reuses an existing active label and queues it without checking/repairing missing `fulfillment_outbox`.
- `createLabelV2(...)` creates the shipment but marketplace confirmation enqueue fails silently or is skipped for some source/provider shape.
- The 30s queue-send timeout may mark the queue job failed while the label creation continues in the background, leaving partial side effects: label/shipment/shipped state but missing queue/outbox/confirmation.
- Source provider detection may use the wrong fields and fail to choose `shipstation` confirmation in this Print Queue path.

## Implementation Requirements

1. Make label creation + confirmation lifecycle atomic enough for operator safety.
   - After a real label is created and local `shipments` row exists, PrepShip must ensure one of these explicit states exists:
     - `pending`
     - `processing`
     - `succeeded`
     - `failed`
     - `not_supported`
     - `not_required`
   - It must never leave `confirmation_provider` / `confirmation_status` null for a source order that requires confirmation.

2. Fix Print Queue / batch-send label creation path.
   - For `POST /print-queue/batch-send` when an order has no existing label and the path calls `createLabelV2(...)`:
     - local shipment persistence must happen.
     - local shipped status may happen only as currently intended.
     - fulfillment confirmation outbox must be created or explicit not-supported/not-required status recorded.
     - queue insertion must still happen or return a clear partial-success/recovery state.
     - job status must expose label-created / queue-created / confirmation-queued states, not only generic success/fail.

3. Fix existing-label recovery path.
   - If `processQueueSendOrder(...)` finds/reuses an existing active label for an order, it must check whether that shipment has a confirmation lifecycle.
   - If missing and the source provider supports confirmation:
     - create the missing idempotent `fulfillment_outbox` row.
     - set shipment confirmation status to `pending`.
     - do not buy another label.
     - do not duplicate postage.
     - do not duplicate an already-succeeded confirmation.

4. Add an idempotent recovery helper.
   - Add a safe helper/service function that can repair a shipped local label missing outbox/confirmation, for example:

```text
ensureShipmentConfirmationLifecycle(orderId, shipmentId, { dryRun?: boolean })
```

   - Requirements:
     - uses existing order/shipment/source data.
     - resolves provider from `orders.source_provider`, `orders.external_order_id`, `orders.source_order_id`, and raw/source payloads.
     - for ShipStation source orders, uses `orders.external_order_id` / `source_order_id` as the upstream ShipStation order id.
     - uses idempotent dedupe key matching existing fulfillment outbox semantics.
     - never creates labels/postage.
     - never mutates shipped/cancelled order content except the explicit confirmation/outbox metadata needed for recovery and allowed by shipped-data override policy if applicable.
     - supports dry-run inspection before apply.

5. ShipStation-source behavior.
   - For orders like `#1149`:

```text
source_provider = shipstation
external_order_id = 290770091
source_order_id = 290770091
```

   - Expected confirmation provider:

```text
shipstation
```

   - Expected connector behavior:

```ts
ssMarkOrderShippedV1({
  orderId: asSSUpstreamOrderId(order.externalOrderId or sourceOrderId),
  trackingNumber,
  carrierCode,
  shipDate,
  notifySalesChannel: true,
  notifyCustomer: false,
})
```

   - Do not call direct Shopify unless the source provider is actually Shopify and Shopify connector support exists. For ShipStation-imported Shopify/HUGRAB orders, ShipStation is the upstream confirmation target.

6. UI/operator visibility.
   - Print Queue / Orders UI should not imply that "label queued" equals "marketplace confirmed."
   - If confirmation is pending/failed/not_supported, expose that status clearly enough for operators to see/retry/recover.
   - At minimum, do not hide a missing/failed confirmation behind a generic shipped state.

7. Add or update read-only diagnostic commands.
   - `inspect:shipping-order` and/or `smoke:marketplace-confirm` should clearly flag this exact state:

```text
shipped local order + active shipment + source provider supports confirmation + no outbox row + null confirmation_status
```

   - Warning example:

```text
confirmation lifecycle missing: active local label has no fulfillment_outbox row and no shipment confirmation_status
```

8. Add safe recovery command or mode.
   - Add a dry-run-first command for the reported class, for example:

```bash
npm run marketplace:confirmation:repair -- --order-number 1149 --dry-run
```

   - Optional apply mode must require explicit flags and should not be run by automated tests against live data:

```bash
npm run marketplace:confirmation:repair -- --order-number 1149 --apply --live-approved
```

   - Apply mode may enqueue/process confirmation only when DJ approves the exact order/operation.

## Required Behavior For Order #1149

Do not create another label.

A dry-run recovery for `#1149` should report something like:

```text
order: 1149
shipment: 24970
source_provider: shipstation
external_shipstation_order_id: 290770091
active_label_exists: true
tracking_present: true
outbox_exists: false
confirmation_status: null
planned_action: create fulfillment_outbox provider=shipstation and set shipment confirmation_status=pending
safe_to_buy_label: false
```

After approved apply/process, it should be possible to show:

```text
fulfillment_outbox provider=shipstation exists
shipments.confirmation_provider=shipstation
shipments.confirmation_status=pending|processing|succeeded|failed
confirmation_attempts >= 0
marketplace_confirmed_at set only if succeeded
```

If ShipStation confirmation fails, store a useful sanitized `confirmation_last_error`; do not leave nulls.

## Guardrails

- Do not buy duplicate postage.
- Do not create another label for an order with `duplicateActiveLabelRisk: true`.
- Do not mark the issue fixed just because PrepShip local status is shipped.
- Do not treat Print Queue queued or printed as proof of marketplace/source confirmation.
- Do not expose raw label URLs, full tracking numbers, customer PII, raw provider payloads, API keys, tokens, carrier credentials, or secrets in logs/tests/task output.
- Do not run live confirmation/apply against order `#1149` or any live order unless DJ explicitly approves that exact order and operation.
- Respect shipped/cancelled lockdown. If touching locked surfaces is necessary, include the required shipped-data override comment/reporting per repo policy. Prefer additive confirmation/outbox recovery code over rewriting shipped-order logic.
- Do not weaken auth/RBAC/client-store scope.

## Testing Applicability

This is a shipping-critical workflow bug crossing label creation, print queue, shipment persistence, fulfillment outbox, and upstream ShipStation/source confirmation. It requires focused regression tests plus workflow certification/smoke checks.

No automated test may buy postage, create real labels, send real marketplace notifications, or mutate live orders. Use mocked/offline/sandbox fixtures by default.

Required test layers:

- focused unit/guard test for missing confirmation lifecycle repair.
- mocked Print Queue batch-send path proving label-created -> shipment persisted -> outbox queued/status recorded.
- existing-label recovery test proving no duplicate label but missing outbox is repaired.
- ShipStation connector payload/ID test proving upstream `external_order_id` / `source_order_id`, not local `orders.id`, is used.
- read-only diagnostic test/fixture for the `#1149`-style state.
- surrounding print queue + marketplace confirmation suites.

## Required Test Cases

1. Normal Print Queue batch-send label path:

```text
no existing label
createLabelV2 succeeds
shipment row exists
fulfillment_outbox row exists
shipment confirmation_status = pending or succeeded/failed explicit
queue entry exists
```

2. Existing-label recovery path:

```text
active shipment exists
fulfillment_outbox missing
confirmation_status null
processQueueSendOrder reuses label
no new label purchased
outbox is created idempotently
queue entry is created/reused
```

3. ShipStation-source provider selection:

```text
source_provider=shipstation
external_order_id=290770091
local order id=1191799
must call/prepare ShipStation confirmation with upstream order id 290770091, not local id 1191799.
```

4. Confirmation unsupported path:

For providers without live confirmation support, shipment must be marked:

```text
confirmation_status = not_supported
confirmation_provider = provider
confirmation_last_error = sanitized reason
```

not left null.

5. No tracking path:

Missing tracking should become:

```text
confirmation_status = not_required or failed with explicit reason
```

according to existing fulfillment semantics, but not null.

6. Diagnostic warning:

`inspect:shipping-order` or equivalent must flag:

```text
shipped + active shipment + provider supports confirmation + no outbox + null confirmation_status
```

7. Idempotency:

Running the repair twice must not duplicate outbox rows or re-buy postage.

## Verification Commands

Run the focused new tests first, then surrounding suites. At minimum run and report results for:

```bash
npm run typecheck
npm run test:print-queue-invalid-label
npm run test:print-queue-durable
npm run test:print-queue-persistence
npm run test:print-queue-ownership
npm run test:print-queue-client-scope
npm run test:queue-label-diagnostics
npm run test:ebay-confirmation:mocked
npm run test:walmart-confirmation:payload
npm run test:marketplace-reconciliation
npm run smoke:shipping:test-label -- --fixture
npm run smoke:marketplace-confirm -- --mock-process-once
```

Also run any new PS-064-specific test/guard commands added, for example:

```bash
npm run test:print-queue-confirmation-outbox
npm run test:marketplace-confirmation-repair
```

Run read-only diagnostics against the real reported order and include redacted output summary:

```bash
npm run inspect:shipping-order -- --order-number 1149
npm run smoke:marketplace-confirm -- --order-id 1191799
npm run marketplace:confirmation:repair -- --order-number 1149 --dry-run
```

Do not run apply/live confirmation unless DJ explicitly approves the exact command and order.

## Definition Of Done

- Print Queue / batch-send label creation cannot leave a locally shipped label without an explicit confirmation lifecycle.
- Existing active labels missing confirmation outbox can be repaired idempotently without duplicate postage.
- ShipStation-source orders use ShipStation mark-as-shipped confirmation with upstream ShipStation order id and `notifySalesChannel=true`.
- Unsupported/not-required/failed states are recorded explicitly; no null confirmation state for confirmation-relevant shipments.
- Order `#1149`-style state is detected by diagnostics and has a dry-run recovery plan.
- Tests prove the original regression and surrounding print queue/confirmation paths.
- No live labels/postage/marketplace notifications/live shipped mutations were performed in automated tests.
- If any live repair is performed later, it is only after DJ approves the exact order/operation and the result is reported with sanitized evidence.

## Return Format

Reply with:

1. Root cause found.
2. Summary of code changes.
3. Files changed.
4. Before/after state for the `#1149`-style case.
5. Exact tests/commands run with pass/fail results.
6. Read-only diagnostic output summary for order `#1149`.
7. Dry-run recovery output for order `#1149`.
8. Confirmation that no duplicate label/postage was created.
9. Confirmation that no live marketplace/source notification was sent unless DJ explicitly approved it.
10. Any remaining risk or follow-up needed.
