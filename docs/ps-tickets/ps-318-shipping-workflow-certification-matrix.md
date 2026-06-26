# PS-318 - Shipping workflow certification matrix

PS-318 is a certification layer over existing backend owners. PS-318 does not create a new shipping workflow owner,
does not rebuild PS-300/302/303/304/305/312/317, and does not move business
truth into React or route-local wrappers. The purpose is to show which
shipping workflow paths already pass through backend source-of-truth services,
which paths are explicitly not_applicable or not_supported, and which live-only
paths require a DJ-approved canary.

## Backend owner map

| Workflow row | Backend owner | Certified responsibility |
| --- | --- | --- |
| Awaiting row loads backend-owned shipping/rate/display state | `src/services/shipping-workflow/best-rate-workflow-dto.ts`, `src/services/shipping-workflow/rate-money.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | Emits safe row state, rate freshness/proof facts, rate money display facts, and create/queue block reasons. |
| Best Rate / selected-rate proof | `src/services/rates-combined.ts`, `src/services/rates.ts`, `src/services/shipping-workflow/rate-fingerprint.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | Owns candidate universe, final best-rate selection, selected-rate proof, freshness, account binding, and retry reason. |
| Create + Print | `src/services/labels.ts#createLabelV2`, `src/services/fulfillment/shipping-safety.ts` | Blocks unsafe shipped/cancelled/upstream-shipped orders, validates selected proof, buys through direct/ShipStation provider owners, persists shipment truth, and enqueues confirmation. |
| Print Queue | `src/services/print-queue.ts`, `src/services/print-queue/queue-route-orchestrator.ts` | Owns create/recover/queue flow, route planning, existing-label recovery, queue URL validation, retry classification, and confirmation repair kick. |
| Shipment persists frozen provider/rate/label snapshot | `src/services/labels.ts#persistCreatedLabel`, `src/db/schema/shipments.ts` | Freezes label URL/cost/provider account/rate snapshot fields such as `selectedRateJson`, `providerAccountNickname`, and `carrierProvider`. |
| Shipped row renders actual shipment truth | `src/db/schema/shipments.ts`, shipping display/read models, Orders row DTOs | Reads persisted shipment facts instead of recomputing rate/purchase truth from frontend state. |
| Fulfillment outbox / marketplace confirmation lifecycle | `src/services/fulfillment/outbox.ts`, `src/services/fulfillment/confirmation-payload.ts` | Plans not_applicable, not_supported, already pending/succeeded, or pending outbox confirmation. Marketplace identity is built once for Walmart/eBay. |
| Billing/inventory side effects | `src/services/fulfillment-deductions.ts`, `src/services/shipping-margin-analytics.ts`, `src/services/shipping-workflow/house-margin-capture.ts` | Inventory/package deductions stay behind backend owners and kill switches; billing/margin reads frozen shipment or billing rows. |

## Store/provider matrix

