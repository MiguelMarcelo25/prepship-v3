import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const shopifyRatesServicePath = 'src/services/shopify-rates.ts';

await check('Shopify Rates backend owner exists separately from normal Best Rate', () => {
  assert.equal(
    existsSync(shopifyRatesServicePath),
    true,
    'Expected src/services/shopify-rates.ts to own separated Shopify rate browsing',
  );
});

const ShopifyRates = await import('../src/services/shopify-rates');

await check('Shopify draft-order rates normalize source/code into carrier/service', () => {
  const normalized = ShopifyRates.normalizeShopifyDraftShippingRates([
    {
      handle: 'shopify-usps-ground',
      title: 'USPS Ground Advantage',
      source: 'USPS',
      code: 'GROUND_ADVANTAGE',
      price: {
        amount: '7.84',
        currencyCode: 'USD',
      },
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.carrierCode, 'USPS');
  assert.equal(normalized[0]?.serviceCode, 'GROUND_ADVANTAGE');
  assert.equal(normalized[0]?.title, 'USPS Ground Advantage');
  assert.equal(normalized[0]?.handle, 'shopify-usps-ground');
  assert.equal(normalized[0]?.amount, 7.84);
  assert.equal(normalized[0]?.currency, 'USD');
  assert.match(normalized[0]?.selectedRateKey ?? '', /^shopify:/);
});

await check('Shopify selected-rate proof refuses stale or missing selected keys', () => {
  const snapshot = ShopifyRates.createShopifyRateQuoteSnapshot({
    orderId: 101,
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
    rates: ShopifyRates.normalizeShopifyDraftShippingRates([
      {
        handle: 'rate-a',
        title: 'USPS Ground',
        source: 'USPS',
        code: 'GROUND_ADVANTAGE',
        price: { amount: '7.84', currencyCode: 'USD' },
      },
    ]),
    checkoutShipping: [],
    fetchedAt: '2026-07-09T00:00:00.000Z',
  });

  const selected = ShopifyRates.assertShopifySelectedRate(snapshot, snapshot.rates[0]?.selectedRateKey);
  assert.equal(selected.carrierCode, 'USPS');
  assert.equal(selected.serviceCode, 'GROUND_ADVANTAGE');
  assert.throws(
    () => ShopifyRates.assertShopifySelectedRate(snapshot, 'shopify:missing'),
    /Selected Shopify rate is no longer available/,
  );
  assert.throws(
    () => ShopifyRates.assertShopifySelectedRate(snapshot, null),
    /selectedRateKey is required/,
  );
});

await check('Shopify purchase input always carries preferredRateSelection', () => {
  const rate = ShopifyRates.normalizeShopifyDraftShippingRates([
    {
      handle: 'rate-a',
      title: 'USPS Ground',
      source: 'USPS',
      code: 'GROUND_ADVANTAGE',
      price: { amount: '7.84', currencyCode: 'USD' },
    },
  ])[0]!;

  const purchaseInput = ShopifyRates.buildShopifyShippingPurchaseInputFromRate({
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
    rate,
    weightOz: 18.25,
    dims: { length: 12, width: 10, height: 3 },
    shippingDatetime: '2026-07-09T00:00:00.000Z',
  });

  assert.deepEqual(purchaseInput.preferredRateSelection, {
    carrierCode: 'USPS',
    serviceCode: 'GROUND_ADVANTAGE',
  });
  assert.equal(purchaseInput.fulfillmentOrderId, 'gid://shopify/FulfillmentOrder/720111');
  assert.equal(purchaseInput.packageInfo.customPackage?.dimensions.length, 12);
});

await check('Shopify rates are not mixed into normal /rates/browse or Best Rate', () => {
  const producer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
  assert.doesNotMatch(producer, /shopifyRates|shopifyShippingRates|shopify_shipping/i);

  const rates = readFileSync('src/services/rates.ts', 'utf8');
  assert.match(rates, /isShopifyShippingDisplayOnlyProvider/);
  assert.match(rates, /normalizeProviderKey\(account\.provider\) === 'shopify'/);
});

await check('Shopify routes are mounted and admin UI keeps Shopify in a separate panel', () => {
  const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
  assert.match(ratesRoute, /\/shopify/);
  assert.match(ratesRoute, /getShopifyRatesForOrder/);

  const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
  assert.match(labelsRoute, /\/shopify/);
  assert.match(labelsRoute, /createShopifyShippingLabelForOrder/);

  const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
  assert.match(modal, /Shopify Rates/);
  assert.match(modal, /Buy Shopify Label/);
  assert.doesNotMatch(modal, /bestRate\s*=\s*shopify/i);
});
