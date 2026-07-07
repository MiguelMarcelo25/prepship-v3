# PS-267 - Post-SOT label purchase residual audit

PS-267 does not create a new label purchase source of truth. It is a residual
certification over completed backend authority work from PS-317, PS-318,
PS-319, PS-326, PS-327, PS-328, and PS-330.

Current finding: No new unowned gap found. No broad label refactor is needed.
If a future live canary proves a specific failure, it should become a narrow
implementation card tied to the exact backend owner that failed.

## Label purchase residual scope

This audit maps side panel Create + Print, Rate Browser apply/save-to-label,
Print Queue create-and-queue, existing-label requeue/reprint, direct-carrier
label route, and ShipStation label route.

It also checks selected-rate proof, current fingerprint, HUGRAB insurance proof,
duplicate active label protection, carrier/account identity, and that synthetic
IDs cannot fall through to ShipStation. Guard coverage pins that synthetic IDs cannot fall through to ShipStation.

## Canonical owner map

| Concern | Canonical owner | PS-267 classification |
| --- | --- | --- |
| Label purchase orchestration for Create + Print and Print Queue missing-label creation | `src/services/labels.ts#createLabelV2` | already covered |
| Shipped/cancelled/upstream shipped and duplicate-shipment safety before postage | `src/services/fulfillment/shipping-safety.ts` | already covered |
| Selected-rate proof, current fingerprint, quote refs, and account binding | `src/services/shipping-workflow/rate-quote-snapshot-store.ts`, `src/services/shipping-workflow/rate-fingerprint.ts` | already covered; PS-328 impacted only for stale/rerate copy |
| HUGRAB insurance proof before provider calls | `src/services/shipping-workflow/hugrab-label-purchase-preflight.ts` | already covered |
| Direct-carrier provider purchase implementation | `src/services/labels-direct.ts`, reached only through `createLabelV2` | already covered |
| Existing-label requeue/reprint, create-and-queue, partial success recovery, and queue retry classification | `src/services/print-queue.ts`, `src/services/print-queue/queue-route-orchestrator.ts` | already covered |
| Marketplace/source confirmation after successful label persistence | `src/services/fulfillment/outbox.ts` | already covered; PS-330 canary-only for live marketplace notification |

## Imperfect data injection points

| Injection point | Current owner response | Classification |
| --- | --- | --- |
| Stale, missing, non-final, or mismatched selected-rate proof | Snapshot/proof owner rejects `snapshot_not_final`, missing/expired proof, and account mismatch before provider purchase. Manual non-best selections are allowed when they exist in the completed backend quote. | already covered; PS-328 impacted for operator warning copy |
| HUGRAB insurance proof unresolved, unsupported, or unproven | HUGRAB preflight delegates certainty, coverage status, and purchase gate before direct-carrier or ShipStation provider calls. | already covered |
| Duplicate active label or upstream/source shipped state | Shipping safety blocks terminal/upstream shipped states before side effects; Print Queue existing-label path queues/reprints instead of rebuying. | already covered |
| Direct-carrier synthetic IDs | Carrier/account identity proof and direct-carrier route owners keep synthetic direct IDs out of ShipStation label purchase. | already covered |
| Existing label URL recovery or label already bought but queue insert failed | Print Queue recovers existing labels and normalizes label URLs before queueing; it does not rebuy postage for recovery. | already covered |
| Live provider responses, postage purchase, or marketplace confirmation | Offline guards prove boundaries only; exact live execution remains PS-330 canary-only. | PS-330 canary-only |

## Label path matrix

