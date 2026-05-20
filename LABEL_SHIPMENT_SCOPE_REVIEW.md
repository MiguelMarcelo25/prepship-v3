# Label / Shipment Scope Review

## Executive Summary

Phase 12 Batch 3J maps the label and shipment access-control boundary before any runtime enforcement work. This is a planning and control batch only.

No runtime label, shipment, shipped/cancelled, fulfillment, or schema behavior changes are included.

The goal is to make the next implementation batch boring: every label and shipment route has a named owner, permission, scope rule, risk, and test before code touches side-effect paths.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Label actions are side-effect heavy | Label creation can write shipments, update orders, affect packages/inventory, and queue fulfillment work | Validate permissions and client/store scope before side effects | Dedicated label permission and ownership tests |
| Shipment reads expose customer PII | Shipment rows can expose recipient data, label metadata, and costs | Scope reads through order/client/store ownership | Scoped user cannot read another client's shipment |
| Label artifacts are sensitive | Label PDFs and label URLs contain customer address data | Treat label PDFs and label URLs as customer PII | Expired/signed URL and scoped retrieval tests |
| Batch label creation can partially cross scopes | A batch can contain orders from multiple clients/stores | Batch label creation must validate every order before side effects | Mixed-scope batch is rejected before any label is purchased |
| Shipped/cancelled guard must remain intact | Label work touches protected order states | Preserve shipped/cancelled label creation guard | Existing orders UX and shipped/cancelled guards continue passing |

## High-Risk Issues

| Area | Current Concern | Enterprise Requirement | Recommended Fix |
|---|---|---|---|
| `POST /labels` and `POST /labels/create` | Label creation is authenticated but needs role and client/store ownership policy | `labels:create` plus order ownership validation | Add preflight scope validation before calling label service |
| `POST /labels/create-batch` | Batch requests can contain mixed order IDs | Every order must be validated before side effects | Add all-or-none batch preflight validation |
| `POST /labels/:shipmentId/void` | Void action touches shipment state and provider state | `labels:void` plus shipment/order ownership validation | Add scoped shipment lookup before void service call |
| `POST /labels/:shipmentId/return` | Return labels expose label artifacts and provider state | `labels:return` plus shipment/order ownership validation | Add scoped shipment lookup before return-label call |
| `GET /labels/:lookup/retrieve` and `GET /labels/:lookup` | Label lookup can expose label URLs/PDF metadata | `labels:read` plus shipment/order ownership validation | Add scoped lookup and artifact policy |
| `GET /shipments` and `GET /shipments/:id` | Shipment reads need explicit client/store filtering | `shipments:read` plus client/store scope | Add read-only scope filters in a reviewed implementation |
| `POST /shipments/sync` | Sync is a global operational action | `shipments:sync` or operations permission | Gate sync start separately from read-only status |

## Medium-Risk Issues

| Area | Concern | Recommendation |
|---|---|---|
| `/labels/mock/:shipmentId` | Signed mock label URLs are intentionally special-case | Keep signed/expiring behavior; do not introduce public unsigned URLs |
| Shipment status route | `/shipments/status` is operational status, not row data | Keep low-PII status response but gate if job payloads expand |
| Label retrieval freshness | Fresh provider retrieval can be slower and expose provider failures | Surface controlled errors and preserve signed/artifact privacy |
| Cost fields | Label costs and rates are financial data | Keep `financials:read` policy for returned costs |
| Audit coverage | Label/void/return actions need actor evidence | Add audit events in the audit-logging implementation batch |

## Route Inventory

