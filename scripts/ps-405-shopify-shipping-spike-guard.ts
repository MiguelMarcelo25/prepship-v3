import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkShopifyShippingReadiness } from '../src/connectors/store/shopify';
import * as ShopifyStore from '../src/connectors/store/shopify';
import { __setCarrierReplay } from '../src/lib/http/timing';
import * as ShopifyShippingLabels from '../src/services/shopify-shipping-labels';
import {
  SHOPIFY_SHIPPING_PROVIDER,
  buildShopifyShippingLabelPurchaseInput,
  evaluateShopifyShippingEligibility,
  isShopifyShippingPurchaseEnabled,
  normalizeShopifyFulfillmentOrderId,
} from '../src/services/shopify-shipping-labels';

process.env.CARRIER_TEST_MODE = '1';

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const rawShopifyOrder = {
  id: 61019990001,
  admin_graphql_api_id: 'gid://shopify/Order/61019990001',
  name: '#1001',
  shipping_address: {
    name: 'PrepShip Test Customer',
    address1: '123 Main St',
    city: 'Los Angeles',
    province_code: 'CA',
    zip: '90001',
    country_code: 'US',
    phone: '+15551234567',
  },
  line_items: [
    {
      admin_graphql_api_id: 'gid://shopify/LineItem/7001',
      sku: 'TEST-SKU-001',
      title: 'PrepShip Test Product',
      quantity: 1,
      grams: 454,
      requires_shipping: true,
    },
  ],
  fulfillment_orders: [
    {
      id: 720111,
      status: 'open',
      request_status: 'unsubmitted',
    },
  ],
};

await check('package exposes the PS-405 Shopify Shipping guard', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.['test:ps-405-shopify-shipping-spike'],
    'tsx scripts/ps-405-shopify-shipping-spike-guard.ts',
  );
});

await check('Shopify Shipping starts disabled unless explicitly enabled', () => {
  assert.equal(isShopifyShippingPurchaseEnabled({}), false);
  assert.equal(isShopifyShippingPurchaseEnabled({ SHOPIFY_SHIPPING_LABELS_ENABLED: 'false' }), false);
  assert.equal(isShopifyShippingPurchaseEnabled({ SHOPIFY_SHIPPING_LABELS_ENABLED: 'true' }), true);
});

await check('Shopify Shipping eligibility requires Shopify source, write_orders, and fulfillment order id', () => {
  const result = evaluateShopifyShippingEligibility({
    sourceProvider: 'shopify',
    rawOrderPayload: rawShopifyOrder,
    grantedScopes: [
      'read_fulfillments',
      'write_fulfillments',
      'read_merchant_managed_fulfillment_orders',
      'write_merchant_managed_fulfillment_orders',
      'read_orders',
      'write_orders',
      'read_products',
    ],
    env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'false' },
  });

  assert.equal(result.provider, SHOPIFY_SHIPPING_PROVIDER);
  assert.equal(result.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(result.eligible, true);
  assert.equal(result.purchaseEnabled, false);
  assert.equal(result.canPurchase, false);
  assert.deepEqual(result.missing, []);
  assert.match(result.blockers.join(' '), /disabled/);
});

await check('Shopify Shipping refuses non-Shopify orders', () => {
  const result = evaluateShopifyShippingEligibility({
    sourceProvider: 'shipstation',
    rawOrderPayload: rawShopifyOrder,
    grantedScopes: ['read_orders', 'write_orders', 'read_merchant_managed_fulfillment_orders'],
    env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'true' },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canPurchase, false);
  assert.deepEqual(result.missing, ['source:shopify']);
});

await check('Shopify Shipping refuses tokens without write_orders', () => {
  const result = evaluateShopifyShippingEligibility({
    sourceProvider: 'shopify',
    rawOrderPayload: rawShopifyOrder,
    grantedScopes: ['read_orders', 'read_merchant_managed_fulfillment_orders'],
    env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'true' },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canPurchase, false);
  assert.deepEqual(result.missing, ['scope:write_orders']);
});

