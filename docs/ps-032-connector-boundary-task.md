# PS-032 - Enforce StoreConnector/CarrierConnector Boundary for Orders, Rates, Labels, and Marketplace Confirmation

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Status: New architecture-hardening task. This does not supersede PS-024, PS-025, or PS-026. It hardens the connector model those tasks depend on.

## Copy/Paste Codex Prompt

You are working in PrepShip V4.

### Goal

Refactor PrepShip so provider-specific store and carrier integrations are isolated behind connector boundaries. PrepShip core must not directly call ShipStation, Walmart, eBay, UPS, EasyPost, Shipp, Walmart Shipping, or future provider APIs from routes/services/UI-facing workflow code. PrepShip should talk to StoreConnector for store/order/marketplace operations and CarrierConnector for rates/labels/tracking/voids. Connectors own provider-specific API calls and normalize all provider-specific payloads into standardized PrepShip values.

### Current Findings / Context

- Main order sync currently calls ShipStation directly from `src/services/order-sync.ts` via `ssV1Request('/orders?...')` and writes `sourceProvider: 'shipstation'` through `buildShipStationOrderSource`.
- Walmart/eBay order pulls currently live in direct endpoint files (`api/carriers/walmart/orders.ts`, `api/carriers/ebay/orders.ts`) and write `store_orders` plus mirrored `orders`; they are not routed through `storeConnectors.walmart.importOrders()` / `storeConnectors.ebay.importOrders()`.
- `src/domain/fulfillment/types.ts` has a narrow `StoreConnector` only for shipment confirmation; `src/connectors/types.ts` has a richer `StoreConnector` with `importOrders`, `syncOrderStatuses`, `normalizeOrder`, and `confirmShipment`. Reconcile these into one true runtime contract or a clearly layered shared contract.
- Shipment confirmation already mostly follows the target model via `src/services/fulfillment/outbox.ts` -> `resolveStoreConnector(..., 'shipment.confirm')` -> connector `confirmShipment`.
- Main label creation still goes through `carrierConnectors.shipstation.createLabel(...)`, but older label/rate/carrier-list code and direct-carrier handlers still contain provider-specific branches and direct provider calls outside clean connector boundaries.

### Target Model

Store/order operations:

- PrepShip core calls a provider-neutral orchestrator/service such as `syncStoreOrders(...)` or `storeConnectorSyncService`.
- That orchestrator resolves a `StoreConnector` by provider/account/capability.
- Only `StoreConnector` implementations may call store APIs: ShipStation order/store APIs, Walmart Marketplace APIs, eBay Sell APIs, Shopify/Amazon future APIs, etc.
- `StoreConnector` returns normalized standardized order/status/store values.
- Core persistence writes normalized rows into `store_orders`, canonical `orders`, and source fields from that normalized output.

Carrier/rate/label operations:

- PrepShip core calls a provider-neutral carrier service/orchestrator.
- That service resolves a `CarrierConnector` by provider/account/capability.
- Only `CarrierConnector` implementations may call carrier/label/rate APIs: ShipStation, UPS, EasyPost, Shipp, Walmart Shipping, etc.
- `CarrierConnector` returns normalized standardized rates, labels, tracking, void results, label URLs/base64, cost/currency, service/carrier names, provider account identity, and safe diagnostics.
- Label purchase/print queue/label persistence must consume normalized connector outputs, not raw provider payloads.

Marketplace confirmation:

- Keep/strengthen existing fulfillment outbox connector flow.
- Confirmation must continue through `StoreConnector.confirmShipment` and must never call provider marketplace confirmation endpoints directly from core services/routes.

### Files / Docs To Inspect First

