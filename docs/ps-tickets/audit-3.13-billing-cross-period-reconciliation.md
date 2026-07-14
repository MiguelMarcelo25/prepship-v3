# Audit 3.13 — cross-period billing reconciliation placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** Regeneration must place every editable order bill
  in the period selected by the current canonical billing ship date, without
  stranding an old-period row, dropping the new row on a unique conflict, or
  changing finalized history.
- **Canonical owners:** `billing.ts#generateLineItems` owns derived line
  reconciliation and persistence. `billing-finalization-policy.ts` plus its
  migration-owned database triggers remain the immutable billing boundary.
- **Unsafe/duplicated owners removed or constrained:** The generator no longer
  treats the requested date window as the complete identity of candidate order
  lines. The description-keyed unique constraint remains a last-resort
  idempotency backstop, but skipped conflicts are counted and logged instead of
  being reported as successful inserts.
- **Earliest imperfect-data entry:** A shipment/order billing date can be
  corrected after an editable line was generated. The new-period source read is
  correct, but the previous period still contains the same order/type/description
  unique key.
- **Callers that delegate:** The existing scoped billing generate route and
  embedded regeneration workflows continue to call `generateLineItems` directly.
  That owner locks candidate bills, removes their editable lines across periods,
  retains the requested-window stale sweep, inserts current rows, and clears
  dirty state in one transaction.
- **Wrapper/resolver logic deleted or forbidden:** No route, frontend, export,
  or invoice reader may move lines or reinterpret ship dates. No regeneration
  path may bypass `assertBillingOrdersEditable`,
  `billingLineItemIsEditablePredicate`, or the database finalized/closed-period
  triggers.
- **Frontend role:** Display/action only. It submits the requested period and
  renders backend generation results; it owns no billing date, move, conflict,
  finality, or amount decision.
- **Backend boundary proof:**
  `test:audit-billing-cross-period-reconciliation` uses offline PGlite to prove
  an editable order moves from June to July, stale July rows are swept, unrelated
  June rows remain, finalized history is preserved, and `RETURNING` exposes a
  skipped unique conflict. Static checks pin the production transaction,
  finality predicates, persisted-row counters/totals, structured warning, and
  current override. It is mandatory in the source-of-truth guard pack.
- **Workflow proof:** PS-412 finalized billing, billing regeneration readiness,
  summary/detail/invoice parity, scope, strict typecheck, production build, full
  SOT pack, and lockdown guards are required.

Per user override `unlock shipped data` on 2026-07-14, the protected file
`src/services/billing.ts` changes only derived `billing_line_items`
reconciliation after read-only shipped/order source queries. It does not update
or delete orders, shipments, labels, marketplace confirmations, inventory, or
finalized billing history. Offline verification performs no configured database
write, provider call, real label/postage purchase, marketplace notification, or
production shipped/cancelled mutation.
