// PS-476: a rule status change must WAKE the orders it affects.
//
// DJ: "make it automatic."
//
// PS-475 taught the engine how to retract. It never ran, because pausing a rule
// updated the rule row and enqueued nothing. Orders 3240/3241 sat 5+ minutes
// with zero runs while paused. Before PS-469 this was masked -- ambient no-op
// sync writes gave 3240 roughly 85 runs an hour -- but with idempotency fixed,
// an order re-evaluates only when something fires an event, and nothing did.
//
// Two design decisions are pinned here because getting either wrong silently
// breaks the feature or breaks compliance:
//
//   1. NOT the reprocess job. outbox-worker refuses any job whose rule is not
//      'active' and evaluates that one rule in isolation, so it can apply a rule
//      but never converge away from one. Plain fact events take the normal path
//      that loads EVERY active rule.
//   2. NOT the manual_reprocess trigger. The hazmat add handler treats it as
//      permission to overwrite a MANUAL declaration, so resuming a rule would
//      re-declare an order a human cleared by hand (order 3242 is that case).
import { readFileSync } from 'node:fs';
import {
  RULE_STATUS_CONVERGENCE_CAP,
  CONVERGENCE_TRIGGER,
} from '../src/services/automations/rule-status-convergence.js';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const convergence = readFileSync('src/services/automations/rule-status-convergence.ts', 'utf8');
const repository = readFileSync('src/services/automations/repository.ts', 'utf8');
const worker = readFileSync('src/services/automations/outbox-worker.ts', 'utf8');

// --- the trigger choice is load-bearing -----------------------------------
check(
  'convergence uses order_facts_updated, NOT manual_reprocess',
  CONVERGENCE_TRIGGER === 'order_facts_updated',
);
check(
  'manual_reprocess is never used as the convergence trigger',
  !/CONVERGENCE_TRIGGER\s*=\s*'manual_reprocess'/.test(convergence),
);
// Why it matters, pinned at the source: the add handler's manual escape hatch.
check(
  'the reason is documented where someone would change it',
  /manual_reprocess/.test(convergence) && /MANUAL/.test(convergence),
);

// --- it emits plain fact events, not reprocess jobs ------------------------
check(
  'convergence enqueues order_facts_changed events',
  convergence.includes("eventType: 'order_facts_changed'"),
);
check(
  'convergence does NOT create reprocess jobs (a paused rule cannot be reprocessed)',
  !convergence.includes('automationReprocessJobs'),
);
check(
  'the worker still refuses reprocess jobs for non-active rules',
  worker.includes("row.rule.status !== 'active'"),
);
check(
  'the fact-event path loads every active rule via the normal evaluator',
  worker.includes('evaluateOrderAutomationFactEvent'),
);

// --- only non-terminal orders are woken ------------------------------------
check(
  'only awaiting_shipment orders are woken (terminal is a guaranteed no-op)',
  convergence.includes("eq(orders.orderStatus, 'awaiting_shipment')"),
);
check(
  'rule client/store scope is respected',
  convergence.includes('rule.clientId != null') && convergence.includes('rule.storeId != null'),
);

// --- bounded, and never silently -------------------------------------------
check(
  'there is a cap (PS-469: unbounded runs cost 322,962 runs / 791 MB)',
  Number.isInteger(RULE_STATUS_CONVERGENCE_CAP) && RULE_STATUS_CONVERGENCE_CAP > 0,
);
check(
  'truncation is logged, never silent',
  /if \(capped\)[\s\S]{0,300}console\.warn/.test(convergence),
);
check(
  'the cap is detected by over-fetching by one',
  convergence.includes('RULE_STATUS_CONVERGENCE_CAP + 1'),
);
check(
  'duplicate enqueues for the same transition are deduped',
  convergence.includes('onConflictDoNothing'),
);

// --- wiring: status change and wake-up are atomic --------------------------
check(
  'setAutomationRuleStatus enqueues convergence',
  /setAutomationRuleStatus[\s\S]*?enqueueRuleStatusConvergence\(tx, updated\)/.test(repository),
);
check(
  'the status update and the enqueue share one transaction',
  /setAutomationRuleStatus[\s\S]*?db\.transaction\(async \(tx\)[\s\S]*?enqueueRuleStatusConvergence/.test(repository),
);

if (failures > 0) {
  console.error(`\nFAIL PS-476 rule status convergence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-476 rule status convergence guard');
