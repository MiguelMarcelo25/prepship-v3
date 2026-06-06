# Refactor Backlog

PS-100 recommends small follow-up cards only. Do not implement these as one
rewrite. Each item is designed to be auditable, reversible, and testable without
buying postage or mutating production shipped/cancelled data.

## 1. Backend Best-Rate Workflow DTO and UI Consumption

- Problem evidence: `src/services/rates.ts` owns `pickBestRate`, while
  `OrdersView.tsx`, `RateBrowserModal.tsx`, and `v2-apiClient.ts` still reconcile
  best-rate display.
- Target owner: backend shipping/rates workflow service.
- Low-risk slice: add read-only DTO fields for `bestRateState`,
  `requestFingerprint`, `carrierStatuses`, and `sourceConfidence`; update one
  UI surface to consume them.
- Likely files: `src/services/rates.ts`, `src/routes/rates.ts`,
  `web/src/components/Views/orders-parity.ts`, `OrdersView.tsx`.
- Tests: PS-079/PS-081/strict recalculation guards plus one DTO guard.
- Non-goals: no label purchase behavior change.
- Blast radius: high.
- Rollback: remove DTO consumption; keep existing rate fields.

## 2. Remove Frontend Rate Fingerprint Authority

- Problem evidence: frontend has request-key/fingerprint helpers in
  `OrdersView.tsx`; backend has `rate-fingerprint.ts` and `rateCacheKey`.
- Target owner: `src/services/shipping-workflow/rate-fingerprint.ts`.
- Low-risk slice: backend returns request identity for all rate responses; frontend
  compares opaque backend key only.
- Likely files: `src/services/rates.ts`, `src/routes/rates.ts`,
  `web/src/lib/v2-apiClient.ts`, `OrdersView.tsx`.
- Tests: fingerprint guard, PS-081, PS-095.
- Non-goals: no rate algorithm changes.
- Blast radius: high.
- Rollback: frontend keeps old key builder behind feature flag.

## 3. Selected Rate Lifecycle DTO

- Problem evidence: selected rate exists as UI selection, `order_overrides`
  recommendation, proof payload, and `shipments.selectedRateJson`.
- Target owner: shipping workflow selected-rate service.
- Low-risk slice: add read-only selected-rate lifecycle state:
  `missing`, `exact`, `stale`, `mismatched`, `not_required`.
- Likely files: `src/services/shipping-workflow/rate-selection-proof.ts`,
  `src/routes/orders.ts`, `web/src/components/Views/orders-parity.ts`.
- Tests: selected-rate proof boundary and PS-098 certification.
- Non-goals: no new enforcement beyond existing proof guard.
- Blast radius: high.
- Rollback: hide DTO fields; existing proof enforcement remains.

## 4. Backend Provider Account Identity Resolver

- Problem evidence: provider/account ids are interpreted in `OrdersView`,
  `RateBrowserModal`, `v2-apiClient`, `src/services/rates.ts`, and direct label
  functions.
- Target owner: backend provider account resolver.
- Low-risk slice: add pure resolver that normalizes ShipStation `se-*`, numeric
  provider ids, direct `carrier_accounts.id`, and synthetic ids without provider
  calls.
- Likely files: new `src/services/shipping-workflow/provider-account-identity.ts`,
  existing guards.
- Tests: account identity guard, direct carrier scope guard.
- Non-goals: no endpoint routing change in first slice.
- Blast radius: high.
- Rollback: stop consuming resolver; keep tests documenting mapping.

## 5. Print Queue Operation State Machine

- Problem evidence: `src/services/print-queue.ts` creates labels, queues labels,
  recovers existing labels, and manages durable progress snapshots.
- Target owner: shipping workflow queue operation service.
- Low-risk slice: add read-only operation-state builder around existing queue job
  data; do not move provider calls.
- Likely files: `src/services/print-queue.ts`, `src/routes/print-queue.ts`,
  `OrdersView.tsx`.
- Tests: direct-carrier queue route, print queue batch names, PS-084.
- Non-goals: no queue schema rewrite.
- Blast radius: high.
- Rollback: return old queue status payload only.

## 6. Label Access Descriptor Service

- Problem evidence: label URL handling is duplicated across print queue, label
  routes, ShipStation helpers, direct labels, and frontend `openLabelPdf`.
- Target owner: backend label access/normalization service.
- Low-risk slice: add pure `normalizeLabelAccess` returning `{kind, url,
  format, safeToOpen, error}`; wire only read/reprint paths first.
