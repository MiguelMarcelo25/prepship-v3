# Shopify to PrepShip Connection Walkthrough

Last updated: 2026-07-07

## Goal

Connect Shopify as a PrepShip store source so unfulfilled Shopify orders can be
pulled into Awaiting Shipment, labels can be purchased/printed in PrepShip, and
tracking can be pushed back to Shopify as a fulfillment after shipment.

Shopify is the store/order source, not the shipping carrier. Rates and labels
still come from PrepShip carrier accounts such as USPS, UPS, Shipp, EasyPost,
or ShipStation.

## Current Store

- Shopify admin URL: `https://admin.shopify.com/store/kf-goodies-2/markets`
- Shopify shop domain for PrepShip: `kf-goodies-2.myshopify.com`

Use the `.myshopify.com` domain in PrepShip. PrepShip also accepts the Shopify
admin store URL and normalizes it to the `.myshopify.com` domain.

## Shopify App Setup

1. In the Shopify Dev Dashboard, create or open the `PrepShip` app.
2. Set App URL to `https://prepshipv4.vercel.app`.
3. Add these Admin API scopes:

```text
read_orders
read_products
read_locations
read_fulfillments
write_fulfillments
read_merchant_managed_fulfillment_orders
write_merchant_managed_fulfillment_orders
```

4. Release the app version.
5. Install the app on the Shopify store.
6. Copy the Client ID and Secret from the Dev Dashboard Settings page.

Keep the secret private. PrepShip exchanges the Client ID and Secret on the
backend for a short-lived Shopify Admin API token before each Shopify API call.
If you previously pasted the Secret into the legacy Admin API Access Token
field, reconnect the store and put it in Client Secret instead.

## PrepShip Setup

1. Open PrepShip Settings.
2. Go to store integrations.
3. Add or edit Shopify.
4. Enter:

```text
Shop Domain: kf-goodies-2.myshopify.com
Client ID: <Shopify Dev Dashboard Client ID>
Client Secret: <Shopify Dev Dashboard Secret>
API Version: 2026-07
```

5. Click `Test Connection`.
6. Click `Pull Orders`.

The Test Connection button exchanges the Client ID and Secret for a Shopify
Admin API token, then reads Shopify `/shop.json`. It should show the shop
identity when the credentials and scopes are valid.

## What PrepShip Now Does

```text
Shopify unfulfilled order
  -> Settings Pull Orders calls the Render API
  -> Shopify connector fetches Admin API /orders.json
  -> connector normalizes order identity, recipient, totals, items, and weight
  -> backend upserts store_orders and canonical orders
  -> Awaiting Shipment can rate, print, and queue labels
  -> after label creation, fulfillment outbox can create Shopify fulfillment
```

The backend owns the Shopify business truth. The frontend only sends the user
intent to pull orders.

## Webhook

When Shopify webhooks are enabled, point Shopify at:

```text
https://prepshipv4-api-l5xc.onrender.com/webhooks/shopify
```

Recommended events:

```text
orders/create
orders/updated
orders/cancelled
fulfillments/create
```

Set this Render API environment variable:

```text
SHOPIFY_WEBHOOK_SECRET=<shopify webhook secret>
```

Without `SHOPIFY_WEBHOOK_SECRET`, PrepShip rejects Shopify webhooks by design.

## Safe Test Plan

1. Create one low-risk Shopify test order.
2. Click `Test Connection` in PrepShip.
3. Click `Pull Orders`.
4. Confirm the order appears once in Awaiting Shipment.
5. Print a test/low-risk label path first.
6. Confirm Shopify receives tracking/fulfillment.
7. Confirm the order no longer remains in Awaiting Shipment after fulfillment
   status sync/webhook evidence.
