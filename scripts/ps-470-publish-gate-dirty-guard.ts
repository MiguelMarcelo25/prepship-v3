/**
 * PS-470 publish-gate guard: an unsaved edit must never publish.
 *
 * Offline/static: pure function, no DB, no network, no postage.
 *
 * The live defect this pins (2026-07-29, HAZ rule). `publish()` posts only the
 * simulation hash, so the backend publishes the SAVED DRAFT and never the
 * on-screen document. Opening a published rule immediately clones a draft, so
 * `hasDraft` was true from the first render and the gate had nothing left to
 * stop on. An operator changed tag.add -> hazmat.add_declaration, published
 * three times, and every version came back byte-identical to the original --
 * three silent no-op publishes, each reported as success.
 *
 * `simulate()` has the same shape: it posts only { orderId }, so a test result
 * describes the saved draft too. The operator saw "Test passed. Ready to
 * publish" for a rule that was not the one on screen.
 */
import { resolvePublishBlockReason, draftNeedsSimulation } from '../web/src/components/Views/automations/publish-gate';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const clean = {
  activeRule: true,
  hasDraft: true,
  isDirty: false,
  needsSimulation: false,
  simulation: null,
};

// ── The regression itself ────────────────────────────────────────────────────
check('a dirty draft CANNOT publish',
  resolvePublishBlockReason({ ...clean, isDirty: true }) !== null);

check('the dirty message names saving as the fix',
  /save the draft/i.test(resolvePublishBlockReason({ ...clean, isDirty: true }) ?? ''),
  resolvePublishBlockReason({ ...clean, isDirty: true }));

// The exact live shape: a passing test, plus an edit made after it. This is
// what published three identical versions.
check('a PASSING test does not rescue a dirty draft',
  resolvePublishBlockReason({
    ...clean,
    isDirty: true,
    needsSimulation: true,
    simulation: { blocked: false, conflictCount: 0 },
  }) !== null);

// Dirty must outrank the simulation prompt -- otherwise the operator is told to
// run a test, runs one against the stale draft, and is waved through.
check('dirty is reported BEFORE the run-a-test prompt',
  /save the draft/i.test(resolvePublishBlockReason({
    ...clean, isDirty: true, needsSimulation: true, simulation: null,
  }) ?? ''));

// ── Everything that must still work ──────────────────────────────────────────
check('a clean low-risk draft publishes', resolvePublishBlockReason(clean) === null);

check('a clean gated draft with a passing test publishes',
  resolvePublishBlockReason({
    ...clean, needsSimulation: true, simulation: { blocked: false, conflictCount: 0 },
  }) === null);

check('an inactive rule cannot publish',
  resolvePublishBlockReason({ ...clean, activeRule: false }) !== null);

check('no draft cannot publish',
  resolvePublishBlockReason({ ...clean, hasDraft: false }) !== null);

check('a gated draft with NO test cannot publish',
  resolvePublishBlockReason({ ...clean, needsSimulation: true, simulation: null }) !== null);

check('a BLOCKED test cannot publish, even when clean',
  resolvePublishBlockReason({
    ...clean, needsSimulation: true, simulation: { blocked: true, conflictCount: 0 },
  }) !== null);

check('a CONFLICTING test cannot publish, even when clean',
  resolvePublishBlockReason({
    ...clean, needsSimulation: true, simulation: { blocked: false, conflictCount: 2 },
  }) !== null);

// A blocked test blocks a low-risk rule too: if the operator ran a test and it
// came back blocked, publishing anyway ignores evidence they asked for.
check('a blocked test blocks even a low-risk rule',
  resolvePublishBlockReason({
    ...clean, needsSimulation: false, simulation: { blocked: true, conflictCount: 0 },
  }) !== null);

// ── The risk classifier this gate depends on ─────────────────────────────────
check('hazmat.add_declaration requires a simulation',
  draftNeedsSimulation(
    [{ type: 'hazmat.add_declaration' }],
    [{ type: 'hazmat.add_declaration', requiresSimulation: true }, { type: 'tag.add', requiresSimulation: false }],
  ));
check('tag.add alone does not require a simulation',
  !draftNeedsSimulation([{ type: 'tag.add' }], [{ type: 'tag.add', requiresSimulation: false }]));
check('an unknown action fails CLOSED (requires a simulation)',
  draftNeedsSimulation([{ type: 'not.a.real.action' }], [{ type: 'tag.add', requiresSimulation: false }]));
check('an empty action list fails CLOSED',
  draftNeedsSimulation([], [{ type: 'tag.add', requiresSimulation: false }]));

// ── The view must delegate, not re-implement ─────────────────────────────────
import { readFileSync } from 'node:fs';
const view = readFileSync('web/src/components/Views/AutomationsView.tsx', 'utf8').replace(/\r\n/g, '\n');
check('AutomationsView delegates to the pure gate',
  /resolvePublishBlockReason\(\{/.test(view));
check('AutomationsView passes isDirty into the gate',
  /resolvePublishBlockReason\(\{[\s\S]{0,240}isDirty/.test(view));
check('a stale test result is dropped when the document changes',
  /if \(isDirty\) setSimulation\(null\)/.test(view));

if (failures > 0) {
  console.error(`\nFAIL PS-470 publish-gate dirty guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-470 publish-gate dirty guard');
