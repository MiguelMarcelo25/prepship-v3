# PS-054 - Fix Walmart PO Lookup Safety and Certify Walmart Label to Print Queue to Marketplace Confirmation Dry-Run

Status: New official task. This task is the source of truth for Walmart customerOrderId to purchaseOrderId lookup safety and the mocked Walmart label/queue/confirmation certification path.

## Problem

Walmart live order lookup by `customerOrderId` must never accept the first returned order when Walmart returns a list that does not contain an exact match. A wrong fallback can buy postage against the wrong Walmart purchase order and then attempt a marketplace confirmation for the wrong order.

The related workflow also needs a mocked end-to-end certification path proving Walmart label creation can produce a queueable label string, Print Queue validates/recover queues it safely, and marketplace confirmation/outbox payloads are built without blocking queue success.

## Required Behavior

- `lookupWalmartOrderByCustomerOrderId(...)` must require an exact returned `customerOrderId`.
- If no exact match is present, the lookup must return `null` and the label path must fail before label purchase with a clear sanitized error.
- Logs must not expose raw Walmart orders, customer addresses, tokens, credentials, raw label payloads, PDFs, or base64 label contents.
- Mocked Walmart label extraction must accept supported nested URL/base64 response shapes.
- Unsupported object-shaped label payloads must fail with actionable sanitized field/type errors before Print Queue insertion.
- Print Queue mode must queue a valid string URL/data URL, recover existing active labels when possible, and avoid duplicate postage.
- Walmart marketplace confirmation/outbox failures must not be shown as label generation or queue insertion failures after a label is successfully created.

## Guardrails

- No real Walmart token, estimate, label purchase, postage, or marketplace notification in automated tests.
- No live order, shipment, print queue, or outbox mutations in automated verification.
- Do not weaken authentication, authorization, client/store scope, source connector, carrier connector, or order connector protections.
- Do not expose secrets, PII, raw provider payloads, raw labels, or full tracking numbers in task output.

## Verification

Required commands:

```bash
npm run test:ps-054-walmart-workflow
npm run test:walmart-confirmation:payload
npm run test:direct-carrier-labels
npm run smoke:marketplace-confirm -- --mock-process-once
npm run guard:shipping-certification
npm run typecheck
npm run build:web
npm run guard:source-of-truth
```

If UI code is touched, also run the relevant browser workflow coverage.

## Definition of Done

- Shared Walmart PO lookup no longer contains any first-order fallback.
- Label purchase cannot continue without an exact live Walmart customerOrderId match.
- Mocked workflow guard covers Walmart lookup, label response extraction, queueable label validation, existing-label recovery contract, and Walmart confirmation payload shape.
- All required commands pass or any environmental blocker is documented clearly.
- Final report confirms no live postage, real label purchase, live Walmart notification, production data mutation, PII leak, or shipped/cancelled protection weakening occurred.
