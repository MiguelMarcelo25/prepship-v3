# PS-053 - Make Print to Queue Atomic and Recover Label-Created/Not-Queued Partial Success

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Status: New official task. This is the source-of-truth task for the Print to Queue failure where postage/label creation succeeds, the order moves to shipped, but the label never appears in the print queue.

## Context

- DJ clicked Print to Queue for order `#200014699696335`.
- UI showed this red error toast:
  `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Object (Request ID: 076ea3d7-0a04-44fe-a00e-a1565c8f83f0)`
- Despite the error, the label was created, the order moved to shipped, and it did not appear in the print queue.
- Repo/db triage found the partial-success state:
  - order is shipped/canonical shipped
  - one active shipment exists with tracking + label URL
  - no `print_queue_orders` row exists for that order/order number
  - no `fulfillment_outbox` row exists for that order
  - label/shipment was created around 2026-05-31 04:50:45 PM PDT; order updated around 2026-05-31 04:55:36 PM PDT
- This is not just a UI toast problem. It is a workflow atomicity/idempotency problem: label/shipped side effects can succeed, but queue insertion can be skipped if a later backend/frontend step throws.
- Prior fixes around commits `e0cc1dd` / `0036067` improved existing-label recovery for explicit "Label already exists for this order" conflicts, but this bug is broader: internal/post-label exceptions after successful label purchase are not recovered into the queue path.

## Business Rule / Safety Invariant

- Print to Queue means: buy/create or recover exactly one label, persist it, move order to shipped if appropriate, and add that exact label to the active print queue.
- It must never buy duplicate postage during recovery.
- Shipped status means label/tracking exists; print queue status is separate and must persist until explicit Confirm Printed / remove / admin clear.
- Do not mark a queue entry printed just because a PDF opened/merged/downloaded.

## Files To Inspect First

- `web/src/components/Views/OrdersView.tsx`
  - `createOrQueueLabel('queue')`
  - `queueExistingLabelAfterCreateConflict(...)`
  - `buildQueueAddPayload(...)`
  - `queueExistingLabels(...)`
  - `sendOrdersToQueueBackend(...)`
  - Quick Reprint / Queue Existing Labels paths
- `src/services/labels.ts`
  - `createLabelV2(...)`
  - `persistCreatedLabel(...)`
  - `markOrderShipped(...)`
  - `enqueueShipmentConfirmation(...)`
  - marketplace confirmation/background followups
- `src/services/print-queue.ts`
  - `addToPrintQueue(...)`
  - queue send job handling
  - PDF merge label fetching/normalization paths
- `src/routes/print-queue.ts`
- `src/routes/labels.ts`
- `src/main.ts`
  - request-id/error handling
- `src/connectors/carrier/shipstation.ts`
- `src/lib/shipstation/labels.ts`
  - labelUrl / label_download normalization boundaries

## Implementation Requirements

### 1. Make Print To Queue Atomic/Idempotent From The Operator's Perspective

- Queue mode must not be split into "create label succeeded" followed by a fragile separate frontend queue-add that can be skipped without recovery.
- Prefer a server-side create-or-recover-and-queue path: create/recover label, persist shipment, add `print_queue_orders` row, then return one queue-aware response.
- If the label already exists, recover the existing active label and queue it; do not create a second label.
- If a label was just created and a later step throws, recovery must detect the active label and queue it instead of leaving "shipped but not queued."

### 2. Make Label URL/PDF Source Normalization Robust

- Normalize provider label payloads at backend boundaries before persistence, retrieval, queue add, and merge.
- Handle string URLs and object-shaped payloads safely, including shapes such as `{ pdf }`, `{ href }`, `{ url }`, and nested `label_download`-style objects.
- Reject invalid/corrupt objects with an actionable PrepShip error message.
- Never surface raw Node errors like `Buffer.from received Object` to the operator.
- Do not persist or enqueue `[object Object]` as a label URL.

### 3. Decouple Marketplace Confirmation/Outbox From Queue Success

- Marketplace confirmation/outbox processing must not block the label+queue result returned to the UI.
- If confirmation enqueue/process fails, record retry/failure state, but do not prevent the created label from entering the print queue.
- Preserve fulfillment outbox retry semantics and do not silently drop marketplace confirmation failures.

### 4. Frontend Recovery Must Be Broader Than Exact String Matching

