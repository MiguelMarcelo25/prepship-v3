# PS-032 Direct Provider Call Audit

Date: 2026-05-27

Status: Phase 0 baseline for PS-032. This document inventories direct provider API usage that exists before the connector-boundary refactor. It does not change runtime behavior.

Safety note: this audit is documentation and static guard coverage only. No real labels, postage, provider mutations, marketplace notifications, shipped/cancelled order edits, or production data updates were performed.

## Boundary Rule

PrepShip core routes, services, schedulers, and UI-facing workflows should not call provider APIs directly. Core code should call StoreConnector or CarrierConnector orchestration, and connector implementations should own provider-specific API clients and payload normalization.

Allowed long-term provider call locations:

- StoreConnector implementations and connector-owned helpers for store/order/marketplace APIs.
- CarrierConnector implementations and connector-owned helpers for rates, labels, tracking, and voids.
- Low-level provider client wrappers only when called by connector-owned code.

Everything else in this document is transitional PS-032 migration debt.

Test fixtures may contain provider-shaped URLs or provider names when they mock connector behavior without performing network calls. For example, `scripts/ebay-confirmation-mocked-guard.ts` asserts mocked eBay confirmation payload shape and does not call the live eBay API.

## Connector-Owned Or Approved Low-Level Files

These files currently contain direct provider call markers and are allowed as connector-owned implementations or low-level provider wrappers. As PS-032 progresses, provider wrappers in `src/lib/*` should remain callable only from connector-owned code.

| File | Provider Area | Reason |
| --- | --- | --- |
| `src/connectors/store/walmart.ts` | Walmart Marketplace | StoreConnector implementation owns Walmart marketplace API details. |
| `src/connectors/store/ebay.ts` | eBay Marketplace | StoreConnector implementation owns eBay marketplace API details. |
| `src/connectors/store/shipstation.ts` | ShipStation store/orders | StoreConnector implementation owns ShipStation order API details. |
| `src/connectors/carrier/shipstation.ts` | ShipStation carrier | CarrierConnector implementation owns ShipStation label/rate behavior. |
| `src/connectors/carrier/ups.ts` | UPS | CarrierConnector implementation owns UPS carrier behavior. |
| `src/connectors/carrier/easypost.ts` | EasyPost | CarrierConnector implementation owns EasyPost carrier behavior. |
| `src/connectors/carrier/shipp.ts` | Shipp | CarrierConnector implementation owns Shipp carrier behavior. |
| `src/connectors/carrier/walmart-shipping.ts` | Walmart Shipping | CarrierConnector implementation owns Walmart Shipping behavior. |
| `src/connectors/carrier/fedex.ts` | FedEx | CarrierConnector implementation owns FedEx carrier behavior. |
| `src/connectors/carrier/usps.ts` | USPS | CarrierConnector implementation owns USPS carrier behavior. |
| `src/connectors/carrier/shipengine.ts` | ShipEngine | CarrierConnector implementation owns ShipEngine carrier behavior. |
| `src/connectors/carrier/ebay-shipping.ts` | eBay Shipping | CarrierConnector implementation owns eBay Logistics shipping behavior. |
| `src/connectors/carrier/amazon-shipping.ts` | Amazon Shipping | CarrierConnector implementation owns Amazon Shipping behavior. |
| `src/lib/shipstation/client.ts` | ShipStation low-level wrapper | Allowed provider wrapper, but should be called by connector-owned code only. |
| `src/lib/shipstation/credentials.ts` | ShipStation low-level wrapper | Allowed provider wrapper, but should be called by connector-owned code only. |
| `src/lib/shipstation/labels.ts` | ShipStation low-level wrapper | Allowed provider wrapper, but should be called by connector-owned code only. |
| `src/lib/shipstation/residential.ts` | ShipStation low-level wrapper | Allowed provider wrapper, but should be called by connector-owned code only. |
| `src/lib/shipstation/v1-client.ts` | ShipStation low-level wrapper | Allowed provider wrapper, but should be called by connector-owned code only. |

## Transitional Direct Provider Call Debt

