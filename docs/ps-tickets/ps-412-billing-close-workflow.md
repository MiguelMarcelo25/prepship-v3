# PS-412 — Billing close workflow placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** Finalizing a client billing period freezes the
  exact invoice lines and subtotal. Later corrections are append-only credit
  notes; they never rewrite the original invoice.
- **Canonical backend owner:** `src/services/billing-finalization-policy.ts`
  owns period-close admission, transaction boundaries, immutable summaries,
  credit balance/idempotency, and regeneration rejection. The database
  backstop is `drizzle/0065_billing_close_workflow.sql`.
- **Current duplicated/unsafe owners:** Before this slice, no workflow set
  `billing_line_items.invoiced=true`; invoice export and later regeneration
  could therefore keep reading and rewriting a supposedly sent invoice.
- **Earliest imperfect-data entry:** A regeneration, billing sidecar edit, or
  late line insert after an invoice is sent can change invoice truth. Credit
  amount/reason/idempotency input enters at the authenticated HTTP boundary.
- **Callers that delegate:** `POST /billing/finalize`, billing generation,
  finalization/credit reads, `POST /billing/credit-notes`, and invoice export
  delegate to the policy or the shared backend invoice-total owner.
- **Logic deleted or forbidden:** The invoice-header totals query was removed
  from the route-local billing service and moved to one shared backend owner.
  Routes and future UI must not set `invoiced`, compute a frozen subtotal,
  mutate a close record, or derive the remaining credit balance.
- **Frontend role:** Phase 5.7 may display backend close/credit DTOs and submit
  operator intent only. It must not own finalization or credit truth.
- **Backend boundary proof:** The PS-412 PGlite guard applies migrations 0059
  and 0065 and proves closed-period line mutations, overlapping closes,
  over-crediting, close/credit history mutation, and duplicate idempotency are
  rejected while a later open period stays writable.
- **Workflow/API proof:** Route source assertions pin client scope,
  `financials:write`, authenticated actor stamping, and delegation to the
  policy owner. Typecheck and production build cover the integrated API.

## Deployment boundary

Migration `0065_billing_close_workflow.sql` must be applied before the matching
application build starts. Boot readiness intentionally fails closed when its
tables, indexes, functions, or triggers are missing. This implementation does
not apply the migration or finalize production billing data.
