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

check('automatic GitHub schedule is enabled', workflow.includes("cron: '*/5 * * * *'"));
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