These files currently contain direct provider calls or provider-client usage outside the target boundary. They are documented so the guard can prevent new unclassified direct provider calls while PS-032 moves existing behavior behind connectors.

| File | Provider Area | Target Owner | Migration Phase |
| --- | --- | --- | --- |
| `api/_lib/walmart-fees-sync.ts` | Walmart fees | Walmart StoreConnector or connector-owned helper | Phase 3 |
| `api/carriers/verify.ts` | Carrier verification | CarrierConnector diagnostics | Phase 4 |
| `api/carriers/walmart/fees.ts` | Walmart fees | Walmart StoreConnector or connector-owned helper | Phase 3 |
| `api/cron/sync-walmart-fees.ts` | Walmart fee sync cron | Walmart StoreConnector or connector-owned helper | Phase 3 |
| `src/lib/imported-handlers/carriers-verify.ts` | Carrier verification | CarrierConnector diagnostics | Phase 4 |

## Migration Map

Phase 1: Reconcile connector contracts and add thin orchestrators.

- Create one coherent StoreConnector runtime contract for order import, status sync, fetch where supported, and shipment confirmation.
- Create one coherent CarrierConnector runtime contract for rate quote, label create, tracking read, and void where supported.
- Keep the boundary thin: resolve connector, call method, persist normalized output.

Phase 1 baseline added on 2026-05-27:

- Canonical connector contracts live in `src/connectors/types.ts`.
- Legacy fulfillment-domain imports re-export those contracts from `src/domain/fulfillment/types.ts` so existing confirmation code uses the same runtime model.
- Store orchestration entry points live in `src/services/store-connector-orchestrator.ts`.
- Carrier orchestration entry points live in `src/services/carrier-connector-orchestrator.ts`.
- Guard command: `npm run test:ps-032-connector-orchestrators`.

Phase 2: Move ShipStation store/order sync.

- Move `src/services/order-sync.ts` direct `ssV1Request` usage into `src/connectors/store/shipstation.ts` or connector-owned helpers.
- Convert scheduler/routes/scripts to call StoreConnector orchestration.
- Keep canonical `orders` and `store_orders` persistence, but feed it normalized connector output.

Phase 2 slice added on 2026-05-27:

- `src/connectors/store/shipstation.ts` owns ShipStation `/orders` API paging and raw ShipStation order normalization.
- `src/services/order-sync.ts` calls `importStoreOrders('shipstation', ...)` instead of `ssV1Request`.
- `src/services/order-sync.ts` remains responsible for account watermarks, client/store attribution, status catch-up, and existing persistence semantics.

Phase 2 ShipStation store/catalog/shipment helper slice added on 2026-05-28:

- `src/connectors/store/shipstation.ts` now owns connector helper calls for ShipStation stores, warehouses, products, order listing, and v1 shipment listing.
- `src/connectors/carrier/shipstation.ts` now owns connector helper calls for ShipStation v2 shipment and label listing used by provider-account enrichment.
- `src/routes/clients.ts`, `src/routes/locations.ts`, `src/services/inventory-enrichment.ts`, `scripts/sync-shipstation-products.ts`, `scripts/reconcile-shipstation-awaiting.ts`, and `src/services/shipment-sync.ts` now call connector-owned helpers instead of low-level ShipStation request clients.
- These routes/services/scripts still own PrepShip persistence, reconciliation decisions, and reporting; only provider API access moved behind the connector boundary.

Phase 3: Move Walmart/eBay store import and marketplace operations.

- Convert `api/carriers/walmart/orders.ts` and `api/carriers/ebay/orders.ts` into thin wrappers over StoreConnector import orchestration.
- Move provider token/API payload logic into connector-owned helpers.
- Keep fulfillment outbox confirmation through StoreConnector.

Phase 3 order-import slice added on 2026-05-27:

- `api/carriers/walmart/orders.ts` now calls `importStoreOrders('walmart', ...)` and no longer calls Walmart Marketplace APIs directly.
- `api/carriers/ebay/orders.ts` now calls `importStoreOrders('ebay', ...)` and no longer calls eBay APIs directly.
- `src/connectors/store/walmart.ts` owns Walmart order token/API fetch logic.
- `src/connectors/store/ebay.ts` owns eBay order token/API fetch logic.