- In queue mode, if an API error occurs, check whether the order now has an active label and attempt the existing-label queue recovery path.
- The old exact "Label already exists for this order" path is not enough.
- User-facing toasts must distinguish:
  - label purchase failed / no postage bought
  - label bought but queue recovery was needed
  - label bought and queued successfully
  - label exists but queue failed and requires manual recovery

### 5. Queue Insertion Must Be Idempotent

- Repeated Print to Queue / Queue Existing Labels clicks for the same active label should not create duplicate active queue entries.
- Existing queue rows should be reused/refreshed consistently according to current print queue semantics.
- Preserve queue scope/client behavior; if queue scope affects visibility, make the result/status explicit enough that operators do not think the label disappeared.

### 6. Preserve Safety Boundaries

- Do not weaken auth/RBAC/client scope/store scope.
- Do not expose secrets, raw label URLs, tracking numbers, customer addresses, raw provider payloads, tokens, or credentials in logs, screenshots, test output, or PR notes.
- Do not mutate shipped/cancelled rows except through the approved shipped-label recovery/queueing behavior.
- Do not buy live postage in automated tests.

## Testing Applicability

- This is a critical operator shipping workflow and crosses label purchase + print queue + marketplace confirmation boundaries.
- It requires backend tests for idempotency/normalization and browser/API workflow coverage for the actual Print to Queue path.
- Automated tests must use mocked/offline provider responses or test fixtures. Do not create real labels, buy postage, or notify marketplaces.

## Required Regression Coverage

Add or update tests that prove all of the following:

1. Queue mode success path:
   - label create succeeds
   - shipment persists
   - order becomes shipped
   - `print_queue_orders` gets exactly one active queued row
   - UI shows success/queue-updated status
2. Partial-success path:
   - simulate label create + shipment persist + order shipped, then throw in a later post-label step
   - system recovers by queueing the existing active label or returns an explicit recoverable "label created but queue failed" status without buying duplicate postage
   - no generic Buffer/Object error reaches the UI
3. Existing-label path:
   - already-shipped/order-with-active-label queues existing label only
   - no duplicate shipment/label/postage is created
4. Object-shaped label payloads:
   - string URL works
   - `{ pdf }` works
   - `{ href }` works
   - `{ url }` works
   - nested `label_download` object works if applicable
   - invalid object returns actionable error and does not enqueue/persist `[object Object]`
5. Queue idempotency:
   - repeated attempts for the same active label do not create duplicate active queue entries
6. Marketplace confirmation/outbox failure:
   - confirmation failure is recorded/retried, but does not prevent label queue insertion

## Verification Commands

Run and return exact output summaries for:

```bash
npm run typecheck
npm run build:web
npm run guard:source-of-truth
npm run test:orders-ux:browser
npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line
```

Also run the focused backend/unit/component/browser test command(s) added for PS-053 and include the exact command(s) and pass/fail result. If a new script is added for the focused tests, document it.

## Manual / Workflow Verification

In mocked/offline/sandbox mode only, reproduce the reported flow:

1. Start with an awaiting shipment order with no label and no queue row.
2. Click/trigger Print to Queue.
3. Verify label/shipment exists, order is shipped, and exactly one queue row exists.
4. Inject/simulate a post-label error after shipment persistence and verify recovery queues the existing label or presents an explicit recoverable queue error without duplicate postage.
5. Verify the shipped side-panel Queue Existing Labels / Quick Reprint path still queues existing labels only.

Do not perform live postage purchase or live marketplace notification unless DJ explicitly approves the exact live test.

## Definition Of Done

- Print to Queue can no longer leave the system in "label bought/order shipped/no queue row/no useful recovery" state for the tested failure classes.
- Object-shaped label payloads are normalized or rejected safely; operator never sees raw Node Buffer/Object type errors.
- Existing-label recovery covers post-label exceptions, not just exact "Label already exists" conflicts.
- Queue entries remain active until explicit operator action; shipped status does not delete/auto-print queue rows.
- Marketplace confirmation failures do not block queue insertion and remain observable/retryable.
- All required automated checks pass.
- The PR/return notes include before/after behavior, files changed, commands run, and evidence for the mocked/offline workflow certification.

## Return Format

- Summary of root cause fixed.
- Files changed.
- How duplicate postage is prevented.
- How queue idempotency is enforced.
- How object-shaped label URLs are normalized/rejected.
- Test commands run with pass/fail results.
- Manual/offline workflow evidence.
- Any remaining risks or follow-up tasks.
