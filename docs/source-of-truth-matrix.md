# PrepShip Source of Truth Matrix

## Purpose

PrepShip uses a layered source-of-truth model. The goal is not to make one
table own every fact. The goal is to make each domain explicit about which
external system, PrepShip table, frozen snapshot, or read model is allowed to
own a fact at each stage of the workflow.

Target model:

```text
External source truth
  -> normalized operational truth
    -> frozen side-effect snapshots
      -> reporting/read-model truth
```

Status key:

- `[OK]` clean/current
- `[MIXED]` transitional or mixed ownership
- `[MISSING]` missing or ambiguous ownership
- `[MUST-FIX]` must be fixed before enterprise production

## Current Layering Rules

- External marketplaces and carriers own facts created outside PrepShip.
- PrepShip Postgres owns normalized operational state used by the warehouse.
- Side effects such as labels, selected rates, billing rows, and inventory
  deductions must be snapshotted at action time.
- Reporting, dashboards, and analysis are read models. They must be
  reproducible and refreshable, not mutation owners.
- Caches such as `rate_cache` are performance artifacts. They are not billing
  or audit truth.

## Domain Matrix

### Orders

Status: `[MIXED]`

External source truth:
- ShipStation, Walmart, eBay, Shopify, Amazon, or future store APIs own the
  original marketplace order facts.

Normalized operational truth:
- `orders` is the local normalized order record.
- Source identity fields such as `source_provider`, `source_account_id`,
  `source_order_id`, and `source_order_number` define external provenance.

Frozen/snapshot truth:
- Terminal local workflow decisions such as locally printed labels and terminal
  shipped/cancelled protection are local operational facts.
- Order-level selected-rate overrides are snapshots only until a shipment
  freezes the final selected rate.

Derived/read-model/cache truth:
- Order list APIs, sidebar counts, and dashboard summaries are read models over
  `orders`, `order_items`, and shipment state.

Mutation owner:
- Order sync services and marketplace import routes.
- User-facing order mutation routes only for editable `awaiting_shipment`
  orders.

Read/API owner:
- `src/routes/orders.ts`
- dashboard/analysis/inventory routes for read-only derived views.

Freshness/staleness rules:
- Imported order facts are as fresh as the last successful connector sync.
- Local terminal state must not be overwritten by stale external reads.

Audit/provenance requirements:
- Preserve raw external payloads and source identity.
- Any manual override should record actor, timestamp, and reason where possible.

Never recalc after snapshot:
- Terminal workflow transitions caused by a PrepShip label or human shipped
  action.
- External source identity.

Known gaps:
- Store connector ingestion is not yet the only import path.
- Some code still treats `orders.items` JSONB as reporting input.

Next hardening step:
- Make every new importer write the same source identity fields and normalize
  item data into `order_items`.

### Order Items / SKU Analytics

Status: `[MIXED]`

External source truth:
- Marketplace order line payloads.

Normalized operational truth:
- `order_items` is the target canonical table for SKU, quantity, line total,
  client, store, status, and order date analytics.

Frozen/snapshot truth:
- The order-line state at import/sync time should be preserved for billing,
  pick/pack analysis, SKU velocity, and reporting.

Derived/read-model/cache truth:
- Dashboard SKU trends, analysis modal rows, inventory velocity, and billing
  item counts should read from `order_items` or read models built from it.

Mutation owner:
- `src/services/order-items.ts`
- Import/sync flows that refresh order item rows when order payloads change.

Read/API owner:
- `src/routes/dashboard.ts`
- `src/routes/inventory.ts`
- `src/routes/analysis.ts`
- billing services after migration.

Freshness/staleness rules:
- `order_items` should refresh whenever canonical order items change.
- Reporting caches should record generation window and time.

Audit/provenance requirements:
- Preserve the original raw item payload in `orders.items` for compatibility
  and traceability while using `order_items` for analytics.

Never recalc after snapshot:
- Billing item counts once invoice line items are generated.

Known gaps:
- `orders.items` JSONB is still used in billing, frontend helpers, legacy
  inventory seeding, and some docs.

Next hardening step:
- Move billing/reporting reads off `orders.items` and keep JSONB only as raw
  import compatibility.

### Inventory

Status: `[OK]`

External source truth:
- External stores may provide product/catalog facts, but PrepShip owns local
  warehouse stock once inventory is received or deducted.

Normalized operational truth:
- `inventoryQuantity = SUM(inventory_ledger.qty)` is the only on-hand quantity.
- Product/SKU defaults live on inventory rows where PrepShip manages them.