| Route | Method | Current Owner | Side Effects | Required Permission | Client/Store Scope Rule | Required Test |
|---|---|---|---|---|---|---|
| `/labels` | `POST` | `src/routes/labels.ts` -> `createLabelV2` | Creates label, writes shipment/order state, may trigger package/inventory/fulfillment side effects | `labels:create` | Validate `orderId` is in caller's allowed client/store scope before service call | Scoped user cannot create a label for another client's order |
| `/labels/create` | `POST` | `src/routes/labels.ts` -> `createLabelV2` | Same as `/labels` | `labels:create` | Same order preflight rule | Same as `/labels` |
| `/labels/create-batch` | `POST` | `src/routes/labels.ts` -> `createBatchV2` | Creates multiple labels and shipment/order side effects | `labels:create` | Validate every order in the batch before any side effect | Mixed-scope batch is rejected before first label purchase |
| `/labels/:shipmentId/void` | `POST` | `src/routes/labels.ts` -> `voidLabelV2` | Voids provider/local shipment state | `labels:void` | Validate shipment -> order -> client/store ownership before service call | Scoped user cannot void another client's shipment |
| `/labels/:shipmentId/return` | `POST` | `src/routes/labels.ts` -> `createReturnLabelV2` | Creates return label artifact | `labels:return` | Validate shipment/order ownership before service call | Scoped user cannot create return label for another client |
| `/labels/:lookup/retrieve` | `GET` | `src/routes/labels.ts` -> `retrieveLabelV2` | Reads or refreshes label artifact metadata | `labels:read` | Validate lookup resolves to an owned shipment/order before returning label data | Scoped user cannot retrieve another client's label |
| `/labels/:lookup` | `GET` | `src/routes/labels.ts` -> `lookupLabel` | Reads local label metadata | `labels:read` | Validate lookup resolves to an owned shipment/order before returning label data | Scoped user cannot lookup another client's label |
| `/labels/mock/:shipmentId` | `GET` | `src/routes/labels.ts` signed mock-label handler | Serves mock label artifact | signed URL policy, optional `labels:read` if moved behind auth | Keep signed/expiring URL; never expose unsigned public mock links | Unsigned or expired mock link is rejected |
| `/shipments` | `GET` | `src/routes/shipments.ts` | Reads shipment rows | `shipments:read` | Intersect requested `clientId` with JWT `clientIds`; scope store via related order where needed | Client-scoped user sees only assigned shipments |
| `/shipments/:id` | `GET` | `src/routes/shipments.ts` | Reads one shipment row | `shipments:read` | Validate shipment belongs to assigned client/store before returning | Client-scoped user cannot read another client's shipment |
| `/shipments/status` | `GET` | `src/routes/shipments.ts` | Reads sync status | `shipments:read` or operations status permission | Keep status payload free of customer PII | Client user denied if status becomes global operational info |
| `/shipments/sync` | `POST` | `src/routes/shipments.ts` -> `syncShipments` | Starts shipment sync job | `shipments:sync` | Global operational action; no client override | Warehouse/client users cannot start global shipment sync |

## Required Policies

- `labels:create`: create single or batch labels only for orders in scope.
- `labels:void`: void labels only for shipments in scope.
- `labels:return`: create return labels only for shipments in scope.
- `labels:read`: retrieve label metadata/artifacts only for shipments in scope.
- `shipments:read`: list/read shipments only in scope.
- `shipments:sync`: start global shipment sync.
- Label PDFs and label URLs are customer PII.
- Batch label creation must validate every order before side effects.
- Preserve shipped/cancelled label creation guard.
- Preserve existing inventory/package auto-deduct kill-switch behavior.
- Preserve signed/expiring mock label URLs.

## Recommended Patches

1. Add permission constants for `labels:create`, `labels:void`, `labels:return`, `labels:read`, `shipments:read`, and `shipments:sync`.
2. Add preflight scoped lookup helpers that read order/shipment ownership without changing shipment or shipped/cancelled mutation logic.
3. Apply read-only shipment scoping first.
4. Apply label mutation preflight checks after side-effect review.
5. Add label artifact audit events after the audit-log table/service exists.
6. Add browser smoke checks for scoped label retrieval and shipment list access.

## Test Plan

- `npm run test:label-shipment-scope-review`
- Future runtime tests:
  - Unauthenticated label/shipment routes return `401`.
  - User without `labels:create` cannot create labels.
  - User without `labels:void` cannot void labels.
  - User without `labels:return` cannot create return labels.
  - User without `shipments:sync` cannot start shipment sync.
  - Scoped user cannot list, lookup, retrieve, void, return, or create labels for another client's shipment/order.
  - Mixed-scope batch label creation is rejected before side effects.
  - Expired or unsigned mock-label URL is rejected.
  - Existing shipped/cancelled lockdown tests still pass.

## Deployment / Rollback Notes

- This batch is documentation and static guard only, so rollback is a normal git revert.
- Runtime enforcement must deploy separately after review because label actions and shipment writes are operationally sensitive.
- If runtime label-scope enforcement later blocks legitimate warehouse work, rollback that implementation batch and keep this review document as the policy map.

## Recommended Implementation Order

1. Review this document with DJ/OpenClaw.
2. Add static tests for label/shipment route policy.
3. Add permission constants and route guards without changing service behavior.
4. Add read-only shipment scope filters.
5. Add label mutation preflight ownership checks.
6. Add audit events for create/void/return/retrieve.
7. Add production smoke evidence to `PRODUCTION_READINESS_SIGNOFF.md`.

## Current Status

- [x] Route inventory completed.
- [x] Lockdown boundary documented.
- [x] Future permissions named.
- [x] Label artifact PII policy documented.
- [x] Batch preflight requirement documented.
- [ ] Runtime enforcement not implemented.
- [ ] Production smoke evidence not captured.
