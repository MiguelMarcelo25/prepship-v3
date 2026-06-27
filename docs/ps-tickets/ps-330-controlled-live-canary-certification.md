# PS-330 - Controlled live/canary certification for guarded shipping and rate workflows

PS-330 is a certification layer over the existing backend source-of-truth owners.
PS-330 does not create a new shipping, rate, label, queue, or marketplace owner,
does not relax selected-rate proof, and does not run live side effects by
itself. It records what is already covered by static/guard tests, what can be
checked read-only, and what requires an explicit DJ canary approval.

## Canonical owner map

| Area | Canonical owner |
| --- | --- |
| Carrier universe and best-rate choice | `src/services/rates-combined.ts`, `src/services/rates.ts` |
| Snapshot/ref and selected-rate proof | `src/services/shipping-workflow/rate-quote-snapshot-store.ts`, `src/services/shipping-workflow/rate-fingerprint.ts` |
| Label purchase and persisted shipment snapshot | `src/services/labels.ts#createLabelV2` |
| Print Queue create/recover/queue flow | `src/services/print-queue.ts`, `src/routes/print-queue.ts` |
| Marketplace/source confirmation lifecycle | `src/services/fulfillment/outbox.ts`, `src/services/fulfillment/confirmation-payload.ts` |
| HUGRAB insurance and customer-rate display facts | `src/services/order-rate-dto.ts`, `src/services/shipping-workflow/insurance-coverage-status.ts`, `src/services/shipping-workflow/hugrab-label-purchase-gate.ts` |

## Safety boundary

Side effects executed: none.

This certification produces No real labels, No postage, No voids, No marketplace notifications,
No production order mutations, No shipped/cancelled mutations, and No billing/inventory mutations.
Any live or staging canary must be approved with exact order/provider/action text before the
command or browser workflow runs.

Required approval format:

`DJ approves PS-330 canary: run <command-or-browser-workflow> for order <id>, provider <provider>, action <action>, expected side effect <side-effect>, rollback <rollback-plan>.`

## Certification layers

| Layer | PS-330 status |
| --- | --- |
| Static/guard | Run offline from package scripts. Must pass before any read-only or canary step. |
| Mocked/offline | Uses fixtures and pure service guards only. No DB, network, providers, labels, postage, or marketplace notifications. |
| Read-only | Optional when staging/production credentials are available. Allowed commands must inspect or dry-run only. |
| Canary plan | Documented below for each path. Requires exact DJ approval and a safe test order/account before use. |
| Live canary result | Not run in this PS-330 certification. No exact live approval was granted for a live side effect. |

## Controlled certification matrix