| Store/provider path | Fixture/order shape | Commands / evidence | Expected result | Actual result | Owner / gap |
| --- | --- | --- | --- | --- | --- |
| HUGRAB / ShipStation-source | Fixture/mock carrier path, backend rate proof, HUGRAB insurance-sensitive policy | `test:ps-085-shipping-workflow`, `test:ps-098-shipping-purchase-boundary`, `test:ps-300-backend-shipping-authority`, `test:ps-327-hugrab-margin-policy` | Selected proof and HUGRAB policy are backend-owned; no frontend purchase truth. | Pass in offline guards. | Backend owners verified. |
| Walmart-source | Walmart order identity, Walmart confirmation payload guard, mock connector | `test:walmart-confirmation:payload`, `test:ps-285-marketplace-confirm-boundary`, `smoke:marketplace-confirm -- --mock-process-once` through `test:shipping-roundtrip-certification` | Confirmation identity includes purchase order / line data; live shipping call is blocked without real line proof. | Pass in mock/offline coverage; live canary required for production connector execution. | Backend owner verified; live canary required. |
| eBay / eBay Shipping or ShipStation-synced eBay | eBay raw order with line items or ShipStation source order id | `test:ps-285-marketplace-confirm-boundary`, `test:ps-326-carrier-account-identity-certification`, confirmation identity pure checks | eBay identity is built from raw order line items; ShipStation relay is not_supported when upstream id is missing. | Pass in pure/static coverage; live canary required for connector execution. | Backend owner verified; live canary required. |
| Direct carrier / Shipp / EasyPost | Direct synthetic provider id, backend queue route and createLabelV2 direct provider branch | `test:direct-carrier-labels`, `test:direct-carrier-queue-route`, `test:ps-303-print-queue-authority`, `test:ps-317-fe-buy-anti-regression`, `test:carrier-harness` | Frontend direct buy is deleted; backend owns direct label purchase or route plan. | Pass in guards. Sandbox/live carrier harness tiers remain opt-in. | Backend owner verified; sandbox/live canary required for provider-specific live response. |
| Manual/internal/no marketplace | Active local label with no marketplace provider | `test:ps-064-confirmation-outbox`, PS-318 lifecycle pure plan | Fulfillment outbox marks not_applicable / not_required instead of inventing a marketplace notification. | Pass in pure lifecycle plan. | not_applicable. |
| Unsupported connector/status | Provider lacks a live confirmation connector or required upstream id | `test:ps-064-confirmation-outbox`, PS-318 lifecycle pure plan | Fulfillment lifecycle marks not_supported and records a safe reason. | Pass in pure lifecycle plan. | not_supported. |

## Reused commands

- `guard:shipping-certification`
- `test:shipping-roundtrip-certification`
- `test:ps-085-shipping-workflow`
- `test:ps-098-shipping-purchase-boundary`
- `test:ps-300-backend-shipping-authority`
- `test:ps-303-print-queue-authority`
- `test:ps-317-fe-buy-anti-regression`
- `test:direct-carrier-labels`
- `test:direct-carrier-queue-route`
- `test:carrier-harness`
- `test:ps-285-marketplace-confirm-boundary`
- `test:ps-064-confirmation-outbox`
- `test:walmart-confirmation:payload`
- `test:shipstation-label-url`
- `test:ps-318-shipping-workflow-certification`

## New PS-318 certification guard

`test:ps-318-shipping-workflow-certification` is fixture/mock/offline only. It:

- checks the matrix document and predecessor command wiring;
- verifies pure shipping safety blocks shipped/cancelled/external-shipped states;
- verifies backend queue route planning preserves never-buy rungs and the
  direct-via-backend cutover;
- verifies Walmart/eBay marketplace identity derivation without label context;
- verifies fulfillment lifecycle plans explicit not_applicable/not_supported
  states instead of silent marketplace failure;
- pins `createLabelV2` source order: safety/proof gates before provider calls,
  shipment snapshot persistence, deductions, margin capture, and confirmation
  enqueue;
- pins Print Queue create/recover/queue behavior and retry classification;
- pins frontend no-buy boundaries and backend intent posting;
- pins shipments/billing/inventory owner fields and kill switches;
- confirms the existing roundtrip runner carries a sanitized store/provider
  matrix.

## Caveats

- Live marketplace notification execution, real labels, real postage, and real
  voids remain outside automated PS-318 proof. Those require a live canary
  required by DJ with exact order/provider/scope approval.
- `test:carrier-harness` self-check is offline. Sandbox/capture/live modes are
  opt-in and are not run by PS-318.
- PS-318 classifies missing live-only coverage as a canary caveat, not as a
  reason to move business truth into frontend code.

## Safety

This certification produces No real labels, No postage, No voids, No marketplace notifications,
No production shipped/cancelled mutation, and No customer PII. It performs no
SQL UPDATE/DELETE against production orders or shipments and does not weaken
selected-rate proof, duplicate-label prevention, RBAC/client scope, financial
redaction, or shipped/cancelled lockdown.