| Path | Evidence | Classification | Follow-up |
| --- | --- | --- | --- |
| side panel Create + Print | `OrdersView` sends backend-issued proof/ref intent; `apiClient.createLabel` posts to `/labels`; `createLabelV2` runs safety, proof, HUGRAB, provider, persistence, and confirmation owners. | already covered | None |
| Rate Browser apply/save-to-label | Rate Browser apply preserves backend `rateQuoteId`, `selectedRateKey`, and selected-rate proof refs from PS-319/PS-321 before label intent. | already covered | None |
| Print Queue create-and-queue | Route forwards selected proof/ref fields; worker creates missing labels through `createLabelV2` and reports proof retry eligibility structurally. | already covered | None |
| existing-label requeue/reprint | Queue route owner treats existing labels as a never-buy rung; Print Queue finds/reuses queueable labels before any create path. | already covered | None |
| direct-carrier label route | Legacy `api/carriers/labels.ts` is retired; backend direct-carrier purchase is reached through `createLabelV2` and `labels-direct.ts`. | already covered | None |
| ShipStation label route | ShipStation branch in `createLabelV2` is after safety, selected-rate proof/account binding, and HUGRAB preflight. | already covered | None |
| duplicate active label protection | Terminal/upstream shipped and active-label safety stay backend-owned; Print Queue recovery never turns an existing label into a second buy. | already covered | None |
| stale re-rate warning before label | Stale/mismatched copy and order-detail invalidation are owned by PS-328 package/rate facts. | PS-328 impacted | None |
| live/canary proof | Real label/postage/provider/marketplace execution remains blocked unless DJ approves the exact PS-330 canary order/provider/action. | PS-330 canary-only | None |
| new unowned gap | No current unowned label-purchase gap was proven by this audit. | new unowned gap: none found | None |

## Evidence commands

Required residual audit evidence:

- `test:ps-267-label-purchase-residual-audit`
- `test:ps-318-shipping-workflow-certification`
- `test:ps-319-rate-convergence-certification`
- `test:ps-326-carrier-account-identity-certification`
- `test:ps-327-hugrab-margin-policy`
- `test:selected-rate-proof-boundary`
- `test:print-to-queue-selected-rate-proof`
- `test:ps-098-shipping-purchase-boundary`
- `test:ps-261-hugrab-label-purchase-gate`
- `test:ps-303-print-queue-authority`
- `test:direct-carrier-labels`
- `test:direct-carrier-queue-route`
- `test:shipping-roundtrip-certification`
- `test:ps-330-controlled-canary-certification`
- `npm run typecheck -- --pretty false`
- `npm run build:web`

## Verification status

| Command | Status | Notes |
| --- | --- | --- |
| `npm run test:ps-267-label-purchase-residual-audit` | Pass | Initial red run failed until this residual matrix existed; final guard passed. |
| `npm run test:ps-318-shipping-workflow-certification` | Pass | Shipping workflow predecessor. |
| `npm run test:ps-319-rate-convergence-certification` | Pass | Rate/proof convergence predecessor. |
| `npm run test:ps-326-carrier-account-identity-certification` | Pass | Carrier/account identity predecessor. |
| `npm run test:ps-327-hugrab-margin-policy` | Pass | HUGRAB policy predecessor. |
| `npm run test:selected-rate-proof-boundary` | Pass | Selected-rate proof purchase boundary. |
| `npm run test:print-to-queue-selected-rate-proof` | Pass | Print Queue proof pass-through boundary. |
| `npm run test:ps-098-shipping-purchase-boundary` | Pass | Label purchase boundary predecessor. |
| `npm run test:ps-261-hugrab-label-purchase-gate` | Pass | HUGRAB label purchase gate predecessor. |
| `npm run test:ps-303-print-queue-authority` | Pass | Print Queue authority predecessor. |
| `npm run test:direct-carrier-labels` | Pass | Direct-carrier label owner predecessor. |
| `npm run test:direct-carrier-queue-route` | Pass | Direct-carrier queue route predecessor. |
| `npm run test:shipping-roundtrip-certification` | Pass | Offline shipping roundtrip certification. |
| `npm run test:ps-330-controlled-canary-certification` | Pass | Live/canary plan predecessor. |
| `npm run typecheck -- --pretty false` | Pass | Repo typecheck. |
| `npm run build:web` | Pass | Web build. |

## Safety

This audit is read-only/offline only. It performs No real labels, No postage, No queue insertions, No marketplace notifications, No production order mutations, and No shipped/cancelled mutations.
It does not alter shipped/cancelled locked paths, does not run SQL updates/deletes, and does not call live provider, marketplace, queue, print, or postage APIs.
