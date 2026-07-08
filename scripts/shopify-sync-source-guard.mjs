import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const service = read('src/services/shopify-order-sync.ts');
const scheduler = read('src/services/sync-scheduler.ts');
const env = read('src/lib/env.ts');
const migration = read('drizzle/0056_store_account_sync_state.sql');

assert(service.includes("provider = 'shopify'"), 'Shopify sync must load only Shopify store accounts');
assert(service.includes("source = 'admin'"), 'Shopify sync must only read operator-approved source=admin stores');
assert(service.includes('active = true'), 'Shopify sync must only read active stores');
assert(service.includes('sync_anchor_at'), 'Shopify sync must respect the approval anchor floor');
assert(service.includes('sync_cursor_at'), 'Shopify sync must advance incremental updated_at cursor');
assert(service.includes('last_sync_error'), 'Shopify sync must record per-store sync errors');
assert(env.includes('SHOPIFY_SYNC_ENABLED'), 'env must expose SHOPIFY_SYNC_ENABLED gate');
assert(scheduler.includes('syncShopifyOrders'), 'sync scheduler must invoke Shopify order sync');
assert(scheduler.includes('SHOPIFY_SYNC_ENABLED'), 'sync scheduler must keep Shopify sync behind env gate');
for (const column of ['sync_anchor_at', 'sync_cursor_at', 'last_synced_at', 'last_sync_error']) {
  assert(migration.includes(column), `migration must add ${column}`);
}

console.log('PASS Shopify sync source and state guards are pinned');
