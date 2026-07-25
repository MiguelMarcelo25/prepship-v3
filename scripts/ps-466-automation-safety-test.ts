import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://postgres:postgres@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';

const [{ hasAppPermission }, { buildAutomationFactsSnapshot }, contracts, evaluator, orchestrator, ratePolicy] = await Promise.all([
  import('../src/middleware/auth'),
  import('../src/services/automations/facts'),
  import('../src/services/automations/contracts'),
  import('../src/services/automations/evaluator'),
  import('../src/services/automations/orchestrator'),
  import('../src/services/automations/rate-policy'),
]);

assert.equal(hasAppPermission({ role: 'operator' }, 'automations:write'), true);
assert.equal(hasAppPermission({ role: 'operator' }, 'automations:publish'), true);
assert.equal(hasAppPermission({ role: 'warehouse' }, 'automations:read'), true);
assert.equal(hasAppPermission({ role: 'warehouse' }, 'automations:publish'), false);
assert.equal(hasAppPermission({ role: 'client_user' }, 'automations:read'), false);
assert.equal(hasAppPermission({ role: 'read_only_support' }, 'automations:write'), false);

const orderUpdatedAt = new Date('2026-07-25T00:00:00Z');
const facts = buildAutomationFactsSnapshot({
  order: {
    id: 101,
    clientId: 4,
    storeId: 378060,
    sourceProvider: 'shipstation',
    orderStatus: 'awaiting_shipment',
    orderTotal: '42.00',
    shippingAmount: '6.00',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    weightOz: 32,
    updatedAt: orderUpdatedAt,
    createdAt: orderUpdatedAt,
    items: [{ sku: 'BAD-COMPATIBILITY-JSON' }],
  } as never,
  items: [{
    id: 1,
    lineIndex: 0,
    sku: 'HU-10',
    name: 'Leeds',
    quantity: '1.000',
    lineTotal: '36.00',
    updatedAt: orderUpdatedAt,
  }],
  override: {
    residential: true,
    tags: [],
    notes: '',
    rateWeightOz: null,
    selectedPid: null,
    selectedPackageId: null,
    bestRateJson: null,
    updatedAt: orderUpdatedAt,
  },
});
assert.deepEqual(facts.lines.map((line) => line.sku), ['HU-10'], 'facts use canonical order_items, never orders.items compatibility JSON');
assert.equal(facts.destination.country, null, 'missing canonical country stays unknown instead of being invented');
assert.equal(facts.workflow.hazmatState, 'unknown', 'PS-466 does not derive hazmat truth without PS-465');

const document = {
  schemaVersion: 1,
  name: 'Tag HU-10',
  trigger: 'order_imported',
  priority: 10,
  position: 0,
  unknownPolicy: 'block',
  scope: { clientIds: [4], storeIds: [378060] },
  condition: {
    kind: 'line_any',
    condition: { kind: 'predicate', field: 'line.sku', operator: 'normalized_eq', value: 'HU-10' },
  },
  actions: [{ type: 'tag.add', schemaVersion: 1, config: { tag: 'AUTOMATED' } }],
} satisfies contracts.AutomationRuleDocument;
const rule = contracts.compileAutomationRuleVersion(document, { ruleId: '1', versionId: '1', versionNumber: 1 });

const memory = orchestrator.createInMemoryAutomationExecutionStore();
let handlerCalls = 0;
const handlers: orchestrator.AutomationHandlerRegistry = {
  'tag.add': async ({ idempotencyKey }) => {
    handlerCalls += 1;
    return { targetType: 'order_tag', targetId: 'AUTOMATED', after: { tag: 'AUTOMATED' }, idempotencyKey };
  },
};

const first = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_imported',
  sourceEventId: 'import-101-v1',
  rules: [rule],
  store: memory,
  handlers,
});
assert.equal(first.status, 'completed');
assert.equal(handlerCalls, 1);
assert.equal(memory.effects.length, 1);
assert.equal(memory.states.get(101)?.status, 'current');

