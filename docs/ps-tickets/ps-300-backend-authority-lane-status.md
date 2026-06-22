# PS-300 Backend shipping authority lane status

Date: 2026-06-22

## Current status

This is the combined status packet for the PS-300 dependency lane:
PS-300 through PS-306.

| Ticket | Percent | Recommendation | Blocker |
| --- | ---: | --- | --- |
| PS-300 | 90% | Final Review-ready | None for backend authority gate |
| PS-301 | 90% | Final Review-ready | None found |
| PS-302 | 90% | Final Review-ready | None found |
| PS-303 | 89% | Final Review-ready, scoped | Backend queue authority exists; frontend local fallback remains until cutover |
| PS-304 | 89% | Final Review-ready, scoped | Backend tuple wins; remaining frontend account fallbacks are accepted as PS-306 cutover debt |
| PS-305 | 90% | Final Review-ready | None for guardrail scope |
| PS-306 | 86% | Keep in progress | `OrdersView.tsx` currently has `const isReadOnly = false`; UI lockdown is not final-ready |

## Evidence now wired

- `test:ps-300-active-lawrence-workflow`
- `test:ps-300-backend-shipping-authority`
- `test:ps-301-row-workflow-authority`
- `test:ps-302-apply-best-rate-authority`
- `test:ps-303-print-queue-authority`
- `test:ps-304-shipping-display-facts-authority`
- `test:ps-305-authority-drift`
- `test:ps-306-ordersview-parity-cutover`
- `test:order-editable-lockdown`
- `test:ps-245-lockdown-fence`

## What is proven

- PS-300 proves backend shipping authority gates: final rate display and purchase
  authority are separate, purchase proof is backend-validated, and queue workers
  preserve snapshot/proof ids.
- PS-301 proves backend row workflow DTO ownership of row state, allowed actions,
  display tuple, and queue route.
- PS-302 proves Apply Best Rate passes backend-issued proof fields through and
  does not mint purchase truth in the frontend.
- PS-303 proves backend Print Queue create/recover/queue authority exists. Its
  Final Review recommendation is scoped because the frontend local fallback
  remains until the flagged cutover.
- PS-304 now prefers backend account display tuple too, and its remaining
  frontend account fallbacks are explicitly tracked as PS-306 cutover debt.
- PS-305 pins backend authority drift guardrails and CI wiring.
- PS-306 is a useful dependency gate, but not Final Review-ready while the
  shipped/cancelled UI read-only gate is disabled in `OrdersView.tsx`.

## Safety

This packet is offline/static. It does not run live labels, buy postage, mutate
queues, call providers, send marketplace notifications, update production
orders, or mutate shipped/cancelled data.

No Trello comments or card moves are performed by this artifact. Trello mutation
still requires explicit `task update`.
