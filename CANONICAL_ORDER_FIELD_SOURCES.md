# Canonical Order Field Sources

The Orders API returns a `canonicalOrder` object. Each row also includes
`canonicalOrder.sourceMap`, which records the actual source used for that row
and whether the original ShipStation data came from API v1, API v2, local
PrepShip data, or a derived fallback.

## Order Fields

| Canonical field | Primary source | Version |
| --- | --- | --- |
| `canonicalOrder.orderId` | `orders.id` | local |
| `canonicalOrder.externalOrderId` | ShipStation `/orders.orderId` stored as `orders.external_order_id` | v1 |
| `canonicalOrder.orderNumber` | ShipStation `/orders.orderNumber` stored as `orders.order_number` | v1 |
| `canonicalOrder.orderStatus` | ShipStation `/orders.orderStatus` stored as `orders.order_status` | v1 |
| `canonicalOrder.orderDate` | ShipStation `/orders.orderDate` stored as `orders.order_date` | v1 |
| `canonicalOrder.createdAt` | PrepShip order row timestamp `orders.created_at` | local |
| `canonicalOrder.updatedAt` | PrepShip order row timestamp `orders.updated_at` | local |
| `canonicalOrder.client.id` | PrepShip client mapping stored as `orders.client_id` | local |
| `canonicalOrder.client.legacyId` | Legacy client id map from store/client id | derived |
| `canonicalOrder.client.storeId` | ShipStation `/orders.advancedOptions.storeId` stored as `orders.store_id` | v1 |
| `canonicalOrder.customer.email` | ShipStation `/orders.customerEmail` stored as `orders.customer_email` | v1 |
| `canonicalOrder.customer.username` | ShipStation `/orders.customerUsername` stored in `orders.raw` | v1 |

## Recipient Fields

| Canonical field | Primary source | Version |
| --- | --- | --- |
| `canonicalOrder.recipient.name` | `orders.raw.shipTo.name`, fallback `orders.ship_to_name` | v1/local |
| `canonicalOrder.recipient.company` | `orders.raw.shipTo.company` | v1 |
| `canonicalOrder.recipient.street1` | `orders.raw.shipTo.street1` | v1 |
| `canonicalOrder.recipient.street2` | `orders.raw.shipTo.street2` | v1 |
| `canonicalOrder.recipient.city` | `orders.raw.shipTo.city`, fallback `orders.ship_to_city` | v1/local |
| `canonicalOrder.recipient.state` | `orders.raw.shipTo.state`, fallback `orders.ship_to_state` | v1/local |
| `canonicalOrder.recipient.postalCode` | `orders.raw.shipTo.postalCode`, fallback `orders.ship_to_postal_code` | v1/local |
| `canonicalOrder.recipient.country` | `orders.raw.shipTo.country`, fallback `US` | v1/derived |
| `canonicalOrder.recipient.phone` | `orders.raw.shipTo.phone` | v1 |
| `canonicalOrder.recipient.residential` | `order_overrides.residential`, fallback `orders.raw.shipTo.residential` | local/v1 |
| `canonicalOrder.recipient.addressVerified` | `orders.raw.shipTo.addressVerified` | v1 |

## Package And Totals