Frozen/snapshot truth:
- Immutable `inventory_ledger` rows own inventory movement history: receives, deductions,
  returns, corrections, and manual adjustments.

Derived/read-model/cache truth:
- Low-stock alerts, days supply, velocity, and enrichment views are read models.

Mutation owner:
- Inventory routes/services.
- Fulfillment deduction services gated by the inventory auto-deduct kill switch.

Read/API owner:
- `src/routes/inventory.ts`
- Dashboard/reporting APIs for stock summaries.

Freshness/staleness rules:
- Current quantity is derived immediately from committed movement rows; no balance cache exists.
- Velocity and days-supply metrics may lag until reporting refresh.

Audit/provenance requirements:
- Every stock change should have a ledger row with source, order/shipment
  reference when applicable, actor/source, and note.

Never recalc after snapshot:
- Historical ledger quantities and deduction reasons.

Known gaps:
- Some inventory seeding/enrichment still scans `orders.items`.

Next hardening step:
- Use `order_items` and reporting metrics for velocity/enrichment instead of
  raw order JSON scans.

### Rates

Status: `[MIXED]`

External source truth:
- Carrier APIs and ShipStation rate APIs own live quotes at quote time.

Normalized operational truth:
- PrepShip rate service normalizes live results, applies filters, blocked
  services, package rules, and markups for display/selection.

Frozen/snapshot truth:
- `shipments.selectedRateJson` owns the rate selected at label time.
- Order override `bestRateJson` is an editable recommendation/selection before
  label purchase, not final billing truth.

Derived/read-model/cache truth:
- `rate_cache` is a cache only.

Mutation owner:
- `src/services/rates.ts`
- Label purchase flow when freezing the selected rate snapshot.

Read/API owner:
- `src/routes/rates.ts`
- order detail/rate UI through approved rate APIs.

Freshness/staleness rules:
- Cached rate rows expire by cache key/version/time and must not override live
  purchase responses.

Audit/provenance requirements:
- Store provider/account/service details on the selected shipment snapshot.

Never recalc after snapshot:
- Selected label rate, carrier account used, service code, and package selected
  for a purchased label.

Known gaps:
- Imported/direct carrier handlers still exist beside the canonical rate
  service.

Next hardening step:
- Enforce one rate normalization/markup path and keep imported handlers as
  thin compatibility wrappers only.

### Carrier Accounts / Credentials

Status: `[MIXED]`

External source truth:
- Carrier providers own credential validity and account capabilities.

Normalized operational truth:
- `carrier_accounts` owns carrier account records and encrypted/secret
  credential payloads.
- `carrier_account_clients` is the target authoritative account-to-client
  assignment table.

Frozen/snapshot truth:
- Shipment rows should store the provider/account identity used to buy a label.

Derived/read-model/cache truth:
- Settings UI, carrier cards, and capability matrix views are read models over
  carrier accounts and assignments.

Mutation owner:
- Carrier account/settings routes and credential verification flows.

Read/API owner:
- `src/routes/carrier-accounts.ts`
- carrier settings APIs and rate/label credential resolution.

Freshness/staleness rules:
- Credential validity is live/external.
- Assignment state is durable in PrepShip.

Audit/provenance requirements:
- Credential create/update/delete/test/use should be audited without exposing
  secret values.

Never recalc after snapshot:
- Carrier account used for a purchased label or manifest.

Known gaps:
- `clients.ssApiKey`, `clients.ssApiSecret`, `clients.ssApiKeyV2`, and
  `clients.rateSourceClientId` still exist as legacy credential paths.

Next hardening step:
- Implement one credential resolver contract:

```ts
type CarrierCredentialResolution = {
  apiKeyV2: string | null
  carrierAccountId: number | null
  clientId: number | null
  sourceClientId: number | null
  source:
    | 'carrier_account_clients'
    | 'client_rate_source'
    | 'client_legacy'
    | 'env_default'
  warnings: string[]
}
```

The resolver should eventually be used by rates, labels, manifests, carrier
verification, and sync where applicable.

### Labels / Shipments

Status: `[OK]` with `[MIXED]` test/mock compatibility

External source truth:
- The carrier/ShipStation owns live label purchase and tracking confirmation.

Normalized operational truth:
- `shipments` owns PrepShip label/shipment records and marketplace
  confirmation state.

Frozen/snapshot truth:
- Tracking number, label cost, label provider, selected rate, service, package,
  account, label date, and marketplace confirmation event history.

Derived/read-model/cache truth:
- Label PDFs, print queue state, shipment status chips, and analytics are
  derived from durable shipment records and queue state.

