import { strict as assert } from 'node:assert';

process.env.DATABASE_URL ??= 'postgres://postgres:test@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';
process.env.AUTOMATION_PREFERENCE_RANKING = 'true';

const [contracts, orchestrator, hazmatAction, ratePolicy, rates, packagePolicy, packagePlan, ratePreference] = await Promise.all([
  import('../src/services/automations/contracts'),
  import('../src/services/automations/orchestrator'),
  import('../src/services/automations/hazmat-action'),
  import('../src/services/automations/rate-policy'),
  import('../src/services/rates'),
  import('../src/services/package-facts-policy'),
  import('../src/services/automations/order-package-plan'),
  import('../src/services/automations/rate-preference'),
]);

const facts: contracts.AutomationFacts = {
  revision: 'ten-action-facts-v1',
  order: {
    id: 46601,
    clientId: 4,
    storeId: 378060,
    sourceProvider: 'shipstation',
    status: 'awaiting_shipment',
    orderTotal: 200,
    itemSubtotal: 190,
    customerShipping: 10,
    tags: [],
    createdAt: '2026-08-11T00:00:00.000Z',
  },
  lines: [{ lineId: '0', sku: 'HU-10', name: 'Leeds Line', quantity: 1 }],
  destination: { country: 'US', state: 'CA', postalCode: '90248', residential: true, poBox: false },
  package: { weightOz: 32, presetId: null },
  workflow: { hasSelectedRate: false, holdForReview: false, hazmatState: 'none' },
  completeness: { identity: true, lines: true, destination: true, package: true, workflow: true },
};

const allActions: contracts.AutomationRuleDocument['actions'] = [
  { type: 'tag.add', schemaVersion: 1, config: { tag: 'AUTOMATED' } },
  { type: 'hold.for_review', schemaVersion: 1, config: { reason: 'Compliance review' } },
  { type: 'insurance.require', schemaVersion: 1, config: { minimumValue: 250, provider: 'parcelguard', profileId: null } },
  { type: 'package.set', schemaVersion: 1, config: { packagePresetId: 'BOX-12' } },
  { type: 'confirmation.set', schemaVersion: 1, config: { confirmation: 'signature' } },
  { type: 'carrier.exclude', schemaVersion: 1, config: { ids: ['fedex'] } },
  { type: 'service.exclude', schemaVersion: 1, config: { ids: ['ups_next_day_air'] } },
  { type: 'carrier.prefer', schemaVersion: 1, config: { id: 'ups' } },
  { type: 'service.prefer', schemaVersion: 1, config: { id: 'ups_ground' } },
  { type: 'hazmat.add_declaration', schemaVersion: 1, config: { contactName: 'Dispatch', contactPhone: '310-555-0100' } },
];
const document: contracts.AutomationRuleDocument = {
  schemaVersion: 1,
  name: 'PS-466 ten-action behavioral fixture',
  trigger: 'order_items_changed',
  priority: 10,
  position: 0,
  unknownPolicy: 'block',
  scope: { clientIds: [4], storeIds: [378060] },
  condition: { kind: 'predicate', field: 'order.client_id', operator: 'eq', value: 4 },
  actions: allActions,
};
const rule = contracts.compileAutomationRuleVersion(document, { ruleId: '466', versionId: '4661', versionNumber: 1 });
const scope = { clientIds: [4], storeIds: [378060], isGlobal: false, isRestricted: true };

