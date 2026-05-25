# PS-031 Store Connector Source of Truth Plan

Status: Connector-first persistence staged behind the existing ShipStation sync, plus architecture safeguards.

## Source-of-Truth Matrix

| Layer | Authoritative data | Derived / compatibility data | Owner |
| --- | --- | --- | --- |
| External stores | Shopify, Amazon, Walmart, eBay, TikTok, WooCommerce, or ShipStation-as-store order APIs | Provider raw payloads | Store connector |
| Operational orders | `orders` plus `order_items` keyed by `source_provider`, `source_account_id`, `source_order_id` | `orders.external_order_id`, `orders.raw`, `orders.items`, legacy `store_id` | Store order ingestion service |
| SKU analytics | `order_items` | `orders.items` raw import compatibility | `src/services/order-items.ts` |
| Label/shipment side effects | `shipments` frozen rate, label, carrier, tracking, cost, and marketplace confirmation snapshots | Provider raw label/rate payloads in selected-rate JSON | Label/carrier services |
| Marketplace confirmation side effects | `fulfillment_outbox` and `shipments.confirmation_*` | UI status summaries | Fulfillment outbox worker |
| Carrier credentials/accounts | `carrier_accounts` and `carrier_account_clients`; legacy client ShipStation keys remain compatibility input | `clients.ss_*` fields | Carrier account resolver |
| Reporting/analytics | Reporting cache tables and dashboard aggregates | Operational tables queried directly where no cache exists | Reporting refresh jobs |

Raw JSON is never the hidden authoritative source for new logic. It is compatibility/debug evidence only.

## Mutation Ownership

- Store connectors own normalization from external order payloads into provider-agnostic order source identity.
- `orders` owns current operational status and customer/shipping fields used by the Orders UI.
- `order_items` owns SKU/item facts used by inventory, billing, dashboard, and analysis flows.
- Carrier/rate services own selected-rate metadata and must preserve upstream provider, actual carrier, account id, account nickname, service, and cost context.
- Label services own `shipments` rows as frozen side-effect records.
- Fulfillment outbox owns marketplace confirmation state transitions: `pending`, `processing`, `succeeded`, `failed`, `not_required`, and `not_supported`.

## ShipStation Compatibility

Current production order import remains ShipStation-first through `syncOrders({})` while PS-031 stages the abstraction. ShipStation continues to work as a store connector and as a carrier connector. Existing DR Prepper / KF Goods flows continue using the same ShipStation V1 order import, V2 rate/label, shipment sync, print queue, and marketplace confirmation paths.

Implemented now:

- Centralize normalized source identity construction so ShipStation uses the same helper future store connectors will use.
- Route ShipStation order persistence through a provider-agnostic `store-order-import` service that writes `orders` plus `order_items`.
- Treat unsupported marketplace confirmation as explicit `not_supported` instead of successful/not-required.
- Add guards proving carrier account identity fields remain visible and distinct.

Future migration:

- Move scheduler account discovery behind a provider-agnostic store order sync orchestrator.
- Add live import implementations for Shopify/Amazon/TikTok/WooCommerce only after credentials, paging, rate limits, and status mapping are specified.
- Add DB uniqueness enforcement on `(source_provider, source_account_id, source_order_id)` only after historical duplicate analysis.

## Non-ShipStation Connector Path

Non-ShipStation imports should call a store connector that returns a normalized source order with:

- `sourceProvider`
- `sourceAccountId`
- `sourceOrderId`
- `sourceOrderNumber`
- `canonicalStatus`
- item data for `order_items`
- raw payload retained only as compatibility/debug evidence

The upsert target must be long-term source identity, not inferred prefixes in `externalOrderId`. `externalOrderId` remains backward compatibility for existing ShipStation rows and old UI assumptions.

## Carrier Account Differentiation

ShipStation is an upstream carrier aggregator, not a single carrier account. A selected ShipStation rate must preserve:

- upstream label/rate provider: `shipstation`
- actual carrier: USPS, UPS, FedEx, etc.
- ShipStation carrier account id / provider account id
- account nickname/display label when available
- service code/name
- selected-rate JSON and label cost context

Existing fields are sufficient for the first safeguard:

- `shipments.providerAccountId`
- `shipments.providerAccountNickname`
- `shipments.carrierProvider`
- `shipments.carrierAccountId`
- `shipments.labelProviderKey`
- `shipments.selectedRateJson`
- `order_overrides.bestRateJson`

If later testing proves any one of these is missing in a live flow, add the smallest migration rather than collapsing accounts into a generic ShipStation bucket.

## Safe Implementation Plan

1. Add a provider-agnostic normalized order source helper and make the ShipStation helper delegate to it.
2. Keep existing ShipStation order sync behavior intact.
3. Change fulfillment enqueue logic to ask the store connector resolver whether `shipment.confirm` is supported.
4. Mark registered-but-not-live or unknown confirmation providers as `not_supported`, not `not_required`.
5. Add a guard proving the plan, helper, and outbox status behavior exist.
6. Run the full required certification set before claiming completion.

## Verification Plan

Minimum commands:

- `npm run typecheck`
- `npm run test:store-connector-source`
- `npm run test:connector-registry`
- `npm run test:connector-architecture`
- `npm run guard:source-of-truth`
- `npm run test:client-store-scope`
- `npm run test:label-shipment-scope-review`
- `npm run test:direct-carrier-labels`
- `npm run test:rate-system-hardening`
- `npm run test:ebay-confirmation:mocked`
- `npm run test:walmart-confirmation:payload`
- `npm run test:marketplace-reconciliation`
- `npm run test:print-queue-client-scope`
- `npm run test:print-queue-ownership`
- `npm run test:print-queue-persistence`
- `npm run test:orders-ux`
- `npm run test:test-order-queue-label`
- `npm run test:api-contracts`
- `npm run test:full-site-certification`

Automated tests must use mocked/offline fixtures only. No real postage, marketplace notifications, live order mutations, shipped/cancelled mutations, raw labels, credentials, or customer PII are allowed.
