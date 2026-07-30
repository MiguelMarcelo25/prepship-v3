// PS-475: the dangerous-goods mark must follow the rules in BOTH directions.
//
// DJ: "if the rules is turn off it must untick and if i turn on it will
// automatically tick."
//
// FIRST ATTEMPT FAILED IN PRODUCTION, and the reason is the most important
// thing in this file. It synthesised a `hazmat.retract` INTENT so the retraction
// could ride the normal intent pipeline. That is structurally impossible:
//
//   automation_action_results.ruleVersionId
//     integer NOT NULL REFERENCES automation_rule_versions(id)
//
// Every effect row must be attributable to a persisted rule version, and a
// retraction has no rule behind it -- the rule is precisely what went away. The
// sentinel ids threw "Rule version ID must be a persisted numeric ID", retried
// five times, and went dead, leaving orders 3240/3241 still marked.
//
// So the decision is a pure predicate and the ACT is an explicit convergence
// step in the orchestrator. Nothing is lost: the hazmat tables carry their own
// audit (revision, decision_source, append-only snapshots).
//
// HALF THIS GUARD IS REFUSALS. A feature that can un-declare dangerous goods is
// only safe while it declines to act on a human decision, a shipped order, or a
// guess.
import { readFileSync } from 'node:fs';
import { shouldRetractAutomationHazmat } from '../src/services/automations/hazmat-retraction-intent.js';
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

const orchestrator = readFileSync('src/services/automations/orchestrator.ts', 'utf8');
const hazmatAction = readFileSync('src/services/automations/hazmat-action.ts', 'utf8');
const schema = readFileSync('src/db/schema/automations.ts', 'utf8');

const facts = (hazmatState: 'active' | 'none' | 'unknown') =>
  ({ workflow: { hazmatState } } as never);
const addIntent = {
  intentId: '24:0', ruleId: '8', versionId: '24', priority: 100, position: 0, actionIndex: 0,
  action: { type: 'hazmat.add_declaration', schemaVersion: 1, config: {} },
} as never;

// --- the decision ----------------------------------------------------------
check(
  'no rule declares hazmat + order is marked -> retract',
  shouldRetractAutomationHazmat([], facts('active'), false),
);
check(
  'a rule still declaring hazmat -> do NOT retract (the rule wins)',
  !shouldRetractAutomationHazmat([addIntent], facts('active'), false),
);
check(
  'terminal order -> do NOT retract (shipped/cancelled history is untouchable)',
  !shouldRetractAutomationHazmat([], facts('active'), true),
);
check(
  'unknown hazmat state -> do NOT retract (never act on a guess)',
  !shouldRetractAutomationHazmat([], facts('unknown'), false),
);
check(
  'order not marked -> do NOT retract (nothing to undo)',
  !shouldRetractAutomationHazmat([], facts('none'), false),
);
check(
  'partial facts with no workflow block -> no crash, no retract',
  (() => {
    try { return !shouldRetractAutomationHazmat([], {} as never, false); } catch { return false; }
  })(),
);

// --- it must NOT be an intent ----------------------------------------------
// The regression pin for the production failure.
check(
  'the effect table still requires a persisted rule version (why intents cannot work)',
  /ruleVersionId: integer\(\)\.notNull\(\)\.references\(\(\) => automationRuleVersions\.id/.test(schema),
);
check(
  'hazmat.retract is NOT an action type',
  !(AUTOMATION_ACTION_TYPES as readonly string[]).includes('hazmat.retract'),
);
check(
  'no synthetic intent is injected into the pipeline',
  !orchestrator.includes('withHazmatRetractionIntent'),
);

// --- it is an explicit convergence step ------------------------------------
check(
  'the orchestrator decides via the predicate',
  orchestrator.includes('shouldRetractAutomationHazmat(evaluation.intents, input.facts, terminal)'),
);
check(
  'convergence runs ONLY on a clean completed pass',
  /if \(status === 'completed' && retractHazmat\)/.test(orchestrator),
);
check(
  'a failed retraction fails the run loudly rather than passing silently',
  orchestrator.includes("failureCode = 'AUTOMATION_HAZMAT_RETRACTION_FAILED'"),
);

// --- the act refuses to erase a human decision -----------------------------
check(
  'a MANUAL declaration is preserved',
  /createAutomationHazmatRetraction[\s\S]*?current\.decisionSource === 'manual'[\s\S]*?preservedManualDecision: true/
    .test(hazmatAction),
);
check(
  'idempotent: a no-op when the declaration is not active',
  /createAutomationHazmatRetraction[\s\S]*?current\.declaration\?\.status !== 'active'[\s\S]*?alreadyCleared/
    .test(hazmatAction),
);
check(
  'it CLEARS rather than deletes (audit trail survives)',
  /createAutomationHazmatRetraction[\s\S]*?normalizeHazmatDeclaration\(\{ status: 'clear' \}\)/.test(hazmatAction),
);
check(
  'expectedRevision stands in for the effect lease',
  /createAutomationHazmatRetraction[\s\S]*?expectedRevision: current\.revision/.test(hazmatAction),
);
check(
  'no fabricated rule ids are written into the audit trail',
  !/createAutomationHazmatRetraction[\s\S]*?ruleId: 'system/.test(hazmatAction),
);

if (failures > 0) {
  console.error(`\nFAIL PS-475 hazmat retraction guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-475 hazmat retraction guard');
