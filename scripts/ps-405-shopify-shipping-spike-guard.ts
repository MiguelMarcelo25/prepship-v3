import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SHOPIFY_SHIPPING_PROVIDER,
  buildShopifyShippingLabelPurchaseInput,
  evaluateShopifyShippingEligibility,
  isShopifyShippingPurchaseEnabled,
  normalizeShopifyFulfillmentOrderId,
} from '../src/services/shopify-shipping-labels';

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
    grantedScopes: ['write_orders'],
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
    grantedScopes: ['read_orders', 'read_products'],
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