Mutation owner:
- `src/services/labels.ts`
- direct carrier label persistence helpers.
- print queue services for queue state.

Read/API owner:
- `src/routes/labels.ts`
- orders route shipment joins.
- print queue APIs.

Freshness/staleness rules:
- DB shipment row is production truth.
- External tracking state can be refreshed later but must not rewrite the
  action-time snapshot.

Audit/provenance requirements:
- Capture provider, account, tracking, cost, selected rate, source, and
  confirmation state without leaking label secrets or customer PII.

Never recalc after snapshot:
- Label cost, selected rate, package used, carrier account used, and tracking
  number for the purchased label.

Known gaps:
- `mock_labels` and in-memory/test label state are valid only for test/dev
  compatibility. Production must not treat in-memory mock state as truth.

Next hardening step:
- Keep explicit naming and guards that separate mock/test label state from
  durable production `shipments` truth.

### Manifests

Status: `[MIXED]`

External source truth:
- Carrier/ShipStation owns official manifest acceptance and closeout state.

Normalized operational truth:
- PrepShip manifest records or manifest API responses should own local manifest
  grouping and operator-visible status.

Frozen/snapshot truth:
- Manifested shipment IDs, carrier/provider/account used, manifest date,
  response IDs, costs if applicable, and closeout result.

Derived/read-model/cache truth:
- Manifest page summary, export rows, and operational reports.

Mutation owner:
- Manifest routes/services.

Read/API owner:
- Manifest UI/API.

Freshness/staleness rules:
- Manifest status should be refreshed from provider only by explicit refresh or
  background job.

Audit/provenance requirements:
- Record who created/closed a manifest, provider response, and shipment set.

Never recalc after snapshot:
- The shipment set included in a closed manifest.

Known gaps:
- Manifest source-of-truth ownership is less documented than rates/labels.

Next hardening step:
- Define manifest tables/status fields and require all manifest flows to store
  provider/account provenance.

### Billing

Status: `[MIXED]`

External source truth:
- No external billing platform currently owns PrepShip billable operations.
- Carrier/provider costs are external facts until captured on shipments.

Normalized operational truth:
- `billing_config` owns billing rules and active billing settings.
- Orders, shipments, packages, inventory ledger, and carrier costs are billing
  inputs.

Frozen/snapshot truth:
- `billing_line_items` should be treated as frozen billable records once
  generated.

Derived/read-model/cache truth:
- Billing previews, summaries, and invoice exports are read models over frozen
  line items and source inputs.

Mutation owner:
- Billing services/routes.

Read/API owner:
- Billing APIs and admin billing UI.

Freshness/staleness rules:
- Draft/previews may be recalculated.
- Generated line items should not drift when source config later changes.

Audit/provenance requirements:
- Generated billable lines should preserve enough description, quantity, unit
  cost, total cost, source shipment/order/package/config, and generation time
  to prove why the charge exists.

Never recalc after snapshot:
- Invoiced billing line item amount, quantity, and source explanation.

Known gaps:
- Billing still reads `orders.items` and reconstructs some charges from live
  source rows.

Next hardening step:
- Move SKU/unit billing inputs to `order_items` and snapshot billing config
  values at line-item generation time.

### Reporting / Dashboard / Analysis

Status: `[MIXED]`

External source truth:
- None. Reporting should consume PrepShip operational truth and external-source
  timestamps.

Normalized operational truth:
- Orders, order items, shipments, inventory, billing, and sync state.

Frozen/snapshot truth:
- Generated reporting artifacts should record input window, filters, job ID,
  generated time, and source version/window.

Derived/read-model/cache truth:
- Reporting metrics, analytics cache, dashboard aggregates, and analysis tables.

Mutation owner:
- Reporting/metrics refresh services and worker jobs.

Read/API owner:
- Dashboard, analysis, and reporting routes.

Freshness/staleness rules:
- Every cached/reporting response should expose freshness or generation time.

Audit/provenance requirements:
- Record date window, client/store filters, source tables/windows, and refresh
  job where applicable.

Never recalc after snapshot:
- Published/exported reporting artifacts unless regenerated with a new artifact
  ID/time.

Known gaps:
- Dashboard/analysis and docs still contain some raw `orders.items` assumptions.

Next hardening step:
- Make reporting metrics/read models the standard API input for dashboard and
  analysis pages.

### Clients / Stores

Status: `[MIXED]`

External source truth:
- Marketplaces and ShipStation own external store IDs and account identifiers.

Normalized operational truth:
- `clients` owns client/customer records.
- Current `clients.storeIds` is a transitional store ownership list.
- Target model should include normalized stores/account mappings.