const retry = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_imported',
  sourceEventId: 'import-101-v1',
  rules: [rule],
  store: memory,
  handlers,
});
assert.equal(retry.runId, first.runId, 'same event/facts/rules digest reuses the completed run');
assert.equal(handlerCalls, 1, 'retry cannot duplicate an action effect');

const concurrentMemory = orchestrator.createInMemoryAutomationExecutionStore();
let concurrentHandlerCalls = 0;
const concurrentHandlers: orchestrator.AutomationHandlerRegistry = {
  'tag.add': async ({ idempotencyKey }) => {
    concurrentHandlerCalls += 1;
    await Promise.resolve();
    return { idempotencyKey };
  },
};
const concurrentResults = await Promise.allSettled([
  orchestrator.executeAutomationEvaluation({ facts, trigger: 'order_imported', sourceEventId: 'concurrent', rules: [rule], store: concurrentMemory, handlers: concurrentHandlers }),
  orchestrator.executeAutomationEvaluation({ facts, trigger: 'order_imported', sourceEventId: 'concurrent', rules: [rule], store: concurrentMemory, handlers: concurrentHandlers }),
]);
assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1, 'one concurrent owner completes the effect');
assert.equal(
  concurrentResults.filter((result) => result.status === 'rejected' && result.reason instanceof orchestrator.AutomationEffectLeaseBusyError).length,
  1,
  'the concurrent non-owner fails closed instead of treating a live planned effect as complete',
);
assert.equal(concurrentHandlerCalls, 1, 'atomic effect claims prevent duplicate handlers under concurrent retries');
assert.equal(concurrentMemory.effects.filter((effect) => effect.status === 'applied').length, 1);

const retryingMemory = orchestrator.createInMemoryAutomationExecutionStore();
let retryingHandlerCalls = 0;
const retryingHandlers: orchestrator.AutomationHandlerRegistry = {
  'tag.add': async ({ idempotencyKey }) => {
    retryingHandlerCalls += 1;
    if (retryingHandlerCalls === 1) throw new Error('injected crash-safe failure');
    return { targetType: 'order_tag', targetId: 'AUTOMATED', idempotencyKey };
  },
};
const failedAttempt = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_imported',
  sourceEventId: 'retry-after-failure',
  rules: [rule],
  store: retryingMemory,
  handlers: retryingHandlers,
});
assert.equal(failedAttempt.status, 'failed');
assert.equal(retryingHandlerCalls, 1);
assert.equal(retryingMemory.effects[0]?.status, 'failed');
const recoveredAttempt = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_imported',
  sourceEventId: 'retry-after-failure',
  rules: [rule],
  store: retryingMemory,
  handlers: retryingHandlers,
});
assert.equal(recoveredAttempt.status, 'completed', 'a failed effect is reclaimed instead of cached forever');
assert.equal(retryingHandlerCalls, 2, 'the canonical handler receives one bounded retry');
assert.equal(retryingMemory.effects[0]?.status, 'applied');
const cachedRecovery = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_imported',
  sourceEventId: 'retry-after-failure',
  rules: [rule],
  store: retryingMemory,
  handlers: retryingHandlers,
});
assert.equal(cachedRecovery.runId, recoveredAttempt.runId, 'the successful retry becomes the completed idempotent result');
assert.equal(retryingHandlerCalls, 2, 'completed recovery cannot execute the handler again');

