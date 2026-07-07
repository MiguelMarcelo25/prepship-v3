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

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll batch-print-via-queue behavioral checks passed.');
}

void main();
