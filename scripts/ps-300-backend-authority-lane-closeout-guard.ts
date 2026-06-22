/**
 * PS-300 lane closeout guard.
 *
 * Offline only. This guard keeps the backend-authority lane truthful: several
 * child cards are Final Review-ready, but PS-304 and PS-306 remain conservative
 * because explicit frontend fallback / UI-lock caveats still exist.
 */
import { existsSync, readFileSync } from 'node:fs';

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

function hasScript(packageJson: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(packageJson);
}

const docPath = 'docs/ps-tickets/ps-300-backend-authority-lane-status.md';
const doc = read(docPath);
const packageJson = read('package.json');
const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
const ps304Doc = read('docs/ps-tickets/ps-304-shipping-display-facts-authority-status.md');
const ps306Doc = read('docs/ps-tickets/ps-306-ordersview-parity-cutover.md');
const ps303Guard = read('scripts/ps-303-print-queue-authority-guard.ts');
const ps304Guard = read('scripts/ps-304-shipping-display-facts-authority-guard.ts');
const ps305Doc = read('docs/ps-tickets/ps-305-authority-drift-guardrails.md');
const ordersView = read('web/src/components/Views/OrdersView.tsx');

check('PS-300 lane status doc exists', existsSync(docPath));

const requiredScripts = [
  ['test:ps-300-active-lawrence-workflow', 'tsx scripts/ps-300-active-lawrence-workflow-guard.ts'],
  ['test:ps-300-backend-shipping-authority', 'tsx scripts/ps-300-backend-shipping-authority-guard.ts'],
  ['test:ps-301-row-workflow-authority', 'tsx scripts/ps-301-row-workflow-authority-guard.ts'],
  ['test:ps-302-apply-best-rate-authority', 'tsx scripts/ps-302-apply-best-rate-authority-guard.ts'],
  ['test:ps-303-print-queue-authority', 'tsx scripts/ps-303-print-queue-authority-guard.ts'],
  ['test:ps-304-shipping-display-facts-authority', 'tsx scripts/ps-304-shipping-display-facts-authority-guard.ts'],
  ['test:ps-305-authority-drift', 'tsx scripts/ps-305-authority-drift-guard.ts'],
  ['test:ps-306-ordersview-parity-cutover', 'tsx scripts/ps-306-ordersview-parity-cutover-guard.ts'],
  ['test:order-editable-lockdown', 'node scripts/order-editable-lockdown-guard.mjs'],
  ['test:ps-245-lockdown-fence', 'tsx scripts/ps-245-lockdown-fence-guard.ts'],
] as const;

for (const [script, target] of requiredScripts) {
  check(`package wires ${script}`, hasScript(packageJson, script, target));
  check(`lane doc lists ${script}`, doc.includes(`\`${script}\``));
}

check('package wires this PS-300 lane closeout guard',
  hasScript(packageJson, 'test:ps-300-backend-authority-lane-closeout', 'tsx scripts/ps-300-backend-authority-lane-closeout-guard.ts'));
check('workflow doc records this PS-300 lane closeout guard',
  workflowDoc.includes('test:ps-300-backend-authority-lane-closeout'));

const finalReviewReady = [
  ['PS-300', '90%', 'Final Review-ready'],
  ['PS-301', '90%', 'Final Review-ready'],
  ['PS-302', '90%', 'Final Review-ready'],
  ['PS-303', '89%', 'Final Review-ready, scoped'],
  ['PS-305', '90%', 'Final Review-ready'],
] as const;

for (const [ticket, percent, recommendation] of finalReviewReady) {
  check(`${ticket} lane row is Final Review-ready at the conservative percent`,
    doc.includes(`| ${ticket} | ${percent} | ${recommendation} |`));
}

check('PS-304 remains conservative and references fallback debt',
  doc.includes('| PS-304 | 86% | Keep in progress |') &&
    doc.includes('frontend compatibility fallback debt remains') &&
    /Current completion estimate: PS-304 86%/.test(ps304Doc) &&
    /not Final Review-ready yet/.test(ps304Doc));
check('PS-306 remains conservative because UI read-only lockdown is disabled',
  doc.includes('| PS-306 | 86% | Keep in progress |') &&
    doc.includes('const isReadOnly = false') &&
    /not Final Review-ready while `OrdersView\.tsx` has/.test(ps306Doc) &&
    /const isReadOnly = false/.test(ordersView));

check('PS-303 scoped final-review note keeps frontend fallback honest',
  doc.includes('frontend local fallback remains until cutover') &&
    ps303Guard.includes('frontend local route fallback remains until final cutover'));
check('PS-304 guard pins backend account tuple preference despite fallback debt',
  ps304Guard.includes('frontend account resolver prefers backend display tuple when present') &&
    ps304Guard.includes('frontend account display now consumes backend tuple before compatibility fallbacks'));
check('PS-305 guardrails still keep frontend debt explicit',
  ps305Doc.includes('Keep remaining compatibility fallbacks explicit and tracked as PS-306 debt'));

check('lane doc rejects live side effects and Trello mutation',
  /offline\/static/.test(doc) &&
    /does not run live labels/.test(doc) &&
    /mutate shipped\/cancelled data/.test(doc) &&
    /Trello mutation[\s\S]*requires explicit `task update`/.test(doc));

if (failures > 0) {
  console.error(`\nFAIL PS-300 backend authority lane closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-300 backend authority lane closeout guard');