Phase 3 eBay OAuth callback slice added on 2026-05-28:

- `api/oauth/ebay/callback.ts` now calls connector-owned `exchangeEbayAuthorizationCode(...)` for the authorization-code exchange.
- `src/connectors/store/ebay.ts` owns the eBay OAuth token endpoint and redacted error handling for that exchange.
- The callback route still owns redirect HTML rendering, credential row selection, and refresh-token persistence.

Phase 4: Move rates, labels, carrier diagnostics, and direct-carrier handlers.

- Convert normal rate and label flows to CarrierConnector orchestration.
- Keep ShipStation, UPS, EasyPost, Shipp, and Walmart Shipping API details inside carrier connectors or connector-owned helpers.
- Ensure label persistence and print queue consume normalized connector outputs.

Phase 4 UPS rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes UPS rate quotes through `quoteCarrierRates('ups', ...)`.
- `src/connectors/carrier/ups.ts` owns UPS OAuth and Rating API calls.
- `api/carriers/rates.ts` remains transitional debt until the remaining direct rate providers are moved.

Phase 4 EasyPost rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes EasyPost rate quotes through `quoteCarrierRates('easypost', ...)`.
- `src/connectors/carrier/easypost.ts` owns EasyPost shipment/rate API calls.
- `api/carriers/rates.ts` still owns order-context lookup and remains transitional debt until all remaining rate providers are moved.

Phase 4 Shipp rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes Shipp rate quotes through `quoteCarrierRates('shipp', ...)`.
- `src/connectors/carrier/shipp.ts` owns Shipp login, ZIP enrichment, quote API calls, and rate normalization.
- `api/carriers/rates.ts` still owns order-context lookup and remains transitional debt until all remaining rate providers are moved.

Phase 4 Walmart Shipping rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes Walmart Shipping rate quotes through `quoteCarrierRates('walmart_shipping', ...)`.
- `src/connectors/carrier/walmart-shipping.ts` owns Walmart Shipping token, shipping-estimates API calls, request shaping, and rate normalization.
- `src/connectors/store/walmart.ts` owns the Walmart customer-order lookup helper used to resolve purchaseOrderId for ShipStation-ingested Walmart orders.
- `api/carriers/rates.ts` still owns database order-context lookup and remains transitional debt until the remaining rate providers are moved.

Phase 4 FedEx rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes FedEx rate quotes through `quoteCarrierRates('fedex', ...)`.
- `src/connectors/carrier/fedex.ts` owns FedEx OAuth, rate API calls, request shaping, and rate normalization.
- `api/carriers/rates.ts` remains transitional debt until all remaining rate providers are moved.

Phase 4 USPS rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes USPS rate quotes through `quoteCarrierRates('usps', ...)`.
- `src/connectors/carrier/usps.ts` owns USPS OAuth, price API calls, request shaping, and rate normalization.
- `api/carriers/rates.ts` remains transitional debt until all remaining rate providers are moved.

Phase 4 ShipEngine rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes ShipEngine rate quotes through `quoteCarrierRates('shipengine', ...)`.
- `src/connectors/carrier/shipengine.ts` owns ShipEngine carrier lookup, rate API calls, request shaping, and rate normalization.
- `api/carriers/rates.ts` remains transitional debt until all remaining rate providers are moved.

Phase 4 eBay Shipping rate slice added on 2026-05-28:

- `api/carriers/rates.ts` now routes eBay Shipping rate quotes through `quoteCarrierRates('ebay_shipping', ...)`.
- `src/connectors/carrier/ebay-shipping.ts` owns eBay Logistics OAuth, shipping quote API calls, request shaping, and rate normalization.
- `api/carriers/rates.ts` still owns local eBay raw-order lookup and remains transitional debt until all remaining rate providers are moved.

Phase 4 Amazon Shipping rate slice added on 2026-05-28:

- `api/carriers/rates.ts` now routes Amazon Shipping rate quotes through `quoteCarrierRates('amazon_shipping', ...)`.
- `src/connectors/carrier/amazon-shipping.ts` owns Amazon LWA auth, SP-API shipping rate calls, request shaping, and rate normalization.
- `api/carriers/rates.ts` still owns local Amazon raw-order lookup and remains transitional debt until all remaining rate providers are moved.