const providerEvents: string[] = [];
const automationWatermark = {
  ...memory.states.get(101)!,
  plan: {
    ...memory.states.get(101)!.plan,
    insurance: { minimumValue: 250, provider: 'parcelguard' as const, profileId: null },
    confirmation: { value: 'signature', intentId: 'confirmation', priority: 10 },
    excludedCarriers: ['se-99'],
    excludedServices: ['ups_ground_saver'],
  },
};
const prepared = await ratePolicy.dispatchRateAfterAutomationPreflight(
  { orderId: 101, insuranceProvider: 'none', insuredValue: 100 },
  { clientIds: [], storeIds: [], isGlobal: true, isRestricted: false },
  async (intent) => {
    providerEvents.push('provider');
    return intent;
  },
  async () => {
    providerEvents.push('preflight');
    return automationWatermark;
  },
);
assert.deepEqual(providerEvents, ['preflight', 'provider'], 'provider dispatch cannot run before automation preflight');
assert.equal(prepared.confirmation, 'signature');
assert.equal(prepared.insuranceProvider, 'parcelguard');
assert.deepEqual(prepared.automationExcludedCarrierIds, ['se-99']);
assert.doesNotThrow(() => ratePolicy.assertAutomationRateProofCurrent(
  `v=13|d=20260725|w=320|z=90248|co=US|ar=legacy:${automationWatermark.rulesetDigest}`,
  automationWatermark,
));
assert.throws(
  () => ratePolicy.assertAutomationRateProofCurrent('v=13|d=20260725|w=320|z=90248|co=US|ar=legacy:stale', automationWatermark),
  (error: unknown) => error instanceof ratePolicy.AutomationRateProofError,
  'a stale/missing rules digest forces re-rate before label purchase',
);

const terminalMemory = orchestrator.createInMemoryAutomationExecutionStore();
const terminal = await orchestrator.executeAutomationEvaluation({
  facts: { ...facts, revision: 'terminal-revision', order: { ...facts.order, status: 'shipped' } },
  trigger: 'order_imported',
  sourceEventId: 'terminal-audit',
  rules: [rule],
  store: terminalMemory,
  handlers,
});
assert.equal(terminal.mode, 'audit_only');
assert.equal(terminal.status, 'completed');
assert.equal(handlerCalls, 1, 'terminal evaluation never invokes action handlers');
assert.equal(terminalMemory.effects[0]?.status, 'audit_only');

const unknown = evaluator.evaluateAutomationBundle({
  facts: { ...facts, revision: 'missing-lines', lines: [], completeness: { ...facts.completeness, lines: false } },
  trigger: 'order_imported',
  rules: [rule],
});
assert.equal(unknown.blocked, true);
const blockedMemory = orchestrator.createInMemoryAutomationExecutionStore();
const blocked = await orchestrator.executeAutomationEvaluation({
  facts: { ...facts, revision: 'missing-lines', lines: [], completeness: { ...facts.completeness, lines: false } },
  trigger: 'order_imported',
  sourceEventId: 'blocked-event',
  rules: [rule],
  store: blockedMemory,
  handlers,
});
assert.equal(blocked.status, 'blocked');
assert.equal(handlerCalls, 1, 'unknown compliance facts block before action handlers');

await assert.rejects(
  orchestrator.ensureAutomationStateCurrent({
    orderId: 101,
    factsRevision: facts.revision,
    rulesetDigest: first.rulesetDigest,
    state: { ...memory.states.get(101)!, status: 'conflict' },
  }),
  (error: unknown) => error instanceof orchestrator.AutomationPreflightError && error.code === 'AUTOMATION_CONFLICT',
  'conflict state fails before a provider-facing caller may continue',
);

await assert.rejects(
  orchestrator.ensureAutomationStateCurrent({
    orderId: 101,
    factsRevision: 'new-facts',
    rulesetDigest: first.rulesetDigest,
    state: memory.states.get(101)!,
  }),
  (error: unknown) => error instanceof orchestrator.AutomationPreflightError && error.code === 'AUTOMATION_EVALUATION_REQUIRED',
  'stale facts revision fails closed',
);

