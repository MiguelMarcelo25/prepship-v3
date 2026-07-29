import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const workflow = readFileSync('.github/workflows/sync-cron.yml', 'utf8');

// 2026-07-29: was `workflow.includes("cron: '*/5 * * * *'")`. The check's own
// name is "automatic GitHub schedule is enabled" -- a schedule EXISTING is the
// invariant; the five-minute literal was an over-specific way of writing it,
// and it made a cost change look like a safety regression.
//
// sync-cron is a SAFETY NET for a wedged pg-boss worker, not the primary
// scheduler (the Render worker runs every 3 minutes). At */5 it fired ~8,640
// times a month and, with production-watchdog doing the same, consumed
// essentially the whole GitHub Actions allowance -- which blocked the deploy
// gate. Now */30, which still catches a wedge well inside any useful window.
//
// Third guard found pinning one of these cron literals. The other two are
// ps-431-production-self-healing-guard.ts and production-watchdog-guard.mjs.
check('automatic GitHub schedule is enabled', /schedule:\s*\n\s*- cron: '[^']+'/.test(workflow));
check('scheduled run targets shipments only', workflow.includes("github.event_name == 'schedule' && 'shipments'"));
check('workflow can call shipment cron endpoint', workflow.includes('endpoint="/cron/sync-shipments"'));
check('missing CRON_SECRET fails scheduled runs loudly', workflow.includes('scheduled shipment sync cannot run') && workflow.includes('exit 1'));
check('overlapping shipment safety-net runs are serialized', workflow.includes('concurrency:') && workflow.includes('cancel-in-progress: false'));
check('workflow is not documented as disabled', !workflow.includes('Automatic GitHub schedules are disabled'));

if (failures > 0) {
  console.error(`\nFAIL PS-365 shipment sync cron safety-net guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-365 shipment sync cron safety-net guard');