await check('Shopify Shipping does not confuse order GIDs with fulfillment order GIDs', () => {
  assert.equal(normalizeShopifyFulfillmentOrderId('gid://shopify/FulfillmentOrder/720111'), 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(normalizeShopifyFulfillmentOrderId(720111), 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(normalizeShopifyFulfillmentOrderId('gid://shopify/Order/61019990001'), null);
});

await check('Shopify Shipping builds the no-postage GraphQL purchase input shape', () => {
  const input = buildShopifyShippingLabelPurchaseInput({
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
    notifyCustomer: false,
    shippingDatetime: '2026-07-08T01:25:00Z',
    totalWeightOz: 18.25,
    originAddress: {
      address1: '123 Warehouse Way',
      city: 'Gardena',
      provinceCode: 'CA',
      zip: '90248',
      countryCode: 'US',
      company: 'GWH Fulfillment Center',
      phone: '+15551234567',
    },
    packageInfo: {
      customPackage: {
        dimensions: {
          length: 12,
          width: 10,
          height: 3,
          unit: 'INCHES',
        },
        type: 'BOX',
        weight: { unit: 'GRAMS', value: 0 },
      },
    },
  });

  assert.equal(input.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(input.notifyCustomer, false);
  assert.equal(input.shippingDatetime, '2026-07-08T01:25:00Z');
  assert.deepEqual(input.totalWeight, { unit: 'GRAMS', value: 517.38 });
  assert.equal(input.originAddress.city, 'Gardena');
  assert.deepEqual(input.packageInfo.customPackage?.dimensions, {
    length: 12,
    width: 10,
    height: 3,
    unit: 'INCHES',
  });
  assert.deepEqual(input.packageInfo.customPackage?.weight, { unit: 'GRAMS', value: 0 });
});

await check('Shopify Shipping mock label adapter proves the purchase path without buying postage', () => {
  const createShopifyShippingMockLabel = (
    ShopifyShippingLabels as typeof ShopifyShippingLabels & {
      createShopifyShippingMockLabel?: (input: {
        fulfillmentOrderId: unknown;
        orderId?: unknown;
        orderName?: unknown;
        shopDomain?: unknown;
        createdAt?: unknown;
      }) => {
        provider: string;
        mock: boolean;
        fulfillmentOrderId: string;
        orderName?: string;
        carrierCode: string;
        serviceCode: string;
        currency: string;
        cost: number;
        postagePurchased: boolean;
        printable: boolean;
        trackingNumber: string;
        labelUrl: string;
        message: string;
      };
    }
  ).createShopifyShippingMockLabel;
  assert.equal(typeof createShopifyShippingMockLabel, 'function');

  const label = createShopifyShippingMockLabel({
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
    orderId: 61019990001,
    orderName: '#1001',
    shopDomain: 'kf-goodies-2.myshopify.com',
    createdAt: '2026-07-08T01:25:00Z',
  });

  assert.equal(label.provider, SHOPIFY_SHIPPING_PROVIDER);
  assert.equal(label.mock, true);
  assert.equal(label.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(label.orderName, '#1001');
  assert.equal(label.carrierCode, 'shopify_shipping');
  assert.equal(label.serviceCode, 'shopify_mock_ground');
  assert.equal(label.currency, 'USD');
  assert.equal(label.cost, 0);
  assert.equal(label.postagePurchased, false);
  assert.equal(label.printable, false);
  assert.match(label.trackingNumber, /^SHOPIFY-MOCK-1001-720111$/);
  assert.match(label.labelUrl, /^mock:\/\/shopify-shipping\/720111$/);
  assert.match(label.message, /no postage/i);

  const serviceSource = readFileSync('src/services/shopify-shipping-labels.ts', 'utf8');
  assert.doesNotMatch(serviceSource, /shippingLabelPurchase\s*\(/);
});

await check('Shopify Shipping live purchase adapter is hard-gated before any Shopify HTTP', async () => {
  const purchaseShopifyShippingLabel = (
    ShopifyStore as typeof ShopifyStore & {
      purchaseShopifyShippingLabel?: (rawCredentials: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>;
    }
  ).purchaseShopifyShippingLabel;
  assert.equal(typeof purchaseShopifyShippingLabel, 'function');

  await assert.rejects(
    () => purchaseShopifyShippingLabel(
      {
        shopDomain: 'kf-goodies-2.myshopify.com',
        clientId: 'shopify_client_id_for_test',
        clientSecret: 'shopify_client_secret_for_test',
        apiVersion: '2026-07',
      },
      {
        env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'false' },
        purchaseInput: {
          fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
          notifyCustomer: false,
          shippingDatetime: '2026-07-08T01:25:00Z',
          totalWeightOz: 18.25,
          packageInfo: {
            customPackage: {
              dimensions: { length: 12, width: 10, height: 3, unit: 'INCHES' },
              type: 'BOX',
              weight: { unit: 'GRAMS', value: 0 },
            },
          },
        },
      },
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'SHOPIFY_SHIPPING_DISABLED');
      assert.match(err instanceof Error ? err.message : String(err), /SHOPIFY_SHIPPING_LABELS_ENABLED disabled/);
      return true;
    },
  );
});

await check('Shopify Shipping live purchase adapter parses the official GraphQL label result', async () => {
  const purchaseShopifyShippingLabel = (
    ShopifyStore as typeof ShopifyStore & {
      purchaseShopifyShippingLabel?: (rawCredentials: Record<string, unknown>, input: Record<string, unknown>) => Promise<{
        provider: string;
        mock: boolean;
        fulfillmentOrderId: string;
        purchaseResultId: string;
        done: boolean;
        status: string;
        labelId: string;
        trackingNumber: string;
        trackingUrl?: string;
        labelUrl: string;
        labelFormat: string;
        carrierCode: string;
        serviceCode: string;
        cost: number | null;
        currency: string | null;
        postagePurchased: boolean;
        printable: boolean;
      }>;
    }
  ).purchaseShopifyShippingLabel;
  assert.equal(typeof purchaseShopifyShippingLabel, 'function');

  __setCarrierReplay([
    {
      name: 'shopify.token',
      body: { access_token: 'test-shopify-token' },
    },
    {
      name: 'shopify.shipping-label-purchase',
      body: {
        data: {
          shippingLabelPurchase: {
            shippingLabelPurchaseResult: {
              id: 'gid://shopify/ShippingLabelPurchaseResult/9001',
              done: true,
              status: 'SUCCESS',
              errors: [],
              shippingLabels: [
                {
                  id: 'gid://shopify/ShippingLabel/8102392109720',
                  printed: false,
                  cancellable: true,
                  trackingInfo: {
                    number: '9400111899560000000000',
                    company: 'USPS',
                    url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899560000000000',
                  },
                  shippingDocuments: [
                    {
                      documentType: 'LABEL',
                      format: 'PDF',
                      shippingLabelId: 'gid://shopify/ShippingLabel/8102392109720',
                      url: 'https://cdn.shopify.com/labels/8102392109720.pdf',
                    },
                  ],
                },
              ],
            },
            userErrors: [],
          },
        },
      },
    },
  ]);

  const result = await purchaseShopifyShippingLabel(
    {
      shopDomain: 'kf-goodies-2.myshopify.com',
      clientId: 'shopify_client_id_for_test',
      clientSecret: 'shopify_client_secret_for_test',
      apiVersion: '2026-07',
    },
    {
      env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'true' },
      orderId: 61019990001,
      orderName: '#1001',
      purchaseInput: {
        fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
        notifyCustomer: false,
        shippingDatetime: '2026-07-08T01:25:00Z',
        totalWeightOz: 18.25,
        preferredRateSelection: {
          carrierCode: 'USPS',
          serviceCode: 'GROUND_ADVANTAGE',
        },
        packageInfo: {
          customPackage: {
            dimensions: { length: 12, width: 10, height: 3, unit: 'INCHES' },
            type: 'BOX',
            weight: { unit: 'GRAMS', value: 0 },
          },
        },
      },
    },
  );

  assert.equal(result.provider, SHOPIFY_SHIPPING_PROVIDER);
  assert.equal(result.mock, false);
  assert.equal(result.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(result.purchaseResultId, 'gid://shopify/ShippingLabelPurchaseResult/9001');
  assert.equal(result.done, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.labelId, 'gid://shopify/ShippingLabel/8102392109720');
  assert.equal(result.trackingNumber, '9400111899560000000000');
  assert.equal(result.labelUrl, 'https://cdn.shopify.com/labels/8102392109720.pdf');
  assert.equal(result.labelFormat, 'PDF');
  assert.equal(result.carrierCode, 'USPS');
  assert.equal(result.serviceCode, 'GROUND_ADVANTAGE');
  assert.equal(result.cost, null);
  assert.equal(result.currency, null);
  assert.equal(result.postagePurchased, true);
  assert.equal(result.printable, true);
});

await check('Shopify Shipping readiness uses the connected store account and hydrates fulfillment order id', async () => {
  __setCarrierReplay([
    {
      name: 'shopify.token',
      body: { access_token: 'test-shopify-token' },
    },
    {
      name: 'shopify.shop',
      body: { shop: { id: 12345, name: 'KF GOODIES', myshopify_domain: 'kf-goodies-2.myshopify.com' } },
    },
    {
      name: 'shopify.access-scopes',
      body: {
        access_scopes: [
          { handle: 'read_orders' },
          { handle: 'write_orders' },
          { handle: 'read_merchant_managed_fulfillment_orders' },
          { handle: 'write_merchant_managed_fulfillment_orders' },
          { handle: 'read_fulfillments' },
          { handle: 'write_fulfillments' },
        ],
      },
    },
    {
      name: 'shopify.orders-import',
      body: { orders: [rawShopifyOrder] },
    },
    {
      name: 'shopify.fulfillment-orders',
      body: {
        fulfillment_orders: [
          {
            id: 720111,
            status: 'open',
            request_status: 'unsubmitted',
          },
        ],
      },
    },
  ]);

  const result = await checkShopifyShippingReadiness(
    {
      shopDomain: 'kf-goodies-2.myshopify.com',
      clientId: 'shopify_client_id_for_test',
      clientSecret: 'shopify_client_secret_for_test',
      apiVersion: '2026-07',
    },
    { env: { SHOPIFY_SHIPPING_LABELS_ENABLED: 'false' } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, SHOPIFY_SHIPPING_PROVIDER);
  assert.equal(result.shopDomain, 'kf-goodies-2.myshopify.com');
  assert.equal(result.orderName, '#1001');
  assert.equal(result.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(result.mockLabel?.mock, true);
  assert.equal(result.mockLabel?.trackingNumber, 'SHOPIFY-MOCK-1001-720111');
  assert.equal(result.mockLabel?.postagePurchased, false);
  assert.equal(result.mockLabel?.printable, false);
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.eligibility.canPurchase, false);
  assert.deepEqual(result.missingScopes, []);
  assert.match(result.message, /mock label path ready/i);
});

await check('Shopify Shipping readiness is wired to the backend route and Settings action', () => {
  assert.match(readFileSync('src/routes/carriers.ts', 'utf8'), /\/shopify\/shipping-readiness/);
  const settings = readFileSync('web/src/components/Settings/CarrierIntegrationsCard.tsx', 'utf8');
  assert.match(settings, /checkShopifyShipping/);
  assert.match(settings, /Shipping Check/);
  assert.match(settings, /formatShopifyShippingReadiness/);
  assert.match(settings, /mock label path ready/);
  assert.match(settings, /live purchase OFF/);
  assert.match(settings, /SHOPIFY_SHIPPING_LABELS_ENABLED/);
  assert.match(settings, /staff permission must be verified by live test/);
  assert.doesNotMatch(settings, /permission needed:/);
});
