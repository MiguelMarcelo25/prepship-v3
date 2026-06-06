# PS-100 Architecture Debt Audit

Date: 2026-06-05  
Branch: `prepshipv4-stable`  
Commit inspected: `9456c1ac`  
Scope: documentation-first architecture debt, source-of-truth, and refactor backlog audit.

## Purpose

PrepShip V4 now has enough shipping, billing, inventory, marketplace, and
frontend workflow surface area that broad cleanup would be unsafe. PS-100 maps
the current codebase and recommends small follow-up tasks. It does not refactor
runtime code.

Layered truth model used by this audit:

```text
external source truth -> normalized operational truth -> frozen side-effect snapshots -> reporting/read models
```

Caches and UI state are performance/display helpers unless explicitly frozen at
a side-effect boundary.

## Audit Documents

- [Hotspot Baseline](./hotspot-baseline.md)
- [Source-of-Truth Matrix](./source-of-truth-matrix.md)
- [Workflow Traces](./workflow-traces.md)
- [Duplication Register](./duplication-register.md)
- [Refactor Backlog](./refactor-backlog.md)

## Top Findings

1. `web/src/components/Views/OrdersView.tsx` is the largest hotspot at 11,750
   LOC and still owns UI state, rate selection, best-rate reconciliation, label
   payload construction, print queue routing, and batch recalculation decisions.
2. `web/src/components/RateBrowserModal.tsx` duplicates rate display, grouping,
   dedupe, selection, and blocked-rate logic that overlaps with `src/services/rates.ts`.
3. `web/src/lib/v2-apiClient.ts` is an API facade plus transformation layer plus
   provider-routing layer; it decides several boundaries that should eventually
   be backend-owned workflow decisions.
4. Shipping side effects are mostly guarded, but label purchase, shipment
   persistence, print queue insertion, fulfillment outbox enqueue, and marketplace
   confirmation still form a multi-step chain rather than one durable lifecycle.
5. Billing, inventory, dashboard, and analysis are improving toward domain
   services, but several read models still derive facts from raw order JSON or
   frontend transformations that should not become audit truth.

## Guardrails Observed

- Shipped/cancelled/shipments lockdown was treated as read-only audit surface.
- No SQL writes, label creation, postage purchase, voids, marketplace
  notifications, or production data mutations were performed for PS-100.
- No secrets, raw provider payloads, raw labels, customer addresses, tracking
  numbers, tokens, cookies, or database URLs are included in these docs.

