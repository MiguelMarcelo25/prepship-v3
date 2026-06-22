/**
 * PS-300 active Lawrence execution workflow guard.
 *
 * Offline only: no DB, no network, no Trello mutation, no provider calls, no
 * labels, no postage, no marketplace notifications, and no production data
 * mutation. This guard locks the active-ticket workflow and verifies it points
 * at existing backend-boundary gates before implementation continues.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const docPath = 'docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md';
const doc = readText(docPath);
const packageJson = readText('package.json');
const envText = readText('src/lib/env.ts');
const printQueueRoute = readText('src/routes/print-queue.ts');
const usersRoute = readText('src/routes/users.ts');

check('PS-300 workflow document exists', existsSync(docPath));

const activeTickets = [
  'PS-166',
  'PS-258',
  'PS-285',
  'PS-287',
  'PS-289',
  'PS-290',
  'PS-292',
  'PS-294',
  'PS-295',
  'PS-296',
  'PS-300',
  'PS-301',
  'PS-302',
  'PS-303',
  'PS-304',
  'PS-305',
  'PS-306',
  'PS-307',
  'PS-308',
];

for (const ticket of activeTickets) {
  check(`document scopes ${ticket}`, doc.includes(ticket));
}

check('workflow requires task regen before sprint batches',
  /Run `task regen`/.test(doc));
check('workflow is report-first by default',
  /Trello policy is report first/.test(doc) &&
  /not add comments, move cards, edit cards, or create cards/.test(doc));
check('task update is the only Trello mutation shortcut',
  /unless the user\s+explicitly runs or approves `task update`/.test(doc));
check('workflow maps unnumbered cards instead of creating duplicates',
  /Map unnumbered cards into existing PS tickets/.test(doc) &&
  /do not create a new PS\s+card/.test(doc));
check('PS-308 supersedes PS-292 tuple direction',
  /PS-308 supersedes PS-292/.test(doc) &&
  /final no-tuple UI direction/.test(doc));

const laneOne = doc.match(/## Lane 1[\s\S]*?## Lane 2/)?.[0] ?? '';
const laneOneOrder = ['PS-300', 'PS-301', 'PS-302', 'PS-303', 'PS-304', 'PS-305', 'PS-306'];
let previousIndex = -1;
for (const ticket of laneOneOrder) {
  const index = laneOne.indexOf(ticket);
  check(`Lane 1 includes ${ticket} in dependency order`, index > previousIndex);
  previousIndex = index;
}

check('workflow records multi-agent role coverage',
  [
    'Orchestrator',
    'Trello Researcher',
    'Backend Engineer',
    'Full-Stack Engineer',
    'QA Tester',
    'Auditor',
    'Release/Runtime Verifier',
    'Regression Agent',
  ].every((role) => doc.includes(role)));

check('closeout requires focused guards and global gates',
  doc.includes('focused guards passing') &&
  doc.includes('`git diff --check` passing') &&
  doc.includes('`npm run typecheck` passing') &&
  doc.includes('`npm run build:web` passing'));
check('closeout distinguishes Final Review from 100%',
  /eligible for Final Review - Lawrence at 89%/.test(doc) &&
  /A card is\s+100% only/.test(doc));
check('safety forbids live money/label/runtime mutations',
  /No live labels, postage, voids, marketplace notifications, production order\s+mutation, or shipped\/cancelled data mutation/.test(doc));
check('workflow rejects frontend-owned business authority',
  /frontend must not own money, rate, label, billing/.test(doc) &&
  /backend source-of-truth owners/.test(doc));
check('workflow protects internal cost visibility',
  /Do not expose internal Rate Cost, margin, SHIPP cost, secrets, or cross-client\s+data/.test(doc));

check('package wires PS-300 workflow guard',
  /"test:ps-300-active-lawrence-workflow"\s*:\s*"tsx scripts\/ps-300-active-lawrence-workflow-guard\.ts"/.test(packageJson));
check('package wires PS-300 backend authority guard',
  /"test:ps-300-backend-shipping-authority"\s*:\s*"tsx scripts\/ps-300-backend-shipping-authority-guard\.ts"/.test(packageJson));
check('package wires PS-301 row workflow authority guard',
  /"test:ps-301-row-workflow-authority"\s*:\s*"tsx scripts\/ps-301-row-workflow-authority-guard\.ts"/.test(packageJson));
check('package wires PS-302 apply-best-rate authority guard',
  /"test:ps-302-apply-best-rate-authority"\s*:\s*"tsx scripts\/ps-302-apply-best-rate-authority-guard\.ts"/.test(packageJson));
check('package wires PS-303 print queue authority guard',
  /"test:ps-303-print-queue-authority"\s*:\s*"tsx scripts\/ps-303-print-queue-authority-guard\.ts"/.test(packageJson));
check('package wires PS-304 shipping display facts authority guard',
  /"test:ps-304-shipping-display-facts-authority"\s*:\s*"tsx scripts\/ps-304-shipping-display-facts-authority-guard\.ts"/.test(packageJson));
check('package wires PS-305 authority drift guard',
  /"test:ps-305-authority-drift"\s*:\s*"tsx scripts\/ps-305-authority-drift-guard\.ts"/.test(packageJson));
check('package wires PS-306 OrdersView parity cutover guard',
  /"test:ps-306-ordersview-parity-cutover"\s*:\s*"tsx scripts\/ps-306-ordersview-parity-cutover-guard\.ts"/.test(packageJson));
check('package wires PS-307 marked-rate comparison guard',
  /"test:ps-307-marked-rate-comparison"\s*:\s*"tsx scripts\/ps-307-marked-rate-comparison-guard\.ts"/.test(packageJson));
check('package wires PS-308 separated rate-cost guard',
  /"test:ps-308-rate-cost-columns"\s*:\s*"tsx scripts\/ps-308-rate-cost-columns-guard\.ts"/.test(packageJson));
check('package wires PS-290 HUGRAB insurance badge guard',
  /"test:ps-290-hugrab-insurance-coverage-badge"\s*:\s*"tsx scripts\/ps-290-hugrab-insurance-coverage-badge-guard\.ts"/.test(packageJson));
check('package still wires PS-279 backend orchestration guard',
  packageJson.includes('"test:ps-279-backend-orchestration"'));
check('package still wires PS-279 closeout guard',
  packageJson.includes('"test:ps-279-backend-boundary-closeout"'));
check('package wires PS-287/294 label guards',
  packageJson.includes('"test:ps-287-print-queue-label-normalization"') &&
  packageJson.includes('"test:ps-287-print-queue-label-normalization-closeout"') &&
  packageJson.includes('"test:ps-294-shipp-4x6-placement"') &&
  packageJson.includes('"test:ps-294-shipp-4x6-closeout"'));
check('package wires PS-292/295/296 money guards',
  packageJson.includes('"test:ps-292-house-tuple-display"') &&
  packageJson.includes('"test:ps-292-final-review-closeout"') &&
  packageJson.includes('"test:ps-295-house-customer-rate-proof"') &&
  packageJson.includes('"test:ps-296-shipping-margin"') &&
  packageJson.includes('"test:ps-296-shipping-margin-closeout"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('package wires PS-166/258 decomposition closeout guard',
  packageJson.includes('"test:ps-166-ps-258-decomposition-closeout"'));
check('package wires PS-285 umbrella closeout guard',
  packageJson.includes('"test:ps-285-umbrella-closeout"'));

check('print queue backend orchestration flag defaults off',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('print queue frontend delegation flag defaults off',
  envText.includes('PRINT_QUEUE_FE_DELEGATION: booleanFlag(false)'));
check('route-plan endpoint is registered',
  printQueueRoute.includes("app.post('/route-plan'"));
check('route-plan is gated before planning',
  (() => {
    const handlerStart = printQueueRoute.indexOf("app.post('/route-plan'");
    const flagCheck = printQueueRoute.indexOf('env.PRINT_QUEUE_BACKEND_ORCHESTRATION', handlerStart);
    const planCall = printQueueRoute.indexOf('planQueueRouteForOrders(', handlerStart);
    return handlerStart >= 0 && flagCheck > handlerStart && planCall > flagCheck;
  })());
check('route-plan disabled state is explicit',
  printQueueRoute.includes("'FEATURE_DISABLED'") && printQueueRoute.includes('503'));
check('user DTO exposes backend and FE queue flags separately',
  usersRoute.includes('printQueueBackendOrchestration') &&
  usersRoute.includes('printQueueFeDelegation') &&
  usersRoute.includes('env.PRINT_QUEUE_BACKEND_ORCHESTRATION') &&
  usersRoute.includes('env.PRINT_QUEUE_FE_DELEGATION'));

if (failures > 0) {
  console.error(`\nFAIL PS-300 active Lawrence workflow guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-300 active Lawrence workflow guard');
