/**
 * PS-349 guard - canonical backend order shipping state.
 *
 * Offline only: static/source checks plus pure frontend predicate checks. No DB,
 * no network, no providers, no labels, no postage, no marketplace calls.
 */
import { readFileSync, existsSync } from 'node:fs';
import { classifyAwaitingRateCellStateWithWorkflow } from '../web/src/components/Views/orders-parity';

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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const ownerPath = 'src/services/shipping-workflow/order-shipping-state.ts';
const owner = read(ownerPath);
const ordersRoute = read('src/routes/orders.ts');
const apiTypes = read('web/src/types/api.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const rateHelpers = read('web/src/components/Views/orders/best-rate/rate-helpers.ts');
const ratePredicates = read('web/src/components/Views/orders/best-rate/rate-display-predicates.ts');
const rowActions = read('web/src/components/Views/orders/order-row-actions.ts');
const ps102 = read('scripts/ps-102-best-rate-workflow-dto-guard.ts');
const packageJson = read('package.json');

check('PS-349 owner module exists', existsSync(ownerPath));
check('owner exports canonical builder and DTO type',
  /export type ShippingWorkflowStateDto/.test(owner) &&
  /export function buildOrderShippingWorkflowState/.test(owner));
check('owner carries required backend-owned fields',
  ['rateState', 'displayRate', 'selectedRateProofState', 'canPrintQueue', 'printQueueBlockedReason', 'nextAction', 'diagnostics']
    .every((needle) => owner.includes(needle)));
check('owner delegates to existing best-rate workflow truth instead of reranking',
  owner.includes('BestRateWorkflowDto') &&
  owner.includes('canDisplayFinalRate') &&
  owner.includes('canUseDisplayedRateForPurchase') &&
  !/\bpickBestRate\b/.test(owner));
check('owner classifies backend-ready rows only when display data is present',
  /return 'ready'/.test(owner) &&
  /displayRate\s*:\s*input\.displayRate/.test(owner));
check('owner exposes print queue eligibility and explicit blocker',
  owner.includes('canPrintQueue') &&
  owner.includes('printQueueBlockedReason') &&
  owner.includes('blockedReasons'));

check('orders route imports PS-349 owner',
  ordersRoute.includes("from '../services/shipping-workflow/order-shipping-state'") ||
  ordersRoute.includes('from "../services/shipping-workflow/order-shipping-state"'));
check('orders route emits shippingWorkflowState at row and shipping model boundaries',
  (ordersRoute.match(/shippingWorkflowState:/g)?.length ?? 0) >= 2);
check('orders route builds shippingWorkflowState from enriched backend workflow',
  ordersRoute.includes('buildOrderShippingWorkflowState') &&
  ordersRoute.includes('bestRateWorkflowRow'));

check('frontend OrderSummaryDto includes shippingWorkflowState',
  /shippingWorkflowState\?:/.test(apiTypes));
check('row-display exposes getOrderShippingWorkflowState',
  /export function getOrderShippingWorkflowState/.test(rowDisplay));
check('rate predicates consume backend shippingWorkflowState display verdict',
  ratePredicates.includes('getOrderShippingWorkflowState') &&
  ratePredicates.includes('rateState') &&
  ratePredicates.includes('displayRate'));
check('rate helpers prefer backend shippingWorkflowState before frontend request veto',
  rateHelpers.includes('shippingWorkflowStateCanDisplayRate') &&
  /if\s*\(\s*shippingWorkflowStateCanDisplayRate\(order\)\s*\)\s*return true/.test(rateHelpers));
check('row action reader can consume shippingWorkflowState print queue verdict',
  rowActions.includes('shippingWorkflowState') &&
  rowActions.includes('canPrintQueue') &&
  rowActions.includes('printQueueBlockedReason'));

check('backend-ready workflow classifier resolves to ready when display is backend-owned',
  classifyAwaitingRateCellStateWithWorkflow({
    bestRateState: 'fresh',
    canDisplayFinalRate: true,
    canUseDisplayedRateForPurchase: true,
    savedRateDisplay: 'fresh',
    allowedActions: {
      canUseSavedRate: true,
      requiresRerate: false,
      canCreateLabel: true,
    },
  }, {
    hasDims: true,
    hasWeight: true,
    hasDisplayableBestRate: true,
    isCalculatingBestRate: false,
    resolvedNoRate: false,
    resolvedError: false,
    hasCarrierContext: false,
    accountsLoading: false,
  }) === 'ready');
check('PS-102 no longer codifies frontend veto of backend-fresh rows',
  !ps102.includes('fresh but NOT frontend-displayable shows a spinner'));
check('package wires PS-349 guard',
  /"test:ps-349-order-shipping-state"\s*:\s*"tsx scripts\/ps-349-order-shipping-state-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL PS-349 order shipping state guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-349 order shipping state guard');
