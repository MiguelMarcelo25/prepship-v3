# PrepShip Shipping Production Audit

Status: PS-016 foundation. Client portal work is pending while PrepShip shipping reliability is certified.

## Live-System Safety

- Automated tests must not create actual shipping labels.
- Automated tests must not buy postage.
- Automated tests must not send real marketplace notifications.
- Automated tests must not touch, mutate, mark shipped, cancel, update, or otherwise modify live orders.
- Live-order testing is manual only with DJ present and approving the exact order and test.
- Default tests must be mocked, offline, fixture-based, sandbox, or read-only diagnostic mode.

## Current Configuration Surfaces

PrepShip separates shipping carriers from marketplace stores:

- Carrier accounts: `carrier_accounts`, used for label/rate providers such as ShipStation and Walmart Shipping.
- Store accounts: `store_accounts`, used for marketplace sources such as Walmart and eBay.
- Canonical order state: `orders`.
- Durable label/shipment records: `shipments`.
- Marketplace confirmation retries: `fulfillment_outbox`.
- Print queue state: `print_queue`.

Configuration audit should report only safe facts: provider, active flag, client/store mapping, account label, account identifier presence, credential presence booleans, and capability status. It must not print credentials, auth headers, raw labels, raw provider payloads, customer addresses, phone numbers, or full customer emails.

## Current PrepShip Flow

1. Operator clicks Print Label / Create + Print Label / queue action.
2. Frontend calls the PrepShip label or print queue route.
3. Backend loads order, validates no active non-void label, resolves carrier/rate/account, and calls label provider.
4. Backend persists `shipments`, updates `orders.order_status`, and writes tracking.
5. Backend enqueues marketplace confirmation in `fulfillment_outbox` when needed.
6. Worker/outbox processor calls the store connector and updates `shipments.confirmation_status`, `marketplace_confirmed_at`, and `orders.canonical_status`.
7. UI opens/reprints label PDF and refreshes visible status.

Known current risks:

- A DB/API timeout can leave the UI stuck at "Creating label PDF..." until the request settles.
- Duplicate active labels are money-moving risk and must be refused by preflight and smoke tools.
- Static guards do not prove carrier label creation, DB persistence, marketplace confirmation, or UI state recovery.
- eBay had a registered connector slot but the shipment confirmation implementation was missing before PS-018.
- Walmart confirmation payload must stay aligned to Walmart's Ship Order Lines API.

## Official Payload References

### ShipStation V1 Mark Order Shipped

Endpoint: `POST https://ssapi.shipstation.com/orders/markasshipped`

```json
{
  "orderId": 93348442,
  "carrierCode": "usps",
  "shipDate": "2026-05-22",
  "trackingNumber": "9400111899223856789012",
  "notifyCustomer": true,
  "notifySalesChannel": true
}
```

`notifyCustomer` controls ShipStation customer notification. `notifySalesChannel` controls marketplace/sales-channel notification.

### ShipStation V2 Create Fulfillments

Endpoint: `POST https://api.shipstation.com/v2/fulfillments`

```json
{
  "fulfillments": [
    {
      "shipment_id": "se-12345678",
      "tracking_number": "1Z12345E1234567890",
      "carrier_code": "ups",
      "ship_date": "2026-05-22T10:00:00Z",
      "notify_customer": true,
      "notify_order_source": true
    }
  ]
}
```

`notify_customer` controls customer email. `notify_order_source` controls marketplace/order source notification.

### eBay Sell Fulfillment

Endpoint: `POST https://api.ebay.com/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment`

```json
{
  "lineItems": [
    {
      "lineItemId": "10022463512345",
      "quantity": 1
    }
  ],
  "shippedDate": "2026-05-22T10:00:00.000Z",
  "shippingCarrierCode": "USPS",
  "trackingNumber": "9400111899223856789012"
}
```

`lineItems.lineItemId` is required and must come from the eBay order. `shippingCarrierCode` and `trackingNumber` are mutually dependent. eBay uses this fulfillment to expose shipped/tracking state to the buyer.

### Walmart Ship Order Lines

Endpoint: `POST https://marketplace.walmartapis.com/v3/orders/{purchaseOrderId}/shipping`

```json
{
  "orderLines": [
    {
      "lineNumber": "1",
      "trackingInfo": {
        "shipDateTime": "1779465600000",
        "carrierName": "USPS",
        "methodCode": "VALUE",
        "trackingNumber": "9400111899223856789012",
        "trackingURL": "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856789012"
      }
    }
  ]
}
```

Walmart requires `purchaseOrderId` in the path and access/correlation/service headers. PrepShip must retain the original Walmart order lines so the correct `lineNumber` values are shipped.

## Go/No-Go Checklist

- Read-only inspector identifies provider, status, client/store, active shipment, outbox state, and retry safety.
- Preflight refuses shipped/cancelled orders and duplicate active labels.
- Fixture label smoke proves the local state-machine expectations without buying postage.
- Marketplace smoke reports pending/succeeded/failed/not_required/unsupported explicitly.
- eBay connector passes mocked success, missing credentials, missing tracking, missing line items, already fulfilled, and retryable failure tests.
- Site action tests cover Print Label, Reprint Label, Send to Queue, Print Queue, batch print, inventory, packages, clients, auth, and failure states in mocked mode.
- No automated workflow touches live orders or creates real postage.

Sources: ShipStation Mark as Shipped, ShipStation V2 Fulfillments, eBay createShippingFulfillment, Walmart Ship Order Lines.