| Path name | Current guard/offline proof command | Live/staging preconditions | Side effect risk | Required DJ approval text | Exact command or browser workflow | Expected result | Pass/fail/blocker | Recovery plan | Follow-up card needed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| strict snapshot-only selected-rate proof enforcement | `test:rate-source-of-truth`; `test:selected-rate-proof-boundary`; `test:ps-319-rate-convergence-certification`; `test:ps-198-rate-quote-proof-passthrough` | Safe awaiting-shipment test order with final `rateQuoteId` and `selectedRateKey`; no active label; exact provider/account known. | Real label/postage if the create-label canary is approved. | `DJ approves PS-330 canary: run smoke:shipping:real-label for order <id>, provider <provider>, action strict-proof label purchase, expected side effect one test label/postage, rollback <void-or-no-retry plan>.` | Read-only first: `npm run smoke:shipping:preflight -- --order-id <id>`. Canary only if approved: `npm run smoke:shipping:real-label -- --order-id <id> --live-approved --api-base <url>`. | Non-final or non-best proof is blocked before provider purchase; valid final proof can buy exactly one approved test label. | Offline guard expected pass; live canary not run. | Stop immediately, inspect order and shipments, do not retry while an active label may exist. | No, unless DJ wants a live strict-proof canary slot. |
| Browse Rates / Apply Best Rate / Recalculate / Create Label / Print Queue proof pass-through | `test:rate-source-of-truth`; `test:ps-302-apply-best-rate-authority`; `test:ps-303-print-queue-authority`; `test:print-to-queue-selected-rate-proof`; `test:ps-320-v2-api-client-transport`; `test:ps-321-ratebrowsermodal-thin-ui` | Safe order with browseable rates; UI user scoped to the same store/client; no active label for purchase/queue canary. | Browse/apply/recalculate can touch saved rate state; create/queue can buy or queue label only if approved. | `DJ approves PS-330 canary: run browser workflow for order <id>, provider <provider>, action browse/apply/recalculate/create/queue proof pass-through, expected side effect <none-or-one-test-label>, rollback <plan>.` | Browser workflow: Browse Rates, Apply Best Rate, Recalculate, Create Label, Print Queue while observing backend-issued `rateQuoteId`, `selectedRateKey`, and `selectedRateProof` pass-through. | Awaiting Best Rate and Rate Browser stay converged; no frontend-minted proof; Print Queue forwards backend proof unchanged. | Offline guard expected pass; browser canary not run. | If UI stalls, inspect API timing, active shipment, and fulfillment outbox before retrying. | No, unless a specific browser canary order is approved. |
| PRINT_QUEUE_BACKEND_ORCHESTRATION default-off backend orchestration path | `test:ps-303-print-queue-authority`; `test:ps-318-shipping-workflow-certification`; `test:shipping-roundtrip-certification` | Feature flag remains default off; staging flag flip is a DJ action; route-plan payload uses non-shipped awaiting orders only. | Route-plan is read-only, but production flag flip can change queue routing. | `DJ approves PS-330 canary: enable PRINT_QUEUE_BACKEND_ORCHESTRATION for staging, order <id>, provider <provider>, action backend route-plan only, expected side effect route-plan response only, rollback disable flag.` | Read-only route-plan canary after approved flag flip; do not start batch-send from PS-330 without separate approval. | Flag off returns `FEATURE_DISABLED` 503; flag on returns backend route plan only and does not buy postage. | Static guard expected pass; flag canary not run. | Disable flag, keep existing `/batch-send` path, and inspect queue jobs before retry. | No, unless DJ wants a staged flag-flip canary. |
| marketplace/source confirmation lifecycle | `test:ps-064-confirmation-outbox`; `test:ps-285-marketplace-confirm-boundary`; `test:walmart-confirmation:payload`; `test:ebay-confirmation:mocked`; `test:shipping-roundtrip-certification` | Known outbox row or approved label-created test order; exact provider/source; confirmation connector support known. | Real marketplace notification or repair if a live retry/apply command is approved. | `DJ approves PS-330 canary: run marketplace confirmation for order <id>, provider <provider>, action <retry-or-repair>, expected side effect one marketplace/source notification, rollback <provider-specific plan>.` | Read-only first: `npm run smoke:marketplace-confirm -- --order-id <id>`. Live only if approved: `npm run marketplace:confirm:retry -- --outbox-id <id> --order-number <orderNumber> --shipment-id <shipmentId> --provider walmart --live-approved`. | Lifecycle is explicit: `not_required`, `not_supported`, `pending`, `processing`, `succeeded`, or `failed`; no silent null state. | Offline guard expected pass; live notification not run. | Stop retries, inspect fulfillment outbox, and use dry-run/repair report before any apply. | No, unless DJ wants a connector-specific live confirmation canary. |
| real provider boundary readiness | `test:carrier-harness`; `test:direct-carrier-labels`; `test:direct-carrier-queue-route`; `test:ps-326-carrier-account-identity-certification`; `test:shipstation-carrier-account-identity` | Safe sandbox or test account for ShipStation-source, Shipp/direct carrier, EasyPost/direct carrier, Walmart/eBay source path; no active label; account nickname/provider id verified. | Provider calls may rate-shop or buy postage depending on command; real label command is mutating. | `DJ approves PS-330 canary: run provider boundary for order <id>, provider <provider>, action <rates-or-real-label>, expected side effect <rates-only-or-one-test-label>, rollback <plan>.` | Rates/sandbox only when safe: `npm run carrier-harness:rates`; real label only if approved: `npm run smoke:carrier-harness:real-label -- --live-approved`. | Provider/account identity stays stable; no label purchase occurs unless the live-approved real-label command is explicitly approved. | Offline harness expected pass; real provider canary not run. | Stop provider calls, inspect active shipment/charge state, and do not retry label purchase without approval. | Yes only if provider credentials or fixtures are missing for a desired canary. |
| HUGRAB insurance-aware next-best/customer-rate and selected-rate proof behavior | `test:ps-327-hugrab-margin-policy`; `test:ps-333-hugrab-current-rate-sot`; `test:ps-334-house-rate-column`; `test:ps-295-house-customer-rate-proof`; `test:ps-261-hugrab-label-purchase-gate` | HUGRAB awaiting order with confirmed insurance policy, final rate snapshot, and exact selected provider/account. | Browse/rate refresh is non-postage; create-label can buy postage if separately approved. | `DJ approves PS-330 canary: run HUGRAB rate/proof canary for order <id>, provider <provider>, action insurance-aware rate proof, expected side effect <none-or-one-test-label>, rollback <plan>.` | Read-only/rate flow: Browse Rates and verify backend customer-rate/house-rate facts. Label only through the strict-proof real-label canary if separately approved. | HUGRAB customer rate uses backend insurance-aware policy; selected-rate proof blocks unsafe purchase and stays backend-owned. | Offline guard expected pass; live canary not run. | If HUGRAB proof is unclear, stop before label purchase and inspect rate snapshot/proof fields. | No, unless DJ wants a HUGRAB live label canary. |

## Command classification

