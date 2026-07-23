import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createShopifyStoreConnector,
  normalizeShopifyOrder,
  normalizeShopifyShopDomain,
  validateShopifyCredentials,
} from '../src/connectors/store/shopify';
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

await check('Shopify Dev Dashboard client credentials are exchanged before verification', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.token',
      body: { access_token: 'dev_dashboard_access_token', scope: 'read_orders,write_fulfillments', expires_in: 86_399 },
    },
    {
      name: 'shopify.shop',
      body: { shop: { id: 12345, name: 'KF GOODIES', myshopify_domain: 'kf-goodies-2.myshopify.com' } },
    },
  ]);

  const result = await verifyProviderCredentials('shopify', {
    shopDomain: 'kf-goodies-2.myshopify.com',
    clientId: 'shopify_client_id_for_test',
    clientSecret: 'shpss_test_secret',
    apiVersion: '2026-07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountIdentifier, 'kf-goodies-2.myshopify.com');
  assert.equal(result.meta?.authMode, 'client_credentials');
});

await check('Shopify Dev Dashboard app-not-installed errors are actionable', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.token',
      status: 400,
      body: {
        error: 'app_not_installed',
        error_description: 'The application is not installed on this shop.',
      },
    },
  ]);

  const result = await verifyProviderCredentials('shopify', {
    shopDomain: 'kf-goodies-2.myshopify.com',
    clientId: 'shopify_client_id_for_test',
    clientSecret: 'shpss_test_secret',
    apiVersion: '2026-07',
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /app is not installed/i);
  assert.match(result.error ?? '', /kf-goodies-2\.myshopify\.com/);
  assert.match(result.error ?? '', /Admin API Access Token/i);
  assert.doesNotMatch(result.error ?? '', /shpss_test_secret/);
});

