# PS-305 Authority Drift Guardrails

Date: 2026-06-22

## Purpose

PS-305 prevents backend-critical shipping authority from drifting back into the
frontend. It is a guardrail ticket, not a runtime behavior change.

The frontend may fetch, display, filter, collect operator intent, show progress,
and render backend statuses. It must not become the source of truth for money,
rates, labels, billing, package facts, carrier account identity, marketplace
notifications, or shipped/cancelled safety.

## Backend Owners

Rates and proof:

- `src/services/rates-combined.ts` owns carrier-universe merge, diagnostics, and
  final best-rate comparison across ShipStation plus direct carriers.
- `src/services/shipping-workflow/rate-quote-snapshot-store.ts` owns backend
  rate quote snapshots, selected-rate keys, and purchase-boundary validation.
- `src/routes/rates.ts` remains the thin route that validates inputs, calls
  services, and returns DTOs.

Labels and Print Queue:

- `src/services/labels.ts#createLabelV2` owns label purchase, direct-carrier
  delegation, duplicate-label protection, selected-rate proof enforcement, and
  HUGRAB label-gate enforcement.
- `src/services/print-queue.ts` owns queueable label URL normalization and
  print-queue label creation/recovery through `createLabelV2`.
- `src/services/print-queue/queue-route-orchestrator.ts` owns backend route-plan
  orchestration when the backend print-queue flags are enabled.

Billing and money:

- `src/services/shipping-workflow/rate-money.ts` owns row money display,
  customer/marked-rate math, marketplace fee display, and markup application.
- `src/services/shipping-margin-analytics.ts` owns shipping-margin read models
  and provenance for actual cost, billable amount, frozen/projected state, and
  missing proof.
- Billing route/service guards remain the authority for generated line items,
  invoice truth, and client scope.

Package, carrier, account, and row display facts:

- `src/services/package-facts-policy.ts` owns effective package/dims/weight
  precedence.
- `src/services/shipping-workflow/best-rate-workflow-dto.ts` owns row workflow
  state, allowed actions, display tuple, carrier/service/account facts, and
  purchase/queue eligibility.
- `src/routes/orders.ts` may assemble backend DTOs from these owners, but route
  code must stay thin and must not mint a competing source of truth.

## Guard Commands

Rates/proof:

- `test:ps-111-backend-rate-authority`
- `test:ps-124-backend-combined-best-rate`
- `test:ps-244-rate-finalization-single-owner`
- `test:ps-302-apply-best-rate-authority`

Labels/queue:

- `test:selected-rate-proof-boundary`
- `test:ps-202-direct-label-owner`
- `test:print-to-queue-selected-rate-proof`
- `test:ps-303-print-queue-authority`

Billing/money:

- `test:ps-177-row-money-display`
- `test:ps-220-house-margin`
- `test:ps-295-house-customer-rate-proof`
- `test:ps-296-shipping-margin`
- `test:ps-296-shipping-margin-closeout`

Package/display:

- `test:ps-205-package-facts-precedence`
- `test:ps-301-row-workflow-authority`
- `test:ps-304-shipping-display-facts-authority`

PS-305 closeout:

- `test:ps-305-authority-drift`

CI ratchet:

- `.github/workflows/ci.yml` runs `test:ps-305-authority-drift` before
  typecheck/build so the authority contract cannot silently disappear.

## Explicit Frontend Debt

These frontend files still need careful PS-306 follow-up when the OrdersView
decomposition continues. Their frontend logic must stay presentation-only or be
moved behind backend owners before it can become authoritative:

- `web/src/components/Views/OrdersView.tsx`
- `web/src/hooks/useOrders.ts`
- `web/src/components/Views/order-shipping-display.ts`
- `web/src/components/Views/orders-display-state.ts`
- `web/src/components/Views/orders-row-display.tsx`
- `web/src/components/RateBrowserModal.tsx`
- `web/src/lib/rate-proof.ts`
- `web/src/components/Views/BillingView.tsx`
- `web/src/components/Views/DashboardView.tsx`
- `web/src/components/Views/InventoryView.tsx`

Current acceptable frontend behavior:

- Read backend-issued `rateQuoteId`, `selectedRateKey`, and proof fields without
  recomputing fingerprints.
- Prefer backend canonical `shipping` and `bestRateWorkflow.display` facts when
  present.
- Keep remaining compatibility fallbacks explicit and tracked as PS-306 debt.
- Render UI state, selected rows, buttons, progress, toasts, filters, and status
  display.

Rejected behavior:

- Frontend-computed final/best rate or customer billable amount.
- Frontend-minted selected-rate proof or purchase fingerprint.
- Frontend direct label purchase orchestration outside backend label owners.
- Frontend billing totals used as invoice truth.
- Frontend package/dim/weight precedence used as the carrier or billing source
  of truth.

## Safety

This PS-305 artifact is offline and read-only. It does not run live labels,
postage, voids, marketplace notifications, production order mutations, queue
mutations, or shipped/cancelled data mutations.

It does not modify shipped/cancelled locked runtime files. Any future change
touching locked shipped/cancelled behavior still requires the explicit current
conversation override from `AGENTS.md`.
