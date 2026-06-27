/**
 * PS-344 - Order row workflow shape cleanup.
 *
 * Offline only: no DB, no network, no labels, no queue mutation.
 * The frontend action reader must consume the backend-stamped top-level
 * bestRateWorkflow DTO, not search nested wrapper shapes.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  getOrderRowActionBlockedReason,
  getOrderRowAllowedActions,
  getOrderRowBlockedReasons,
  getOrderRowStateAxes,
} from '../web/src/components/Views/orders/order-row-actions';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`Missing ${endNeedle}`);
  return source.slice(start, end);
}

const topLevelWorkflow = {
  bestRateWorkflow: {
    lifecycleState: 'awaiting',
    rateState: 'fresh',
    labelState: 'none',
    queueState: 'none',
    packageState: 'ready',
    allowedActions: {
      canBrowseRates: true,
      canRecalculate: true,
      canApplyBestRate: true,
      canPrintToQueue: false,
      canEditPackage: true,
      canSelectRow: true,
      canQueueLabel: true,
      canMarkExternalShipped: false,
    },
    blockedReasons: {
      printToQueue: 'no_rate',
    },
  },
  shippingModel: {
    bestRateWorkflow: {
      lifecycleState: 'cancelled',
      rateState: 'mismatched_request',
      allowedActions: {
        canBrowseRates: false,
        canRecalculate: false,
        canApplyBestRate: false,
        canPrintToQueue: true,
        canEditPackage: false,
        canSelectRow: false,
        canQueueLabel: false,
        canMarkExternalShipped: true,
      },
      blockedReasons: {
        printToQueue: 'cancelled_lock',
      },
    },
  },
};

const nestedOnlyWorkflow = {
  shippingModel: {
    bestRateWorkflow: {
      lifecycleState: 'awaiting',
      rateState: 'fresh',
      allowedActions: {
        canBrowseRates: true,
        canRecalculate: true,
        canApplyBestRate: true,
        canPrintToQueue: true,
        canEditPackage: true,
        canSelectRow: true,
        canQueueLabel: true,
        canMarkExternalShipped: true,
      },
      blockedReasons: {
        printToQueue: 'no_rate',
      },
    },
  },
};

const topActions = getOrderRowAllowedActions(topLevelWorkflow);
const topAxes = getOrderRowStateAxes(topLevelWorkflow);
const topReasons = getOrderRowBlockedReasons(topLevelWorkflow);
const nestedOnlyActions = getOrderRowAllowedActions(nestedOnlyWorkflow);
const nestedOnlyAxes = getOrderRowStateAxes(nestedOnlyWorkflow);
const nestedOnlyReasons = getOrderRowBlockedReasons(nestedOnlyWorkflow);

check('top-level backend workflow drives allowed actions',
  topActions.canBrowseRates === true &&
  topActions.canApplyBestRate === true &&
  topActions.canPrintToQueue === false &&
  topActions.canMarkExternalShipped === false);

check('top-level backend workflow wins over stale nested wrapper workflow',
  topAxes.lifecycleState === 'awaiting' &&
  topAxes.rateState === 'fresh' &&
  topReasons.printToQueue === 'no_rate' &&
  getOrderRowActionBlockedReason(topLevelWorkflow, 'printToQueue') === 'No rate is available for this order');

check('nested-only shippingModel workflow is ignored for actions',
  Object.values(nestedOnlyActions).every((value) => value === null));

check('nested-only shippingModel workflow is ignored for state axes',
  Object.values(nestedOnlyAxes).every((value) => value === null));

check('nested-only shippingModel workflow is ignored for blocked reasons',
  Object.keys(nestedOnlyReasons).length === 0);

const orderRowActionsSource = readFileSync('web/src/components/Views/orders/order-row-actions.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const useOrders = readFileSync('web/src/hooks/useOrders.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const ledger = readFileSync('docs/ps-tickets/ps-ledger.md', 'utf8');
const normalizeOrderBody = sliceBetween(
  useOrders,
  'function transformOrderRowV4toV2(',
  '\nfunction toIsoStart(',
);

check('order row action reader does not search shippingModel.bestRateWorkflow',
  !/shippingModel[\s\S]{0,80}bestRateWorkflow|bestRateWorkflow[\s\S]{0,80}shippingModel/.test(orderRowActionsSource));

check('orders route stamps bestRateWorkflow at the top-level row DTO',
  ordersRoute.includes('bestRateWorkflow: bestRateWorkflowRow') &&
  ordersRoute.includes('withOrderRowWorkflow(bestRateWorkflow'));

check('orders hook preserves top-level bestRateWorkflow from the backend row',
  /return\s*\{\s*\.\.\.row,/.test(normalizeOrderBody) &&
  !/\bbestRateWorkflow\s*:/.test(normalizeOrderBody));

check('package wires PS-344 guard',
  packageJson.includes('"test:ps-344-order-row-workflow-shape-cleanup"'));

check('ledger reserves PS-344 cleanup ticket',
  ledger.includes('| PS-344 | Order row workflow shape cleanup |'));

check('PS-344 doc exists',
  existsSync('docs/ps-tickets/ps-344-order-row-workflow-shape-cleanup.md'));

if (failures > 0) {
  console.error(`\nFAIL PS-344 order row workflow shape cleanup guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-344 order row workflow shape cleanup guard');