| Canonical field | Primary source | Version |
| --- | --- | --- |
| `canonicalOrder.weight` | ShipStation `/orders.weight` normalized into `orders.weight_oz` | v1 |
| `canonicalOrder.weight.value` | ShipStation `/orders.weight.value` normalized into ounces | v1 |
| `canonicalOrder.weight.units` | Canonical unit normalized to `ounces` | derived |
| `canonicalOrder.weightOz` | `orders.weight_oz` | v1 |
| `canonicalOrder.dimensions` | `orders.raw.dimensions`, fallback `order_overrides.rateDims*` | v1/local |
| `canonicalOrder.dimensions.length` | `orders.raw.dimensions.length`, fallback `order_overrides.rateDimsL` | v1/local |
| `canonicalOrder.dimensions.width` | `orders.raw.dimensions.width`, fallback `order_overrides.rateDimsW` | v1/local |
| `canonicalOrder.dimensions.height` | `orders.raw.dimensions.height`, fallback `order_overrides.rateDimsH` | v1/local |
| `canonicalOrder.dimensions.units` | `orders.raw.dimensions.units`, fallback canonical `inches` | v1/derived |
| `canonicalOrder.packageCode` | ShipStation `/orders.packageCode` stored in `orders.raw` | v1 |
| `canonicalOrder.requestedShippingService` | ShipStation `/orders.requestedShippingService` stored in `orders.raw` | v1 |
| `canonicalOrder.requestedServiceCode` | `orders.raw.serviceCode`, fallback `orders.service_code` | v1/local |
| `canonicalOrder.totals.orderTotal` | ShipStation `/orders.orderTotal` stored as `orders.order_total` | v1 |
| `canonicalOrder.totals.shippingAmount` | ShipStation `/orders.shippingAmount` stored as `orders.shipping_amount` | v1 |
| `canonicalOrder.items` | ShipStation `/orders.items[]` stored as `orders.items` | v1 |

## Shipping Fields

| Canonical field | Source priority | Version |
| --- | --- | --- |
| `canonicalOrder.shipping.carrierCode` | `shipments.selected_rate_json.carrierCode` -> `shipments.carrier_code` -> `order_overrides.best_rate_json.carrierCode` -> `orders.carrier_code` | v2 -> v1 -> v2 -> v1 |
| `canonicalOrder.shipping.serviceCode` | `shipments.selected_rate_json.serviceCode` -> `shipments.service_code` -> `order_overrides.best_rate_json.serviceCode` -> `orders.service_code` | v2 -> v1 -> v2 -> v1 |
| `canonicalOrder.shipping.trackingNumber` | `shipments.tracking_number` from v2 label creation when available, otherwise v1 shipment sync | v2/v1 |
| `canonicalOrder.shipping.providerAccountId` | selected-rate provider id -> `shipments.provider_account_id` -> best-rate provider id -> derived account lookup | v2/derived |
| `canonicalOrder.shipping.accountNickname` | selected-rate nickname -> `shipments.provider_account_nickname` -> best-rate nickname -> derived account lookup | v2/derived |
| `canonicalOrder.shipping.selectedRateAmount` | selected-rate JSON amount -> shipment cost + other cost -> label cost -> best-rate amount | v2 -> v1 -> v2 -> v2 |
| `canonicalOrder.shipping.bestRateAmount` | `order_overrides.best_rate_json`, fallback shipment cost when shipped/cancelled | v2/v1 |
| `canonicalOrder.shipping.labelCost` | v2 label shipment cost stored as `shipments.label_cost`, fallback v1 shipment cost + other cost | v2/v1 |
| `canonicalOrder.shipping.labelCreatedAt` | v2 label create date when available -> v1 shipment create date -> `order_overrides.best_rate_at` -> order updated date -> order created date | v2/v1/local |
| `canonicalOrder.shipping.shipDate` | `shipments.ship_date` | v1 |
| `canonicalOrder.shipping.shipmentId` | ShipStation shipment id stored as `shipments.label_shipment_id` | v1 |
| `canonicalOrder.shipping.source` | Shows whether canonical shipping came from a shipment row, saved rate override, or no shipping source | local |
| `canonicalOrder.shipping.selectedRate` | selected-rate JSON, fallback synthesized shipment selected-rate object | v2/v1 |
| `canonicalOrder.shipping.bestRate` | best-rate JSON, fallback synthesized shipment selected-rate object | v2/v1 |

## How To Inspect A Row

Open an order-list API response and check:

```json
{
  "canonicalOrder": {
    "shipping": { "...": "..." },
    "sourceMap": {
      "shipping.accountNickname": {
        "version": "v2",
        "source": "shipments.provider_account_nickname",
        "via": "ShipStation v2 /carriers nickname cached on shipment"
      }
    }
  }
}
```
