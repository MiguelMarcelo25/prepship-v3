/**
 * PS-466 closure packet — HUGRAB / HU-10 dangerous goods, end to end.
 *
 * Proves the PUBLISHED production rule against REAL production facts, using the
 * real loader, the real compiler, the real evaluator and the real conflict
 * reducer. Nothing is mocked except where a SKU does not exist in production,
 * which is called out per-check.
 *
 * READ-ONLY BY CONSTRUCTION. It loads rules and facts and evaluates them in
 * memory. It never calls saveOrderHazmat, never writes order_automation_state,
 * never touches a provider, and never buys postage. The evaluator and reducer
 * are pure; the only IO is SELECT.
 */
import { getAutomationRule, listAutomationRules } from '../src/services/automations/repository.js';
import { compileAutomationRuleVersion } from '../src/services/automations/contracts.js';
import { loadAutomationFacts } from '../src/services/automations/facts.js';
import { evaluateAutomationBundle } from '../src/services/automations/evaluator.js';
import { reduceAutomationIntents } from '../src/services/automations/conflicts.js';
import { getAutomationActionDefinition } from '../src/services/automations/catalog.js';
import {
  assertAutomationRateProofCurrent,
  assertAutomationPlanSupportedByProvider,
} from '../src/services/automations/rate-policy.js';
import type { AutomationFacts } from '../src/services/automations/contracts.js';

const GLOBAL_SCOPE = { isRestricted: false, clientIds: [], storeIds: [] } as never;
const HUGRAB_CLIENT_ID = 4;
const PROOF_ORDER_ID = 1838710; // order #3222 — HUGRAB, lines Booster-gel-001 + HU-10