await check('Shopify portal validation uses GraphQL and never echoes the token', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      data: {
        shop: { name: 'KF GOODIES', myshopifyDomain: 'kf-goodies-2.myshopify.com' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  assert.equal(
    normalizeShopifyShopDomain('https://admin.shopify.com/store/kf-goodies-2/orders'),
    'kf-goodies-2.myshopify.com',
  );
  assert.throws(() => normalizeShopifyShopDomain('https://example.com'), /myshopify\.com/);

  const result = await validateShopifyCredentials(
    { shopDomain: 'kf-goodies-2.myshopify.com', adminAccessToken: 'shpat_secret' },
    { fetch: fetchImpl, apiVersion: '2026-07', timeoutMs: 5_000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.shopName, 'KF GOODIES');
  assert.equal(result.myshopifyDomain, 'kf-goodies-2.myshopify.com');
  assert.equal(JSON.stringify(result).includes('shpat_secret'), false);
  assert.equal(calls[0]?.url, 'https://kf-goodies-2.myshopify.com/admin/api/2026-07/graphql.json');
});

await check('Shopify GraphQL order normalization supports direct store polling', async () => {
  const gqlOrder = {
    id: 'gid://shopify/Order/1234567890',
    name: '#1001',
    createdAt: '2026-07-08T12:00:00Z',
    updatedAt: '2026-07-08T12:10:00Z',
    cancelledAt: null,
    displayFulfillmentStatus: 'FULFILLED',
    email: 'order@example.com',
    customer: { displayName: 'Jane Buyer', email: 'customer@example.com' },
    shippingAddress: {
      name: 'Jane Buyer',
      city: 'Austin',
      provinceCode: 'TX',
      zip: '78701',
    },
    currentTotalPriceSet: { shopMoney: { amount: '29.99', currencyCode: 'USD' } },
    totalShippingPriceSet: { shopMoney: { amount: '6.50', currencyCode: 'USD' } },
    lineItems: {
      edges: [
        {
          node: {
            id: 'gid://shopify/LineItem/1',
            sku: 'SKU-1',
            title: 'Starter Kit',
            quantity: 2,
            variant: { id: 'gid://shopify/ProductVariant/987' },
            originalUnitPriceSet: { shopMoney: { amount: '11.00', currencyCode: 'USD' } },
          },
        },
      ],
    },
    totalWeight: 32,
  };

  const normalized = normalizeShopifyOrder(gqlOrder, {
    accountId: '42',
    clientId: 7,
    storeId: 9_200_042,
  });
  assert.equal(normalized.sourceProvider, 'shopify');
  assert.equal(normalized.sourceAccountId, '42');
  assert.equal(normalized.sourceOrderId, '1234567890');
  assert.equal(normalized.sourceOrderNumber, '#1001');
  assert.equal(normalized.canonicalStatus, 'shipped');
  assert.equal(normalized.externallyShipped, true);
  assert.equal(normalized.customerName, 'Jane Buyer');
  assert.equal(normalized.customerEmail, 'order@example.com');
  assert.equal(normalized.shipToCity, 'Austin');
  assert.equal(normalized.shipToState, 'TX');
  assert.equal(normalized.shipToPostalCode, '78701');
  assert.equal(normalized.weightOz, 32);
  assert.equal(normalized.orderTotal, '29.99');
  assert.equal(normalized.shippingPaid, 6.5);
  assert.equal((normalized.items as Array<Record<string, unknown>>)[0]?.sku, 'SKU-1');
  assert.equal((normalized.items as Array<Record<string, unknown>>)[0]?.variantId, 'gid://shopify/ProductVariant/987');
  assert.match(
    read('src/connectors/store/shopify.ts'),
    /fulfillmentOrders\s*\(\s*first:/,
    'Shopify GraphQL order import must request fulfillmentOrders so label purchase eligibility survives sync',
  );
  assert.doesNotMatch(
    read('src/connectors/store/shopify.ts'),
    /remainingLineItems\s*\(/,
    'Shopify GraphQL order import must not request the removed FulfillmentOrder.remainingLineItems field',
  );
  assert.match(
    read('src/connectors/store/shopify.ts'),
    /fulfillmentOrders[\s\S]*lineItems\s*\(\s*first:\s*100\s*\)/,
    'Shopify GraphQL order import must request FulfillmentOrder.lineItems for remaining quantities',
  );

  const graphqlCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    graphqlCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      data: {
        orders: {
          edges: [{ cursor: 'edge-cursor-1', node: gqlOrder }],
          pageInfo: { hasNextPage: true, endCursor: 'edge-cursor-1' },
        },
      },
      extensions: {
        cost: { throttleStatus: { currentlyAvailable: 100, restoreRate: 50 } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const connector = createShopifyStoreConnector({
    fetch: fetchImpl,
    sleep: async () => undefined,
    apiVersion: '2026-07',
  });
  const result = await connector.importOrders({
    companyId: 1,
    accountId: '42',
    credentials: {
      shopDomain: 'kf-goodies-2.myshopify.com',
      adminAccessToken: 'shpat_secret',
    },
    sinceDate: '2026-07-08T00:00:00.000Z',
    cursor: null,
    limit: 50,
    storeId: 9_200_042,
  });

  assert.equal(result.provider, 'shopify');
  assert.equal(result.accountId, '42');
  assert.equal(result.orders.length, 1);
  assert.equal(result.cursor, 'edge-cursor-1');
  assert.equal(result.diagnostics?.hasNextPage, true);
  assert.equal(result.diagnostics?.maxUpdatedAt, '2026-07-08T12:10:00.000Z');
  assert(graphqlCalls.some((call) => call.url === 'https://kf-goodies-2.myshopify.com/admin/api/2026-07/graphql.json'));
});

await check('Shopify order import forwards worker cancellation to the GraphQL request', async () => {
  const abort = new AbortController();
  let requestSignal: AbortSignal | null = null;
  const connector = createShopifyStoreConnector({
    fetch: async (_url, init) => {
      requestSignal = init?.signal ?? null;
      abort.abort(new DOMException('cancelled', 'AbortError'));
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ data: { orders: { edges: [], pageInfo: {} } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    sleep: async () => undefined,
    apiVersion: '2026-07',
  });

  await assert.rejects(
    connector.importOrders({
      companyId: 1,
      accountId: '42',
      credentials: {
        shopDomain: 'kf-goodies-2.myshopify.com',
        adminAccessToken: 'shpat_secret',
      },
      signal: abort.signal,
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(requestSignal, abort.signal);
});

await check('Shopify order normalization preserves fulfillment-order facts for label purchase', () => {
  const gqlOrder = {
    id: 'gid://shopify/Order/1234567890',
    name: '#1001',
    createdAt: '2026-07-08T12:00:00Z',
    updatedAt: '2026-07-08T12:10:00Z',
    displayFulfillmentStatus: 'UNFULFILLED',
    fulfillmentOrders: {
      edges: [
        {
          node: {
            id: 'gid://shopify/FulfillmentOrder/720111',
            status: 'OPEN',
            requestStatus: 'UNSUBMITTED',
            assignedLocation: {
              location: {
                id: 'gid://shopify/Location/333',
                name: 'GWH Fulfillment Center',
              },
            },
            lineItems: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/FulfillmentOrderLineItem/501',
                    remainingQuantity: 2,
                    lineItem: { id: 'gid://shopify/LineItem/1' },
                  },
                },
              ],
            },
          },
        },
      ],
    },
    shippingAddress: {
      name: 'Jane Buyer',
      city: 'Austin',
      provinceCode: 'TX',
      zip: '78701',
    },
    currentTotalPriceSet: { shopMoney: { amount: '29.99', currencyCode: 'USD' } },
    lineItems: { edges: [] },
    totalWeight: 32,
  };

  const normalized = normalizeShopifyOrder(gqlOrder, {
    accountId: '42',
    clientId: 7,
    storeId: 9_200_042,
  });
  const raw = normalized.rawPayload as Record<string, unknown>;
  const fulfillmentOrders = raw.fulfillmentOrders as Record<string, unknown>;
  const firstEdge = (fulfillmentOrders.edges as Array<Record<string, unknown>>)[0];
  const node = firstEdge.node as Record<string, unknown>;

  assert.equal(node.id, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(node.status, 'OPEN');
  assert.equal(node.requestStatus, 'UNSUBMITTED');
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

await check('Shopify import auto-refreshes a Dev Dashboard access token', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.token',
      body: { access_token: 'fresh_access_token', scope: 'read_orders,write_fulfillments', expires_in: 86_399 },
    },
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
      clientId: 'shopify_client_id_for_test',
      clientSecret: 'shpss_test_secret',
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      apiVersion: '2026-07',
    },
    limit: 25,
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0]?.sourceOrderNumber, '#1007');
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
  assert.match(read('src/connectors/store/shopify.ts'), /grant_type:\s*'client_credentials'/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /shopify:\s*pullShopifyOrders/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /pullResultSampleOrderIds/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /row\.orderNumber/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /mirrored to Awaiting/);
  assert.doesNotMatch(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /sample PO IDs/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /name: 'clientId'[^}]*required: false/);
  assert.match(read('web/src/components/Settings/CarrierIntegrationsCard.tsx'), /name: 'clientSecret'[^}]*required: false/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /importStoreOrders\('shopify'/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /upsertNormalizedStoreOrders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /INSERT INTO store_orders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /mirroredOrders/);
  assert.match(read('src/lib/imported-handlers/shopify-orders.ts'), /source identity below is the canonical key/);
  assert.doesNotMatch(read('src/lib/imported-handlers/shopify-orders.ts'), /hasExistingMarketplaceOrderRow\(sql, 'shopify'/);
  assert.match(read('src/services/marketplace-status-reconciliation.ts'), /MarketplaceProvider = 'walmart' \| 'ebay' \| 'shopify'/);
  assert.match(read('src/services/fulfillment/outbox.ts'), /provider !== 'shopify'/);
});

console.log('PASS Shopify store connector guard');