Frozen/snapshot truth:
- Orders and shipments should store source account/store/provider identity at
  action time.

Derived/read-model/cache truth:
- Sidebar store counts, settings store cards, and assignment chips.

Mutation owner:
- Client/store settings routes and connector account routes.

Read/API owner:
- Init/stores APIs, settings APIs, orders sidebar counts.

Freshness/staleness rules:
- Store assignments are durable PrepShip config.
- External store metadata refreshes only by connector sync or admin action.

Audit/provenance requirements:
- Record store/account assignment changes and source provider identity.

Never recalc after snapshot:
- Source store/account on imported orders and purchased labels.

Known gaps:
- `clients.storeIds` array is not a full enterprise store/account ownership
  model.

Next hardening step:
- Create normalized `stores` and client-store/account mapping model before
  adding more marketplace connectors.

### Sync / Worker State

Status: `[OK]` with operational dependencies

External source truth:
- External APIs own upstream data availability and modified timestamps.

Normalized operational truth:
- Sync settings/watermarks, job queue state, worker status, and advisory locks
  own local sync progress.

Frozen/snapshot truth:
- Sync run results, errors, processed row counts, and recovery/backfill windows.

Derived/read-model/cache truth:
- `/sync/status`, `/worker/status`, UI sync pills, and operational diagnostics.

Mutation owner:
- Sync scheduler, job queue, worker process, and cron/recovery endpoints.

Read/API owner:
- Sync/worker status routes and frontend status components.

Freshness/staleness rules:
- Worker heartbeat and last successful sync must be recent enough for operator
  confidence.
- Watermarks must only advance after durable successful processing.

Audit/provenance requirements:
- Record run mode, account/client scope, since-window, counts, failures, and
  last error without exposing secrets or PII.

Never recalc after snapshot:
- Completed sync run result and watermark advancement reason.

Known gaps:
- Production freshness evidence may require authenticated tokens/operator
  access.

Next hardening step:
- Keep status tooling authenticated and add a redacted signoff artifact for
  production freshness checks.

### Settings / Configuration

Status: `[MIXED]`

External source truth:
- External providers own credential validity and API capabilities.

Normalized operational truth:
- PrepShip settings tables, client config, carrier account config, billing
  config, and environment variables own runtime configuration.

Frozen/snapshot truth:
- Action-time config used for labels, billing lines, inventory deductions, and
  manifests.

Derived/read-model/cache truth:
- Settings UI cards, system status, cache status, and diagnostics.

Mutation owner:
- Settings/admin routes and credential/config services.

Read/API owner:
- Settings routes, init routes, and system status APIs.

Freshness/staleness rules:
- UI status should reflect current persisted config plus live verification
  results where available.

Audit/provenance requirements:
- Config and credential changes should be audited with actor and redacted
  before/after metadata.

Never recalc after snapshot:
- Config values used for frozen billing/label/manifest actions.

Known gaps:
- Some config still lives in legacy client columns or environment-only fallback
  paths.

Next hardening step:
- Define a config precedence resolver per domain and expose provenance in
  diagnostics without exposing secrets.

## Explicit Dual-Truth Areas

### `orders.items` vs `order_items`

Current truth:
- `orders.items` is raw/import compatibility.
- `order_items` is the target canonical item analytics table.

Target truth:
- All SKU analytics, billing item counts, dashboard metrics, picklists, and
  inventory velocity use `order_items`.

Risk if left mixed:
- Different pages can show different quantities, revenue, or SKU velocity.

Safe migration path:
- Keep writing `orders.items`.
- Keep refreshing `order_items`.
- Move read paths domain by domain.
- Add guards so new reporting code does not use raw JSONB directly without a
  temporary whitelist.

Guard/test needed:
- Source-of-truth guard warning for new `orders.items` reporting usage.

### `clients.storeIds` vs Normalized Store Ownership

Current truth:
- `clients.storeIds` is the current assignment mechanism.

Target truth:
- Normalized store/account ownership tables with provider, source account,
  source store ID, client assignment, active/test flags, and sync settings.

Risk if left mixed:
- Store connector identity, order dedupe, sidebar counts, and confirmation
  routing can diverge.

Safe migration path:
- Introduce normalized stores in parallel.
- Backfill from client store IDs.
- Route new connector work through normalized store mappings.

Guard/test needed:
- Guard for new store ownership logic that bypasses the normalized store model
  after it exists.

### Client Credential Fields vs Carrier Account Tables

Current truth:
- `clients.ssApiKey*` and `clients.rateSourceClientId` still serve legacy
  ShipStation credential flows.