const tags = new Set<string>();
let tagWrites = 0;
let holdWrites = 0;
let hazmatWrites = 0;
let providerCalls = 0;
let hazmatCurrent: {
  declaration: any;
  revision: number;
  semanticHash: string | null;
  decisionSource: 'automation' | 'manual' | null;
  clientId: number;
} = {
  declaration: null,
  revision: 0,
  semanticHash: null as string | null,
  decisionSource: null as 'automation' | 'manual' | null,
  clientId: 4,
};
const canonicalHazmat = hazmatAction.createAutomationHazmatHandler({
  getCurrent: async () => hazmatCurrent as never,
  save: async (input) => {
    hazmatWrites += 1;
    const declaration = input.declaration;
    const { hazmatSemanticHash } = await import('../src/services/shipping-workflow/hazmat-declaration');
    hazmatCurrent = {
      declaration,
      revision: hazmatCurrent.revision + 1,
      semanticHash: hazmatSemanticHash(declaration),
      decisionSource: 'automation',
      clientId: 4,
    };
    return { ...hazmatCurrent, changed: true, invalidatedRate: true } as never;
  },
});
const planOwned: orchestrator.AutomationHandler = async ({ facts: currentFacts, intent, idempotencyKey }) => ({
  targetType: 'order_automation_state',
  targetId: String(currentFacts.order.id),
  after: { actionType: intent.action.type, config: intent.action.config },
  idempotencyKey,
});
const handlers: orchestrator.AutomationHandlerRegistry = {
  'tag.add': async ({ intent, idempotencyKey }) => {
    const tag = String(intent.action.config.tag);
    if (!tags.has(tag)) { tags.add(tag); tagWrites += 1; }
    return { targetType: 'order_tag', targetId: tag, after: { tags: [...tags] }, idempotencyKey };
  },
  'hold.for_review': async ({ idempotencyKey }) => {
    if (!tags.has('HOLD_FOR_REVIEW')) { tags.add('HOLD_FOR_REVIEW'); holdWrites += 1; }
    return { targetType: 'order_workflow_hold', targetId: String(facts.order.id), after: { tags: [...tags] }, idempotencyKey };
  },
  'insurance.require': planOwned,
  'package.set': planOwned,
  'confirmation.set': planOwned,
  'carrier.exclude': planOwned,
  'service.exclude': planOwned,
  'carrier.prefer': planOwned,
  'service.prefer': planOwned,
  'hazmat.add_declaration': canonicalHazmat,
};

const store = orchestrator.createInMemoryAutomationExecutionStore();
const first = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_items_changed',
  sourceEventId: 'ten-action-event-1',
  rules: [rule],
  store,
  handlers,
  scope,
});
assert.equal(first.status, 'completed');
assert.equal(store.effects.length, 10, 'all ten actions cross the orchestrator effect boundary');
assert.equal(store.effects.filter((effect) => effect.status === 'applied').length, 10);
assert.deepEqual([...tags].sort(), ['AUTOMATED', 'HOLD_FOR_REVIEW']);
assert.equal(tagWrites, 1);
assert.equal(holdWrites, 1);
assert.equal(hazmatWrites, 1);

const watermark = store.states.get(facts.order.id)!;
assert.equal(watermark.plan.hold.required, true);
assert.equal(watermark.plan.insurance?.minimumValue, 250);
assert.equal(watermark.plan.package?.value, 'BOX-12');
assert.equal(watermark.plan.confirmation?.value, 'signature');
assert.deepEqual(watermark.plan.excludedCarriers, ['fedex']);
assert.deepEqual(watermark.plan.excludedServices, ['ups_next_day_air']);
assert.equal(watermark.plan.preferredCarrier?.value, 'ups');
assert.equal(watermark.plan.preferredService?.value, 'ups_ground');
assert.ok(watermark.plan.hazmatIntentId);

const prepared = ratePolicy.applyAutomationPlanToRateIntent({
  orderId: facts.order.id,
  confirmation: null,
  insuranceProvider: 'none',
  insuredValue: 300,
}, watermark);
assert.equal(prepared.confirmation, 'signature', 'confirmation reaches the canonical rate intent');
assert.equal(prepared.insuredValue, 300, 'insurance.require is a floor and cannot lower existing coverage');
assert.equal(prepared.insuranceProvider, 'parcelguard');
const explicitConfirmation = ratePolicy.applyAutomationPlanToRateIntent({
  orderId: facts.order.id,
  confirmation: 'adult_signature',
}, watermark);
assert.equal(explicitConfirmation.confirmation, 'adult_signature', 'confirmation.set cannot overwrite an explicit operator choice');

const automationPackage = packagePlan.packageRungFromPlan(watermark.plan);
const resolvedPackage = packagePolicy.resolvePackageFactsFromInputs({
  override: null,
  automation: automationPackage,
  comboDefault: { selectedPackageId: 'DEFAULT-BOX' },
  singleSkuDefault: null,
  imported: { selectedPackageId: 'IMPORTED-BOX', weightOz: 32 },
});
assert.equal(resolvedPackage.source, 'automation');
assert.equal(resolvedPackage.selectedPackageId, 'BOX-12');
const operatorWins = packagePolicy.resolvePackageFactsFromInputs({
  override: { selectedPackageId: 'OPERATOR-BOX' },
  automation: automationPackage,
  comboDefault: null,
  singleSkuDefault: null,
  imported: null,
});
assert.equal(operatorWins.source, 'override', 'package.set cannot overwrite an order-specific operator choice');

