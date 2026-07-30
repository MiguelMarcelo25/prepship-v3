// PS-475: the dangerous-goods mark must follow the rules in BOTH directions.
//
// DJ: "if the rules is turn off it must untick and if i turn on it will
// automatically tick."
//
// Ticking already worked. Unticking did not, structurally: when no rule asks for
// hazmat there is no intent, so no handler runs, so nothing retracts. Orders
// 3240/3241/3242 kept their HAZMAT badge with all four rules paused.
//
// The engine now synthesises a hazmat.retract intent before reduction, so it
// inherits conflict handling, the effect lease, the idempotency key and
// rate-proof invalidation rather than re-implementing them.
//
// HALF THIS GUARD IS REFUSALS, and that is the point. A feature that can
// un-declare dangerous goods is only safe while it refuses to do so for a human
// decision, for a shipped order, or on a guess.
import { readFileSync } from 'node:fs';
import { withHazmatRetractionIntent } from '../src/services/automations/hazmat-retraction-intent.js';
import { AUTOMATION_ACTION_TYPES } from '../src/services/automations/catalog.js';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const catalog = readFileSync('src/services/automations/catalog.ts', 'utf8');
const hazmatAction = readFileSync('src/services/automations/hazmat-action.ts', 'utf8');
const runtime = readFileSync('src/services/automations/runtime.ts', 'utf8');
const orchestrator = readFileSync('src/services/automations/orchestrator.ts', 'utf8');

function facts(hazmatState: 'active' | 'none' | 'unknown'): never {
  return { workflow: { hazmatState } } as never;
}
const addIntent = {
  intentId: '24:0', ruleId: '8', versionId: '24', priority: 100, position: 0, actionIndex: 0,
  action: { type: 'hazmat.add_declaration', schemaVersion: 1, config: {} },
} as never;
const isRetract = (list: readonly unknown[]) =>
  list.some((i) => (i as { action: { type: string } }).action.type === 'hazmat.retract');

// --- it retracts when it should -------------------------------------------
check(
  'no rule declares hazmat + order is marked -> retraction is emitted',
  isRetract(withHazmatRetractionIntent([], facts('active'), false)),
);
check(
  'other rules still running does not suppress the retraction',
  isRetract(withHazmatRetractionIntent(
    [{ intentId: '21:0', ruleId: '3', versionId: '21', priority: 20, position: 0, actionIndex: 0,
       action: { type: 'tag.add', schemaVersion: 1, config: { tag: 'AUTOMATED' } } } as never],
    facts('active'), false,
  )),
);

// --- REFUSALS: the safety half --------------------------------------------
check(
  'a rule still declaring hazmat -> NO retraction (the rule wins)',
  !isRetract(withHazmatRetractionIntent([addIntent], facts('active'), false)),
);
check(
  'terminal order -> NO retraction (shipped/cancelled history is untouchable)',
  !isRetract(withHazmatRetractionIntent([], facts('active'), true)),
);
check(
  'hazmatState unknown -> NO retraction (never act on a guess)',
  !isRetract(withHazmatRetractionIntent([], facts('unknown'), false)),
);
check(
  'order not marked -> NO retraction (nothing to undo)',
  !isRetract(withHazmatRetractionIntent([], facts('none'), false)),
);
// Regression pin. The first cut read facts.workflow.hazmatState directly and
// crashed on partial facts -- which the PS-469 guard builds -- so it would have
// thrown on every automation run. A missing workflow block must be inert.
check(
  'partial facts with no workflow block -> no crash, NO retraction',
  (() => {
    try {
      return !isRetract(withHazmatRetractionIntent([], {} as never, false));
    } catch {
      return false;
    }
  })(),
);
check(
  'already emitted -> not duplicated',
  withHazmatRetractionIntent(
    withHazmatRetractionIntent([], facts('active'), false), facts('active'), false,
  ).length === 1,
);
check(
  'the original intents are preserved, not replaced',
  withHazmatRetractionIntent([addIntent], facts('active'), false).length === 1,
);

// --- the retract action must never be operator-authorable ------------------
check(
  'hazmat.retract exists as an action type',
  (AUTOMATION_ACTION_TYPES as readonly string[]).includes('hazmat.retract'),
);
check(
  'hazmat.retract is available:false so it cannot be authored in a rule',
  /type: 'hazmat\.retract',[\s\S]{0,600}?available: false/.test(catalog),
);

// --- the handler refuses to erase a human decision -------------------------
check(
  'a retraction handler exists',
  hazmatAction.includes('createAutomationHazmatRetractionHandler'),
);
check(
  'the handler preserves a MANUAL declaration',
  /createAutomationHazmatRetractionHandler[\s\S]*?current\.decisionSource === 'manual'[\s\S]*?preservedManualDecision: true/
    .test(hazmatAction),
);
check(
  'the handler is a no-op when the declaration is not active (converges)',
  /createAutomationHazmatRetractionHandler[\s\S]*?current\.declaration\?\.status !== 'active'/.test(hazmatAction),
);
check(
  'the handler clears rather than deletes (audit trail survives)',
  /createAutomationHazmatRetractionHandler[\s\S]*?normalizeHazmatDeclaration\(\{ status: 'clear' \}\)/.test(hazmatAction),
);

// --- wiring ----------------------------------------------------------------
check(
  'the handler is registered (an unregistered one fails the whole run)',
  /'hazmat\.retract': automationHazmatRetractionHandler/.test(runtime),
);
check(
  'the engine injects the retraction before reduction',
  orchestrator.includes('withHazmatRetractionIntent(evaluated.intents, input.facts, terminal)')
    && orchestrator.indexOf('withHazmatRetractionIntent(evaluated.intents')
      < orchestrator.indexOf('reduceAutomationIntents(evaluation.intents)'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-475 hazmat retraction guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-475 hazmat retraction guard');
