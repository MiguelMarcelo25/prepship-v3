# PS-269 - Print Queue residual audit

PS-269 does not create a new Print Queue source of truth. It is a residual
certification over completed backend authority work from PS-303, PS-317,
PS-318, PS-319, PS-326, and PS-330.

Current finding: No new unowned gap found. No broad Print Queue rewrite is
needed. If a future controlled canary proves a specific live queue/provider
failure, it should become a narrow implementation card tied to the backend owner
that failed.

## Print Queue residual scope

This audit maps existing-label queue/reprint, create-label-then-queue,
partial-success recovery, duplicate-label prevention, direct-carrier synthetic
IDs, and queued, printed, shipped, and marketplace-confirmed states.

It also checks label/print state, fulfillment outbox state, and
marketplace-confirmation separation. The `PRINT_QUEUE_BACKEND_ORCHESTRATION`
route-plan path remains flag-gated and pure; live queue/label behavior remains
PS-330 canary-only.

## Canonical owner map

| Concern | Canonical owner | PS-269 classification |
| --- | --- | --- |
| Print Queue create/recover/queue worker, duplicate queue upsert, status snapshots, queued/printed/delivered state | `src/services/print-queue.ts` | already guarded |
| Send-to-Queue route decision and never-buy ladder | `src/services/print-queue/queue-route-orchestrator.ts` | already guarded |
| Print Queue route schemas, batch-send job dispatch, route-plan flag gate, print/confirm entry APIs | `src/routes/print-queue.ts` | already guarded |
| Missing-label purchase for queue-created labels | `src/services/labels.ts#createLabelV2` | already guarded |
| Direct-carrier label purchase and synthetic shipment/provider label identity | `src/services/labels-direct.ts` | already guarded |
| Marketplace/source confirmation lifecycle after queueing an existing shipped label | `src/services/fulfillment/outbox.ts` | already guarded; PS-330 canary-only for live marketplace notification |
| Durable merged PDF side-store | `src/services/print-queue-pdf-store.ts` | already guarded |
| Operator intent payload and deleted frontend direct buy path | `web/src/components/Views/OrdersView.tsx` | already guarded |
| FE route-plan binding/fallback helper | `web/src/lib/resolve-backend-route-plan.ts` | already guarded |

## Imperfect data injection points

| Injection point | Current owner response | Classification |
| --- | --- | --- |
| Order already has an active queueable label | Worker checks `findExistingQueueableLabelForOrder` before `createLabelV2` and queues the existing label. | already guarded |
| Label purchase succeeds but a later queue step fails | Worker re-reads `details.labelUrl` or the active shipment label and queues that existing label instead of rebuying postage. | already guarded |
| Caller sends a stale or corrupt label URL | `normalizePrintQueueLabelUrl` rejects empty/non-string/`[object Object]` values before queue persistence and PDF merge. | already guarded |
| Duplicate queue request for the same order/client | `addToQueue` upserts by `[printQueue.orderId, printQueue.clientId]`, reports `alreadyQueued`, and keeps status `queued`. | already guarded |
| Missing-label queue request lacks valid selected-rate proof | `createLabelV2` runs selected-rate proof/account binding and HUGRAB preflight before any provider purchase; queue job reports structural retry eligibility. | already guarded |
| Direct-carrier synthetic provider ID | Queue route owner applies the never-buy ladder and `directViaBackend`; selected-rate proof and ShipStation label builder also block synthetic IDs on the wrong provider path. | already guarded |
| Operator opens/merges/downloads a PDF | PDF generation/open/download is not proof of physical printing; explicit confirm moves only successful queued entry ids to `printed`. | already guarded |
| Local shipped status or marketplace confirmation state changes | Queue rows remain separate from shipped status and fulfillment outbox confirmation lifecycle; queueing an existing shipped label only repairs missing confirmation lifecycle through the outbox owner. | already guarded |
| `PRINT_QUEUE_BACKEND_ORCHESTRATION` route plan fails or is disabled | Route-plan endpoint returns `FEATURE_DISABLED`; FE helper returns `null` and falls back only when delegation is not bound. | already guarded |
| Live provider/queue/printer behavior | Offline guards prove owner boundaries only; exact live queue/label/printer behavior remains controlled canary work. | PS-330 canary-only |

## Print Queue path matrix

