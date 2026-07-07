/**
 * Guard: batch-print pipeline (Create + Print via chained backend queue jobs).
 *
 * Behavioral half — exercises the pure chain module with injected fakes:
 *   - proof pre-pass only re-rates orders that need an override
 *   - recalc/override failures are collected, and those orders are EXCLUDED
 *     from the queue-send call (never sent to the purchase boundary broken)
 *   - fade callback fires per successfully bought order
 *   - the print tail runs only when the send job queued entries
 *
 * Wiring half (appended by a later task) — source-asserts the OrdersView
 * flag-ON branch chains the two backend jobs and never buys from the FE.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectBatchPrintProofOverrides,
  runCreatePrintChain,
} from '../web/src/components/Views/batch-create-print-chain';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((err) => {
      failures += 1;
      console.error(`FAIL ${name}:`, err instanceof Error ? err.message : err);
    });
}

const sequentialPool = async <T>(items: T[], worker: (item: T) => Promise<void>) => {
  for (const item of items) await worker(item);
};

async function main() {
  await check('proof pass re-rates only orders needing an override', async () => {
    const recalculated: number[] = [];
    const result = await collectBatchPrintProofOverrides(
      [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
      {
        needsOverride: (order) => order.orderId === 2,
        recalculate: async (order) => {
          recalculated.push(order.orderId);
          return { ok: true as const, rate: { amount: 9.86 } };
        },
        buildOverride: () => ({ serviceCode: 'ups_ground' }),
        runPool: sequentialPool,
      },
    );
    assert.deepEqual(recalculated, [2]);
    assert.deepEqual([...result.overrides.keys()], [2]);
    assert.equal(result.failures.length, 0);
  });

  await check('recalc failure and null override become failures, not overrides', async () => {
    const result = await collectBatchPrintProofOverrides(
      [{ orderId: 1 }, { orderId: 2 }],
      {
        needsOverride: () => true,
        recalculate: async (order) =>
          order.orderId === 1
            ? { ok: false as const, message: 'rate expired' }
            : { ok: true as const, rate: {} },
        buildOverride: () => null,
        runPool: sequentialPool,
      },
    );
    assert.equal(result.overrides.size, 0);
    assert.equal(result.failures.length, 2);
    assert.equal(result.failures[0]!.message, 'rate expired');
    assert.match(result.failures[1]!.message, /could not be proven/);
  });

  await check('chain excludes proof-failed orders from the send and sequences fade + print', async () => {
    const sentOrderIds: number[] = [];
    const faded: number[] = [];
    let printedWith: string[] | null = null;
    const outcome = await runCreatePrintChain(
      [
        { orderId: 1, orderNumber: 'A-1' },
        { orderId: 2, orderNumber: 'A-2' },
      ],
      {
        needsOverride: (order) => order.orderId === 2,
        recalculate: async () => ({ ok: false as const, message: 'rate expired' }),
        buildOverride: () => null,
        runPool: sequentialPool,
        sendToQueue: async (orders) => {
          sentOrderIds.push(...orders.map((order) => order.orderId));
          return {
            queued: 1,
            failed: 0,
            queuedEntryIds: ['entry-1'],
            successOrderIds: new Set([1]),
            skippedErrors: [],
          };
        },
        printEntries: async (entryIds) => {
          printedWith = entryIds;
          return true;
        },
        markShipped: (orderId) => faded.push(orderId),
      },
    );
    assert.deepEqual(sentOrderIds, [1]);
    assert.deepEqual(faded, [1]);
    assert.deepEqual(printedWith, ['entry-1']);
    assert.equal(outcome.queued, 1);
    assert.equal(outcome.failed, 1); // the proof-failed order counts as failed
    assert.equal(outcome.printed, true);
    assert.equal(outcome.printAttempted, true);
    assert.match(outcome.errors[0]!, /^A-2: rate expired$/);
  });

  await check('chain skips the print tail when nothing queued', async () => {
    let printCalled = false;
    const outcome = await runCreatePrintChain(
      [{ orderId: 5, orderNumber: 'B-5' }],
      {
        needsOverride: () => false,
        recalculate: async () => ({ ok: true as const, rate: {} }),
        buildOverride: () => ({}),
        runPool: sequentialPool,
        sendToQueue: async () => ({
          queued: 0,
          failed: 1,
          queuedEntryIds: [],
          successOrderIds: new Set<number>(),
          skippedErrors: ['Order B-5: Missing label payload'],
        }),
        printEntries: async () => {
          printCalled = true;
          return true;
        },
        markShipped: () => {},
      },
    );
    assert.equal(printCalled, false);
    assert.equal(outcome.printed, false);
    assert.equal(outcome.printAttempted, false);
    assert.deepEqual(outcome.errors, ['Order B-5: Missing label payload']);
  });

  // ── Wiring half: source asserts on the flag plumbing and the flag-ON branch ──
  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  const envSource = readFileSync('src/lib/env.ts', 'utf8');
  const usersRoute = readFileSync('src/routes/users.ts', 'utf8');
  const jobKinds = readFileSync('web/src/components/Views/orders-persistent-queue-job.ts', 'utf8');

  const sourceCheck = (name: string, condition: boolean) => {
    if (!condition) {
      failures += 1;
      console.error(`FAIL ${name}`);
    } else {
      console.log(`ok   ${name}`);
    }
  };

  // 2026-07-07 cleanup slice (post-live-canary): the legacy sequential loop AND the
  // BATCH_PRINT_VIA_QUEUE rollout flag are DELETED — the chain is the only batch path.
  // These asserts pin the deletion so neither can silently come back.
  sourceCheck(
    'BATCH_PRINT_VIA_QUEUE rollout flag fully retired (env + /users/me + OrdersView)',
    !envSource.includes('BATCH_PRINT_VIA_QUEUE:') &&
      !usersRoute.includes('batchPrintViaQueue') &&
      !ordersView.includes('batchPrintViaQueue'),
  );
  sourceCheck("job kind union includes 'create-print'", /'create-print'/.test(jobKinds));

  const batchActionStart = ordersView.indexOf('async function handleBatchAction');
  const batchActionEnd = ordersView.indexOf('async function handleBatchMarkAsShipped');
  sourceCheck('handleBatchAction slice found', batchActionStart >= 0 && batchActionEnd > batchActionStart);
  const batchActionSlice =
    batchActionStart >= 0 && batchActionEnd > batchActionStart
      ? ordersView.slice(batchActionStart, batchActionEnd)
      : '';
  sourceCheck(
    'print mode chains runCreatePrintChain UNCONDITIONALLY',
    /if \(mode === 'print'\) \{/.test(batchActionSlice) && /runCreatePrintChain\(/.test(batchActionSlice),
  );
  sourceCheck(
    "chain uses kind 'create-print' + deferred refetch",
    /kind:\s*'create-print'/.test(batchActionSlice) && /deferOrdersRefetch:\s*true/.test(batchActionSlice),
  );
  sourceCheck('batch action NEVER buys from the FE (no apiClient.createLabel)', !/apiClient\.createLabel\(/.test(batchActionSlice));
  sourceCheck('legacy sequential per-order loop is deleted', !batchActionSlice.includes('const processOrder = async'));
  sourceCheck(
    'exactly ONE apiClient.createLabel remains file-wide (the single-order side panel, intentionally kept)',
    (ordersView.match(/apiClient\.createLabel\(/g) ?? []).length === 1,
  );

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll batch-print-via-queue behavioral checks passed.');
}

void main();
