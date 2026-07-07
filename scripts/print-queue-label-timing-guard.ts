/**
 * Guard: Print-to-Queue must expose backend label-create timing details.
 *
 * The queue send result already records labelPurchaseMs, but that bucket is too
 * broad to optimize safely. The label owner should return its own timing
 * breakdown and the print-queue owner should persist it with the per-order
 * queue timing snapshot.
 */
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

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const labels = read('src/services/labels.ts');
const printQueue = read('src/services/print-queue.ts');
const queueSnapshot = read('src/services/print-queue/queue-send-snapshot.ts');
const packageJson = read('package.json');

check('labels exports a label-create timing breakdown type',
  /export type LabelCreateTimingBreakdown/.test(labels));
check('label response DTO carries optional backend timings',
  /timings\?: LabelCreateTimingBreakdown/.test(labels));
check('createLabelTimer stores step durations and exposes snapshot()',
  /const steps: Record<string, number> = \{\}/.test(labels) &&
    /snapshot\(/.test(labels) &&
    /steps: \{ \.\.\.steps \}/.test(labels));
check('real label response returns timer snapshot timings',
  /timings: timer\.snapshot\(\{ provider: directRef \? 'direct' : 'shipstation' \}\)/.test(labels));
check('test label response returns timer snapshot timings',
  /timings: timer\.snapshot\(\{ provider: 'mock' \}\)/.test(labels));
check('print queue timing type includes labelCreateTimings',
  /labelCreateTimings\?: LabelCreateTimingBreakdown/.test(printQueue));
check('print queue copies createLabelV2 timings into queue result timings',
  /if \(created\.timings\) timings\.labelCreateTimings = created\.timings/.test(printQueue));
check('durable queue snapshot type includes labelCreateTimings',
  /labelCreateTimings\?: LabelCreateTimingBreakdown/.test(queueSnapshot));
check('package.json wires test:print-queue-label-timing',
  /"test:print-queue-label-timing": "tsx scripts\/print-queue-label-timing-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL print queue label timing guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS print queue label timing guard');
