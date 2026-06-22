/**
 * PS-301 guard - backend row workflow authority.
 *
 * Proves the backend BestRateWorkflowDto owns row status, allowed actions, and
 * queue route eligibility. Offline only: no DB, no network, no providers, no
 * labels, no postage, no marketplace calls, no Trello mutation.
 */
import { readFileSync } from 'node:fs';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type BestRateWorkflowDto,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

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

const NOW = new Date('2026-06-22T12:00:00.000Z');
const FINGERPRINT = 'ps301|zip=19422|dims=8x6x6|provider=607855';

const freshRate = {
  amount: 10.79,
  shipmentCost: 10.79,
  otherCost: 0,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  shippingProviderId: 607855,
  packageCode: 'package',
  requestFingerprint: FINGERPRINT,
  cacheKey: FINGERPRINT,
  proofSource: 'backend_rate_response',
  isComplete: true,
  cacheExpiresAt: '2026-06-22T18:00:00.000Z',
};

const baseFacts: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: null,
  canonicalServiceCode: null,
  canonicalAccountNickname: 'ROCEL C81F70',
  selectedRateCarrierCode: null,
  providerAccountId: 607855,
};

function workflowFor(savedBestRate: unknown): BestRateWorkflowDto {
  return buildBestRateWorkflowDto({
    currentRequestFingerprint: FINGERPRINT,
    backendRequestKey: FINGERPRINT,
    savedBestRate,
    source: 'cache',
    carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 }],
    now: NOW,
  });
}

const freshWorkflow = withOrderRowWorkflow(workflowFor(freshRate), baseFacts);
check('awaiting fresh backend-proofed rate is final',
  freshWorkflow.rowState === 'final', freshWorkflow);
check('final row permits create label and queue label',
  freshWorkflow.allowedActions.canCreateLabel === true &&
  freshWorkflow.allowedActions.canQueueLabel === true &&
  freshWorkflow.allowedActions.canRate === true &&
  freshWorkflow.allowedActions.canBrowseRates === true &&
  freshWorkflow.allowedActions.canRecalculate === true,
  freshWorkflow.allowedActions);
check('ShipStation/non-direct label-needed row routes to backend queue owner',
  freshWorkflow.queueRoute === 'backend', freshWorkflow);

const staleWorkflow = withOrderRowWorkflow(workflowFor({
  ...freshRate,
  cacheExpiresAt: '2026-06-22T11:59:59.000Z',
}), baseFacts);
check('awaiting stale backend-proofed rate becomes stale_rate',
  staleWorkflow.rowState === 'stale_rate', staleWorkflow);
check('stale row remains rateable but cannot create or queue a new label',
  staleWorkflow.allowedActions.canRate === true &&
  staleWorkflow.allowedActions.canBrowseRates === true &&
  staleWorkflow.allowedActions.canRecalculate === true &&
  staleWorkflow.allowedActions.canCreateLabel === false &&
  staleWorkflow.allowedActions.canQueueLabel === false &&
  staleWorkflow.allowedActions.requiresRerate === true,
  staleWorkflow.allowedActions);

const needsDimsWorkflow = withOrderRowWorkflow(workflowFor(freshRate), {
  ...baseFacts,
  hasCompleteDims: false,
});
check('missing dimensions are backend-owned needs_dims before purchase',
  needsDimsWorkflow.rowState === 'needs_dims' &&
  needsDimsWorkflow.allowedActions.canCreateLabel === false &&
  needsDimsWorkflow.allowedActions.canQueueLabel === false &&
  needsDimsWorkflow.allowedActions.canBrowseRates === true,
  needsDimsWorkflow);

const directWorkflow = withOrderRowWorkflow(workflowFor(freshRate), {
  ...baseFacts,
  isDirectCarrierSelection: true,
});
check('direct-carrier label-needed row routes to direct-create',
  directWorkflow.queueRoute === 'direct-create', directWorkflow);