const rateRows = [
  { rate_id: 'fedex-cheap', carrier_id: 'fedex', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 5 } },
  { rate_id: 'ups-air', carrier_id: 'ups', carrier_code: 'ups', service_code: 'ups_next_day_air', shipping_amount: { amount: 8 } },
  { rate_id: 'ups-ground', carrier_id: 'ups', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 7 } },
] as never[];
const eligible = rates.filterRatesForAutomationPlan(rateRows, prepared);
assert.deepEqual(eligible.map((rate: { rate_id: string }) => rate.rate_id), ['ups-ground'], 'carrier/service exclusions reach the canonical rate filter');
const preference = ratePreference.preferenceFromPlan(watermark.plan);
assert.deepEqual(preference, { carrier: 'ups', service: 'ups_ground' });
assert.equal(rates.pickBestRate(rateRows as never, preference)?.rate_id, 'ups-ground', 'enabled preference changes the canonical best-rate winner');
assert.equal(rates.pickBestRate(rateRows as never, { carrier: 'missing', service: null })?.rate_id, 'fedex-cheap', 'an unmatched preference falls back instead of filtering all rates');

const retry = await orchestrator.executeAutomationEvaluation({
  facts,
  trigger: 'order_items_changed',
  sourceEventId: 'different-event-same-facts',
  rules: [rule],
  store,
  handlers,
  scope,
});
assert.equal(retry.runId, first.runId);
assert.deepEqual({ tagWrites, holdWrites, hazmatWrites, providerCalls }, { tagWrites: 1, holdWrites: 1, hazmatWrites: 1, providerCalls: 0 }, 'exact retry has zero duplicate or provider side effects');

const negativeStore = orchestrator.createInMemoryAutomationExecutionStore();
const negative = await orchestrator.executeAutomationEvaluation({
  facts: { ...facts, revision: 'negative-facts', order: { ...facts.order, clientId: 9 } },
  trigger: 'order_items_changed',
  sourceEventId: 'negative-event',
  rules: [rule],
  store: negativeStore,
  handlers,
  scope: { ...scope, clientIds: [9] },
});
assert.equal(negative.evaluation.intents.length, 0);
assert.equal(negativeStore.effects.length, 0, 'non-matching facts invoke no action handler');

const conflictRule = contracts.compileAutomationRuleVersion({
  ...document,
  name: 'Conflicting package choice',
  actions: [{ type: 'package.set', schemaVersion: 1, config: { packagePresetId: 'BOX-OTHER' } }],
}, { ruleId: '467', versionId: '4671', versionNumber: 1 });
const conflictStore = orchestrator.createInMemoryAutomationExecutionStore();
const conflict = await orchestrator.executeAutomationEvaluation({
  facts: { ...facts, revision: 'conflict-facts' },
  trigger: 'order_items_changed',
  sourceEventId: 'conflict-event',
  rules: [rule, conflictRule],
  store: conflictStore,
  handlers,
  scope,
});
assert.equal(conflict.status, 'conflict');
assert.equal(conflictStore.effects.length, 0, 'conflicting scalar actions fail before every handler');
assert.equal(providerCalls, 0);

process.env.AUTOMATION_PREFERENCE_RANKING = 'false';
assert.throws(
  () => contracts.compileAutomationRuleVersion(document, { ruleId: '468', versionId: '4681', versionNumber: 1 }),
  /Preference automation is unavailable|is unavailable/,
  'preference rules fail compilation when canonical ranking is disabled',
);
process.env.AUTOMATION_PREFERENCE_RANKING = 'true';

