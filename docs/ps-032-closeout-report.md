# PS-032 Closeout Report

Date: 2026-05-28

Status: Complete. Final verification matrix passed.

## Summary

PS-032 moved PrepShip's known store/order and carrier/rate/label provider integrations behind connector boundaries.

The intended runtime model is now:

- PrepShip core -> StoreConnector orchestration -> provider store API -> normalized orders/status/store values -> persistence/UI
- PrepShip core -> CarrierConnector orchestration -> provider carrier API -> normalized rates/labels/tracking/void values -> persistence/print queue/UI
- `fulfillment_outbox` -> `StoreConnector.confirmShipment` -> marketplace confirmation

No separate `OrderConnector` is currently used. Store/order import uses `StoreConnector`.

## Exact Files Changed In This Closeout

- `docs/ps-032-connector-boundary-task.md`
- `docs/ps-032-direct-provider-call-audit.md`
- `docs/ps-032-connector-architecture.md`
- `docs/ps-032-closeout-report.md`
- `docs/prepship-current-connector-flow.drawio`

## Direct Provider Calls And Allowed Locations

Direct provider call markers are allowed only in connector-owned files or approved low-level wrappers:

- Store connectors: `src/connectors/store/shipstation.ts`, `src/connectors/store/walmart.ts`, `src/connectors/store/walmart-fees.ts`, `src/connectors/store/ebay.ts`
- Carrier connectors: `src/connectors/carrier/shipstation.ts`, `src/connectors/carrier/ups.ts`, `src/connectors/carrier/easypost.ts`, `src/connectors/carrier/shipp.ts`, `src/connectors/carrier/walmart-shipping.ts`, `src/connectors/carrier/fedex.ts`, `src/connectors/carrier/usps.ts`, `src/connectors/carrier/shipengine.ts`, `src/connectors/carrier/ebay-shipping.ts`, `src/connectors/carrier/amazon-shipping.ts`, `src/connectors/carrier/credential-verification.ts`
- Approved low-level ShipStation wrappers: `src/lib/shipstation/client.ts`, `src/lib/shipstation/credentials.ts`, `src/lib/shipstation/labels.ts`, `src/lib/shipstation/residential.ts`, `src/lib/shipstation/v1-client.ts`

Compatibility routes and services are allowed only when they call connector orchestration and own PrepShip concerns such as auth, account lookup, local order context, persistence, response shaping, and safe error handling.

## Connector Types And Orchestrators

- Canonical connector contracts live in `src/connectors/types.ts`.
- Fulfillment-domain compatibility imports are unified through `src/domain/fulfillment/types.ts`.
- StoreConnector orchestration lives in `src/services/store-connector-orchestrator.ts`.
- CarrierConnector orchestration lives in `src/services/carrier-connector-orchestrator.ts`.

## Guards

- `scripts/ps-032-connector-boundary-guard.mjs` blocks provider API markers outside connector-owned files or approved low-level wrappers. Its transitional debt list must remain empty.
- `scripts/ps-032-connector-orchestrator-guard.mjs` verifies core order/rate/label flows call connector orchestration rather than provider APIs directly.
- `scripts/connector-architecture-guard.mjs` and `scripts/connector-registry-guard.mjs` protect the broader connector registry and architecture rules.
- `scripts/vercel-function-imports-guard.mjs` protects Vercel API routes from startup-time connector-tree imports that can crash serverless functions before auth/OPTIONS.

## Implementation Truth Checks

- `src/services/order-sync.ts` does not call `ssV1Request` directly.
- Walmart/eBay order routes call `importStoreOrders`.
- Label/rate paths call CarrierConnector orchestration.
- Direct provider APIs appear only in connector-owned files, approved low-level wrappers, or static guard/mock scripts.
- The PS-032 boundary guard reports zero unclassified transitional debt.

## Verification Results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build:web` | Pass |
| `npm run test:connector-architecture` | Pass |
| `npm run test:connector-registry` | Pass |
| `npm run test:ps-032-connector-orchestrators` | Pass |
| `npm run test:ps-032-connector-boundary` | Pass: 20 connector-owned files, 0 transitional debt files |
| `npm run test:vercel-function-imports` | Pass |
| `npm run test:direct-carrier-labels` | Pass |
| `npm run test:ebay-confirmation:mocked` | Pass |
| `npm run test:walmart-confirmation:payload` | Pass |

Additional implementation truth checks:

- `rg -n "ssV1Request|ssRequest" src/services/order-sync.ts` returned no matches.
- `rg -n "importStoreOrders" api/carriers/walmart/orders.ts api/carriers/ebay/orders.ts src/services/order-sync.ts` confirmed ShipStation, Walmart, and eBay order paths call StoreConnector orchestration.
- `rg -n "quoteCarrierRates|createCarrierLabel|listCarrierAccounts" api/carriers/rates.ts api/carriers/labels.ts src/services/rates.ts src/services/labels.ts src/routes/rates.ts` confirmed rate, label, and carrier-account paths call CarrierConnector orchestration.

## Known Follow-Ups

- Future marketplaces such as Shopify, Amazon store order import, TikTok, and WooCommerce still need their own StoreConnector implementations before those providers can become first-class order sources.
- Provider live rate availability still depends on valid credentials, account eligibility, provider uptime, and shipment/package inputs.
- Compatibility routes should remain thin wrappers and should not regain provider-specific API calls.

## Safety Confirmation

This closeout pass is documentation and static verification only. It did not create real labels, buy postage, send live marketplace notifications, mutate provider orders, or mutate shipped/cancelled data.