Phase 4 ShipStation carrier-list slice added on 2026-05-28:

- `src/routes/rates.ts` now routes `/rates/carriers` through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/carriers` API call for carrier account listing.
- ShipStation rate estimation in `src/services/rates.ts` remains transitional debt until the cached rate engine is moved behind the carrier connector.

Phase 4 ShipStation rate-service carrier-discovery slice added on 2026-05-28:

- `src/services/rates.ts` now routes cached-rate carrier discovery through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` remains the owner of ShipStation `/v2/carriers` calls.
- ShipStation `/v2/rates/estimate` calls in `src/services/rates.ts` remain transitional debt for the next cached-rate engine slice.

Phase 4 ShipStation cached-rate estimate slice added on 2026-05-28:

- `src/services/rates.ts` now routes per-carrier ShipStation estimates through `quoteCarrierRates('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/rates/estimate` API call.
- The cached rate service still owns PrepShip-specific cache keys, carrier diagnostics, blocked-service filtering, and markup application.

Phase 4 ShipStation package-sync slice added on 2026-05-28:

- `src/routes/packages.ts` now routes ShipStation carrier package sync through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/carriers` call used for package metadata.
- The packages route still owns PrepShip package persistence, stock fields, and ledger behavior.

Phase 4 ShipStation init carrier bootstrap slice added on 2026-05-28:

- `src/routes/init.ts` now routes init carrier bootstrap endpoints through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/carriers` calls used by `/init-data`, `/carrier-accounts`, and `/carriers`.
- The init route still owns app-shell DB bootstrap, scope filtering, and public response shaping.

Phase 4 ShipStation label carrier-nickname slice added on 2026-05-28:

- `src/services/labels.ts` now routes carrier nickname ShipStation carrier-list lookup through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/carriers` call used for nickname resolution.
- ShipStation label creation and label-from-rate calls in `src/services/labels.ts` remain transitional debt until the label purchase slice moves fully through CarrierConnector orchestration.

Phase 4 ShipStation legacy label-purchase slice added on 2026-05-28:

- `src/services/labels.ts` now routes normal V2 label creation plus legacy label-from-rate and label-from-shipment helpers through `createCarrierLabel('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` owns the ShipStation `/v2/labels/rates/{rateId}` and `/v2/labels` API calls used by those helpers.
- `src/services/labels.ts` still owns PrepShip shipment persistence, fulfillment outbox enqueueing, inventory/package deductions, and label recovery behavior.

Phase 4 UPS/EasyPost direct-label slice added on 2026-05-28:

- `api/carriers/labels.ts` now routes UPS and EasyPost direct-label purchases through `createCarrierLabel('ups' | 'easypost', ...)`.
- `src/connectors/carrier/ups.ts` owns UPS OAuth plus `/api/shipments/v2403/ship` label creation.
- `src/connectors/carrier/easypost.ts` owns EasyPost shipment creation and `/buy` label purchase.
- The labels route still owns order editability checks, direct-label persistence, marketplace outbox enqueueing, and response shaping.

Phase 4 Shipp direct-label slice added on 2026-05-28:

- `api/carriers/labels.ts` now routes Shipp direct-label purchases through `createCarrierLabel('shipp', ...)`.
- `src/connectors/carrier/shipp.ts` owns Shipp login, quote, label creation, and label document normalization.
- The labels route still owns order editability checks, direct-label persistence, marketplace outbox enqueueing, Walmart post-label confirmation recovery, and response shaping.

Phase 4 Walmart Shipping direct-label slice added on 2026-05-28:

- `api/carriers/labels.ts` now routes Walmart Shipping direct-label purchases through `createCarrierLabel('walmart_shipping', ...)`.
- `src/connectors/carrier/walmart-shipping.ts` owns Walmart Shipping label estimates, label creation, label download fallback paths, and label response extraction.
- The labels route still owns local order-context lookup, order editability checks, direct-label persistence, marketplace outbox enqueueing, Walmart post-label confirmation recovery, and response shaping.

Phase 4 Walmart post-label confirmation slice added on 2026-05-28:

- `api/carriers/labels.ts` now routes immediate Walmart post-label marketplace confirmation through `confirmStoreShipment('walmart', ...)`.
- `src/connectors/store/walmart.ts` remains the owner of the Walmart `/v3/orders/{purchaseOrderId}/shipping` marketplace confirmation call.
- The labels route still owns local shipment/outbox status updates after the StoreConnector confirmation result.

Phase 4 Walmart label-context lookup cleanup added on 2026-05-28:

- `api/carriers/labels.ts` now uses connector-owned `lookupWalmartOrderByCustomerOrderId(...)` for Walmart source-order lookup during Walmart Shipping label creation.
- `src/connectors/store/walmart.ts` owns the Walmart token and `/v3/orders` lookup calls used by that label context.
- The labels route still owns local order-context lookup, order editability checks, direct-label persistence, marketplace outbox enqueueing, and response shaping.

Phase 4 UPS credential-probe slice added on 2026-05-28:

- `api/carriers/ups/probe.ts` now routes UPS credential probing through connector-owned `probeUpsCredentials(...)`.
- `src/connectors/carrier/ups.ts` owns the UPS OAuth credential probe call and safe fingerprint response shape.
- The probe route still owns query-parameter parsing, no-store JSON headers, and safe error handling.

Phase 4 Walmart Shipping carriers-probe slice added on 2026-05-28:

- `api/carriers/walmart/probe-carriers.ts` now routes Walmart Shipping carrier-access probing through connector-owned `probeWalmartShippingCarriers(...)`.
- `src/connectors/carrier/walmart-shipping.ts` owns the Walmart OAuth token call and `/v3/shipping/labels/carriers` probe.
- The probe route still owns Supabase auth, CORS, DB credential lookup, provider validation, and safe error handling.

Phase 4 USPS address-validation slice added on 2026-05-28:

- `api/carriers/validate-address.ts` now routes USPS address validation through connector-owned `validateUspsAddress(...)`.
- `src/connectors/carrier/usps.ts` owns USPS OAuth plus `/addresses/v3/address` normalization.
- The validation route still owns Supabase auth, CORS, DB credential lookup, provider validation, input validation, and safe error handling.

Phase 4 rate-scoping diagnostic slice added on 2026-05-28:

- `scripts/probe-rate-scoping.ts` now routes ShipStation carrier-account probing through `listCarrierAccounts('shipstation', ...)`.
- `src/connectors/carrier/shipstation.ts` remains the owner of the ShipStation `/v2/carriers` call.
- The diagnostic script still owns client credential-resolution reporting and console output.

Phase 4 diagnostic carrier-orchestration cleanup added on 2026-05-28:

- `src/lib/imported-handlers/rates-multi.ts` now uses `listCarrierAccounts('shipstation', ...)` for multi-account ShipStation carrier fan-out.
- `scripts/verify-ground-saver-fix.ts` now uses `listCarrierAccounts('shipstation', ...)` and `quoteCarrierRates('shipstation', ...)` for the live diagnostic probe.
- `src/services/labels.ts` no longer carries a stale direct ShipStation request import after the label-purchase paths moved through `createCarrierLabel('shipstation', ...)`.
- `scripts/recover-marketplace-notifications.ts` only had stale direct-helper references in comments; those were rewritten without changing recovery behavior.

Phase 5: Tighten guards.

- Remove files from the transitional debt list as they are migrated.
- Make `scripts/ps-032-connector-boundary-guard.mjs` fail on any remaining direct provider call outside connector-owned files.
- Add targeted tests proving routes/services/schedulers use StoreConnector/CarrierConnector orchestration.

## Guard Purpose

`scripts/ps-032-connector-boundary-guard.mjs` intentionally does not claim PS-032 is complete. It freezes the Phase 0 direct-provider-call inventory so new provider calls cannot quietly appear in core routes/services while the migration is underway.

When a transitional file is migrated behind connectors, remove it from both this document's transitional table and the guard's `transitionalDebt` set.