- `carrier_accounts` and `carrier_account_clients` are the target account model.

Target truth:
- One credential resolver returns the credential/account assignment with
  provenance.

Risk if left mixed:
- Rates, labels, manifests, and sync can use different accounts for the same
  client/order without clear explanation.

Safe migration path:
- Implement resolver in one place.
- Have all domain services use it.
- Keep legacy client fields only as fallback sources with warnings.

Guard/test needed:
- Guard direct credential lookup patterns outside approved resolver paths.

### Live Rate vs `rate_cache` vs Selected Shipment Rate

Current truth:
- Live provider API is quote truth at fetch time.
- `rate_cache` is a cache.
- `shipments.selectedRateJson` is final action-time selected-rate truth.

Target truth:
- Billing and audit use selected shipment rate, not stale cache.

Risk if left mixed:
- Invoices or reports may change after rates are refetched.

Safe migration path:
- Keep cache for UI speed only.
- Freeze selected rate during label purchase.
- Make billing consume shipment snapshots.

Guard/test needed:
- Guard direct billing use of `rate_cache` as invoice truth.

### Billing Recalculation vs Frozen `billing_line_items`

Current truth:
- Billing can still reconstruct from live orders/items/shipments.
- `billing_line_items` exists as generated billing records.

Target truth:
- Draft previews can recalculate; generated/invoiced line items are frozen.

Risk if left mixed:
- Historical invoices drift when package costs, billing config, rates, or order
  item parsing changes.

Safe migration path:
- Snapshot config and source facts into line items at generation time.
- Treat invoiced rows as immutable except explicit adjustment/credit flows.

Guard/test needed:
- Guard invoiced line item mutation paths and live recalculation used for
  historical invoice totals.

### Reporting Cache vs Operational Tables

Current truth:
- Operational tables own facts.
- Reporting metrics/analytics cache should own prepared read models.

Target truth:
- Dashboard and analysis read from reproducible read models where practical.

Risk if left mixed:
- Pages can duplicate formulas, issue slow queries, or show inconsistent
  numbers.

Safe migration path:
- Move heavy calculations into reporting services.
- Include `generatedAt`, input window, and source filters in cache rows.

Guard/test needed:
- Guard new broad raw order scans in frontend/dashboard paths.

### Mock/In-Memory Labels vs Durable `shipments`

Current truth:
- Mock/test labels are allowed for test mode.
- Durable `shipments` is production label truth.

Target truth:
- In-memory/mock labels are never production source of truth.

Risk if left mixed:
- Production labels can appear missing, duplicate, or unverifiable after process
  restart.

Safe migration path:
- Keep mock code explicitly named and scoped.
- Persist even test labels enough for UI/queue flows.
- Use `shipments` for all production label state.

Guard/test needed:
- Guard production label paths against depending on in-memory label maps.

## Frozen Snapshot Rules

Freeze these at action time:

- selected rate
- carrier account used
- package used
- label cost
- label provider and tracking number
- billed package cost
- billing config values used to generate line items
- inventory deduction reason and quantity
- shipment confirmation status/event history
- manifest shipment set and provider response
- order terminal state transition reason

Live external data can change later. Frozen snapshots remain the proof of what
PrepShip used at the time.

## Guardrail Strategy

The first guard is intentionally warning-oriented. It should:

- fail when this matrix document is missing or loses required sections;
- warn on transitional patterns already present in the repo;
- report likely drift with file path and suggested owner/service;
- stay local and non-destructive;
- require no database credentials or production secrets.

Suggested package script name:

```json
{
  "guard:source-of-truth": "node scripts/source-of-truth-guard.mjs"
}
```

## PS-032 Modular Boundary Matrix

PS-032 defines the boundary PrepShip should preserve before splitting into
Shipping Core, WMS, Billing, Analytics, Client Portal, and Admin/Platform
modules. This is not a broad refactor plan. It is the source-of-truth contract
future refactors must follow.