const existingLabelWorkflow = withOrderRowWorkflow(workflowFor(freshRate), {
  ...baseFacts,
  hasQueueableLabel: true,
  isDirectCarrierSelection: true,
});
check('existing queueable label outranks direct-create and routes to backend',
  existingLabelWorkflow.queueRoute === 'backend', existingLabelWorkflow);

const testWorkflow = withOrderRowWorkflow(workflowFor(freshRate), {
  ...baseFacts,
  isTest: true,
  isDirectCarrierSelection: true,
});
check('test order routes to backend mock path',
  testWorkflow.queueRoute === 'backend', testWorkflow);

const shippedWorkflow = withOrderRowWorkflow(workflowFor(null), {
  ...baseFacts,
  orderStatus: 'shipped',
  hasShipment: true,
});
check('local shipped row can queue existing label but cannot create postage',
  shippedWorkflow.rowState === 'local_shipped' &&
  shippedWorkflow.allowedActions.canQueueLabel === true &&
  shippedWorkflow.allowedActions.canCreateLabel === false,
  shippedWorkflow);

const blockedWorkflow = withOrderRowWorkflow(workflowFor(freshRate), {
  ...baseFacts,
  orderStatus: 'cancelled',
});
check('cancelled row is backend-blocked for all operator actions',
  blockedWorkflow.rowState === 'blocked' &&
  blockedWorkflow.allowedActions.canCreateLabel === false &&
  blockedWorkflow.allowedActions.canQueueLabel === false &&
  blockedWorkflow.allowedActions.canRate === false &&
  blockedWorkflow.allowedActions.canBrowseRates === false &&
  blockedWorkflow.allowedActions.canRecalculate === false &&
  blockedWorkflow.allowedActions.canMarkExternalShipped === false,
  blockedWorkflow);

const owner = read('src/services/shipping-workflow/best-rate-workflow-dto.ts');
check('row workflow lives on BestRateWorkflowDto, not a parallel object',
  owner.includes('rowState?: OrderRowWorkflowState') &&
  owner.includes('queueRoute?:') &&
  owner.includes('allowedActions: BestRateWorkflowAllowedActions'));
check('withOrderRowWorkflow sets rowState, allowedActions, display, and queueRoute in one backend owner',
  /export function withOrderRowWorkflow\(/.test(owner) &&
  /rowState,\s*\n\s*allowedActions: rowActionsFor\(rowState, dto\.allowedActions\),\s*\n\s*display: displayTupleFor\(facts\),\s*\n\s*queueRoute: queueRouteFor\(facts\)/.test(owner));
check('backend row workflow owner is pure',
  !owner.includes('fetch(') &&
  !/\bfrom\s+['"][^'"]*\/db/.test(owner) &&
  !owner.includes('createLabelV2('));

const ordersRoute = read('src/routes/orders.ts');
check('orders route enriches rows with backend row workflow owner',
  /withOrderRowWorkflow\(bestRateWorkflow, \{/.test(ordersRoute));
check('orders route emits enriched bestRateWorkflow DTO',
  (ordersRoute.match(/bestRateWorkflow: bestRateWorkflowRow/g)?.length ?? 0) >= 1);

const ps173 = read('scripts/ps-173-order-row-workflow-guard.ts');
check('existing PS-173 guard remains as the behavioral predecessor',
  ps173.includes('backend-owned order-row workflow state') &&
  ps173.includes('withOrderRowWorkflow'));

const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
check('workflow doc records PS-301 row workflow guard',
  workflowDoc.includes('test:ps-301-row-workflow-authority'));

const packageJson = read('package.json');
check('package wires PS-301 row workflow guard',
  /"test:ps-301-row-workflow-authority"\s*:\s*"tsx scripts\/ps-301-row-workflow-authority-guard\.ts"/.test(packageJson));
check('package still wires predecessor row workflow guard',
  /"test:ps-173-order-row-workflow"\s*:\s*"tsx scripts\/ps-173-order-row-workflow-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL PS-301 row workflow authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-301 row workflow authority guard');
