# PS-032 Connector Architecture

Date: 2026-05-28

Status: Closeout architecture reference for the PS-032 connector boundary.

## Boundary Model

Store/order operations:

```text
PrepShip routes/services/schedulers
  -> StoreConnector orchestrator
  -> resolved StoreConnector
  -> provider store API
  -> normalized orders/status/store values
  -> PrepShip persistence and UI
```

Carrier/rate/label operations:

```text
PrepShip routes/services/UI workflows
  -> CarrierConnector orchestrator
  -> resolved CarrierConnector
  -> provider carrier API
  -> normalized rates/labels/tracking/void values
  -> PrepShip persistence, print queue, and UI
```

Marketplace confirmation:

```text
PrepShip fulfillment_outbox
  -> StoreConnector.confirmShipment
  -> provider marketplace confirmation API
  -> normalized confirmation result
  -> retry-safe local outbox state
```

## Current Reality

- PrepShip uses `StoreConnector`, not a separate `OrderConnector`, as the order/store abstraction.
- ShipStation is still an important practical source because many stores are connected inside ShipStation, but the main PrepShip order sync path now reaches ShipStation through the ShipStation StoreConnector.
- Walmart and eBay import routes are compatibility HTTP wrappers. They do not own marketplace API calls; they call StoreConnector orchestration.
- Carrier rates, labels, account listing, verification, tracking, and related diagnostics route through CarrierConnector orchestration.
- API routes and services may still own auth, RBAC, account lookup, local order context, persistence, response shaping, and safety checks. They must not own provider API calls or provider payload normalization.
- Low-level provider wrappers under `src/lib/*` are allowed only when called by connector-owned code.

## Normalized Outputs

Store connectors normalize provider-specific orders into PrepShip values such as:

- `sourceProvider`
- `sourceAccountId`
- `sourceOrderId`
- `sourceOrderNumber`
- marketplace/store identity
- canonical status
- order date
- customer/address fields
- items
- totals and shipping paid
- safe raw reference or redacted payload metadata

Carrier connectors normalize provider-specific carrier responses into PrepShip values such as:

- provider and provider account identity
- carrier and service codes/names
- rate cost and currency
- tracking number
- label URL or label base64 plus label format
- void/tracking capability flags
- safe diagnostics and redacted metadata

## New Walmart User Walkthrough

1. User adds Walmart API credentials.
2. PrepShip stores the Walmart account credentials and store/provider identity.
3. Store sync calls the StoreConnector orchestrator for Walmart.
4. The Walmart StoreConnector calls Walmart Marketplace APIs, normalizes orders, and returns standardized order values.
5. PrepShip persistence writes `store_orders` and canonical `orders` from the normalized output.
6. User sees Walmart orders in the normal order UI.
7. User buys or prints a label through the selected CarrierConnector.
8. PrepShip writes shipment, label, tracking, and print queue state from normalized carrier output.
9. `fulfillment_outbox` queues marketplace confirmation.
10. The outbox resolves the Walmart StoreConnector and calls `confirmShipment`.
11. Walmart receives tracking/ship confirmation, and PrepShip stores the normalized confirmation result.

## Compatibility Wrappers

Compatibility routes may remain for existing URLs and UI workflows as long as they are thin wrappers. A wrapper is acceptable when it only handles:

- authentication and RBAC
- CORS/OPTIONS behavior
- request validation
- local account or order-context lookup
- PrepShip persistence
- response shaping
- safe error redaction

A wrapper is not acceptable if it calls provider APIs directly, parses provider-specific response bodies, mints provider tokens outside connector-owned code, or bypasses StoreConnector/CarrierConnector orchestration.