Safe/offline commands for PS-330 evidence:

- `npm run test:ps-330-controlled-canary-certification`
- `npm run test:rate-source-of-truth`
- `npm run test:ps-318-shipping-workflow-certification`
- `npm run test:ps-319-rate-convergence-certification`
- `npm run test:ps-320-v2-api-client-transport`
- `npm run test:ps-321-ratebrowsermodal-thin-ui`
- `npm run test:ps-326-carrier-account-identity-certification`
- `npm run test:ps-327-hugrab-margin-policy`
- `npm run test:ps-333-hugrab-current-rate-sot`
- `npm run test:ps-334-house-rate-column`
- `npm run test:print-to-queue-selected-rate-proof`
- `npm run test:ps-303-print-queue-authority`
- `npm run test:ps-285-marketplace-confirm-boundary`
- `npm run test:walmart-confirmation:payload`
- `npm run test:ebay-confirmation:mocked`
- `npm run test:shipping-roundtrip-certification`

Allowed only as read-only/dry-run when the target environment and exact order
are known:

- `npm run preflight:print-queue`
- `npm run smoke:shipping:preflight -- --order-id <id>`
- `npm run shipstation:recover:dry-run`
- `npm run shipstation:external-shipped:dry-run`

Blocked unless exact DJ approval names the order/provider/action:

- `npm run smoke:shipping:real-label -- --order-id <id> --live-approved --api-base <url>`
- `npm run smoke:carrier-harness:real-label -- --live-approved`
- `npm run smoke:marketplace-confirm -- --order-id <id> --process-once`
- `npm run marketplace:confirm:retry -- --outbox-id <id> --order-number <orderNumber> --shipment-id <shipmentId> --provider walmart --live-approved`
- `npm run marketplace:confirmation:repair -- --order-number <orderNumber> --apply --live-approved`
- `npm run shipment-confirmation:recover:apply -- --order-id <id> --live-approved`
- `npm run shipstation:recover:apply -- --order-id <id> --live-approved`
- `npm run shipstation:external-shipped:apply -- --order-id <id> --live-approved`

## Verification status

| Command | Status | Notes |
| --- | --- | --- |
| `npm run test:ps-330-controlled-canary-certification` | Pass | New PS-330 guard. Initial red run failed until this matrix existed. |
| `npm run test:rate-source-of-truth` | Pass | Rate source-of-truth guard. |
| `npm run test:ps-318-shipping-workflow-certification` | Pass | Shipping workflow matrix predecessor. |
| `npm run test:ps-319-rate-convergence-certification` | Pass | Rate convergence predecessor. |
| `npm run test:ps-320-v2-api-client-transport` | Pass | Transport/typed API pass-through predecessor. |
| `npm run test:ps-321-ratebrowsermodal-thin-ui` | Pass | Rate Browser thin UI predecessor. |
| `npm run test:ps-326-carrier-account-identity-certification` | Pass | Carrier identity predecessor. |
| `npm run test:ps-327-hugrab-margin-policy` | Pass | HUGRAB policy predecessor. |
| `npm run test:ps-333-hugrab-current-rate-sot` | Pass | HUGRAB current-rate source-of-truth predecessor. |
| `npm run test:ps-334-house-rate-column` | Pass | House-rate column predecessor. |
| `npm run test:print-to-queue-selected-rate-proof` | Pass | Print Queue proof pass-through. |
| `npm run test:ps-303-print-queue-authority` | Pass | Print Queue backend authority. |
| `npm run test:ps-285-marketplace-confirm-boundary` | Pass | Marketplace confirmation boundary. |
| `npm run test:walmart-confirmation:payload` | Pass | Walmart payload guard. |
| `npm run test:ebay-confirmation:mocked` | Pass | eBay mocked confirmation guard. |
| `npm run test:rate-system-hardening` | Pass | First isolated run failed because legacy `fetchRates` dropped backend `carrierDiagnostics`; fixed as a pass-through diagnostic adapter gap. |
| `npm run test:shipping-roundtrip-certification` | Pass | First run failed through the nested rate-system-hardening guard; rerun passed after diagnostics pass-through was restored. |
| `npm run typecheck -- --pretty false` | Pass | Repo typecheck. |
| `npm run build:web` | Pass | Web build. |

## Canaries not run

Live canary result remains not run. PS-330 does not have exact DJ approval for a
specific live order/provider/action, so it did not buy labels, send marketplace
confirmations, void labels, apply recovery scripts, mutate production orders, or
touch shipped/cancelled data.

Potential follow-up cards if DJ wants live certification windows:

- PS-330A - Strict selected-rate proof live canary on one DJ-approved test order.
- PS-330B - Backend Print Queue orchestration staging flag-flip canary.
- PS-330C - Marketplace/source confirmation live canary for one safe outbox row.
- PS-330D - Provider boundary sandbox/live canary by carrier account family.
