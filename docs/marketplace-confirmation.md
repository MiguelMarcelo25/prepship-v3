# Marketplace Confirmation

PrepShip separates label creation from marketplace shipment confirmation. A carrier label can be created successfully while eBay, Walmart, or a sales channel still has not been marked shipped.

## Supported Providers

- `shipstation`: confirms via ShipStation fulfillment/mark-shipped behavior when configured.
- `walmart`: confirms through Walmart Ship Order Lines.
- `ebay`: confirms through eBay Sell Fulfillment `createShippingFulfillment`.

## eBay Requirements

eBay confirmation requires:

- store account credentials with `appId`, `certId`, and `refreshToken`
- OAuth scope `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
- eBay order ID
- one or more `lineItems` with `lineItemId`
- carrier code
- tracking number
- shipped date

The connector must never log OAuth tokens, raw eBay payloads with buyer PII, raw customer addresses, or credentials. Errors are normalized and redacted before they are stored in `fulfillment_outbox.last_error` or `shipments.confirmation_last_error`.

## Retry Behavior

- Missing credentials, missing order ID, missing line items, and missing tracking are non-retryable until data is fixed.
- HTTP 429 and 5xx errors are retryable.
- eBay "already fulfilled" / duplicate fulfillment conflicts are treated as safe success so retries do not create harmful duplicate side effects.

## Recovery

Use `npm run smoke:marketplace-confirm -- --order-id <id>` to inspect current state. Live marketplace processing is not automated; any live-order recovery must be coordinated with DJ.
