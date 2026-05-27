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
| `api/carriers/labels.ts` | Carrier labels | CarrierConnector label orchestration | Phase 4 |
| `api/carriers/rates.ts` | Carrier rates | CarrierConnector rate orchestration | Phase 4 |
| `api/carriers/ups/probe.ts` | UPS probe | UPS CarrierConnector diagnostics | Phase 4 |
| `api/carriers/validate-address.ts` | Carrier address validation | CarrierConnector validation capability or connector-owned helper | Phase 4 |
| `api/carriers/verify.ts` | Carrier verification | CarrierConnector diagnostics | Phase 4 |
| `api/carriers/walmart/fees.ts` | Walmart fees | Walmart StoreConnector or connector-owned helper | Phase 3 |
| `api/carriers/walmart/probe-carriers.ts` | Walmart Shipping probe | Walmart Shipping CarrierConnector diagnostics | Phase 4 |
| `api/cron/sync-walmart-fees.ts` | Walmart fee sync cron | Walmart StoreConnector or connector-owned helper | Phase 3 |
| `api/oauth/ebay/callback.ts` | eBay OAuth/API token flow | eBay connector-owned auth helper | Phase 3 |
| `scripts/probe-rate-scoping.ts` | ShipStation rate probe | CarrierConnector diagnostics script or connector-owned helper | Phase 4 |
| `scripts/reconcile-shipstation-awaiting.ts` | ShipStation order reconciliation | ShipStation StoreConnector status/order sync | Phase 2 |
| `scripts/recover-marketplace-notifications.ts` | Marketplace notification recovery | StoreConnector confirmation/outbox orchestration | Phase 3 |
| `scripts/sync-shipstation-products.ts` | ShipStation product sync | ShipStation StoreConnector or connector-owned catalog helper | Phase 2 |
| `scripts/verify-ground-saver-fix.ts` | ShipStation rate verification | ShipStation CarrierConnector diagnostics | Phase 4 |
| `src/lib/imported-handlers/carriers-verify.ts` | Carrier verification | CarrierConnector diagnostics | Phase 4 |
| `src/lib/imported-handlers/rates-multi.ts` | Carrier rates | CarrierConnector rate orchestration | Phase 4 |
| `src/routes/clients.ts` | ShipStation stores/accounts | StoreConnector/account orchestration | Phase 2 |
| `src/routes/init.ts` | ShipStation initialization | Connector/account bootstrap orchestration | Phase 2 |
| `src/routes/locations.ts` | ShipStation locations | ShipStation connector-owned helper | Phase 2 |
| `src/routes/packages.ts` | ShipStation package metadata | CarrierConnector/account metadata orchestration | Phase 4 |
| `src/routes/rates.ts` | ShipStation rates | CarrierConnector rate orchestration | Phase 4 |
| `src/services/inventory-enrichment.ts` | ShipStation product/order enrichment | ShipStation StoreConnector or connector-owned helper | Phase 2 |
| `src/services/labels.ts` | ShipStation label creation | CarrierConnector label orchestration | Phase 4 |
| `src/services/rates.ts` | ShipStation rates | CarrierConnector rate orchestration | Phase 4 |
| `src/services/shipment-sync.ts` | ShipStation shipment sync | StoreConnector/CarrierConnector sync orchestration | Phase 2 |

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

Phase 3: Move Walmart/eBay store import and marketplace operations.

- Convert `api/carriers/walmart/orders.ts` and `api/carriers/ebay/orders.ts` into thin wrappers over StoreConnector import orchestration.
- Move provider token/API payload logic into connector-owned helpers.
- Keep fulfillment outbox confirmation through StoreConnector.

Phase 3 order-import slice added on 2026-05-27:

- `api/carriers/walmart/orders.ts` now calls `importStoreOrders('walmart', ...)` and no longer calls Walmart Marketplace APIs directly.
- `api/carriers/ebay/orders.ts` now calls `importStoreOrders('ebay', ...)` and no longer calls eBay APIs directly.
- `src/connectors/store/walmart.ts` owns Walmart order token/API fetch logic.
- `src/connectors/store/ebay.ts` owns eBay order token/API fetch logic.

Phase 4: Move rates, labels, carrier diagnostics, and direct-carrier handlers.

- Convert normal rate and label flows to CarrierConnector orchestration.
- Keep ShipStation, UPS, EasyPost, Shipp, and Walmart Shipping API details inside carrier connectors or connector-owned helpers.
- Ensure label persistence and print queue consume normalized connector outputs.

Phase 4 UPS rate slice added on 2026-05-27:

- `api/carriers/rates.ts` now routes UPS rate quotes through `quoteCarrierRates('ups', ...)`.
- `src/connectors/carrier/ups.ts` owns UPS OAuth and Rating API calls.
- `api/carriers/rates.ts` remains transitional debt until the remaining direct rate providers are moved.

Phase 5: Tighten guards.

- Remove files from the transitional debt list as they are migrated.
- Make `scripts/ps-032-connector-boundary-guard.mjs` fail on any remaining direct provider call outside connector-owned files.
- Add targeted tests proving routes/services/schedulers use StoreConnector/CarrierConnector orchestration.

## Guard Purpose

`scripts/ps-032-connector-boundary-guard.mjs` intentionally does not claim PS-032 is complete. It freezes the Phase 0 direct-provider-call inventory so new provider calls cannot quietly appear in core routes/services while the migration is underway.

When a transitional file is migrated behind connectors, remove it from both this document's transitional table and the guard's `transitionalDebt` set.
