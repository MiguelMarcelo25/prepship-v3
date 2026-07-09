import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/prepship_test';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret';

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
const ShopifyConnector = await import('../src/connectors/store/shopify');
const CredentialAccounts = await import('../src/lib/credential-accounts');

await check('Shopify draft-order delivery-options query matches Shopify schema', () => {
  const query = ShopifyConnector.__shopifyConnectorTestOnly.SHOPIFY_DRAFT_ORDER_DELIVERY_OPTIONS_QUERY;
  assert.match(query, /draftOrderAvailableDeliveryOptions/);
  assert.match(query, /availableShippingRates/);
  assert.match(query, /\bhandle\b/);
  assert.match(query, /\btitle\b/);
  assert.match(query, /\bsource\b/);
  assert.match(query, /\bcode\b/);
  assert.match(query, /price\s*\{/);
  assert.match(query, /\bamount\b/);
  assert.match(query, /\bcurrencyCode\b/);
  assert.doesNotMatch(
    query,
    /draftOrderAvailableDeliveryOptions[\s\S]*userErrors/,
    'draftOrderAvailableDeliveryOptions returns delivery options directly; userErrors is not a valid field',
  );
});

await check('Shopify draft-order delivery-options parser accepts mocked GraphQL rates', () => {
  const rates = ShopifyConnector.parseShopifyDraftOrderDeliveryOptionsResponse({
    data: {
      draftOrderAvailableDeliveryOptions: {
        availableShippingRates: [
          {
            handle: 'shopify-ups-3-day-select',
            title: 'UPS 3 Day Select',
            source: 'UPS',
            code: '3_DAY_SELECT',
            price: { amount: '13.42', currencyCode: 'USD' },
          },
        ],
      },
    },
  });

  assert.equal(rates.length, 1);
  assert.deepEqual(rates[0], {
    handle: 'shopify-ups-3-day-select',
    title: 'UPS 3 Day Select',
    source: 'UPS',
    code: '3_DAY_SELECT',
    price: { amount: '13.42', currencyCode: 'USD' },
  });
});

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

await check('Shopify account resolver accepts stale connector ids and synthetic store ids', () => {
  assert.deepEqual(
    ShopifyRates.shopifyStoreAccountIdCandidatesForOrder({
      sourceAccountId: 'store-account-42',
      storeId: null,
    }),
    [42],
  );
  assert.deepEqual(
    ShopifyRates.shopifyStoreAccountIdCandidatesForOrder({
      sourceAccountId: '42',
      storeId: 9_200_077,
    }),
    [42, 77],
  );
});

await check('Shopify live-order fallback verifies the Shopify order identity', () => {
  assert.equal(
    ShopifyRates.shopifyOrderContextMatchesOrderIdentity(
      { id: 61019990001, name: '#1007' },
      { sourceOrderId: '61019990001', sourceOrderNumber: '#1007' },
    ),
    true,
  );
  assert.equal(
    ShopifyRates.shopifyOrderContextMatchesOrderIdentity(
      { id: 61019990001, name: '#1008' },
      { sourceOrderId: '61019990001', sourceOrderNumber: '#1007' },
    ),
    false,
  );
});

await check('Shopify reconnect uses shop domain as store-account identity', () => {
  const normalized = CredentialAccounts.normalizeCredentialAccountBody({
    provider: 'shopify',
    label: 'KF Goodies',
    accountIdentifier: 'dev-app-client-id-that-can-change',
    credentials: {
      shopDomain: 'https://kf-goodies-2.myshopify.com/admin',
      clientId: 'dev-app-client-id-that-can-change',
      clientSecret: 'shpss_secret',
    },
    source: 'admin',
  });
  assert.equal(normalized.accountIdentifier, 'kf-goodies-2.myshopify.com');
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

await check('Shopify draft-order delivery options stay separate from label rates', () => {
  const checkoutDeliveryOptions = ShopifyRates.normalizeShopifyDraftShippingRates([
    {
      handle: 'standard',
      title: 'Standard',
      source: 'shopify',
      code: 'Standard',
      price: { amount: '8.00', currencyCode: 'USD' },
    },
  ]);
  const snapshot = ShopifyRates.createShopifyRateQuoteSnapshot({
    orderId: 101,
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/720111',
    rates: [],
    checkoutShipping: [],
    checkoutDeliveryOptions,
    fetchedAt: '2026-07-09T00:00:00.000Z',
  });

  assert.deepEqual(snapshot.rates, [], 'checkout delivery options must not be treated as Shopify label rates');
  assert.equal(snapshot.checkoutDeliveryOptions?.[0]?.title, 'Standard');
  assert.equal(snapshot.labelRatesAvailable, false);
  assert.match(snapshot.labelRatesMessage ?? '', /does not expose.*label rates/i);
  assert.throws(
    () => ShopifyRates.assertShopifySelectedRate(snapshot, checkoutDeliveryOptions[0]?.selectedRateKey),
    /does not expose.*label rates/i,
  );
});

await check('Shopify cheapest-auto purchase input omits preferredRateSelection', () => {
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

  assert.equal(
    'preferredRateSelection' in purchaseInput,
    false,
    'V1 must omit preferredRateSelection so Shopify chooses the cheapest available label at purchase time',
  );
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
  assert.doesNotMatch(labelsRoute, /const shopifyCreateBody[\s\S]*?shopifyRateQuoteId:\s*z\.string\(\)\.min\(1\)[\s\S]*?\}\);/);
  assert.doesNotMatch(labelsRoute, /const shopifyCreateBody[\s\S]*?selectedRateKey:\s*z\.string\(\)\.min\(1\)[\s\S]*?\}\);/);

  const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
  assert.match(modal, /Shopify Shipping/);
  assert.match(modal, /not Shopify label rates/);
  assert.doesNotMatch(modal, /bestRate\s*=\s*shopify/i);
});

await check('Shopify label purchase UI is honest about price visibility before purchase', () => {
  const panel = readFileSync('web/src/components/Views/OrdersDetailSidePanel.tsx', 'utf8');
  assert.match(panel, /Cheapest available Shopify label/);
  assert.match(panel, /Price:\s*shown after Shopify purchase/);
  assert.match(panel, /Buy Cheapest Shopify Label/);

  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  assert.match(ordersView, /SHOPIFY_LABEL_PURCHASE_CONFIRM_MESSAGE/);
  assert.match(ordersView, /does not provide the exact label price before purchase/);
  assert.match(ordersView, /buy the cheapest available Shopify Shipping label/);
  assert.match(ordersView, /window\.confirm\(SHOPIFY_LABEL_PURCHASE_CONFIRM_MESSAGE\)/);
  assert.match(ordersView, /hasShopifyLabelPurchaseIntent/);
  assert.match(ordersView, /hasShopifyLabelPurchaseIntent\(batchOrders\)/);
});
