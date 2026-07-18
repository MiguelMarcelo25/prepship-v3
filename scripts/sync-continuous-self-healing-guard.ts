/**
 * Continuous ShipStation sync guard.
 *
 * Offline only: no database/provider calls and no order/shipment mutations.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TokenBucket, type RateBucket } from '../src/lib/shipstation/rate-limiter';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  classifyOrderSyncQueueRows,
  hasPendingOrderSyncWork,
} = await import('../src/services/order-sync-queue-state');

const empty = classifyOrderSyncQueueRows([]);
assert.equal(hasPendingOrderSyncWork(empty), false);
assert.equal(
  hasPendingOrderSyncWork(classifyOrderSyncQueueRows([{ id: 'order-1', state: 'created' }])),
  true,
);
assert.equal(
  hasPendingOrderSyncWork(classifyOrderSyncQueueRows([{ id: 'order-2', state: 'retry' }])),
  true,
);
assert.equal(
  hasPendingOrderSyncWork(classifyOrderSyncQueueRows([{ id: 'order-3', state: 'active' }])),
  false,
  'an active row cannot preempt another lane owner; only runnable pending work may do so',
);

const bucket: RateBucket = new TokenBucket(1, 1 / 60_000);
await bucket.acquire();
const abort = new AbortController();
const blockedAcquire = bucket.acquire({ signal: abort.signal });
abort.abort(new Error('order refresh pending'));
await assert.rejects(blockedAcquire, /order refresh pending/);

const read = (path: string): string => readFileSync(path, 'utf8');
const queue = read('src/services/sync-job-queue.ts');
const v1 = read('src/lib/shipstation/v1-client.ts');
const laneLock = read('src/services/sync-lane-lock.ts');
const scheduler = read('src/services/sync-scheduler.ts');

assert.match(
  queue,
  /runShipmentSyncWithOrderPriority[\s\S]*hasPendingOrderSyncWork[\s\S]*preempt\.abort/,
);
assert.match(
  queue,
  /runShipmentSyncWithOrderPriority[\s\S]*deferBusySyncJob\([\s\S]*JOBS\.shipments,[\s\S]*JOBS\.orders/,
);
assert.match(
  queue,
  /jobData && typeof jobData === 'object'[\s\S]*jobData as Record<string, unknown>/,
  'priority deferral must preserve the original shipment payload',
);
assert.match(v1, /bucket\.acquire\(\{ signal: opts\.signal \}\)/);
assert.match(
  laneLock,
  /SYNC_LANE_IDLE_TRANSACTION_TIMEOUT_MS = SYNC_JOB_RUNNING_LEASE_MS \+ 5_000/,
);
assert.match(
  laneLock,
  /idle_in_transaction_session_timeout: SYNC_LANE_IDLE_TRANSACTION_TIMEOUT_MS/,
);
assert.match(
  queue,
  /if \(!this\.consumersRegistered\) \{[\s\S]{0,500}?await this\.dependencies\.recoverActiveJobs\(\);[\s\S]{0,200}?await this\.dependencies\.readActiveJobs\(\)/,
  'consumer handoff must recover safe orphan rows before applying its active-job fence',
);
assert.match(
  queue,
  /recoverActiveJobs: async \(\) => \{[\s\S]{0,200}?await reapStuckActiveJobs\(\)/,
  'the handoff recovery dependency must delegate to the canonical stuck-job reaper',
);
assert.match(queue, /unlock shipped data on 2026-07-18/);
assert.match(v1, /unlock shipped data on 2026-07-18/);
assert.match(laneLock, /unlock shipped data on 2026-07-18/);
assert.match(scheduler, /FULFILLMENT_OUTBOX_BATCH_LIMIT = 1/);
assert.match(
  scheduler,
  /processFulfillmentOutboxOnce\(\{[\s\S]*limit: FULFILLMENT_OUTBOX_BATCH_LIMIT/,
);

console.log('PASS continuous ShipStation sync self-healing guard');
