import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { orderOverrides } from '../src/db/schema/orders.js';
import { persistBestRateWithRatchet } from '../src/services/best-rate-ratchet-db.js';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function rate(totalCost: number, isComplete = false, requestFingerprint = 'same-inputs') {
  return {
    shipmentCost: totalCost,
    otherCost: 0,
    totalCost,
    requestFingerprint,
    isComplete,
  };
}

async function main(): Promise<void> {
  const backfill = read('src/services/rates-backfill.ts');
  const producer = read('src/services/rate-backfill-job-producer.ts');
  const queue = read('src/services/sync-job-queue.ts');
  const importOwner = read('src/services/store-order-import.ts');
  const ratesRoute = read('src/routes/rates.ts');
  const browseStore = read('src/services/rate-browse-job-store.ts');
  const browseWorkflowStore = read('src/services/rate-browse-workflow-store.ts');
  const browseWorker = read('src/services/rate-browse-worker.ts');
  const workerFenceMigration = read('drizzle/0067_durable_worker_execution_fences.sql');
  const ratchet = read('src/services/best-rate-ratchet-db.ts');
  const doc = read('docs/ps-tickets/audit-5.5-multi-instance-readiness.md');
  const audit = read('AUDIT-2026-07-13.md');

  assert.match(producer, /new PgBoss/);
  assert.match(producer, /id: payload\.jobId/);
  assert.match(backfill, /enqueueDurableRateBackfillJob\(payload\)/);
  assert.match(queue, /parseDurableRateBackfillJobPayload\(jobData\)/);
  assert.match(queue, /runDurableRateBackfillJob\(explicitRequest, signal\)/);
  assert.match(queue, /ratePayload \? \{ \.\.\.ratePayload, \.\.\.deferredMetadata \}/);
  assert.match(queue, /ratePayload\?\.jobId \?\? 'cadence'/);
  assert.match(queue, /durable rate-backfill deferral failed; retrying original queue job/);
  assert.match(importOwner, /await enqueueBackfillBestRatesForOrderIds\([\s\S]{0,120}'rate-on-ingest'/);
  assert.match(ratesRoute, /await enqueueBackfillBestRates\(body, 'manual'\)/);
  assert.doesNotMatch(backfill, /queuedRateOnIngestOrderIds|queuedBackfillRequests/);
  assert.match(backfill, /MAX_COMPLETED_JOBS_IN_MEMORY = 25/);
  assert.match(backfill, /pruneCompletedBackfillJobs\(\)/);

  assert.doesNotMatch(browseStore, /SELECT pg_advisory_lock|queueMicrotask/);
  assert.match(workerFenceMigration, /rate_browse_jobs_request_active_unq/);
  assert.match(browseStore, /generation = generation \+ 1/);
  assert.match(browseStore, /heartbeatRateBrowseJobRecord/);
  assert.match(browseWorker, /RATE_BROWSE_JOB_NAME/);
  assert.match(browseWorker, /runDurableWorkerAttempt/);
  assert.match(browseWorkflowStore, /durableReservationFailureSnapshot/);
  assert.match(browseWorkflowStore, /created: false/);
  assert.match(browseWorkflowStore, /provider work was not started/);

  assert.match(ratchet, /persistBestRateWithRatchet/);
  assert.match(ratchet, /IS NOT DISTINCT FROM/);
  assert.match(ratchet, /onConflictDoNothing/);

  const client = new PGlite();
  const testDb = drizzle(client, { schema, casing: 'snake_case' });
  const connection = testDb as unknown as Parameters<typeof persistBestRateWithRatchet>[2];
  await testDb.execute(sql`CREATE TABLE order_overrides (
    order_id integer PRIMARY KEY,
    residential boolean,
    tracking_number text,
    notes text DEFAULT '',
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    ref_usps_rate text,
    ref_ups_rate text,
    rate_weight_oz real,
    rate_dims_l real,
    rate_dims_w real,
    rate_dims_h real,
    selected_pid integer,
    selected_package_id text,
    best_rate_json jsonb,
    best_rate_at timestamptz,
    best_rate_dims text,
    recipient_override jsonb,
    shipping_account text,
    externally_shipped_source text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await Promise.all([
    persistBestRateWithRatchet(1, { bestRateJson: rate(10.14), updatedAt: new Date() }, connection),
    persistBestRateWithRatchet(1, { bestRateJson: rate(11.66), updatedAt: new Date() }, connection),
  ]);
  const [winner] = await testDb
    .select({ bestRateJson: orderOverrides.bestRateJson })
    .from(orderOverrides)
    .where(sql`${orderOverrides.orderId} = 1`);
  assert.equal(
    Number((winner?.bestRateJson as { totalCost?: unknown } | null)?.totalCost),
    10.14,
    'concurrent thin quotes must settle on the cheaper same-input winner',
  );

  const blocked = await persistBestRateWithRatchet(
    1,
    { bestRateJson: rate(12.25), updatedAt: new Date() },
    connection,
  );
  assert.deepEqual(blocked, { persisted: false, blocked: true });

  const complete = await persistBestRateWithRatchet(
    1,
    { bestRateJson: rate(12.25, true), updatedAt: new Date() },
    connection,
  );
  assert.deepEqual(complete, { persisted: true, blocked: false });

  for (const heading of [
    'Business rule/workflow being changed',
    'Canonical backend/domain/read-model/policy owner',
    'Current duplicated/unsafe owners',
    'Where bad/stale/incomplete data can enter',
    'Callers that must delegate to the owner',
    'Wrapper/resolver/helper logic to delete or explicitly forbid',
    'Frontend role: display/action only; no authoritative business logic',
    'Backend boundary tests required',
    'Workflow/UI proof required',
    'Per-instance state inventory',
  ]) {
    assert.ok(doc.includes(heading), `Audit 5.5 document includes ${heading}`);
  }
  assert.match(audit, /- \[x\] 5\.5 \*\*Multi-instance readiness complete\*\*/);

  await client.close();
  console.log('PASS Audit 5.5 multi-instance readiness guard');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