- Likely files: `src/services/labels.ts`, `src/services/print-queue.ts`,
  `src/routes/print-queue.ts`, `web/src/lib/v2-apiClient.ts`.
- Tests: label URL guard, PS-099 label output guard.
- Non-goals: no provider label creation changes.
- Blast radius: medium.
- Rollback: fall back to current URL fields.

## 7. Marketplace Confirmation Status Surface

- Problem evidence: confirmation state spans `fulfillment_outbox` and shipment
  confirmation columns; local shipped does not mean upstream confirmed.
- Target owner: fulfillment confirmation lifecycle service.
- Low-risk slice: add read-only order/shipment confirmation DTO and UI badge for
  pending/failed/not-required.
- Likely files: `src/services/fulfillment/outbox.ts`, `src/routes/orders.ts`,
  `OrdersView.tsx`.
- Tests: marketplace confirmation guards, shipping roundtrip certification.
- Non-goals: no live marketplace calls.
- Blast radius: high.
- Rollback: hide badge; outbox unchanged.

## 8. Billing Frozen Line Item Read Model

- Problem evidence: billing generation reads live `orders`/`shipments` and writes
  `billing_line_items`; invoice/detail paths can still mix live reads for display.
- Target owner: billing generation/read-model service.
- Low-risk slice: document and enforce detail/invoice reads to prefer generated
  line items when present; diagnostics can show live mismatch separately.
- Likely files: `src/services/billing.ts`, `src/routes/billing.ts`,
  `web/src/components/Views/BillingView.tsx`.
- Tests: billing detail consistency, billing external fulfilled, billing pricing.
- Non-goals: no retroactive invoice mutation.
- Blast radius: high.
- Rollback: keep current route behavior; guard remains advisory.

## 9. Order Items Analytics Source Migration

- Problem evidence: `order_items` exists, but `orders.items` JSONB still appears
  in combo defaults, billing, inventory seeding, and analytics paths.
- Target owner: order item/reporting services.
- Low-risk slice: add read-only parity report showing where `orders.items` is
  still required, then migrate one analytics endpoint.
- Likely files: `src/services/order-items.ts`, `src/routes/analysis.ts`,
  `src/routes/dashboard.ts`.
- Tests: dashboard orders/units, analysis client scope, top SKU guards.
- Non-goals: no raw payload deletion.
- Blast radius: medium.
- Rollback: endpoint falls back to old query.

## 10. Package Default Precedence Resolver

- Problem evidence: order dims/weight can come from product defaults,
  SKU-quantity dims, combo defaults, packages, and order overrides.
- Target owner: package/default resolver service.
- Low-risk slice: pure resolver returns precedence and reason for one order; UI
  continues to call existing save routes.
- Likely files: `src/services/combo-package-defaults.ts`,
  `src/routes/products.ts`, `OrdersView.tsx`.
- Tests: PS-082 combo defaults, combo package default guards.
- Non-goals: no shipped/cancelled/default backfill.
- Blast radius: medium.
- Rollback: UI ignores resolver reason.

## 11. Split API Client By Domain

- Problem evidence: `web/src/lib/v2-apiClient.ts` is 4,818 LOC and mixes rates,
  labels, inventory, packages, billing, dashboard, and normalization.
- Target owner: frontend domain API clients that only transport backend DTOs.
- Low-risk slice: extract label/print-queue methods into a new module without
  changing method signatures.
- Likely files: `web/src/lib/v2-apiClient.ts`, new `web/src/lib/api/shipping.ts`.
- Tests: typecheck, label/print queue guards, full-site certification if UI touched.
- Non-goals: no backend behavior change.
- Blast radius: medium.
- Rollback: re-export old methods from `v2-apiClient.ts`.

## 12. Shipping Eligibility DTO Consolidation

- Problem evidence: blocked services and insurance/confirmation eligibility are
  represented in backend services and frontend modal display helpers.
- Target owner: backend shipping eligibility service.
- Low-risk slice: backend rate response includes canonical `allowed`,
  `blockedReason`, `ruleId`, `requiresRerate`.
- Likely files: `src/lib/shipping-service-eligibility.ts`, `src/services/rates.ts`,
  `src/routes/rates.ts`, `RateBrowserModal.tsx`.
- Tests: PS-057, PS-072, rate hardening, direct-carrier scope.
- Non-goals: no carrier quote algorithm changes.
- Blast radius: medium.
- Rollback: UI ignores new fields.