- `src/connectors/types.ts`
- `src/domain/fulfillment/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/store-resolution.ts`
- `src/connectors/carrier-resolution.ts`
- `src/connectors/store/shipstation.ts`
- `src/connectors/store/walmart.ts`
- `src/connectors/store/ebay.ts`
- `src/connectors/carrier/shipstation.ts`
- `src/connectors/carrier/ups.ts`
- `src/connectors/carrier/easypost.ts`
- `src/connectors/carrier/shipp.ts`
- `src/connectors/carrier/walmart-shipping.ts`
- `src/services/order-sync.ts`
- `src/services/normalized-order-persistence.ts`
- `src/services/fulfillment/outbox.ts`
- `src/services/labels.ts`
- `src/services/rates.ts`
- `src/services/shipment-sync.ts`
- `src/services/inventory-enrichment.ts`
- `api/carriers/walmart/orders.ts`
- `api/carriers/ebay/orders.ts`
- `api/carriers/labels.ts`
- `api/carriers/rates.ts`
- `src/lib/shipstation/*`
- Existing connector guards: `scripts/connector-architecture-guard.mjs`, `scripts/connector-registry-guard.mjs`, direct-carrier guards, runtime DDL guards
- Docs: `docs/source-of-truth-matrix.md`, `docs/marketplace-confirmation.md`, `SHIPPING_INTEGRATION_PS_REMEDIATION.md`, `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`

### Implementation Requirements

Define the connector boundary clearly.

- Create or reconcile canonical shared types for `StoreConnector` and `CarrierConnector`.
- `StoreConnector` must support normalized order import/status sync/fetch/confirmation where provider supports it.
- `CarrierConnector` must support normalized rate quote/label create/void/tracking where provider supports it.
- Avoid duplicate incompatible `StoreConnector` definitions.

Move provider-specific store API logic behind StoreConnectors.

- ShipStation order import/status sync logic should move from `src/services/order-sync.ts` into `src/connectors/store/shipstation.ts` or connector-owned helpers.
- Walmart order import/normalization logic should move behind `src/connectors/store/walmart.ts`.
- eBay order import/normalization logic should move behind `src/connectors/store/ebay.ts`.
- Existing routes/cron/scheduler should call the generic store connector sync orchestrator, not provider APIs directly.
- Keep `store_orders` and canonical `orders` persistence, but persistence should consume normalized connector outputs.

Move provider-specific carrier/rate/label logic behind CarrierConnectors.

- All normal label creation should resolve a `CarrierConnector` and call its normalized `createLabel` method.
- Direct carrier label/rate branches in API files should be converted into connector resolution/orchestration where practical.
- ShipStation label/rate/carrier code should remain allowed only inside ShipStation carrier connector or connector-owned helpers.
- UPS/EasyPost/Shipp/Walmart Shipping calls should remain allowed only inside their `CarrierConnector` implementations or connector-owned helpers.

Normalize standardized values.

- Define normalized order fields: `sourceProvider`, `sourceAccountId`, `sourceOrderId`, `sourceOrderNumber`, marketplace/store identity, `canonicalStatus`, `orderDate`, customer/address fields, items, totals, shipping paid, raw payload reference/redacted payload policy.
- Define normalized carrier/rate/label fields: `provider`, `providerAccountId`, `carrierCode`, `carrierName`, `serviceCode`, `serviceName`, `trackingNumber`, `labelUrl`, `labelBase64`/`labelFormat` where applicable, cost, currency, voidable, raw safe metadata, diagnostics.
- Core PrepShip code should not parse raw provider response shape except through connector-normalized outputs.

Add guards to prevent regression.

- Add/extend static guards so provider API clients/imports (`ssRequest`, `ssV1Request`, Walmart/eBay token/API fetches, UPS/EasyPost/Shipp direct calls, etc.) are forbidden outside approved connector/lib directories.
- Add guard coverage that routes/services/schedulers use connector orchestrators, not direct provider calls.
- Add guard coverage that label creation and rates route through `CarrierConnector` resolution.
- Add guard coverage that store order import/status sync route through `StoreConnector` resolution.
- If provider library wrappers remain in `src/lib/provider`, they may be called by connector implementations only.

