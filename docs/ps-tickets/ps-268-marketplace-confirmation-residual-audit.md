# PS-268 - Marketplace confirmation residual audit

PS-268 does not create a new marketplace confirmation source of truth. It is a
residual certification over completed backend authority work from PS-064,
PS-253, PS-262A, PS-263, PS-285, PS-318, and PS-330.

Current finding: No new unowned gap found. No broad marketplace confirmation refactor
is needed. If a future live canary proves a specific provider failure, it should
become a narrow PS-284 implementation card or a new card tied to the exact
backend owner that failed.

## Marketplace confirmation residual scope

This audit maps ShipStation-source, Walmart-source, eBay/direct marketplace,
not_required, and not_supported confirmation paths.

It also checks that local shipped, label/print state, fulfillment outbox state,
and upstream marketplace/source confirmation state stay separate. Recovery and
retry scripts remain dry-run safe by default, idempotent, and do not introduce a
direct notify connector path outside the outbox/connector owner lifecycle.

## Canonical owner map

| Concern | Canonical owner | PS-268 classification |
| --- | --- | --- |
| Confirmation lifecycle planning, idempotency, outbox enqueue/process/retry, and void retract | `src/services/fulfillment/outbox.ts` | already covered |
| Marketplace identity hydration for Walmart/eBay payloads | `src/services/fulfillment/confirmation-payload.ts` | already covered |
| Thin connector resolve/dispatch wrapper with no external callers | `src/services/store-connector-orchestrator.ts` | already covered |
| ShipStation-source mark-shipped relay | `src/connectors/store/shipstation.ts` | already covered; PS-330 canary-only for live source relay |
| Walmart-source confirmation payload and provider API translation | `src/connectors/store/walmart.ts` | already covered; PS-330 canary-only for live provider notification |
| eBay/direct marketplace fulfillment payload and already-fulfilled handling | `src/connectors/store/ebay.ts` | already covered; PS-330 canary-only for live provider notification |
| Exact outbox retry command | `scripts/retry-marketplace-confirmation.ts` | already covered; PS-330 canary-only when run live |
| Lifecycle repair command | `scripts/repair-marketplace-confirmation.ts` | already covered |
| Missing-confirmation recovery command | `scripts/recover-missing-shipment-confirmations.ts` | already covered |

## Imperfect data injection points

| Injection point | Current owner response | Classification |
| --- | --- | --- |
| Existing local label has no active shipment row | Lifecycle plan returns `no_active_shipment`; it does not mark marketplace confirmed or buy a label. | already covered |
| Shipment confirmation already succeeded | Lifecycle plan returns `already_succeeded`; processing is idempotent and does not re-notify. | already covered |
| Shipment confirmation already pending or processing | Lifecycle plan returns `already_pending`; callers delegate to the existing outbox row. | already covered |
| Existing label has no tracking number | Lifecycle plan returns `mark_not_required_no_tracking`; no marketplace notification is attempted. | already covered |
| Manual/internal/no marketplace source | Lifecycle plan returns `mark_not_required`. | already covered |
| Unsupported source connector | Lifecycle plan returns `mark_not_supported` and records an explicit terminal confirmation state. | already covered |
| ShipStation source without upstream source id | Lifecycle plan returns `mark_not_supported`; local shipped and upstream relay are not treated as the same fact. | already covered |
| Walmart order identity or line payload is incomplete | Confirmation payload owner hydrates `purchaseOrderId` and `rawOrder`; Walmart connector rejects missing order line numbers. | already covered |
| eBay order identity or line payload is incomplete | Confirmation payload owner hydrates `ebayOrderId`, `rawOrder`, and `lineItems`; eBay connector rejects missing line items. | already covered |
| Live marketplace/provider behavior | Offline guards prove owner boundaries only; exact live execution remains controlled canary work. | PS-330 canary-only |

## Confirmation path matrix

