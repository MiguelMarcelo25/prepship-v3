/**
 * PS-335 guard-of-the-guard for the mandatory SOT/backend-truth/no-wrapper pack.
 *
 * Offline/static only: reads package scripts, CI, docs, and the pack runner. It
 * does not import product runtime, call providers, touch DB, buy labels, notify
 * marketplaces, or mutate shipped/cancelled data.
 */
import { existsSync, readFileSync } from 'node:fs';

const REQUIRED_GUARDS = [
  'test:ps-305-authority-drift',
  'test:rate-source-of-truth',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:ps-336-task-sot-gates',
  'test:ps-429-final-review-closure',
  'test:ps-430-print-queue-worker-health',
  'test:ps-431-production-self-healing',
  'test:ps-433-frontend-source-of-truth',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-329-orders-wrapper-sot-cleanup',
  'test:ps-412-finalized-billing',
  'test:audit-money-rounding',
  'test:audit-orders-service-boundary',
  'test:audit-pg-boss-inventory-outbox',
  'test:audit-runtime-schema-readiness',
  'test:audit-imported-handler-boundary',
  'test:audit-print-queue-merge-durability',
  'test:audit-structured-money-logging',
  'test:audit-orders-bulk-snapshot',
] as const;

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: readonly string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const packageJsonText = read('package.json');
const packageJson = packageJsonText ? JSON.parse(packageJsonText) as { scripts?: Record<string, string> } : {};
const scripts = packageJson.scripts ?? {};
const ci = read('.github/workflows/ci.yml');
const packPath = 'scripts/sot-guard-pack.mjs';
const pack = read(packPath);
const prTemplate = read('.github/pull_request_template.md');
const archChecklist = read('docs/engineering/architecture-first-checklist.md');
const taskTemplate = read('docs/engineering/task-template.md');

check('package wires the consolidated mandatory SOT guard pack',
  scripts['test:sot-guard-pack'] === 'node scripts/sot-guard-pack.mjs');
check('package wires the PS-335 guard-of-the-guard',
  scripts['test:ps-335-sot-guard-pack'] === 'tsx scripts/ps-335-sot-guard-pack-guard.ts');

for (const command of REQUIRED_GUARDS) {
  check(`package keeps required guard ${command}`, typeof scripts[command] === 'string' && scripts[command].length > 0);
}

check('SOT guard pack runner exists', existsSync(packPath));
checkIncludesAll('SOT guard pack runner includes every required guard', pack, REQUIRED_GUARDS);
checkPatterns('SOT guard pack runner actually executes npm run commands sequentially', pack, [
  /spawnSync\(/,
  /npm/,
  /run/,
  /process\.exit\(1\)/,
]);
check('SOT guard pack runner is offline/static and contains no live/mutating command names',
  !/(live-approved|real-label|marketplace:confirm:retry|:apply|shipstation:recover|shipstation:external-shipped|smoke:marketplace-confirm|smoke:shipping)/i.test(pack));

check('CI references the consolidated SOT guard pack by npm script',
  /npm run test:sot-guard-pack/.test(ci));
check('CI no longer relies only on the old two standalone authority guards',
  /test:sot-guard-pack/.test(ci) &&
  !(/test:ps-305-authority-drift[\s\S]*test:rate-source-of-truth[\s\S]*Typecheck/.test(ci) &&
    !/test:ps-314-no-sot-bypass-wrappers|test:ps-316-backend-truth-law|test:sot-guard-pack/.test(ci)));

checkIncludesAll('PR template requires the mandatory SOT guard pack for sensitive changes', prTemplate, [
  'npm run test:sot-guard-pack',
  'Backend truth / no-wrapper law checked',
  'no wrapper/helper/adapter became a second source of truth',
]);
checkIncludesAll('architecture checklist names the mandatory SOT guard pack', archChecklist, [
  'npm run test:sot-guard-pack',
  'SOT/no-wrapper guard pack',
]);
checkIncludesAll('task template names the mandatory SOT guard pack', taskTemplate, [
  'npm run test:sot-guard-pack',
  'source-of-truth / backend-truth / no-wrapper',
]);

if (failures > 0) {
  console.error(`\nPS-335 SOT guard-pack guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-335 SOT guard-pack guard passed.');
