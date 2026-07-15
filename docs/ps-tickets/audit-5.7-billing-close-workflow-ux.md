# Audit 5.7 - Billing close workflow UX

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** An operator can close one client's
  selected billing period, see that its invoice rows are immutable, and append
  a reasoned credit memo instead of editing finalized money.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/billing-finalization-policy.ts` owns period overlap checks,
  invoice-total freezing, database locks, immutable finalization summaries,
  credit idempotency, and remaining-balance enforcement. The scoped billing
  routes expose that owner; the frontend is not a second close policy.
- **Current duplicated/unsafe owners:** Audit 3.6 already supplied the backend
  owner and database triggers, but Billing had no operator close/credit surface.
  Operators could not see a period lock before attempting edit/bulk actions,
  and the only correction path exposed in the UI was the editable detail flow.
- **Where bad/stale/incomplete data can enter:** The earliest UI inputs are the
  selected client/range and credit amount/reason. A user can switch clients or
  dates while a confirmation is open, cached lock state can be stale, and a
  timed-out credit request can be retried. The UI captures the exact close
  intent, fails closed while lock state is loading/unavailable, and sends a
  stable per-payload request key; the backend rechecks every fact in its
  transaction and the database remains the final backstop.
- **Callers that must delegate to the owner:** `BillingView.tsx` calls
  `/billing/finalizations`, `/billing/finalize`, and `/billing/credit-notes`
  directly. `BillingCloseWorkflowPanel.tsx` renders only returned DTO fields and
  collects operator intent. Detail edit/review/bulk affordances consume the
  returned lock state for immediate UX, while their backend mutations still
  enforce finality independently.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Do not
  calculate finalization subtotal, credited amount, balance, period overlap,
  credit eligibility, or invoice editability in React. Do not mint a local
  finalization, mutate a closed invoice, silently reuse a request key after the
  amount/reason changes, or treat disabled buttons as the enforcement boundary.
- **Frontend role: display/action only; no authoritative business logic:** The
  panel formats backend strings/dates, sends the selected client/range and
  credit draft, renders the backend finalization/credit DTOs verbatim, and
  disables obvious edit actions when the backend says the range overlaps a
  finalization. The backend owns all money and lock decisions.
- **Backend boundary tests required:** `test:ps-412-finalized-billing` proves
  exact invoice totals, overlap serialization, immutable rows, scoped write
  routes, append-only credit notes, idempotent replay, and credit balance limits.
  `test:ps-416-billing-fail-closed` continues to prove billing regeneration
  fails closed when finality cannot be read.
- **Workflow/UI proof required:**
  `test:audit-billing-close-workflow-ux:browser` route-mocks all external reads
  and proves open-period rendering, captured finalize intent, confirmation,
  locked edit controls, append-only credit submission with a request key,
  refreshed backend balance, and visible credit history. The focused static
  guard pins endpoint literals, query keys, fail-closed wiring, DTO rendering,
  backend ownership, and canonical checklist/package wiring.

## Result

The close panel appears only after an operator opens a client's Billing line
items, so the client and date range are explicit. An open range offers
**Finalize period** behind a confirmation that names the captured client/range.
After the backend succeeds, the panel renders the frozen subtotal, credited
amount, balance, frozen order/line counts, actor, and timestamp from its DTO.

Any overlapping finalization makes the selected range read-only in the UI.
Edit, warning-review, no-box-cost, zero-shipping-review, and HUGRAB bulk entry
points are disabled (and the parent edit handler also rejects them). If the
lock read fails, those actions stay disabled until status can be verified. This
is operator feedback only: every backend/database guard from Audit 3.6 remains
authoritative.

Credit memos require an amount and audit reason. The UI supplies a request key
that remains stable for retries of the same draft and changes whenever the
operator changes amount/reason. Successful responses replace the displayed
finalization summary and append the returned immutable credit DTO without
recomputing any money in React.

## Safety

No backend policy, billing route, schema, shipped/cancelled order guard,
shipment history, label/postage path, inventory path, or marketplace
notification path changed. Browser proof uses route mocks. No configured
database/provider call, real invoice finalization, credit memo, label/postage
purchase, inventory mutation, or production shipped/cancelled mutation was
performed.

## Verification

Passed: strict backend/frontend typecheck; production web build; the PS-412
finalized-billing boundary; PS-416 billing fail-closed proof; PS-311 bulk box
cost, PS-363 no-box-cost, and PS-375 manual-zero-box-cost compatibility guards;
the focused Audit 5.7 guard; the route-mocked browser workflow; and the full
36-guard source-of-truth pack.

The optional PS-373 storage-proof and PS-376 zero-shipping-review static guards
still report pre-existing pattern drift in `src/services/billing.ts`. That file
and both guards are unchanged by Audit 5.7; their unrelated backend assertions
are not part of this frontend close-workflow diff.
