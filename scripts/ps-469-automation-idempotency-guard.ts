/**
 * PS-469 automation idempotency guard.
 *
 * Offline/static: an in-memory execution store. No DB, no provider, no postage.
 *
 * The defect this pins: `executionKey` used to include `sourceEventId`, which
 * the migration-0079 trigger builds from `txid_current()`. Every transaction
 * touching the order minted a new event id, so the key changed on every write,
 * `findCompleted` never matched, and the engine re-evaluated identical facts
 * forever -- 322,962 runs across 294 orders in four days, 791 MB.
 *
 * The invariant is simple and is what this asserts: SAME FACTS => ONE RUN,
 * however many events arrive.
 */
import { readFileSync } from 'node:fs';
import { executeAutomationEvaluation } from '../src/services/automations/orchestrator';
import type {
  AutomationExecutionResult,
  AutomationExecutionStore,
} from '../src/services/automations/orchestrator';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

/**
 * Minimal in-memory store implementing the REAL AutomationExecutionStore
 * interface, mirroring the postgres store's outcome semantics: 'running' and
 * 'failed' are not completed, so a retry after failure still proceeds.
 */
function createStore() {
  const runs = new Map<string, { id: number; status: string; result: AutomationExecutionResult | null }>();
  const beginCalls: string[] = [];
  let nextId = 1;
  const store: AutomationExecutionStore = {
    async findCompleted(key) {
      const row = runs.get(key);
      if (!row || row.status === 'running' || row.status === 'failed') return null;
      return row.result;
    },
    async begin(input) {
      beginCalls.push(input.executionKey);
      const existing = runs.get(input.executionKey);
      if (existing) {
        if (existing.status === 'failed') existing.status = 'running';
        return existing.id;
      }
      const id = nextId++;
      runs.set(input.executionKey, { id, status: 'running', result: null });
      return id;
    },
    async claimEffect() { return { status: 'complete' }; },
    async recordEffect() { /* no effects exercised here */ },
    async finish(result) {
      const row = runs.get(result.executionKey);
      if (row) {
        row.status = 'completed';
        row.result = result;
      }
    },
    async setState() { /* watermark not exercised here */ },
  };
  return { store, runs, beginCalls };
}

const facts = {
  revision: 'facts-rev-A',
  order: { id: 1801946, status: 'awaiting_shipment', clientId: 4, storeId: 378060 },
  lines: [],
} as never;

const baseInput = {
  facts,
  rules: [],
  handlers: {} as never,
  scope: { isRestricted: false, clientIds: [], storeIds: [] } as never,
};

// ── The core invariant ───────────────────────────────────────────────────────
// Three DIFFERENT event ids -- exactly what txid_current() produces on three
// no-op writes -- against identical facts. This must be ONE run, not three.
{
  const { store, beginCalls } = createStore();
  for (const txid of ['11025096', '11025098', '11025216']) {
    await executeAutomationEvaluation({
      ...baseInput,
      store,
      trigger: 'order_items_changed',
      sourceEventId: `automation-facts:order_items:1801946:${txid}:order_items_changed`,
    });
  }
  const distinctKeys = new Set(beginCalls);
  check('three distinct event ids on identical facts produce ONE execution key',
    distinctKeys.size === 1, { keys: distinctKeys.size, begins: beginCalls.length });
}

// A changed factsRevision MUST still produce a new run -- otherwise the fix
// would silently stop the engine reacting to real changes.
{
  const { store, beginCalls } = createStore();
  await executeAutomationEvaluation({
    ...baseInput, store, trigger: 'order_items_changed', sourceEventId: 'evt-1',
  });
  await executeAutomationEvaluation({
    ...baseInput,
    facts: { ...(facts as object), revision: 'facts-rev-B' } as never,
    store, trigger: 'order_items_changed', sourceEventId: 'evt-2',
  });
  check('a changed factsRevision still produces a NEW run',
    new Set(beginCalls).size === 2, beginCalls.length);
}

// Different triggers on the same facts stay distinct -- order_facts_updated and
// order_items_changed are different questions and must not collapse together.
{
  const { store, beginCalls } = createStore();
  for (const trigger of ['order_items_changed', 'order_facts_updated']) {
    await executeAutomationEvaluation({ ...baseInput, store, trigger, sourceEventId: 'evt-same' });
  }
  check('different triggers on identical facts stay distinct',
    new Set(beginCalls).size === 2);
}

// ── Anti-regression: the source-text pin ─────────────────────────────────────
const orchestrator = readFileSync('src/services/automations/orchestrator.ts', 'utf8').replace(/\r\n/g, '\n');
const keyFn = orchestrator.slice(
  orchestrator.indexOf('function executionKey'),
  orchestrator.indexOf('function effectKey'),
);
check('executionKey does NOT take sourceEventId', !/sourceEventId/.test(keyFn), keyFn.slice(0, 200));
check('executionKey still binds factsRevision', /factsRevision/.test(keyFn));
check('executionKey still binds rulesetDigest', /rulesetDigest/.test(keyFn));
check('executionKey still binds trigger', /\btrigger\b/.test(keyFn));
check('sourceEventId is still PERSISTED for provenance',
  /sourceEventId: input\.sourceEventId/.test(orchestrator));

if (failures > 0) {
  console.error(`\nFAIL PS-469 automation idempotency guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-469 automation idempotency guard');
