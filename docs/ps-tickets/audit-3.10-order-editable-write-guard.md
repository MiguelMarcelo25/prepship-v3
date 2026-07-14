# Audit 3.10 — transaction-time order edit lockdown placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** An order edit accepted by the HTTP preflight must
  still fail if label purchase, shipment sync, external shipment, or upstream
  cancellation makes the order terminal before persistence.
- **Canonical owner:** `src/services/order-editable-write.ts` locks the order row,
  re-reads status/canonical status/external-shipment facts, delegates lifecycle
  classification to `order-lifecycle-status.ts`, and runs the write in that same
  transaction. `assertOrderEditable` remains the early scope/auth/audit boundary.
- **Unsafe/duplicated owners removed:** `PATCH /orders/:id` and `/save-dims`
  directly wrote `orders`/`order_overrides` after an earlier snapshot. The
  override/rate command owner and combo-default fanout also had check-to-write
  gaps. Those writes now delegate to the final guard.
- **Earliest imperfect-data entry:** Provider label persistence, order sync, or a
  concurrent operator action can change raw status, canonical status, or
  `externally_shipped` after the route's initial SELECT.
- **Callers that delegate:** PATCH, residential, selected provider/package,
  Apply Best Rate, saved Best Rate, combo-default save/propagation/materialize,
  shipped-external source persistence, and save-dims all carry the preflight
  authorization to the write boundary. Manual external-shipment status updates
  carry the same lifecycle predicate into their final UPDATE.
- **Wrapper/resolver logic deleted or forbidden:** Routes may not directly write
  guarded order/override fields. Callers may not reimplement terminal-status
  strings; the final owner must call `resolveOrderLifecycleStatus`. Only the
  audited admin `?force=1` branch may mint `allowTerminal: true`.
- **Frontend role:** None. The frontend continues to send operator intent and
  render backend errors; it owns no lifecycle or mutation authorization truth.
- **Backend boundary proof:** `test:audit-order-editable-write` pins the row-lock
  transaction, canonical lifecycle delegation, fail-closed authorization,
  route-to-command wiring, combo propagation, and external-shipment predicates.
  It is mandatory in the source-of-truth guard pack.
- **Workflow proof:** Orders service-boundary, lockdown, effective-lifecycle,
  combo-default, Apply Best Rate, external-shipment, rate source-of-truth,
  strict typecheck, production build, and full SOT-pack checks are required.

Per user override `unlock shipped data` on 2026-07-14, protected order mutation
boundaries were strengthened only. No real database mutation, provider call,
label/postage purchase, inventory deduction, or marketplace notification is
part of the offline verification.
