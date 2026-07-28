import { strict as assert } from 'node:assert';
import {
  compileAutomationRuleVersion,
  type AutomationFacts,
  type AutomationRuleDocument,
} from '../src/services/automations/contracts';
import { evaluateAutomationBundle } from '../src/services/automations/evaluator';
import { reduceAutomationIntents } from '../src/services/automations/conflicts';
import { getAutomationCatalog } from '../src/services/automations/catalog';

const completeFacts: AutomationFacts = {
  revision: 'facts-1',
  order: {
    id: 101,
    clientId: 4,
    storeId: 378060,
    sourceProvider: 'shipstation',
    status: 'awaiting_shipment',
    orderTotal: 42,
    itemSubtotal: 36,
    customerShipping: 6,
    tags: ['priority'],
    createdAt: '2026-07-25T00:00:00.000Z',
  },
  lines: [
    { lineId: 'line-1', sku: ' hu-10 ', name: 'Leeds Line', quantity: 1 },
    { lineId: 'line-2', sku: 'OTHER', name: 'Accessory', quantity: 2 },
  ],
  destination: { country: 'US', state: 'CA', postalCode: '90248', residential: true, poBox: false },
  package: { weightOz: 32, presetId: null },
  workflow: { hasSelectedRate: false, holdForReview: false, hazmatState: 'none' },
  completeness: {
    identity: true,
    lines: true,
    destination: true,
    package: true,
    workflow: true,
  },
};

const hu10Rule: AutomationRuleDocument = {
  schemaVersion: 1,
  name: 'HUGRAB Leeds Line review',
  trigger: 'order_imported',
  priority: 10,
  position: 0,
  unknownPolicy: 'block',
  scope: { clientIds: [4], storeIds: [378060] },
  condition: {
    kind: 'group',
    op: 'all',
    children: [
      { kind: 'predicate', field: 'order.client_id', operator: 'eq', value: 4 },
      {
        kind: 'line_any',
        condition: {
          kind: 'group',
          op: 'all',
          children: [
            { kind: 'predicate', field: 'line.sku', operator: 'normalized_eq', value: 'HU-10' },
            { kind: 'predicate', field: 'line.quantity', operator: 'gte', value: 1 },
          ],
        },
      },
    ],
  },
  actions: [
    { type: 'tag.add', schemaVersion: 1, config: { tag: 'HAZMAT' } },
    { type: 'hold.for_review', schemaVersion: 1, config: { reason: 'HU-10 requires hazmat review' } },
  ],
};

const compiled = compileAutomationRuleVersion(hu10Rule, {
  ruleId: 'rule-hu10',
  versionId: 'version-hu10-v1',
  versionNumber: 1,
});
assert.equal(compiled.documentHash.length, 64, 'compiled immutable documents use a full SHA-256 digest');

const evaluated = evaluateAutomationBundle({
  facts: completeFacts,
  trigger: 'order_imported',
  rules: [compiled],
});
assert.equal(evaluated.matches.length, 1, 'HUGRAB + exact normalized HU-10 matches');
assert.equal(evaluated.matches[0]?.result, 'true');
assert.deepEqual(evaluated.intents.map((intent) => intent.action.type), ['tag.add', 'hold.for_review']);

const nearMiss = evaluateAutomationBundle({
  facts: {
    ...completeFacts,
    revision: 'facts-near-miss',
    lines: [{ lineId: 'line-1', sku: 'HU-100', name: 'Near miss', quantity: 1 }],
  },
  trigger: 'order_imported',
  rules: [compiled],
});
assert.equal(nearMiss.matches[0]?.result, 'false', 'HU-100 must not match exact HU-10');

const missingLines = evaluateAutomationBundle({
  facts: {
    ...completeFacts,
    revision: 'facts-lines-unknown',
    lines: [],
    completeness: { ...completeFacts.completeness, lines: false },
  },
  trigger: 'order_imported',
  rules: [compiled],
});
assert.equal(missingLines.matches[0]?.result, 'unknown');
assert.equal(missingLines.blocked, true, 'compliance unknownPolicy=block fails closed');

const reducedConflict = reduceAutomationIntents([
  {
    intentId: 'package-b-intent', ruleId: 'package-b', versionId: 'package-b-v1',
    priority: 20, position: 0, actionIndex: 0,
    action: { type: 'package.set', schemaVersion: 1, config: { packagePresetId: 'box-b' } },
  },
  {
    intentId: 'package-a-intent', ruleId: 'package-a', versionId: 'package-a-v1',
    priority: 20, position: 0, actionIndex: 0,
    action: { type: 'package.set', schemaVersion: 1, config: { packagePresetId: 'box-a' } },
  },
]);
assert.equal(reducedConflict.conflicts.length, 1, 'same-priority scalar disagreement is explicit');
assert.equal(reducedConflict.holdRequired, true, 'incompatible scalar intents create a compliance hold');