| Domain/module | Authoritative source of truth | Derived/read-model sources | Cache-only sources | Frozen snapshot sources | Mutation owner | Read owner | Current coupling risks | Target boundary |
|---|---|---|---|---|---|---|---|---|
| Orders / order import | External store order plus normalized `orders` row with source identity fields | Order list APIs, sidebar counts, dashboard summaries | None | Terminal local workflow facts and import provenance | Store connector/order sync services and editable order routes | Orders API, dashboard, analysis, inventory reads | ShipStation-first sync still exists; raw payload/prefix inference can leak into new logic | `shipping-core` import boundary with connector-first identity |
| Order items | `order_items` canonical line-level truth | SKU analytics, billing previews, dashboard SKU metrics | None | Imported line facts at sync time; billed line copies after generation | Normalized persistence and order item service | Dashboard, inventory, analysis, billing | `orders.items` is still used by billing, analysis, inventory seeding, and frontend compatibility | `shipping-core` writes canonical items; `billing` and `analytics` consume read models |
| Shipping selections / order overrides | `order_overrides` and editable shipping fields before label creation | Rate browser DTOs and order detail display | None | Final selected rate/package/account on `shipments` | Shipping/rate/order override services | Orders UI and label routes | Pre-label selected rate can be mistaken for final billing truth | `shipping-core` owns selections until shipment snapshot |
| Rates / rate cache | Live carrier or ShipStation quote response at request time | Rate browser display and diagnostics | `rate_cache` only | `shipments.selectedRateJson` after label purchase | Rate service and label purchase flow | Rate routes and Orders UI | Billing must not read cache as invoice/audit truth | `shipping-core`; cache remains performance-only |
| Labels / shipments | `shipments` durable label, tracking, carrier, cost, and provider account snapshot | Reprint, tracking, billing, manifest, reporting views | Mock/test label stores only in non-production flows | Shipment row itself | Label service and shipment sync | Orders, print queue, billing, marketplace confirmation | Shipping label creation currently triggers WMS deductions directly | `shipping-core` emits shipment events; WMS/Billing consume |
| Print queue | `print_queue_orders` active/printed/removed status in DB | Queue drawer grouping and history view | None | Queue status transitions and print confirmation timestamps | Print queue service/routes | Orders UI print queue drawer | Frontend must never be queue source of truth | `shipping-core` print workflow |
| Marketplace confirmation / outbox | `fulfillment_outbox` plus shipment confirmation status fields | Marketplace status/retry UI | None | Provider response/status history at processing time | Fulfillment outbox service and store confirmation connectors | Orders/ops status views | Unsupported providers need explicit not-supported state, not silent success | `shipping-core` event/outbox boundary |
| Inventory | `inventory` SKU/config row plus ledger-derived `inventoryQuantity` | Stock tables, low/out badges, receiving UI | None | Ledger entries for each stock movement | WMS inventory movement owner/routes | Inventory UI, reporting, billing read models | Shipping services still call fulfillment deductions directly | `wms` event consumer; Shipping emits shipment/deduction intent |
| Inventory ledger | Immutable `inventory_ledger` signed movement history | History panel, discrepancy reports, storage billing inputs | None | Ledger row with client/SKU/source/effective/posted/actor/reason identity | `src/services/inventory-movement.ts` | Inventory history, billing/reporting | Historical repair scripts must emit reviewed append-only reversals | `wms` immutable movement log |
| Inventory balance / read model | `SUM(inventory_ledger.qty)` exposed only as `inventoryQuantity` | Stock-level table, dashboard counts, alerts | Reporting caches may store velocity, never a competing balance | Ledger history remains proof | `src/services/inventory-stock-math.ts` | Inventory/dashboard/analytics/Client Portal | Missing history is reported, never replaced by order/cache fallback | `wms` owns the ledger projection; others render it |
| Products / SKU defaults | `products` canonical SKU defaults; `product_defaults` compatibility/read model | Inventory/product forms and defaults display | None | Defaults copied into order/shipment/billing snapshots when used | Product/WMS services | Inventory, products, rate/package helpers | Product route mirrors into `product_defaults`; dual writes need a single service | `wms` product catalog boundary |
| Packages / package stock | Package catalog/package stock tables and package ledger where applicable | Package UI and shipping package choices | None | Package choice frozen on shipment; package movement ledger | WMS package service and shipping package selection service | Packages UI, Orders rate/label UI | Label creation can deduct package stock directly | `wms` owns stock; `shipping-core` owns chosen package snapshot |
| Billing config | Billing config/rate tables | Billing preview DTOs | None | Billing config copied into generated line items/invoices | Billing service/routes | Billing UI and exports | Billing reads across live domains and raw order JSON in places | `billing` module consumes stable read models/snapshots |
| Billing line items / invoices | `billing_line_items` and invoice records after generation | Billing summaries, invoice UI, exports | None | Generated invoice/line-item rows are frozen unless adjusted | Billing generation/adjustment services | Billing UI/admin exports | Recalculating historical invoices from live orders can drift | `billing` frozen financial snapshot boundary |
| Analytics / reporting / dashboard | Operational tables plus generated reporting projections | Dashboard cards, analysis tables, reporting metrics | Reporting caches only with `generatedAt` and window | None unless reports are explicitly exported/finalized | Reporting refresh services | Dashboard/analysis UI | Duplicate formulas in routes/frontend can diverge or slow production | `analytics` projections/read models |
| Clients / stores / accounts | Clients, stores/accounts, carrier account assignment, credentials resolver | Sidebar counts, filters, store/client selectors | None | Shipment/provider account snapshots and audit records | Admin/platform account services and credential resolver | Shipping, sync, billing, dashboard | Legacy client ShipStation credential fields coexist with carrier account tables | `admin/platform` owns identity/credentials; modules consume resolver |
| Frontend / app shell / module entitlements | Backend APIs and entitlement decisions | Sidebar/routes/buttons and local UI state | Browser state only for UX | None | App shell and backend entitlement services | Operators/admin users | Sidebar hiding is not an API authorization boundary; large views contain business logic | `client-portal` owns UI intent; backend modules own business truth |