| Path | Evidence | Classification | Follow-up |
| --- | --- | --- | --- |
| existing-label queue/reprint | `processQueueSendOrder` reads an existing shipment label before purchase; `addToQueue` upserts queue rows by order/client. | already guarded | None |
| create-label-then-queue | Missing labels are created only by `createLabelV2`, after shipping safety, selected-rate proof/account binding, and HUGRAB proof gates. | already guarded | None |
| partial-success recovery | If the provider label exists after an error, the worker re-reads the active shipment label and queues it; it does not buy duplicate postage. | already guarded | None |
| duplicate-label prevention | `createLabelV2` checks active labels before provider calls; `addToQueue` is idempotent for duplicate queue inserts. | already guarded | None |
| direct-carrier synthetic IDs | PS-326 and PS-303 prove synthetic direct IDs cannot silently fall into the ShipStation path; `directViaBackend` can only reduce FE direct-create buys. | already guarded | None |
| queued, printed, shipped, and marketplace-confirmed states | Queue status is `queued`, explicit confirm marks `printed`, tracking can mark `delivered`, shipped label facts live on shipments/orders, and confirmation lifecycle lives in fulfillment outbox. | already guarded | None |
| label/print state | Label URL and PDF merge state do not imply physical printing; successful merge returns `successful_entry_ids` for explicit confirmation. | already guarded | None |
| fulfillment outbox state | Queueing an existing shipped label calls `ensureShipmentConfirmationLifecycle` and starts outbox processing separately from queue persistence. | already guarded | None |
| marketplace-confirmation separation | Print Queue does not mark marketplace confirmed; outbox/connectors own pending/succeeded/failed/not_required/not_supported confirmation state. | already guarded | None |
| live/canary proof | Real label purchase, queue insertion, PDF print, and marketplace notification are not executed by this card. | PS-330 canary-only | None |
| new unowned gap | No current unowned Print Queue gap was proven by this audit. | new unowned gap: none found | None |

## Evidence commands

Required residual audit evidence:

- `test:ps-269-print-queue-residual-audit`
- `test:ps-303-print-queue-authority`
- `test:ps-303-fe-route-binding`
- `test:ps-317-fe-buy-anti-regression`
- `test:ps-318-shipping-workflow-certification`
- `test:ps-319-rate-convergence-certification`
- `test:ps-326-carrier-account-identity-certification`
- `test:print-to-queue-selected-rate-proof`
- `test:selected-rate-proof-boundary`
- `test:ps-098-shipping-purchase-boundary`
- `test:ps-053-print-queue-atomic`
- `test:ps-256-durable-print-queue-pdf`
- `test:ps-285-print-queue-evidence`
- `test:direct-carrier-labels`
- `test:direct-carrier-queue-route`
- `test:shipping-roundtrip-certification`
- `test:ps-330-controlled-canary-certification`
- `npm run typecheck -- --pretty false`
- `npm run build:web`

## Verification status

| Command | Status | Notes |
| --- | --- | --- |
| `npm run test:ps-269-print-queue-residual-audit` | Pass | Initial red run failed until this residual matrix existed; final guard passed. |
| `npm run test:ps-303-print-queue-authority` | Pass | Backend Print Queue create/recover/queue authority. |
| `npm run test:ps-303-fe-route-binding` | Pass | FE route-plan binding cutover. |
| `npm run test:ps-317-fe-buy-anti-regression` | Pass | Deleted frontend direct-carrier buy anti-regression. |
| `npm run test:ps-318-shipping-workflow-certification` | Pass | Shipping workflow predecessor. |
| `npm run test:ps-319-rate-convergence-certification` | Pass | Rate/proof convergence predecessor. |
| `npm run test:ps-326-carrier-account-identity-certification` | Pass | Carrier/account identity predecessor. |
| `npm run test:print-to-queue-selected-rate-proof` | Pass | Print Queue proof pass-through/retry predecessor. |
| `npm run test:selected-rate-proof-boundary` | Pass | Selected-rate purchase boundary predecessor. |
| `npm run test:ps-098-shipping-purchase-boundary` | Pass | Label purchase boundary predecessor. |
| `npm run test:ps-053-print-queue-atomic` | Pass | Print Queue atomic recovery predecessor. |
| `npm run test:ps-256-durable-print-queue-pdf` | Pass | Durable PDF predecessor. |
| `npm run test:ps-285-print-queue-evidence` | Pass | Print Queue evidence predecessor. |
| `npm run test:direct-carrier-labels` | Pass | Direct-carrier label owner predecessor. |
| `npm run test:direct-carrier-queue-route` | Pass | Direct-carrier route predecessor. |
| `npm run test:shipping-roundtrip-certification` | Pass | Offline shipping roundtrip certification. |
| `npm run test:ps-330-controlled-canary-certification` | Pass | Live/canary plan predecessor. |
| `npm run typecheck -- --pretty false` | Pass | Repo typecheck. |
| `npm run build:web` | Pass | Web build. |

## Safety

This audit is read-only/offline only. It performs No real labels, No postage,
No queue insertions, No PDF print, No marketplace notifications, No production
order mutations, and No shipped/cancelled mutations.

Safety phrase for the guard: No production order mutations.

It does not alter shipped/cancelled locked paths, does not run SQL
updates/deletes, and does not call live provider, queue, print, marketplace, or
postage APIs.
