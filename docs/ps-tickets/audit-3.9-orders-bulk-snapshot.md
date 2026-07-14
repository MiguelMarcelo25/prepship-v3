# Audit 3.9 — Orders bulk-action snapshot placement

## Architecture placement / source-of-truth gate

- **Business workflow:** Bulk actions need a complete, current order DTO for
  each explicitly selected ID without replaying every filtered Orders page.
- **Canonical owner:** `src/services/orders-read-model.ts` owns snapshot
  ordering/completeness; the existing Orders list/read-model pipeline owns row
  composition. The route validates, scopes, and delegates.
- **Unsafe/duplicated owner removed:** `v2-apiClient.fetchMatchingOrdersForSelection`
  sequentially downloaded full list pages, while `OrdersView` searched those
  unrelated rows for missing selections.
- **Earliest imperfect-data entry:** Selected IDs can outlive a paginated page.
  Rehydrating by current filters can omit a selected row after status/filter
  drift or combine DTOs from different page-request times.
- **Callers that delegate:** Selected bulk-action hydration posts only missing
  IDs. All-matching actions first request matching IDs, then one snapshot.
- **Forbidden duplicate logic:** The endpoint does not rebuild order DTOs,
  authorize mutations, or decide batch eligibility. It reuses the canonical
  list DTO and existing scope predicates.
- **Frontend role:** Keep selected IDs and request/display the backend snapshot.
  Existing backend mutation boundaries still revalidate every action.
- **Boundary proof:** `test:audit-orders-bulk-snapshot` proves input bounds,
  scope/delegation wiring, requested ordering, missing-ID reporting, and removal
  of sequential full-page hydration.
- **Workflow proof:** Orders service-boundary, authority, lockdown, typecheck,
  production build, and SOT-pack guards remain required.

No provider call, label/postage operation, marketplace notification, database
write, or shipped/cancelled mutation is part of this read-only endpoint.