Preserve behavior and safety.

- Do not weaken auth/RBAC, client/store scope, source-of-truth constraints, secret redaction, PII redaction, shipped/cancelled lockdown, label safety, or production safeguards.
- Do not create real labels, buy postage, send live marketplace notifications, mutate live provider orders, or perform live tests by default.
- Do not expose tokens, API keys, buyer PII, raw labels, raw addresses, or unredacted provider payloads in logs/tests/docs.
- Existing production behavior should be preserved unless the connector boundary requires a deliberate, documented compatibility change.

### Documentation

Update/add architecture docs showing the new model:

- PrepShip core -> StoreConnector -> provider store API -> normalized orders -> PrepShip persistence/UI
- PrepShip core -> CarrierConnector -> provider carrier API -> normalized rates/labels/tracking -> PrepShip persistence/print queue
- PrepShip fulfillment_outbox -> `StoreConnector.confirmShipment` -> marketplace confirmation

Include a short "new Walmart user" walkthrough: add Walmart credentials -> store connector pulls normalized orders -> user buys/prints label via carrier connector -> outbox confirms shipment via Walmart StoreConnector.

### Suggested Phasing

1. Phase 0: Inventory direct provider calls and classify allowed connector-owned vs forbidden core calls.
2. Phase 1: Reconcile types and introduce connector orchestrators with minimal behavior changes.
3. Phase 2: Move ShipStation order sync behind StoreConnector.
4. Phase 3: Move Walmart/eBay order pull normalization behind StoreConnectors while preserving existing endpoints as thin wrappers if needed.
5. Phase 4: Move label/rate/direct-carrier logic behind CarrierConnector orchestration.
6. Phase 5: Add guards/docs/certification tests.

### Verification Commands

- `npm run typecheck`
- `npm run build`
- `npm run test:connector-architecture` or the updated equivalent guard command
- `npm run test:connector-registry` or the updated equivalent guard command
- `npm run test:ps-032-connector-boundary`
- `npm run test:ps-032-connector-orchestrators`
- Existing relevant direct-carrier/marketplace/label guards from `package.json`
- Existing marketplace confirmation smoke/guard tests in mocked/dry-run mode
- Existing PS-022/full-site workflow certification commands if present and runnable

Add and run new targeted tests proving:

- ShipStation order sync calls StoreConnector orchestrator, not `ssV1Request` directly from core service.
- Walmart/eBay order pull wrappers call StoreConnector orchestrator, not provider API logic directly.
- Label creation/rate flows call CarrierConnector orchestrator.
- Provider API wrappers are only imported by connector implementations or connector-owned helpers.
- Normalized outputs contain required fields and no raw secrets/PII in logs/errors.

### Definition Of Done

- There is one coherent connector contract model for store and carrier operations.
- PrepShip core pulls store orders only from StoreConnector-normalized outputs.
- PrepShip core creates rates/labels/tracking/voids only from CarrierConnector-normalized outputs.
- ShipStation, Walmart, eBay, UPS, EasyPost, Shipp, Walmart Shipping direct API calls are isolated to connector implementations or explicitly connector-owned helper modules.
- Existing order sync, direct Walmart/eBay order import, label purchase, print queue persistence, and marketplace confirmation behavior remains covered by tests/guards.
- Static guards prevent future provider-direct calls from creeping back into core routes/services.
- Docs show the new connector-first architecture and new-user Walmart flow.
- All required verification commands pass, or any blocked command is documented with exact reason and no silent skip.

### Return Format

- Summary of architecture changes made.
- Exact files changed.
- Direct provider calls found and where each was moved/allowed.
- New/updated normalized connector types.
- New/updated guards and what they block.
- Verification commands run with pass/fail results.
- Any known follow-up tasks required.
- Confirmation that no real labels/postage/live marketplace notifications/provider mutations were performed.
