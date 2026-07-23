/**
 * PS-447 offline certification for ShipStation v2 admission.
 * No provider or production database calls are made.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DurableTokenBucket,
  type DurableTokenBucketStore,
} from '../src/lib/shipstation/durable-rate-limiter';
import { fetchWithTimeout } from '../src/lib/fetch-timeout';

type Row = { tokens: number; pauseUntil: number };

class SharedMemoryStore implements DurableTokenBucketStore {
  readonly rows = new Map<string, Row>();
  readonly attempts = new Map<string, number>();

  async seed(input: { key: string; capacity: number }): Promise<void> {
    if (!this.rows.has(input.key)) {
      this.rows.set(input.key, { tokens: input.capacity, pauseUntil: 0 });
    }
  }

  async tryAcquire({ key }: { key: string }): Promise<boolean> {
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    const row = this.rows.get(key)!;
    if (Date.now() < row.pauseUntil || row.tokens < 1) return false;
    row.tokens -= 1;
    return true;
  }

  async deferUntil({ key, delayMs }: { key: string; delayMs: number }): Promise<void> {
    const row = this.rows.get(key)!;
    row.tokens = 0;
    row.pauseUntil = Math.max(row.pauseUntil, Date.now() + delayMs);
  }
}

async function expectAborted(work: Promise<void>, label: string): Promise<void> {
  await assert.rejects(work, undefined, label);
}

async function main(): Promise<void> {
  // Two instances model two processes: their shared store grants one combined budget.
  const shared = new SharedMemoryStore();
  const apiProcess = new DurableTokenBucket('shared-key', 2, 0.000_001, shared);
  const workerProcess = new DurableTokenBucket('shared-key', 2, 0.000_001, shared);
  await Promise.all([apiProcess.acquire(), workerProcess.acquire()]);
  assert.equal(shared.rows.get('shared-key')?.tokens, 0, 'two processes must consume one shared budget');

  const cancelled = new AbortController();
  const blocked = workerProcess.acquire({ signal: cancelled.signal });
  setTimeout(() => cancelled.abort(new DOMException('cancelled', 'AbortError')), 10);
  await expectAborted(blocked, 'cancelled admission must stop while waiting for the next permit');
  const attemptsAfterAbort = shared.attempts.get('shared-key');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shared.attempts.get('shared-key'), attemptsAfterAbort, 'cancelled admission must stop polling');

  const otherKey = new DurableTokenBucket('other-key', 1, 0.000_001, shared);
  await otherKey.acquire();
  assert.equal(shared.rows.get('other-key')?.tokens, 0, 'API-key budgets must stay isolated');

  // A Retry-After written by one process pauses the same key for every process.
  const pausedStore = new SharedMemoryStore();
  const pausingProcess = new DurableTokenBucket('paused-key', 2, 0.000_001, pausedStore);
  const observingProcess = new DurableTokenBucket('paused-key', 2, 0.000_001, pausedStore);
  await pausingProcess.deferFor(100);
  const pauseAbort = new AbortController();
  const pausedAcquire = observingProcess.acquire({ signal: pauseAbort.signal });
  setTimeout(() => pauseAbort.abort(new DOMException('cancelled', 'AbortError')), 10);
  await expectAborted(pausedAcquire, 'shared Retry-After must block a second process');

  // The shared HTTP chokepoint must preserve a caller abort instead of replacing its signal.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  try {
    const caller = new AbortController();
    const request = fetchWithTimeout('https://offline.invalid/cancel', { signal: caller.signal }, 1_000);
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(request, (error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ), 'caller cancellation must reach the in-flight fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const client = readFileSync('src/lib/shipstation/client.ts', 'utf8');
  const rates = readFileSync('src/services/rates.ts', 'utf8');
  const backfillDecision = readFileSync('src/services/rate-preexpiry-refresh-request.ts', 'utf8');
  const connector = readFileSync('src/connectors/carrier/shipstation.ts', 'utf8');
  const tracking = readFileSync('src/connectors/tracking/shipstation.ts', 'utf8');
  const labels = readFileSync('src/lib/shipstation/labels.ts', 'utf8');
  const fetchTimeout = readFileSync('src/lib/fetch-timeout.ts', 'utf8');

  assert.match(client, /'interactive' \| 'batch' \| 'background'/);
  assert.match(rates, /interactiveRateFetchWaiters\.shift\(\)[\s\S]*batchRateFetchWaiters\.shift\(\)[\s\S]*backgroundRateFetchWaiters\.shift\(\)/);
  assert.match(backfillDecision, /priority: 'batch'/);
  assert.match(client, /deferShipStationV2Budget\(key, backoffMs\)/);
  assert.match(client, /shipStationV2DurableBucket\(apiKey\)\.deferFor\(delayMs\)/);
  assert.match(client, /acquireShipStationV2Budget\(key, opts\.priority \?\? 'interactive', requestSignal\)/);
  assert.match(client, /abortableDelay\(backoffMs, requestSignal\)/);
  assert.match(fetchTimeout, /AbortSignal\.any\(\[init\.signal, controller\.signal\]\)/);
  assert.match(connector, /priority: input\.priority \?\? 'background'/);
  assert.match(tracking, /priority: 'background'/);
  assert.match(labels, /priority: 'background'/);
  assert.doesNotMatch(labels, /ssCreateLabel[\s\S]{0,1200}priority: '(?:batch|background)'/);

  console.log('PASS PS-447 ShipStation admission guard');
}

void main();