const labelSource = readFileSync(new URL('../src/services/labels.ts', import.meta.url), 'utf8');
const labelWrapper = labelSource.indexOf('export async function createLabelV2(');
const purchaseLock = labelSource.indexOf('acquireLabelPurchaseLock(body.orderId)', labelWrapper);
const labelImpl = labelSource.indexOf('async function createLabelV2Impl(');
const labelPreflight = labelSource.indexOf("stage: 'before_label_purchase'", labelImpl);
const firstProviderDispatch = labelSource.indexOf('dispatchFulfillmentOperation<DirectPurchaseResult>', labelImpl);
assert.ok(purchaseLock > labelWrapper && purchaseLock < labelImpl, 'ordinary label purchases acquire the lock before entering the implementation');
assert.ok(labelPreflight > labelImpl && labelPreflight < firstProviderDispatch, 'label automation preflight is ordered before provider dispatch');

const browseSource = readFileSync(new URL('../src/services/rate-browse-response-producer.ts', import.meta.url), 'utf8');
const browseEntry = browseSource.indexOf('export async function produceRateBrowsePayload');
const browsePreflight = browseSource.indexOf('prepareAutomationRateIntent(requestedBody', browseEntry);
const browseProviderBoundary = browseSource.indexOf('resolveRateInput(browseRateInput)', browseEntry);
assert.ok(browsePreflight > browseEntry && browsePreflight < browseProviderBoundary, 'browse preflight runs before carrier discovery/rate resolution');

const ratesSource = readFileSync(new URL('../src/services/rates.ts', import.meta.url), 'utf8');
const resolveEntry = ratesSource.indexOf('export async function resolveRateInput');
const internalPreflight = ratesSource.indexOf('prepareAutomationRateIntent(input, GLOBAL_SCOPE)', resolveEntry);
const carrierDiscovery = ratesSource.indexOf('resolveRateCredentialContext(input)', resolveEntry);
assert.ok(internalPreflight > resolveEntry && internalPreflight < carrierDiscovery, 'background rate callers cannot discover carriers before automation preflight');

const automationRuntimeSource = readFileSync(new URL('../src/services/automations/runtime.ts', import.meta.url), 'utf8');
assert.equal(/createCarrierLabel|dispatchFulfillmentOperation|purchaseShopifyShippingLabel/.test(automationRuntimeSource), false, 'generic automation handlers contain no provider purchase capability');
assert.match(automationRuntimeSource, /lte\(automationRules\.activeFrom, input\.orderCreatedAt\)/, 'normal evaluation honors the future-orders-only activation boundary');

const outboxWorkerSource = readFileSync(new URL('../src/services/automations/outbox-worker.ts', import.meta.url), 'utf8');
assert.match(outboxWorkerSource, /const BATCH_SIZE = 10[\s\S]*const MAX_ATTEMPTS = 5/, 'confirmed reprocessing is bounded and retry-capped');
assert.equal(/createCarrierLabel|dispatchFulfillmentOperation|purchaseShopifyShippingLabel/.test(outboxWorkerSource), false, 'reprocess worker cannot purchase labels or call postage providers');
assert.match(outboxWorkerSource, /eq\(automationOutbox\.status, 'processing'\)[\s\S]*automationOutbox\.leaseExpiresAt/, 'expired processing claims re-enter the durable outbox');
assert.match(outboxWorkerSource, /eq\(automationOutbox\.lockToken, claimed\.lockToken\)/, 'outbox completion is fenced to the current lease owner');
assert.match(outboxWorkerSource, /row\.attemptCount >= MAX_ATTEMPTS[\s\S]*status: 'dead'/, 'repeated worker crashes eventually dead-letter an expired claim');

const postgresStoreSource = readFileSync(new URL('../src/services/automations/postgres-store.ts', import.meta.url), 'utf8');
assert.match(postgresStoreSource, /existing\.status === 'failed'[\s\S]*existing\.status === 'planned'[\s\S]*existing\.leaseExpiresAt <= now/, 'failed or expired effects are reclaimable under a fresh lease');

console.log('PS-466 facts/RBAC/idempotency/recovery/terminal/preflight safety tests passed (54 assertions)');