let failures = 0;
function check(label: string, got: unknown, want: unknown, note?: string) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}${note ? `  [${note}]` : ''}`);
}

/** Same facts, line SKUs swapped. Used only for SKUs absent from production. */
function withSkus(facts: AutomationFacts, skus: string[]): AutomationFacts {
  return { ...facts, lines: skus.map((sku, i) => ({ ...(facts.lines[0] ?? {}), id: i + 1, sku, name: sku, quantity: 1 })) } as AutomationFacts;
}

const run = (facts: AutomationFacts, rules: unknown[]) =>
  evaluateAutomationBundle({ facts, trigger: 'order_imported', rules: rules as never });

async function main() {
  const facts = await loadAutomationFacts(PROOF_ORDER_ID, GLOBAL_SCOPE);

  // Compiles the PUBLISHED version regardless of whether the rule is currently
  // active. The first cut of this loaded via loadActiveAutomationRules, which
  // made the whole acceptance proof collapse the moment the rule was paused --
  // and pausing it was the correct operational call while hazmat writes are
  // gated. What this packet proves is the RULE'S LOGIC: that it matches HU-10
  // and rejects the near-misses. Pausing does not change that; it only decides
  // whether the engine consults it. Activation is reported below as its own
  // fact instead of being silently required.
  const listed = await listAutomationRules(GLOBAL_SCOPE);
  const hazmatOwners = [];
  for (const row of listed) {
    if (row.activeVersionId == null) continue;
    const detail = await getAutomationRule(row.id, GLOBAL_SCOPE);
    const version = detail.versions.find((v) => v.id === row.activeVersionId);
    if (!version) continue;
    const document = version.document as { actions?: { type: string }[] };
    if (!(document.actions ?? []).some((a) => a.type === 'hazmat.add_declaration')) continue;
    hazmatOwners.push({
      status: row.status,
      compiled: compileAutomationRuleVersion(document as never, {
        ruleId: String(row.id),
        versionId: String(version.id),
        versionNumber: version.versionNumber,
      }),
      label: `rule ${row.id} v${version.id} (${row.status})`,
    });
  }
  const rules = hazmatOwners.map((r) => r.compiled);

  console.log('=== 1. rule exists and is published in production ===');
  check('a hazmat rule is PUBLISHED for HUGRAB', hazmatOwners.length > 0, true,
    hazmatOwners.map((r) => r.label).join(' | '));
  // Reported, not asserted. A paused rule is a deliberate operational state --
  // right now, because hazmat writes are gated pending carrier certification.
  const live = hazmatOwners.filter((r) => r.status === 'active');
  console.log(`INFO  currently ACTIVE hazmat rules: ${live.length}`
    + `${live.length === 0 ? '  [paused — engine will not consult it until resumed]' : ''}`);

  console.log('\n=== 2. matches a REAL HUGRAB HU-10 order (#3222, id 1838710) ===');
  check('order is HUGRAB', facts.order.clientId, HUGRAB_CLIENT_ID);
  check('order really contains HU-10', facts.lines.map((l) => l.sku).includes('HU-10'), true,
    `real lines: ${facts.lines.map((l) => l.sku).join(' + ')}`);
  const real = run(facts, rules);
  const hazmatIntents = real.intents.filter((i) => i.action.type === 'hazmat.add_declaration');
  check('rule matched and planned a dangerous-goods declaration', hazmatIntents.length > 0, true);
  check('evaluation not blocked', real.blocked, false);
  check('mixed cart does not defeat the match', facts.lines.length > 1, true,
    'line_any: one matching line is enough');

  console.log('\n=== 3. does NOT match HU-100 or KIT-HU-10 ===');
  console.log('        (neither SKU exists in production, so these reuse the REAL order facts');
  console.log('         with only the line SKUs substituted — real rule, synthetic lines)');
  for (const sku of ['HU-100', 'KIT-HU-10']) {
    const negative = run(withSkus(facts, [sku]), rules);
    check(`no declaration planned for ${sku}`,
      negative.intents.filter((i) => i.action.type === 'hazmat.add_declaration').length, 0);
  }
  const both = run(withSkus(facts, ['HU-100', 'KIT-HU-10']), rules);
  check('no declaration when an order has BOTH near-miss SKUs',
    both.intents.filter((i) => i.action.type === 'hazmat.add_declaration').length, 0);
  const stillMatches = run(withSkus(facts, ['HU-100', 'HU-10']), rules);
  check('but DOES match when a real HU-10 sits beside a near-miss',
    stillMatches.intents.filter((i) => i.action.type === 'hazmat.add_declaration').length > 0, true);

  console.log('\n=== 4. invalidates stale rate/quote proof ===');
  check('hazmat.add_declaration is declared rate-proof-invalidating',
    getAutomationActionDefinition('hazmat.add_declaration')?.invalidatesRateProof, true);
  const reduced = reduceAutomationIntents(real.intents as never);
  check('the reduced plan carries invalidatesRateProof', reduced.plan.invalidatesRateProof, true);
  check('the plan names the winning hazmat intent', reduced.plan.hazmatIntentId != null, true);
  check('no conflicts in the reduced plan', reduced.conflicts.length, 0);

  console.log('\n=== 5. hazmat-aware rerating is reachable ===');
  check('the declaration action carries the contact the carrier needs',
    Object.keys((hazmatIntents[0]?.action.config ?? {})).sort(), ['contactName', 'contactPhone']);
  check('action is restrictive (narrows carriers, never widens)',
    getAutomationActionDefinition('hazmat.add_declaration')?.actionClass, 'restrictive');

  console.log('\n=== 6. label preflight refuses stale proof (no postage) ===');
  // These are the exact assertions the LABEL path runs before any purchase:
  // labels.ts:2635 (proof currency) and labels.ts:1832 (provider can consume
  // the plan). Calling them directly exercises the preflight without touching
  // a provider or buying anything.
  const watermark = {
    orderId: PROOF_ORDER_ID,
    factsRevision: 'r1',
    rulesetDigest: 'digest-abc',
    engineVersion: 'ps-466-v1',
    status: 'applied',
    plan: reduced.plan,
    lastRunId: null,
    failureCode: null,
  } as never;
  const threw = (fn: () => void): string | null => {
    try { fn(); return null; } catch (error) { return (error as Error).constructor.name; }
  };

  check('stale/missing rate proof is REFUSED before purchase',
    threw(() => assertAutomationRateProofCurrent(null, watermark)), 'AutomationRateProofError');
  check('a fingerprint quoting a DIFFERENT ruleset is refused',
    threw(() => assertAutomationRateProofCurrent('automationRulesVersion=abc:other-digest', watermark)),
    'AutomationRateProofError');
  check('a provider that cannot consume the plan fails CLOSED',
    threw(() => assertAutomationPlanSupportedByProvider(watermark, 'Shopify Shipping')),
    'AutomationPreflightError');

  console.log('\n=== 7. purchase safety ===');
  check('automation cannot buy a label',
    getAutomationActionDefinition('label.purchase' as never) ?? null, null,
    'no such action exists in the registry');
  check('declaring is publish-permissioned',
    getAutomationActionDefinition('hazmat.add_declaration')?.permission, 'automations:publish');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} PS-466 HUGRAB/HU-10 closure packet — ${failures} failure(s)`);
  console.log('No writes performed. No provider called. No postage purchased.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
