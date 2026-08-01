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
import { buildAutomationFactsSnapshot } from '../src/services/automations/facts';
import {
  AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW,
  AUTOMATION_BACKSTOP_WINDOW_MS,
  executeAutomationEvaluation,
} from '../src/services/automations/orchestrator';
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
function createStore(recentRunCount = 0) {
  const runs = new Map<string, { id: number; status: string; result: AutomationExecutionResult | null }>();
  const beginCalls: string[] = [];
  const setStateCalls: unknown[] = [];
  let nextId = 1;
  const store: AutomationExecutionStore = {
    async findCompleted(key) {
      const row = runs.get(key);
      if (!row || row.status === 'running' || row.status === 'failed') return null;
      return row.result;
    },
    // PS-469 backstop: how many runs this order already has in the window.
    async countRunsSince() { return recentRunCount; },
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
    async setState(state) { setStateCalls.push(state); },
  };
  return { store, runs, beginCalls, setStateCalls };
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

// ── the backstop (PS-469 part 4) ─────────────────────────────────────────────
/**
 * Insurance, not a fix. Three separate changes stopped the original loop, each
 * removing a value that changed on every write from a fingerprint meant to describe
 * content. The backstop bounds the NEXT one, because that failure mode is silent:
 * nothing breaks and no rule misfires, the engine just burns ~200 MB/day computing
 * the same answer until a human notices.
 *
 * Sized from measured production after the fixes: healthy orders run ~34/day, the
 * busiest ~79/day, and the bug ran 913/day. 300 sits in that gap.
 *
 * The risk being managed in the other direction is that a suppressed evaluation is a
 * rule that does not fire -- so these checks pin just as hard that it does NOT trip
 * below the ceiling, and does not touch the order's state when it does.
 */
{
  const backstopFacts = {
    ...facts,
    order: { ...facts.order, id: 4242 },
  } as typeof facts;
  const run = async (recentRuns: number) => {
    const s = createStore(recentRuns);
    const result = await executeAutomationEvaluation({
      ...baseInput, facts: backstopFacts, store: s.store, sourceEventId: 'evt-backstop',
    });
    return { s, result };
  };

  const under = await run(AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW - 1);
  check('an order just UNDER the ceiling still evaluates normally',
    under.result.status !== 'blocked', under.result.status);

  const over = await run(AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW);
  check('an order AT the ceiling is suppressed', over.result.status === 'blocked');
  check('the suppressed run is recorded, not silently dropped',
    over.s.beginCalls.length === 1 && over.result.runId != null);
  check('the suppressed run is audit_only, so it can apply nothing',
    over.result.mode === 'audit_only');
  check('the suppressed run plans no intents and no effects',
    over.result.evaluation.intents.length === 0
      && over.result.reduction.plan.tags.length === 0);

  // The property that makes this safe to leave on: suppressing work must not rewrite
  // the order's derived automation state with the empty plan it just did not compute.
  check('a trip does NOT write order state (it would wipe the real plan)',
    over.s.setStateCalls.length === 0, over.s.setStateCalls.length);

  // ...and the backstop must not become the thing it is bounding.
  const again = await run(AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW + 5_000);
  check('a far-over-ceiling order still records exactly ONE row for the window',
    again.s.beginCalls.length === 1, again.s.beginCalls.length);

  // Decisive check for "one row per window": ONE shared store, two trips separated by
  // real elapsed time. Without bucketing the key on the window, a second trip a few
  // milliseconds later mints a different key and a second row -- and the backstop
  // becomes the very thing it is meant to bound. Two trips in the same millisecond
  // would pass either way, so the delay is load-bearing, not incidental.
  const shared = createStore(AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW);
  const tripOnce = () => executeAutomationEvaluation({
    ...baseInput, facts: backstopFacts, store: shared.store, sourceEventId: 'evt-repeat',
  });
  const firstTrip = await tripOnce();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const secondTrip = await tripOnce();
  check('repeat trips 25ms apart share one deterministic window-bucketed key',
    firstTrip.executionKey === secondTrip.executionKey,
    { a: firstTrip.executionKey, b: secondTrip.executionKey });
  check('repeat trips write exactly ONE row, not one per suppressed attempt',
    shared.beginCalls.length === 1, shared.beginCalls.length);
  check('the backstop key is distinct from a normal evaluation key',
    firstTrip.executionKey !== under.result.executionKey);

  check('the ceiling leaves real headroom over the busiest measured healthy order (79/day)',
    AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW >= 79 * 2);
  check('the ceiling is still below the rate the actual bug ran at (913/day)',
    AUTOMATION_BACKSTOP_MAX_RUNS_PER_WINDOW < 913);
  check('the window is a bounded, finite span',
    AUTOMATION_BACKSTOP_WINDOW_MS > 0 && Number.isFinite(AUTOMATION_BACKSTOP_WINDOW_MS));
}

// ── factsRevision stability (PS-469 part 2) ──────────────────────────────────
/**
 * Fixing the execution key exposed the layer beneath it. Measured on production
 * 2026-08-01, two days after the key fix shipped: runs-per-facts_revision is
 * exactly 2.00 (= the number of distinct triggers), so the key now dedupes
 * perfectly -- and yet order 1801946 still logged 913 runs in one day, because
 * `facts_revision` itself changed 458 times.
 *
 * The revision hash mixed WRITE-TIME METADATA into a SEMANTIC fingerprint:
 * orderUpdatedAt, overrideUpdatedAt and latestItemUpdate. Sync re-upserts rows
 * that have not changed, Postgres bumps updated_at anyway, and the revision
 * moves even though every evaluated fact is byte-identical. Five sampled runs
 * on that order carried five different factsRevision values and produced the
 * SAME result each time: zero intents, zero matches, empty plan.
 *
 * The invariant: the revision is a function of the FACTS, not of when the row
 * was last written.
 */
const ORDER_ROW = {
  id: 1801946,
  clientId: 7,
  storeId: 3,
  sourceProvider: 'shipstation',
  orderStatus: 'awaiting_shipment',
  orderTotal: '42.50',
  shippingAmount: '5.00',
  shipToState: 'CA',
  shipToPostalCode: '90210',
  weightOz: 32,
  createdAt: new Date('2026-07-27T03:16:32.859Z'),
  updatedAt: new Date('2026-07-31T00:12:09.722Z'),
};
const ITEM_ROW = {
  id: 55,
  lineIndex: 0,
  sku: 'SKU-1',
  name: 'Widget',
  quantity: 2,
  lineTotal: '42.50',
  updatedAt: new Date('2026-07-31T00:12:10.321Z'),
};
const OVERRIDE_ROW = {
  residential: true,
  tags: ['ready'],
  notes: null,
  rateWeightOz: null,
  selectedPid: null,
  selectedPackageId: null,
  bestRateJson: null,
  updatedAt: new Date('2026-07-31T00:12:09.722Z'),
};
const baseFacts = { order: ORDER_ROW, items: [ITEM_ROW], override: OVERRIDE_ROW };

const revisionOf = (input: Parameters<typeof buildAutomationFactsSnapshot>[0]) =>
  buildAutomationFactsSnapshot(input).revision;

// The decisive one. This is the production scenario: a no-op sync re-upsert.
check('a no-op write that only moves updated_at produces the SAME revision',
  revisionOf(baseFacts) === revisionOf({
    ...baseFacts,
    order: { ...ORDER_ROW, updatedAt: new Date('2026-08-01T00:12:09.722Z') },
    items: [{ ...ITEM_ROW, updatedAt: new Date('2026-08-01T00:12:10.321Z') }],
    override: { ...OVERRIDE_ROW, updatedAt: new Date('2026-08-01T00:12:09.722Z') },
  }),
  { base: revisionOf(baseFacts) });

check('a null updatedAt is treated the same as any other timestamp',
  revisionOf(baseFacts) === revisionOf({
    ...baseFacts, order: { ...ORDER_ROW, updatedAt: null },
  }));

// PS-469 part 3. Sync deletes and re-inserts order_items rather than updating
// them, so the row's serial id is a write artefact, not a fact about the line.
check('re-inserted item rows with new serial ids produce the SAME revision',
  revisionOf(baseFacts) === revisionOf({
    ...baseFacts, items: [{ ...ITEM_ROW, id: ITEM_ROW.id + 999_999 }],
  }));

// ...but the revision must still MOVE for every fact a rule can read. Without
// these, "stop the loop" could be satisfied by a constant, and the engine would
// stop reacting to real changes.
const movesRevision: Array<[string, Parameters<typeof buildAutomationFactsSnapshot>[0]]> = [
  ['order status', { ...baseFacts, order: { ...ORDER_ROW, orderStatus: 'shipped' } }],
  ['order total', { ...baseFacts, order: { ...ORDER_ROW, orderTotal: '99.99' } }],
  ['customer shipping', { ...baseFacts, order: { ...ORDER_ROW, shippingAmount: '9.99' } }],
  ['destination state', { ...baseFacts, order: { ...ORDER_ROW, shipToState: 'NY' } }],
  ['destination postal', { ...baseFacts, order: { ...ORDER_ROW, shipToPostalCode: '10001' } }],
  ['package weight', { ...baseFacts, order: { ...ORDER_ROW, weightOz: 64 } }],
  ['item quantity', { ...baseFacts, items: [{ ...ITEM_ROW, quantity: 3 }] }],
  ['item sku', { ...baseFacts, items: [{ ...ITEM_ROW, sku: 'SKU-2' }] }],
  ['item line total', { ...baseFacts, items: [{ ...ITEM_ROW, lineTotal: '50.00' }] }],
  ['an item being removed', { ...baseFacts, items: [] }],
  ['override tags', { ...baseFacts, override: { ...OVERRIDE_ROW, tags: ['hold'] } }],
  ['override residential', { ...baseFacts, override: { ...OVERRIDE_ROW, residential: false } }],
  ['override rate weight', { ...baseFacts, override: { ...OVERRIDE_ROW, rateWeightOz: 48 } }],
  ['override selected package', { ...baseFacts, override: { ...OVERRIDE_ROW, selectedPackageId: 'pkg-1' } }],
  ['a selected rate appearing', { ...baseFacts, override: { ...OVERRIDE_ROW, selectedPid: 'pid-1' } }],
  ['hazmat becoming active', {
    ...baseFacts,
    hazmat: { declaration: { status: 'active' as const }, revision: 2, semanticHash: 'h2' },
  }],
];
const baseRevision = revisionOf(baseFacts);
for (const [label, input] of movesRevision) {
  check(`the revision still CHANGES when ${label} changes`, revisionOf(input) !== baseRevision);
}

// ── Anti-regression: the source-text pin ─────────────────────────────────────
const orchestrator = readFileSync('src/services/automations/orchestrator.ts', 'utf8').replace(/\r\n/g, '\n');
// Slice the executionKey FUNCTION only -- to its own closing brace, not to whatever
// happens to be declared next. The previous "up to function effectKey" span silently
// swallowed anything inserted between them, so unrelated prose could fail this pin.
const keyFnStart = orchestrator.indexOf('function executionKey');
const keyFn = orchestrator.slice(
  keyFnStart,
  orchestrator.indexOf('\n}', keyFnStart) + 2,
);
check('executionKey does NOT take sourceEventId', !/sourceEventId/.test(keyFn), keyFn.slice(0, 200));
check('executionKey still binds factsRevision', /factsRevision/.test(keyFn));
check('executionKey still binds rulesetDigest', /rulesetDigest/.test(keyFn));
check('executionKey still binds trigger', /\btrigger\b/.test(keyFn));
check('sourceEventId is still PERSISTED for provenance',
  /sourceEventId: input\.sourceEventId/.test(orchestrator));

const factsSource = readFileSync('src/services/automations/facts.ts', 'utf8').replace(/\r\n/g, '\n');
const revisionHash = factsSource.slice(
  factsSource.indexOf('const revision = automationDocumentHash('),
  factsSource.indexOf('return { revision, ...factsWithoutRevision };'),
);
check('the revision hash does NOT read any updatedAt',
  !/updatedAt|latestItemUpdate/.test(revisionHash), revisionHash);
check('the revision hash still covers the full fact document',
  /facts: factsWithoutRevision/.test(revisionHash));
check('the revision hash still covers hazmat semantic identity',
  /semanticHash/.test(revisionHash));

if (failures > 0) {
  console.error(`\nFAIL PS-469 automation idempotency guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-469 automation idempotency guard');