## Dependency Classification

Correct dependencies:
- Shipping reads orders, order items, selected package/rate state, carrier
  credentials through approved services, and writes durable shipments and print
  queue/outbox records.
- WMS reads shipment/order events to maintain inventory and package stock.
- Billing reads shipment snapshots, billing config, order item read models, and
  inventory/package movement snapshots.
- Analytics reads operational tables or reporting projections, never mutates
  shipping/WMS/billing truth.

Risky/tangled dependencies:
- `src/services/labels.ts` imports `src/services/fulfillment-deductions.ts`.
  Shipping label creation therefore directly invokes WMS inventory/package
  deduction instead of emitting an event that WMS consumes.
- `src/services/order-sync.ts`, `src/services/shipment-sync.ts`, and
  `src/routes/orders.ts` also call fulfillment deductions. These remain
  protected by `INVENTORY_AUTO_DEDUCT`, but they are still cross-module
  coupling.
- `src/services/billing.ts`, `src/routes/analysis.ts`,
  `src/routes/inventory.ts`, `web/src/lib/v2-apiClient.ts`, and some frontend
  views still reference raw `orders.items` compatibility data.
- `src/routes/analysis.ts` contains route-time `ALTER TABLE` compatibility DDL.
  Schema changes should live in migrations/scripts, not request handlers.
- `src/routes/products.ts` mirrors product data into `product_defaults`.
  Product defaults need one WMS service boundary that owns both current and
  compatibility writes.

Should become event consumers:
- Inventory deductions and package stock deductions should consume shipment
  events from Shipping Core.
- Billing line item generation should consume shipment/order item/package
  snapshots and billing config snapshots.
- Dashboard and analysis should consume reporting projections.
- Marketplace confirmation should consume shipment-created events through
  capability-aware store connectors.

Should become backend service boundaries:
- Label purchase, queue/reprint, rate selection, marketplace confirmation,
  inventory receive/deduct/adjust, billing generation, product defaults,
  package stock, and reporting refresh.
- Frontend components should send operator intent and render API responses;
  they should not compute invoice truth, stock truth, or provider state.

Should become read models/projections:
- Dashboard KPIs and trend charts.
- Analysis tables and billing previews where expensive joins are needed.
- Inventory balance/velocity/day-supply calculations.
- Client/store/sidebar counts.

Should be cache-only:
- `rate_cache`, browser query caches, and any temporary API memoization.
- Cache rows must not be used as billing, audit, shipment, inventory, or
  marketplace confirmation truth.

Should be frozen snapshots:
- `shipments` selected rate, carrier account, label provider, tracking, package,
  cost, and provider response summary.
- `billing_line_items` and invoice rows after generation.
- `inventory_ledger` movement rows.
- Print queue printed/removed confirmation events.
- Fulfillment outbox attempts and provider confirmation status history.

## Target Module Boundaries

### shipping-core

Owns:
- order import/normalization for Shipping users;
- rates, selected rate/order override workflow, label purchase, shipments;
- print queue, reprint/retrieve label, manifests where applicable;
- marketplace confirmation outbox and connector dispatch;
- carrier account selection through the platform credential resolver.

Consumes:
- client/store/account assignments from Admin/Platform;
- WMS package/product defaults when enabled;
- billing eligibility/config read APIs only when displaying billing-adjacent
  shipping information.

Does not own:
- inventory balance, product catalog maintenance, billing invoice truth, or
  dashboard formulas.

### wms

Owns:
- inventory, inventory ledger, stock balance/read model, receiving, adjustments;
- product/SKU defaults and package/package-stock lifecycle;
- WMS-specific analytics inputs such as velocity and days supply.

Consumes:
- shipment/order events emitted by Shipping Core.

