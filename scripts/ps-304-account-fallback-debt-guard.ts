/**
 * PS-304 account fallback debt guard.
 *
 * Offline/static only. This proves PS-304's backend display tuple wins before
 * frontend account compatibility fallbacks, while the remaining fallbacks are
 * explicitly tracked as PS-306 cutover debt.
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

function indexOfOrFail(source: string, pattern: string): number {
  const idx = source.indexOf(pattern);
  check(`source contains ${pattern}`, idx >= 0);
  return idx;
}

const debtDocPath = 'docs/ps-tickets/ps-304-account-display-fallback-debt.md';
const debtDoc = read(debtDocPath);
const statusDoc = read('docs/ps-tickets/ps-304-shipping-display-facts-authority-status.md');
const laneDoc = read('docs/ps-tickets/ps-300-backend-authority-lane-status.md');
const packageJson = read('package.json');
const shippingDisplay = read('web/src/components/Views/order-shipping-display.ts');
const displayState = read('web/src/components/Views/orders-display-state.ts');
const ps306Doc = read('docs/ps-tickets/ps-306-ordersview-parity-cutover.md');
const ps305Doc = read('docs/ps-tickets/ps-305-authority-drift-guardrails.md');
const workflowOwner = read('src/services/shipping-workflow/best-rate-workflow-dto.ts');

check('PS-304 fallback debt doc exists', existsSync(debtDocPath));
check('package wires PS-304 account fallback debt guard',
  hasScript(
    packageJson,
    'test:ps-304-account-fallback-debt',
    'tsx scripts/ps-304-account-fallback-debt-guard.ts',
  ));

const backendIdx = indexOfOrFail(shippingDisplay, 'if (input.backendDisplayAccountNickname) return input.backendDisplayAccountNickname');
const fallbackOrder = [
  'if (input.awaitingBestRateNickname) return input.awaitingBestRateNickname',
  'if (input.canonicalNickname) return input.canonicalNickname',
  'if (input.selectedNickname) return input.selectedNickname',
  'if (input.labelAccountLabel) return input.labelAccountLabel',
  'if (isShippBrokeredServiceCode(input.brokeredServiceCode)) return SHIPP_BROKERED_ACCOUNT_LABEL',
  'if (input.v2AccountNickname) return input.v2AccountNickname',
  "if (input.hasSelectedRate) return 'External'",
  'if (input.bestRateNickname) return input.bestRateNickname',
  'return input.carrierCodeFallback',
];

for (const fallback of fallbackOrder) {
  const idx = indexOfOrFail(shippingDisplay, fallback);
  check(`backend display account wins before ${fallback}`, backendIdx < idx);
}

check('frontend passes backend display account tuple into resolver',
  displayState.includes('backendDisplayAccountNickname: normalizeShippingAccountName') &&
    displayState.includes('bestRateWorkflow?.display'));
check('backend workflow owner emits account display tuple',
  workflowOwner.includes('accountNickname: string | null') &&
    /display: displayTupleFor\(facts\)/.test(workflowOwner));

check('fallback debt doc maps every remaining account candidate to PS-306',
  /awaiting best-rate nickname/.test(debtDoc) &&
    /canonical shipping nickname/.test(debtDoc) &&
    /selected-rate nickname/.test(debtDoc) &&
    /live label account label/.test(debtDoc) &&
    /Shipp brokered display fallback/.test(debtDoc) &&
    /V2 static account lookup/.test(debtDoc) &&
    /selected-rate `External`/.test(debtDoc) &&
    /best-rate nickname/.test(debtDoc) &&
    /carrier-code display fallback/.test(debtDoc) &&
    /PS-306 must review or remove these compatibility paths/.test(debtDoc));
check('PS-306 doc carries the account fallback removal candidate',
  /remaining account-display fallback removal/.test(ps306Doc));
check('PS-305 doc keeps frontend fallback debt explicit',
  /Keep remaining compatibility fallbacks explicit and tracked as PS-306 debt/.test(ps305Doc));

check('PS-304 status is now Final Review-ready but not 100%',
  /Current completion estimate: PS-304 89%/.test(statusDoc) &&
    /Final Review-ready/.test(statusDoc) &&
    /PS-306 cutover debt/.test(statusDoc));
check('PS-300 lane status lifts PS-304 to scoped Final Review-ready',
  /\| PS-304 \| 89% \| Final Review-ready, scoped \|/.test(laneDoc));
check('debt packet documents offline safety',
  /offline authority\/debt acceptance/.test(debtDoc) &&
    /does not run labels/.test(debtDoc) &&
    /mutate shipped\/cancelled data/.test(debtDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-304 account fallback debt guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-304 account fallback debt guard');
