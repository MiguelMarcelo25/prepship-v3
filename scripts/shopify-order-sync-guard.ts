import assert from 'node:assert/strict';
import type { NormalizedOrder } from '../src/connectors/types';

process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/prepship_test';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret';

const {
  isShopifySyncableAccount,
  shopifySyncSince,
  syncShopifyAccount,
} = await import('../src/services/shopify-order-sync');

const account = {
  id: 42,
  clientId: 7,
  source: 'admin',
  active: true,
  credentials: { shopDomain: 'kf-goodies-2.myshopify.com', adminAccessToken: 'shpat_secret' },
  syncAnchorAt: new Date('2026-07-08T10:00:00.000Z'),
  syncCursorAt: new Date('2026-07-08T12:00:00.000Z'),
};

assert.equal(isShopifySyncableAccount(account), true);
assert.equal(isShopifySyncableAccount({ ...account, source: 'portal' }), false);
assert.equal(isShopifySyncableAccount({ ...account, active: false }), false);
assert.equal(shopifySyncSince(account), '2026-07-08T12:00:00.000Z');
assert.equal(
  shopifySyncSince({ ...account, syncCursorAt: new Date('2026-07-08T09:00:00.000Z') }),
  '2026-07-08T10:00:00.000Z',
);

const normalizedOrder: NormalizedOrder = {
  sourceProvider: 'shopify',
  sourceAccountId: '42',
  sourceOrderId: '1234567890',
  sourceOrderNumber: '#1001',
  marketplace: 'shopify',
  storeId: '9200042',
  canonicalStatus: 'awaiting_shipment',
  customerName: 'Jane Buyer',
  customerEmail: 'buyer@example.com',
  shippingPaid: 6.5,
  rawPayload: { id: 'gid://shopify/Order/1234567890' },
};

const calls: string[] = [];
await syncShopifyAccount(account, {
  importOrders: async (provider, input) => {
    calls.push(`import:${provider}:${input.sinceDate}:${input.cursor ?? 'none'}:${input.storeId}`);
    return {
      provider: 'shopify',
      accountId: '42',
      orders: [normalizedOrder],
      cursor: null,
      diagnostics: { hasNextPage: false, maxUpdatedAt: '2026-07-08T12:10:00.000Z' },
    };
  },
  persistOrders: async (orders) => {
    calls.push(`persist:${orders.length}`);
    return orders.length;
  },
  updateAccountProgress: async (id, progress) => {
    calls.push(`progress:${id}:${progress.syncCursorAt?.toISOString()}:${progress.lastSyncError ?? 'clear'}`);
  },
});

assert.deepEqual(calls, [
  'import:shopify:2026-07-08T12:00:00.000Z:none:9200042',
  'persist:1',
  'progress:42:2026-07-08T12:10:00.000Z:clear',
]);

const failedCalls: string[] = [];
await assert.rejects(
  () => syncShopifyAccount(account, {
    importOrders: async () => ({
      provider: 'shopify',
      accountId: '42',
      orders: [normalizedOrder],
      cursor: null,
      diagnostics: { hasNextPage: false, maxUpdatedAt: '2026-07-08T12:10:00.000Z' },
    }),
    persistOrders: async () => {
      failedCalls.push('persist');
      throw new Error('database unavailable');
    },
    updateAccountProgress: async () => {
      failedCalls.push('progress');
    },
  }),
  /database unavailable/,
);
assert.deepEqual(failedCalls, ['persist']);

console.log('PASS Shopify order sync cursor/floor semantics are pinned');