| Path | Evidence | Classification | Follow-up |
| --- | --- | --- | --- |
| ShipStation-source | `outbox.ts` plans `create_outbox_pending`; `src/connectors/store/shipstation.ts` relays through `ssMarkOrderShippedV1`; PS-285 pins allowed call sites. | already covered | None |
| Walmart-source | `confirmation-payload.ts` hydrates Walmart identity; `src/connectors/store/walmart.ts` builds the `orderShipment` envelope and rejects missing line numbers. | already covered | None |
| eBay/direct marketplace | `confirmation-payload.ts` hydrates eBay identity and line items; `src/connectors/store/ebay.ts` treats already-fulfilled 409 responses as safe success. | already covered | None |
| not_required | Manual/internal/no-marketplace providers and no-tracking local labels are explicit plan outcomes. | already covered | None |
| not_supported | Unsupported connectors and ShipStation rows without upstream source ids are explicit terminal outcomes, not silent failures. | already covered | None |
| local shipped vs upstream confirmation | Local shipped status is distinct from `shipments.confirmation_status`, `marketplace_confirmed_at`, and `fulfillment_outbox.status`. | already covered | None |
| label/print state vs confirmation | Label URL and Print Queue state do not mean marketplace confirmed; outbox lifecycle owns upstream confirmation. | already covered | None |
| fulfillment outbox state | Pending, processing, succeeded, failed, not_required, and not_supported states are explicit owner outcomes or recovery inputs. | already covered | None |
| upstream marketplace/source confirmation state | Provider connector success updates confirmation lifecycle; retry/recovery scripts inspect before applying any live operation. | already covered | None |
| direct notify connector path | PS-285 pins `connector.confirmShipment` dispatch to `src/services/fulfillment/outbox.ts` and the resolver wrapper only; `confirmStoreShipment` has zero callers outside its module. | already covered | None |
| recovery/retry scripts | `scripts/repair-marketplace-confirmation.ts` and `scripts/recover-missing-shipment-confirmations.ts` are dry-run safe by default; apply/live paths require exact approval/ids and delegate to outbox lifecycle. | already covered | None |
| live/canary proof | Real marketplace notifications remain PS-330 canary-only unless DJ approves the exact order/provider/action. | PS-330 canary-only | None |
| PS-284 implementation | No current implementation gap was proven. Use PS-284 only if a future provider canary proves a specific connector behavior gap. | PS-284 implementation: none triggered | None |
| new unowned gap | No current unowned marketplace confirmation gap was proven by this audit. | new unowned gap: none found | None |

## Evidence commands

Required residual audit evidence:

- `test:ps-268-marketplace-confirmation-residual-audit`
- `test:ps-318-shipping-workflow-certification`
- `test:ps-064-confirmation-outbox`
- `test:ps-285-marketplace-confirm-boundary`
- `test:walmart-confirmation:payload`
- `test:ebay-confirmation:mocked`
- `test:ps-262a-confirmation-payload-funnel`
- `test:ps-253-outbox-stale-reclaim`
- `test:ps-263-void-confirmation-retract`
- `test:shipment-confirmation-auto-recovery`
- `test:shipping-roundtrip-certification`
- `test:ps-330-controlled-canary-certification`
- `npm run typecheck -- --pretty false`
- `npm run build:web`

## Verification status

| Command | Status | Notes |
| --- | --- | --- |
| `npm run test:ps-268-marketplace-confirmation-residual-audit` | Pass | Initial red run failed until this residual matrix existed; final guard passed. |
| `npm run test:ps-318-shipping-workflow-certification` | Pass | Shipping workflow predecessor. |
| `npm run test:ps-064-confirmation-outbox` | Pass | Confirmation lifecycle/outbox predecessor. |
| `npm run test:ps-285-marketplace-confirm-boundary` | Pass | Marketplace dispatch boundary predecessor. |
| `npm run test:walmart-confirmation:payload` | Pass | Walmart payload predecessor. |
| `npm run test:ebay-confirmation:mocked` | Pass | eBay mocked connector predecessor. |
| `npm run test:ps-262a-confirmation-payload-funnel` | Pass | Confirmation payload funnel predecessor. |
| `npm run test:ps-253-outbox-stale-reclaim` | Pass | Outbox stale reclaim predecessor. |
| `npm run test:ps-263-void-confirmation-retract` | Pass | Void/retract predecessor. |
| `npm run test:shipment-confirmation-auto-recovery` | Pass | Missing-confirmation recovery predecessor. |
| `npm run test:shipping-roundtrip-certification` | Pass | Offline shipping roundtrip certification. |
| `npm run test:ps-330-controlled-canary-certification` | Pass | Live/canary plan predecessor. |
| `npm run typecheck -- --pretty false` | Pass | Repo typecheck. |
| `npm run build:web` | Pass | Web build. |

## Safety

This audit is read-only/offline only. It performs No real labels, No postage,
No queue insertions, No marketplace notifications, No production order
mutations, and No shipped/cancelled mutations.

Safety phrase for the guard: No production order mutations.

It does not alter shipped/cancelled locked paths, does not run SQL
updates/deletes, and does not call live provider, marketplace, queue, print, or
postage APIs.