Does not own:
- label purchase, carrier credentials, marketplace confirmation, or invoice
  finalization.

### billing

Owns:
- billing config, billing preview/generation services, billing line items,
  invoices, credits, and adjustments.

Consumes:
- shipment snapshots, order item read models, package/stock movement snapshots,
  and frozen billing config copies.

Does not own:
- live rate cache, live order mutation, inventory mutation, or shipping labels.

### analytics

Owns:
- reporting projections, dashboard/analysis read models, refresh cadence, and
  generated-at/window metadata.

Consumes:
- operational events/tables from Shipping Core, WMS, Billing, and Platform.

Does not own:
- operational mutation of orders, labels, inventory, billing, credentials, or
  marketplace confirmations.

### client-portal

Owns:
- UI routes, form state, local filters, operator intent, and presentation
  components.

Consumes:
- backend APIs and feature entitlement responses.

Does not own:
- business truth, invoice truth, stock truth, credential truth, or shipment
  truth. Sidebar hiding is not sufficient authorization.

### admin/platform

Owns:
- clients, stores/accounts, users, roles/RBAC, module entitlements, credential
  governance, audit policy, and service configuration.

Consumes:
- status/read models from other modules for admin operations.

Does not own:
- domain-specific shipment, inventory, billing, or analytics calculations except
  through admin-safe orchestration.

## Non-Negotiable Architecture Rules

- Frontend owns UI state and operator intent only; backend owns business truth.
- `rate_cache` cannot be billing/audit truth.
- `shipments` owns label/tracking/cost snapshots.
- `order_items` should be canonical item-level truth for analytics/billing where
  possible; raw `orders.items` is compatibility/fallback unless documented.
- Inventory display, billing, and analytics should read one balance/read model,
  not recalculate stock differently per page.
- Shipping can emit events; WMS, Billing, and Analytics respond if enabled.
  Shipping should not require WMS to be enabled.
- Billing/invoices need frozen generated snapshots. Finalized billing should
  not silently change when upstream data changes.
- Module visibility and API access must eventually be controlled by feature
  entitlements, not only sidebar hiding.
- Shipped/cancelled lockdown, client/store scope, RBAC, credential redaction,
  label safety, and financial redaction are architectural constraints, not UI
  preferences.

## PS-032 Confirmed Coupling Risks

- Shipping -> WMS deduction coupling:
  `src/services/labels.ts`, `src/services/order-sync.ts`,
  `src/services/shipment-sync.ts`, and `src/routes/orders.ts` invoke
  `src/services/fulfillment-deductions.ts`. The kill switch is correct, but the
  target boundary is a WMS event consumer.
- Raw order JSON compatibility:
  `src/services/billing.ts`, `src/routes/analysis.ts`,
  `src/routes/inventory.ts`, `web/src/lib/v2-apiClient.ts`, and frontend views
  still use `orders.items`. This is allowed temporarily but should not expand.
- Route-time schema DDL:
  `src/routes/analysis.ts` has `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  compatibility logic. Future schema changes should be migrations or explicit
  maintenance scripts.
- Product defaults dual-write:
  `src/routes/products.ts` mirrors into `product_defaults`. The target is one
  WMS product-defaults service that owns canonical and compatibility writes.
- Reporting formula duplication:
  Dashboard/analysis/frontend text and route queries still encode business
  formulas. The target is analytics read models with documented formulas and
  generation windows.

## PS-032 Follow-Up Recommendations

P0:
- Extract a Shipping -> WMS event contract for shipment-created, shipment-voided,
  inventory-deduction-requested, and package-deduction-requested.
- Add a no-production-backdoor entitlement model so module access is enforced by
  backend APIs, not only sidebar visibility.

P1:
- Move billing SKU/unit reads from raw `orders.items` to `order_items` or frozen
  billing snapshots.
- Move analysis route-time DDL into migrations/maintenance scripts.
- Create one WMS product-defaults service for `products`, `product_defaults`,
  and inventory default synchronization.

P2:
- Promote dashboard/analysis calculations into reporting projections.
- Add module-boundary guards for new frontend financial/stock truth
  calculations.
- Stage connector-first order import behind existing ShipStation-compatible
  flows.

## Recommended Follow-Up Tasks

- Implement the carrier credential resolver contract and migrate rates/labels
  first.
- Migrate billing SKU/unit reads from `orders.items` to `order_items`.
- Define normalized stores/account ownership tables before adding more direct
  marketplace ingestion.
- Make reporting metrics the standard dashboard/analysis input.
- Add immutable adjustment/credit flows for any future billing corrections.
