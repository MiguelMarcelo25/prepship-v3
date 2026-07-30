// PS-472: a blocked order must say WHY it is blocked.
//
// 2026-07-30. A hazmat rule matched HU-10 HUGRAB orders, tried to write a
// declaration, and was refused: "Hazmat declaration writes are disabled."
// One failed action fails the whole run, and a failed run blocks rating. What
// the operator saw was "Rate unavailable · Retry" on the row and a generic
// "Automation evaluation failed; retry or review before continuing" from the
// API. Neither named hazmat, the action, or the capability flag behind it.
//
// 11 orders sat frozen for two days. The cause was already recorded in
// automation_action_results.reason the entire time -- nothing carried it out to
// the operator. This guard pins that it now does.
//
// DJ chose "explicit hold with a visible reason" over "skip and ship": the
// block STAYS so nothing ships undeclared. Only the explanation changed. The
// fail-closed checks at the bottom exist so a later "fix" cannot quietly turn
// this into fail-open.
import { readFileSync } from 'node:fs';
import { automationFailureMessage } from '../src/services/automations/automation-failure-message.js';

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
const runtime = readFileSync('src/services/automations/runtime.ts', 'utf8');

// --- behaviour: call the real function, do not pattern-match it ------------
const real = automationFailureMessage({
  actionType: 'hazmat.add_declaration',
  reason: 'Hazmat declaration writes are disabled.',
});
check(
  'the production case names the action and the handler reason',
  real.includes('hazmat.add_declaration') && real.includes('Hazmat declaration writes are disabled'),
);
check(
  'the message tells the operator what to do next',
  real.includes('Resolve it before rating or label purchase.'),
);
check(
  'an already-punctuated handler reason does not produce ".."',
  !real.includes('..'),
);
check(
  'reason alone still surfaces the reason',
  automationFailureMessage({ reason: 'Provider rejected the payload.' })
    .includes('Provider rejected the payload'),
);
check(
  'action alone still names the action',
  automationFailureMessage({ actionType: 'package.set' }).includes('package.set'),
);
check(
  'no detail at all still yields a usable sentence',
  automationFailureMessage({}).trim().length > 0
    && automationFailureMessage({}).includes('Resolve it'),
);
// The whole point of the ticket: the generic string must not come back.
check(
  'the old opaque message is gone from the formatter output',
  !automationFailureMessage({ actionType: 'hazmat.add_declaration', reason: 'x' })
    .includes('retry or review before continuing'),
);

// --- wiring: the preflight actually uses it --------------------------------
check(
  'orchestrator builds the failed-state message from the real reason',
  orchestrator.includes('automationFailureMessage({')
    && orchestrator.includes('reason: state.failureReason'),
);
check(
  'orchestrator no longer emits the generic failed-state string',
  !orchestrator.includes('Automation evaluation failed; retry or review before continuing'),
);
check(
  'the watermark carries the failure detail',
  /failureReason\?: string \| null;/.test(orchestrator)
    && /failureActionType\?: string \| null;/.test(orchestrator),
);
check(
  'runtime populates the failure detail from automation_action_results',
  runtime.includes('loadLatestAutomationFailure')
    && runtime.includes('automationActionResults.reason'),
);
check(
  'the failure lookup is skipped for healthy orders (rating hot path)',
  /status === 'failed'\s*\n?\s*\?\s*await loadLatestAutomationFailure/.test(runtime),
);

// --- fail-closed: this must stay a block, not a bypass ---------------------
// DJ's explicit choice. An order whose hazmat declaration could not be recorded
// must NOT rate or buy a label -- only the error text changed.
check(
  'a failed automation state still throws (nothing ships undeclared)',
  /if \(state\.status === 'failed'\) \{[\s\S]*?throw new AutomationPreflightError\(/.test(orchestrator),
);
check(
  'the failed state still uses the blocking preflight code',
  orchestrator.includes("'AUTOMATION_EVALUATION_FAILED'"),
);
check(
  'blocked and conflict states still throw',
  orchestrator.includes("'AUTOMATION_FACTS_UNKNOWN'")
    && orchestrator.includes("'AUTOMATION_CONFLICT'"),
);

if (failures > 0) {
  console.error(`\nFAIL PS-472 automation failure visibility guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-472 automation failure visibility guard');
