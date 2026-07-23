/**
 * PS-442 offline closeout guard.
 *
 * No database/provider calls, labels, postage, marketplace notifications, or
 * production order/shipment mutations occur in this test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderShipmentSyncAccountsByWatermark } from '../src/services/shipment-sync-fairness';
import { resolveSyncJobAdmission } from '../src/services/sync-job-admission';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  PRODUCT_SYNC_NEXT_ACCOUNT_KEY,
  followingProductSyncAccountId,
  productSyncPageKey,
  rotateProductSyncAccounts,
} = await import('../src/services/inventory-product-sync-progress');

const productAccounts = [
  { label: 'main', ownerClientId: null },
  { label: 'Renamable A', ownerClientId: 41 },
  { label: 'Renamable B', ownerClientId: 42 },
];
const rotated = rotateProductSyncAccounts(productAccounts, 'client:42');
assert.deepEqual(rotated.map((account) => account.ownerClientId), [42, null, 41]);
assert.equal(followingProductSyncAccountId(rotated, 0), 'main');
assert.equal(productSyncPageKey(productAccounts[1]!), 'inventory.shipstation_products.next_page:client:41');
assert.equal(PRODUCT_SYNC_NEXT_ACCOUNT_KEY, 'inventory.shipstation_products.next_account');

const fairShipmentAccounts = orderShipmentSyncAccountsByWatermark([
  { account: 'fresh', accountId: 'client:3', watermarkMs: 300, primaryKey: 'fresh-key' },
  { account: 'never-run', accountId: 'client:2', watermarkMs: null, primaryKey: 'never-key' },
  { account: 'old', accountId: 'client:1', watermarkMs: 100, primaryKey: 'old-key' },
]);
assert.deepEqual(fairShipmentAccounts.map((row) => row.account), ['never-run', 'old', 'fresh']);
assert.equal(fairShipmentAccounts[0]!.primaryKey, 'never-key');

assert.deepEqual(
  resolveSyncJobAdmission('prepship.sync.inventory-import', {
    kind: 'busy-defer',
    recoveryPriority: false,
  }),
  { policy: 'standard', singletonKey: 'busy-defer', priority: 0 },
);
assert.deepEqual(
  resolveSyncJobAdmission('prepship.sync.products', {
    kind: 'busy-defer',
    recoveryPriority: false,
  }),
  { policy: 'standard', singletonKey: 'busy-defer', priority: 0 },
);

const read = (path: string): string => readFileSync(path, 'utf8');
const inventory = read('src/services/inventory-enrichment.ts');
const shipstationConnector = read('src/connectors/store/shipstation.ts');
const queue = read('src/services/sync-job-queue.ts');
const reaper = read('src/services/sync-stuck-job-reaper.ts');
const shipmentSync = read('src/services/shipment-sync.ts');
const reporting = read('src/services/reporting-metrics.ts');
const packageRoute = read('src/routes/packages.ts');
const packageReviews = read('src/services/package-consumption-review-read-model.ts');
const walmartFees = read('src/connectors/store/walmart-fees.ts');
const scheduler = read('src/services/sync-scheduler.ts');
const orderSync = read('src/services/order-sync.ts');
const shopifySync = read('src/services/shopify-order-sync.ts');
const ratesBackfill = read('src/services/rates-backfill.ts');
const timeoutRetry = read('src/services/with-timeout-retry.ts');
const packageSchema = read('src/services/package-consumption-schema.ts');

assert.match(orderSync, /AWAITING_RESUME_CURSOR_KEY_PREFIX/);
assert.match(inventory, /productSyncPageKey\(acct\)/);
assert.match(inventory, /maxPagesPerAccount \?\? 2/);
assert.match(inventory, /timeBudgetExhausted/);
assert.match(inventory, /errors: Array<\{ account: string; message: string \}>/);
assert.match(shipstationConnector, /listShipStationProducts[\s\S]*signal: input\.signal/);

const busyDeferBlock = queue.slice(
  queue.indexOf('const BUSY_DEFER_JOB_NAMES'),
  queue.indexOf('const SHIPSTATION_CONSUMER_LEADER_LOCK'),
);
assert.match(busyDeferBlock, /JOBS\.inventoryImport/);
assert.match(busyDeferBlock, /JOBS\.syncProducts/);
assert.match(queue, /runSyncProductsTick\(signal\)/);
assert.match(reaper, /MANUAL_FULL_ORDER_SINGLETON_KEY/);

assert.match(shipmentSync, /orderShipmentSyncAccountsByWatermark/);
assert.match(shipmentSync, /deferredAccounts/);
assert.match(shipmentSync, /timeBudgetExhausted/);
assert.match(shipmentSync, /Math\.max\(storedLastSync \?\? 0, candidateMs\)/);
assert.match(orderSync, /shipStationSyncWatermarkKeys/);

assert.match(shopifySync, /SHOPIFY_SYNC_MAX_PAGES_PER_RUN/);
assert.match(shopifySync, /signal\?\.throwIfAborted/);

assert.match(ratesBackfill, /DurableRateBackfillGenerationState/);
assert.match(ratesBackfill, /nextPayload: payload/);
assert.match(ratesBackfill, /shouldCoalesceCadenceGeneration/);

assert.match(reporting, /reapStaleReportingRefreshRuns/);
assert.match(reporting, /where status = 'running'/);
assert.match(reporting, /status = 'failure'/);
assert.match(packageRoute, /app\.get\('\/consumption-reviews'/);
assert.match(packageReviews, /packageConsumptionReviews\.status/);
assert.match(packageReviews, /pending/);

assert.match(scheduler, /runReapStaleRateJobsTick/);
assert.match(scheduler, /runRateCacheEvictionTick/);
assert.match(queue, /await runReapStaleRateJobsTick\(\)/);
assert.match(queue, /await runRateCacheEvictionTick\(\)/);

assert.match(walmartFees, /fetchWithTimeout\('https:\/\/marketplace\.walmartapis\.com\/v3\/token'/);
assert.match(walmartFees, /fetchWithTimeout\([\s\S]*WALMART_REQUEST_TIMEOUT_MS/);
assert.match(walmartFees, /signal\?\.throwIfAborted\(\)/);
assert.match(scheduler, /syncWalmartFeesAllAccounts\(pg, fromDate, toDate\)/);

assert.match(timeoutRetry, /timeoutController\.abort\(timeoutError\)/);
assert.match(timeoutRetry, /await operationPromise\.catch/);
assert.match(packageSchema, /assertRuntimeSchemaReady/);
const runtimeDdlPattern = new RegExp(
  `${'create'}\\s+${'table'}|${'alter'}\\s+${'table'}`,
  'i',
);
assert.doesNotMatch(packageSchema, runtimeDdlPattern);

console.log('PASS PS-442 sync fairness, durable state, and provider cancellation guard');
