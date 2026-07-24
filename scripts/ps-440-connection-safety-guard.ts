/**
 * PS-440 offline certification. All provider calls are mocked; the database is
 * in-memory PGlite. This script never buys postage, creates a real label,
 * notifies a marketplace, or connects to production.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema/index.js';
import { fetchWithTimeout } from '../src/lib/fetch-timeout.js';
import { withPgBossPoolLifetime } from '../src/lib/pg-boss-pool-lifetime.js';
import { SYNC_JOB_LANE_VALUES } from '../src/services/sync-job-lanes.js';
import { classifyWorkerResolvedResult } from '../src/services/worker-result-classification.js';
import {
  assertPurchasedLabelArtifact,
  LabelArtifactMissingAfterPurchaseError,
} from '../src/services/label-artifact-safety.js';
import { planQueueSendRecovery } from '../src/services/print-queue/queue-send-recovery.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://ps440:ps440@localhost:5432/ps440';
process.env.SUPABASE_URL ||= 'https://ps440.invalid';
process.env.SUPABASE_ANON_KEY ||= 'ps440-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'ps440-service';
process.env.SUPABASE_JWT_SECRET ||= 'ps440-jwt';
process.env.RATE_LIMITER_BACKEND = 'memory';

async function proveBodyTimeout(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.flushHeaders();
    response.write('partial');
    // Deliberately leave the body open. fetchWithTimeout must abort the read.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PS-440 test server did not bind');

  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${address.port}/stalled-body`,
      {},
      1_000,
    );
    assert.equal(response.status, 200, 'the fixture must receive headers before testing body timeout');
    await assert.rejects(response.text(), undefined, 'a stalled response body must be timeout-bounded');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function proveShopifyCancellation(): Promise<void> {
  const { syncShopifyAccount } = await import('../src/services/shopify-order-sync.js');
  const abort = new AbortController();
  let persisted = 0;
  let progressWrites = 0;
  const account = {
    id: 440,
    clientId: 44,
    source: 'admin',
    active: true,
    credentials: { shopDomain: 'offline.invalid', adminAccessToken: 'mock' },
    syncAnchorAt: new Date('2026-07-23T00:00:00.000Z'),
    syncCursorAt: null,
  };

  await assert.rejects(
    syncShopifyAccount(account, {
      signal: abort.signal,
      resolveClientContext: async () => ({ clientId: 44, syntheticStoreId: 9_200_440 }),
      importOrders: async (_provider, input) => {
        assert.equal(input.signal, abort.signal, 'worker cancellation must reach Shopify GraphQL');
        abort.abort(new DOMException('cancelled', 'AbortError'));
        return { provider: 'shopify', accountId: '440', orders: [], cursor: null };
      },
      persistOrders: async () => {
        persisted += 1;
        return 0;
      },
      updateAccountProgress: async () => {
        progressWrites += 1;
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(persisted, 0, 'a cancelled Shopify job must not persist orders');
  assert.equal(progressWrites, 0, 'a cancelled Shopify job must not advance its cursor');
}

async function proveShipStationTotalDeadline(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    calls += 1;
    return new Response('temporarily unavailable', { status: 503 });
  }) as typeof fetch;
  try {
    const { ssV1Request } = await import('../src/lib/shipstation/v1-client.js');
    const startedAt = Date.now();
    await assert.rejects(
      ssV1Request('/offline', {
        apiKey: 'mock-key',
        apiSecret: 'mock-secret',
        timeoutMs: 35,
        maxRetries: 5,
      }),
    );
    assert.ok(Date.now() - startedAt < 500, 'the total deadline must include retry backoff');
    assert.equal(calls, 1, 'the expired total budget must stop subsequent attempts');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function proveWalmartReceiptFence(): Promise<void> {
  const ledger = await import('../src/services/fulfillment-operation-ledger.js');
  const client = new PGlite();
  try {
    await client.exec(readFileSync(new URL('../drizzle/0072_external_operations.sql', import.meta.url), 'utf8'));
    const database = drizzle(client, { schema, casing: 'snake_case' });
    let token = 0;
    const dependencies = {
      database: database as never,
      ensureSchema: async () => undefined,
      randomToken: () => `ps440-token-${++token}`,
    } as Parameters<typeof ledger.acquireFulfillmentOperation>[1];
    const operationInput = {
      kind: 'forward_label' as const,
      provider: 'walmart_shipping',
      subjectType: 'order',
      subjectId: 440001,
      semanticGeneration: 1,
      request: { serviceCode: 'walmart_ground', packageId: 44 },
    };
    const acquired = await ledger.acquireFulfillmentOperation(operationInput, dependencies);
    assert.equal(acquired.kind, 'dispatch');
    if (acquired.kind !== 'dispatch') throw new Error('Walmart fixture did not acquire dispatch');

    let providerPosts = 0;
    const purchased = await ledger.dispatchFulfillmentOperation(
      {
        lease: acquired.lease,
        execute: async () => {
          providerPosts += 1;
          return {
            labelId: 'walmart-label-440001',
            trackingNumber: 'WM440001',
            labelUrl: '',
          };
        },
        normalizeReceipt: (result) => ({
          receipt: { created: result },
          providerOperationId: result.labelId,
          providerResultId: result.trackingNumber,
        }),
      },
      dependencies,
    );

    assert.throws(
      () => assertPurchasedLabelArtifact('Walmart Shipping', purchased.labelUrl),
      LabelArtifactMissingAfterPurchaseError,
    );
    const recorded = await ledger.getLatestLabelOperationForOrder(440001, dependencies);
    assert.equal(recorded?.state, 'receipt_recorded', 'empty artifact remains a durable receipt');
    const retry = await ledger.acquireFulfillmentOperation(operationInput, dependencies);
    assert.equal(retry.kind, 'resume_receipt', 'retry must reuse the recorded Walmart receipt');
    assert.equal(providerPosts, 1, 'retry must not issue a second mocked provider POST');

    const recovery = planQueueSendRecovery({
      workerOrders: [{ orderId: 440001, clientId: 44 }],
      itemStates: [{
        orderId: 440001,
        clientId: 44,
        state: 'provider_pending_recovery',
        blockedReason: 'label_purchase_reconciliation_required',
      }],
    });
    assert.deepEqual(recovery.safeOrders, []);
    assert.deepEqual(recovery.providerPendingOrderIds, [440001]);
  } finally {
    await client.close();
  }
}

async function proveExternalShippedSingleNotify(): Promise<void> {
  const { markOrderShippedExternally } = await import(
    '../src/services/fulfillment/mark-shipped-externally.js'
  );
  let transitionWon = false;
  let notifications = 0;
  const applyLifecycleCommand = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (transitionWon) {
      return { statusChanged: false };
    }
    transitionWon = true;
    return { statusChanged: true };
  };
  const input = {
    order: {
      id: 440002,
      sourceProvider: 'walmart',
      externalOrderId: 'walmart-440002',
      clientId: 44,
      orderNumber: 'PS-440-002',
      raw: {},
    },
    flag: true,
    trackingNumber: 'WM440002',
    carrierCode: 'ups',
    notifyMarketplace: true,
    writeAuthorization: { allowTerminal: false },
  };
  const dependencies = {
    applyLifecycleCommand: applyLifecycleCommand as never,
    resolveProvider: (() => 'walmart') as never,
    confirmDirect: (async () => {
      notifications += 1;
      return { ok: true };
    }) as never,
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  };

  const results = await Promise.all([
    markOrderShippedExternally(input as never, dependencies),
    markOrderShippedExternally(input as never, dependencies),
  ]);
  assert.equal(results.filter((result) => result.statusFlipped).length, 1);
  assert.equal(notifications, 1, 'two concurrent calls must notify the marketplace once');
}

async function main(): Promise<void> {
  assert.equal(new Set(SYNC_JOB_LANE_VALUES).size, 8, 'the canonical lane set has eight unique lanes');
  const laneLock = readFileSync(new URL('../src/services/sync-lane-lock.ts', import.meta.url), 'utf8');
  assert.match(laneLock, /SYNC_LANE_LOCK_POOL_MAX = SYNC_JOB_LANE_VALUES\.length/);

  const bounded = withPgBossPoolLifetime({ connectionString: process.env.DATABASE_URL }, 77);
  assert.equal(bounded.maxLifetimeSeconds, 77);
  for (const file of [
    '../src/services/sync-job-queue.ts',
    '../src/services/rate-backfill-job-producer.ts',
    '../src/services/rate-browse-worker.ts',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new PgBoss\(\{/);
    assert.match(source, /withPgBossPoolLifetime/);
  }

  assert.equal(classifyWorkerResolvedResult({ candidates: 3, checked: 0, errors: 3 }).status, 'failed');
  assert.equal(classifyWorkerResolvedResult({ attemptedAccounts: 2, synced: 0, errors: 2 }).status, 'failed');
  assert.equal(classifyWorkerResolvedResult({ attemptedAccounts: 2, synced: 0, errors: 1 }).status, 'succeeded');

  const webhook = readFileSync(new URL('../src/routes/webhooks.ts', import.meta.url), 'utf8');
  assert.match(webhook, /ok: false, recorded: false, retryable: true \}, 503/);
  assert.doesNotMatch(webhook, /ok: true, recorded: false \}, 202/);

  const reporting = readFileSync(new URL('../src/services/reporting-metrics.ts', import.meta.url), 'utf8');
  assert.equal(
    reporting.match(/withRefreshRun\([^\n]+\(\) => db\.transaction/g)?.length,
    4,
    'all four DELETE+INSERT projection replacements are transactional',
  );

  const labels = readFileSync(new URL('../src/services/labels.ts', import.meta.url), 'utf8');
  const walmartGuardAt = labels.indexOf("directProviderKey === 'walmart_shipping'");
  const consumeAt = labels.indexOf('consumeFulfillmentOperation(operationId', walmartGuardAt);
  assert.ok(walmartGuardAt > 0 && consumeAt > walmartGuardAt);
  assert.match(labels.slice(walmartGuardAt, consumeAt), /assertPurchasedLabelArtifact/);

  await proveBodyTimeout();
  await proveShopifyCancellation();
  await proveShipStationTotalDeadline();
  await proveWalmartReceiptFence();
  await proveExternalShippedSingleNotify();

  console.log('PASS PS-440 connection, cancellation, failure-truth, and provider-safety guard');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
