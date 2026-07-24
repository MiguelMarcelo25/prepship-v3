import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { OrderSyncAccountDiagnostic } from '../src/services/order-sync';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { buildShopifyOrderSyncStatus } = await import('../src/services/shopify-order-sync');
const { buildSyncProviderStatusReadModel } = await import('../src/services/sync-provider-status-read-model');
const { syncJobAttemptSnapshotFromRow } = await import('../src/services/sync-job-queue');
const { formatSyncPill } = await import('../web/src/components/Views/orders-parity');

const nowMs = Date.parse('2026-07-24T05:06:30.000Z');
const shipStationAccount: OrderSyncAccountDiagnostic = {
  accountId: 'main',
  displayName: 'ShipStation main',
  ownerClientId: null,
  storeIds: [1],
  lastSyncedAt: '2026-07-24T05:06:20.000Z',
  ageSeconds: 10,
  runAgeSeconds: null,
  fresh: true,
  stale: false,
  state: 'fresh',
  activeJobId: null,
  lastStartedAt: '2026-07-24T05:06:18.000Z',
  lastCompletedAt: '2026-07-24T05:06:21.000Z',
  lastSuccessAt: '2026-07-24T05:06:21.000Z',
  lastFailureAt: null,
  lastError: null,
  backlogPasses: 0,
  backlogPages: 0,
  cursors: [],
};

const freshShopify = buildShopifyOrderSyncStatus([
  {
    id: 5,
    label: 'Shopify',
    lastSyncedAt: '2026-07-24T05:06:23.000Z',
    lastSyncError: null,
  },
], { enabled: true, nowMs });
assert.equal(freshShopify.health, 'healthy');
assert.equal(freshShopify.accounts[0]?.state, 'fresh');

const successfulAttempt = (name: string) => syncJobAttemptSnapshotFromRow({
  name,
  state: 'completed',
  created_on: '2026-07-24T05:06:17.000Z',
  started_on: '2026-07-24T05:06:18.000Z',
  completed_on: '2026-07-24T05:06:24.000Z',
  output: { ok: true },
});
const deferredShopifyAttempt = syncJobAttemptSnapshotFromRow({
  name: 'prepship.sync.shopify-orders',
  state: 'completed',
  created_on: '2026-07-24T05:06:17.000Z',
  started_on: '2026-07-24T05:06:18.000Z',
  completed_on: '2026-07-24T05:06:19.000Z',
  output: {
    ok: true,
    skipped: true,
    deferred: false,
    blockedBy: 'prepship.sync.orders',
    reason: 'lane_lock_held',
  },
});
assert.equal(deferredShopifyAttempt.blockedBy, 'prepship.sync.orders');
assert.equal(deferredShopifyAttempt.reason, 'lane_lock_held');

const baseInput = {
  nowMs,
  orders: {
    lastSyncedAt: shipStationAccount.lastSyncedAt,
    health: 'healthy' as const,
    allAccountsFresh: true,
    accounts: [shipStationAccount],
  },
  shipments: { lastSyncedAt: '2026-07-24T05:06:15.000Z' },
  shopify: freshShopify,
};
const deferredButFresh = buildSyncProviderStatusReadModel({
  ...baseInput,
  attempts: [
    successfulAttempt('prepship.sync.orders'),
    deferredShopifyAttempt,
    successfulAttempt('prepship.sync.shipments'),
  ],
});
assert.equal(deferredButFresh.summary.state, 'deferred');
assert.equal(deferredButFresh.summary.attentionProviderCount, 0);
assert.deepEqual(
  deferredButFresh.providers.find((provider) => provider.key === 'shopify_orders'),
  {
    key: 'shopify_orders',
    label: 'Shopify orders',
    enabled: true,
    state: 'deferred',
    fresh: true,
    lastSuccessfulAt: '2026-07-24T05:06:23.000Z',
    ageSeconds: 7,
    cadenceMinutes: 3,
    accountCount: 1,
    blockedBy: 'prepship.sync.orders',
    blockedByLabel: 'ShipStation orders',
    reason: 'lane_lock_held',
  },
);
assert.equal(
  formatSyncPill({
    status: 'done',
    mode: 'incremental',
    page: 0,
    lastSync: nowMs - 10_000,
    orders: baseInput.orders,
    shipments: baseInput.shipments,
    providerSummary: deferredButFresh.summary,
    providers: deferredButFresh.providers,
  }).text,
  'All sources live · Shopify waiting',
  'a fresh provider waiting for a shared lane must not look stale or actively syncing',
);

