import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createShopifyStoreConnector } from '../src/connectors/store/shopify';
import { connectorImplementationStatus } from '../src/connectors/implementation-status';
import { verifyProviderCredentials } from '../src/connectors/carrier/credential-verification';
import { __setCarrierReplay } from '../src/lib/http/timing';

process.env.CARRIER_TEST_MODE = '1';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

const shopifyOrder = {
  id: 61019990001,
  name: '#1007',
  order_number: 1007,
  created_at: '2026-07-07T11:40:00-04:00',
  financial_status: 'paid',
  fulfillment_status: null,
  email: 'buyer@example.com',
  current_total_price: '146.88',
  total_price: '146.88',
  total_shipping_price_set: {
    shop_money: { amount: '7.95', currency_code: 'USD' },
  },
  shipping_address: {
    name: 'Hannah Lieu',
    city: 'Los Angeles',
    province_code: 'CA',
    zip: '90001',
    country_code: 'US',
    phone: '5551234567',
  },
  shipping_lines: [
    { code: 'standard', title: 'Standard', price: '7.95' },
  ],
  line_items: [
    {
      id: 7001,
      admin_graphql_api_id: 'gid://shopify/LineItem/7001',
      sku: 'Booster-gel-001',
      title: 'Booster Gel',
      quantity: 2,
      current_quantity: 2,
      price: '21.19',
      grams: 454,
      requires_shipping: true,
      image: { src: 'https://cdn.shopify.com/booster.jpg' },
    },
    {
      id: 7002,
      sku: 'HU-10',
      title: 'Leeds Line V2',
      quantity: 1,
      current_quantity: 1,
      price: '106.32',
      grams: 64,
      requires_shipping: true,
    },
  ],
};

await check('Shopify credentials verifier reads shop metadata without mutating orders', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.shop',
      body: { shop: { id: 12345, name: 'KF GOODIES', myshopify_domain: 'kf-goodies-2.myshopify.com' } },
    },
  ]);

  const result = await verifyProviderCredentials('shopify', {
    shopDomain: 'https://kf-goodies-2.myshopify.com/admin',
    accessToken: 'shpat_test_token',
    apiVersion: '2026-07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountIdentifier, 'kf-goodies-2.myshopify.com');
  assert.equal(result.accountLabel, 'KF GOODIES');
});

await check('Shopify import normalizes paid unfulfilled orders for canonical store persistence', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.orders-import',
      body: {
        orders: [shopifyOrder],
      },
    },
  ]);

  const connector = createShopifyStoreConnector();
  assert.ok(connector.importOrders, 'Shopify connector must expose importOrders');
  const result = await connector.importOrders({
    companyId: 0,
    accountId: 'store-account-42',
    credentials: {
      shopDomain: 'kf-goodies-2.myshopify.com',
      accessToken: 'shpat_test_token',
      apiVersion: '2026-07',
    },
    limit: 25,
  });

  const normalized = Array.isArray(result) ? result : result.orders;
  assert.equal(normalized.length, 1);
  const [order] = normalized;
  assert.equal(order.sourceProvider, 'shopify');
  assert.equal(order.sourceAccountId, 'store-account-42');
  assert.equal(order.sourceOrderId, '61019990001');
  assert.equal(order.sourceOrderNumber, '#1007');
  assert.equal(order.canonicalStatus, 'awaiting_shipment');
  assert.equal(order.customerName, 'Hannah Lieu');
  assert.equal(order.customerEmail, 'buyer@example.com');
  assert.equal(order.shipToCity, 'Los Angeles');
  assert.equal(order.shipToState, 'CA');
  assert.equal(order.shipToPostalCode, '90001');
  assert.equal(order.orderTotal, '146.88');
  assert.equal(order.shippingPaid, 7.95);
  assert.equal(order.weightOz, 35);
  assert.equal(Array.isArray(order.items), true);
  assert.equal((order.items as Array<Record<string, unknown>>)[0]?.sku, 'Booster-gel-001');
});

await check('Shopify shipment confirmation creates fulfillment from fulfillment orders', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.fulfillment-orders',
      body: {
        fulfillment_orders: [
          {
            id: 8899001,
            status: 'open',
            request_status: 'unsubmitted',
            line_items: [
              { id: 50001, line_item_id: 7001, fulfillable_quantity: 2 },
              { id: 50002, line_item_id: 7002, fulfillable_quantity: 1 },
            ],
          },
        ],
      },
    },
    {
      name: 'shopify.ship-confirm',
      status: 201,
      body: { fulfillment: { id: 99001, status: 'success' } },
    },
  ]);

  const connector = createShopifyStoreConnector();
  const result = await connector.confirmShipment({
    orderId: 1457903,
    shipmentId: 333,
    externalOrderId: 'shopify-61019990001',
    clientId: 9_200_042,
    orderNumber: '#1007',
    trackingNumber: '9400110200881234567890',
    carrierCode: 'USPS',
    shipDate: '2026-07-07',
    notifyCustomer: true,
    notifyMarketplace: true,
    credentials: {
      shopDomain: 'kf-goodies-2.myshopify.com',
      accessToken: 'shpat_test_token',
      apiVersion: '2026-07',
    },
    payload: {
      sourceOrderId: '61019990001',
      trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400110200881234567890',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'shopify');
});

await check('Shopify is marked live and wired into Settings Pull Orders', () => {
  assert.equal(connectorImplementationStatus.shopify.status, 'live');
  assert.match(read('src/routes/carriers.ts'), /shopifyOrdersHandler/);
  assert.match(read('src/routes/carriers.ts'), /\/shopify\/orders/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /shopify:\s*pullShopifyOrders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /importStoreOrders\('shopify'/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /upsertNormalizedStoreOrders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /INSERT INTO store_orders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /hasExistingMarketplaceOrderRow\(sql, 'shopify'/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /reconcileMarketplaceOrderStatuses\(sql/);
  assert.match(read('src/services/marketplace-status-reconciliation.ts'), /MarketplaceProvider = 'walmart' \| 'ebay' \| 'shopify'/);
  assert.match(read('src/services/fulfillment/outbox.ts'), /provider !== 'shopify'/);
});

console.log('PASS Shopify store connector guard');