const reducedHazmatConflict = reduceAutomationIntents([
  {
    intentId: 'hazmat-a-intent', ruleId: 'hazmat-a', versionId: 'hazmat-a-v1',
    priority: 10, position: 0, actionIndex: 0,
    action: { type: 'hazmat.add_declaration', schemaVersion: 1, config: { contactName: 'Dispatch A', contactPhone: '310-555-0100' } },
  },
  {
    intentId: 'hazmat-b-intent', ruleId: 'hazmat-b', versionId: 'hazmat-b-v1',
    priority: 20, position: 0, actionIndex: 0,
    action: { type: 'hazmat.add_declaration', schemaVersion: 1, config: { contactName: 'Dispatch B', contactPhone: '310-555-0200' } },
  },
]);
assert.equal(reducedHazmatConflict.conflicts[0]?.actionType, 'hazmat.add_declaration', 'different dangerous-goods contacts always conflict');
assert.equal(reducedHazmatConflict.holdRequired, true, 'hazmat disagreement holds even when rule priorities differ');

const reducedSafe = reduceAutomationIntents([
  ...evaluated.intents,
  {
    ...evaluated.intents[0]!,
    intentId: 'tag-duplicate',
    action: { type: 'tag.add', schemaVersion: 1, config: { tag: 'hazmat' } },
  },
  {
    ...evaluated.intents[0]!,
    intentId: 'insurance-100',
    action: { type: 'insurance.require', schemaVersion: 1, config: { minimumValue: 100, provider: 'parcelguard', profileId: null } },
  },
  {
    ...evaluated.intents[0]!,
    intentId: 'insurance-250',
    action: { type: 'insurance.require', schemaVersion: 1, config: { minimumValue: 250, provider: 'carrier', profileId: null } },
  },
]);
assert.deepEqual(reducedSafe.plan.tags, ['HAZMAT'], 'tags use a case-insensitive stable union');
assert.equal(reducedSafe.plan.insurance?.minimumValue, 250, 'insurance takes the highest safe minimum');

const compiledDangerousGoods = compileAutomationRuleVersion({
  ...hu10Rule,
  actions: [{
    type: 'hazmat.add_declaration',
    schemaVersion: 1,
    config: { contactName: 'Dispatch Desk', contactPhone: '310-555-0100' },
  }],
}, { ruleId: 'hazmat', versionId: 'hazmat-v1', versionNumber: 1 });
assert.deepEqual(compiledDangerousGoods.document.actions[0]?.config, {
  contactName: 'Dispatch Desk',
  contactPhone: '310-555-0100',
});
assert.throws(
  () => compileAutomationRuleVersion({
    ...hu10Rule,
    actions: [{
      type: 'hazmat.add_declaration',
      schemaVersion: 1,
      config: { contactName: 'Dispatch Desk', contactPhone: 'not-a-phone' },
    }],
  }, { ruleId: 'hazmat-invalid', versionId: 'hazmat-invalid-v1', versionNumber: 1 }),
  /contact phone is invalid/,
  'invalid dangerous-goods contact details fail before publication',
);

assert.throws(
  () => compileAutomationRuleVersion({
    ...hu10Rule,
    actions: [{ type: 'label.purchase' as never, schemaVersion: 1, config: {} }],
  }, { ruleId: 'unsafe', versionId: 'unsafe-v1', versionNumber: 1 }),
  /Unsupported automation action/,
  'purchase actions cannot enter the allowlisted plan',
);

const catalog = getAutomationCatalog();
assert.equal(catalog.actions.find((action) => action.type === 'hazmat.add_declaration')?.available, true);
assert.equal(catalog.actions.find((action) => action.type === 'hazmat.add_declaration')?.label, 'Set shipment as dangerous goods');
// package.set is available now that the canonical package resolver consumes
// plan.package as its 'automation' rung (package-facts-policy.ts).
assert.equal(catalog.actions.find((action) => action.type === 'package.set')?.available, true);
// The preference actions follow AUTOMATION_PREFERENCE_RANKING, which is
// default-OFF -- so unavailable here, and unavailable in production until it
// is switched on. That is the point: the action and the ranking share a switch.
assert.equal(catalog.actions.find((action) => action.type === 'carrier.prefer')?.available, false);
assert.equal(catalog.actions.find((action) => action.type === 'service.prefer')?.available, false);
assert.equal(catalog.actions.some((action) => action.type === 'label.purchase'), false);
assert.equal(catalog.actions.some((action) => String(action.type) === 'hazmat.clear'), false, 'automation has no hazmat clear action');
assert.equal(catalog.limits.maxDepth, 3);
assert.equal(catalog.limits.maxNodes, 50);

console.log('PS-466 pure evaluator/conflict/action-registry tests passed');