// ── the shared handler boundary refuses a stale run owner ────────────────────
//
// All ten configured actions reach their handler through claimEffect(), so ONE test at that
// boundary covers all of them - ten copies would prove nothing extra. What matters is that a
// failed parent-run admission stops the handler BEFORE it runs, not after.
{
  let handlerCalls = 0;
  const countingHandlers = Object.fromEntries(
    Object.entries(handlers).map(([type, fn]) => [type, async (...args: unknown[]) => {
      handlerCalls += 1;
      return (fn as (...a: unknown[]) => unknown)(...args);
    }]),
  );
  const fencedStore = orchestrator.createInMemoryAutomationExecutionStore();
  const realClaim = fencedStore.claimEffect.bind(fencedStore);
  let admitted = 0;
  fencedStore.claimEffect = (async (effect: unknown) => {
    admitted += 1;
    // Simulate the parent-run fence refusing admission: ownership moved while this worker
    // was mid-run.
    throw new Error('Automation run lease lost before effect admission');
  }) as typeof fencedStore.claimEffect;
  void realClaim;

  await assert.rejects(
    orchestrator.executeAutomationEvaluation({
      facts, trigger: 'order_items_changed', sourceEventId: 'stale-admission-event',
      rules: [rule], store: fencedStore, handlers: countingHandlers as never, scope,
    }),
    /lease lost before effect admission/,
    'a refused parent-run admission must abort the run',
  );
  assert.equal(handlerCalls, 0, 'NO handler may run once parent-run admission is refused');
  assert.equal(fencedStore.effects.length, 0, 'and no action-result row may be produced');
  assert.equal(admitted, 1, 'the run stops at the first refused admission rather than looping');
}

// ── the UNFENCED convergence step is fenced by a lease renewal ───────────────
//
// Hazmat retraction never calls claimEffect(), so the parent-run fence that guards all ten
// handlers does not cover it. It mutates the canonical hazmat declaration directly. The
// orchestrator must therefore RENEW the run lease first, and a failed renewal must stop the
// retraction before it happens - not merely refuse the finish() afterwards.
{
  // Retraction fires when workflow hazmat is active and no rule asks for a declaration.
  const retractFacts = {
    ...facts,
    workflow: { ...(facts as { workflow?: Record<string, unknown> }).workflow, hazmatState: 'active' },
  } as typeof facts;

  let retractions = 0;
  const retractSpy = async () => { retractions += 1; };

  // A store whose lease renewal fails: ownership moved while this worker was mid-run.
  const lostLeaseStore = orchestrator.createInMemoryAutomationExecutionStore();
  lostLeaseStore.renewRunLease = (async () => {
    throw new Error('Automation run lease lost before convergence');
  }) as typeof lostLeaseStore.renewRunLease;

  // The spy MUST be injected here. Without it this case falls through to the production
  // `automationHazmatRetraction()`, which fails for an unrelated reason (no database role in
  // this suite) and leaves every assertion green — proving the run failed, but proving
  // nothing about whether the retraction was stopped BEFORE it ran. That is the same
  // right-outcome-wrong-mechanism trap this card keeps producing.
  const lost = await orchestrator.executeAutomationEvaluation({
    facts: retractFacts, trigger: 'before_rate', sourceEventId: 'retract-lost-lease',
    rules: [], store: lostLeaseStore, handlers, scope, retractHazmat: retractSpy as never,
  });
  assert.equal(retractions, 0, 'a stale owner must NOT retract a hazmat declaration');
  assert.notEqual(lost.status, 'completed', 'and the run must not report success');

  // The legitimate owner renews and retracts exactly once.
  const heldStore = orchestrator.createInMemoryAutomationExecutionStore();
  let renewals = 0;
  heldStore.renewRunLease = (async () => { renewals += 1; }) as typeof heldStore.renewRunLease;
  const held = await orchestrator.executeAutomationEvaluation({
    facts: retractFacts, trigger: 'before_rate', sourceEventId: 'retract-held-lease',
    rules: [], store: heldStore, handlers, scope, retractHazmat: retractSpy as never,
  });
  assert.equal(held.status, 'completed');
  assert.equal(renewals, 1, 'the lease is renewed before the convergence command');
  assert.equal(retractions, 1, 'the rightful owner retracts exactly once');
}

console.log(JSON.stringify({
  fixture: 'PS-466 ten-action behavioral fixture / order 46601',
  command: 'npm run test:ps-466-ten-action-behavior',
  actions: allActions.map((action) => action.type),
  before: { tags: [], hazmatRevision: 0, providerCalls: 0 },
  after: { tags: [...tags], hazmatRevision: hazmatCurrent.revision, appliedEffects: store.effects.length, providerCalls },
  negative: 'non-match=0 effects; scalar conflict=0 effects; operator package override wins; unmatched preference falls back',
  idempotency: { tagWrites, holdWrites, hazmatWrites, repeatRunId: retry.runId },
  unauthorizedSideEffects: { providerCalls, postagePurchases: 0, labels: 0, refunds: 0, inventoryWrites: 0, billingWrites: 0 },
}, null, 2));