const activelySyncing = buildSyncProviderStatusReadModel({
  ...baseInput,
  attempts: [
    successfulAttempt('prepship.sync.orders'),
    syncJobAttemptSnapshotFromRow({
      name: 'prepship.sync.shopify-orders',
      state: 'active',
      created_on: '2026-07-24T05:06:25.000Z',
      started_on: '2026-07-24T05:06:26.000Z',
    }),
    successfulAttempt('prepship.sync.shipments'),
  ],
});
assert.equal(activelySyncing.summary.state, 'running');
assert.equal(
  formatSyncPill({
    status: 'done',
    mode: 'incremental',
    page: 0,
    lastSync: nowMs - 10_000,
    providerSummary: activelySyncing.summary,
    providers: activelySyncing.providers,
  }).text,
  'Syncing Shopify orders…',
);

const queuedButFresh = buildSyncProviderStatusReadModel({
  ...baseInput,
  attempts: [
    syncJobAttemptSnapshotFromRow({
      name: 'prepship.sync.orders',
      state: 'created',
      created_on: '2026-07-24T05:06:25.000Z',
    }),
    successfulAttempt('prepship.sync.shopify-orders'),
    successfulAttempt('prepship.sync.shipments'),
  ],
});
assert.equal(queuedButFresh.summary.state, 'queued');
assert.equal(
  formatSyncPill({
    status: 'done',
    mode: 'incremental',
    page: 0,
    lastSync: nowMs - 10_000,
    providerSummary: queuedButFresh.summary,
    providers: queuedButFresh.providers,
  }).text,
  'All sources live · ShipStation queued',
  'a scheduled refresh must not hide that its current provider data is still fresh',
);

const staleShopify = buildShopifyOrderSyncStatus([
  {
    id: 5,
    label: 'Shopify',
    lastSyncedAt: '2026-07-24T04:30:00.000Z',
    lastSyncError: null,
  },
], { enabled: true, nowMs });
const attention = buildSyncProviderStatusReadModel({
  ...baseInput,
  shopify: staleShopify,
  attempts: [
    successfulAttempt('prepship.sync.orders'),
    successfulAttempt('prepship.sync.shopify-orders'),
    successfulAttempt('prepship.sync.shipments'),
  ],
});
assert.equal(attention.summary.state, 'attention');
assert.equal(attention.summary.attentionProviderCount, 1);

const failedShopify = buildShopifyOrderSyncStatus([
  {
    id: 5,
    label: 'Shopify',
    lastSyncedAt: '2026-07-24T05:06:23.000Z',
    lastSyncError: 'auth',
  },
], { enabled: true, nowMs });
assert.equal(failedShopify.health, 'error');
assert.equal(failedShopify.accounts[0]?.state, 'failed');

const read = (path: string) => readFileSync(path, 'utf8');
assert.match(read('src/routes/sync.ts'), /buildSyncProviderStatusReadModel/);
assert.match(read('src/routes/sync.ts'), /providerSummary: providerStatus\.summary/);
assert.match(read('web/src/Home.tsx'), /providerBusy/);
assert.match(read('web/src/components/Views/orders-parity.ts'), /providerSummary/);
assert.match(
  read('package.json'),
  /"test:sync-provider-status"\s*:\s*"tsx scripts\/sync-provider-status-read-model-guard\.ts"/,
);

console.log('PASS backend sync provider freshness and deferred-reason read model');
