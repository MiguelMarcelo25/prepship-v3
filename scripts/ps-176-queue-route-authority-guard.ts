/**
 * PS-176 (Phase 4, part 1) guard — queue ROUTING policy is backend-owned,
 * with the live never-buy ladder intact.
 *
 * Repo-verified before this part: the spec's validation chain ALREADY runs
 * server-side immediately before side effects (createLabelV2: editable lock,
 * PS-128/129 shipping safety, duplicate-label, PS-186 test policy, PS-105
 * proof, residential parity, service + carrier-family eligibility; idempotent
 * queue upsert). What remained FE-owned was the direct-vs-backend ROUTING
 * decision — this part moves that policy onto the row workflow DTO
 * (queueRoute), while the FE's LIVE safety ladder (operator options, fresh
 * label/test facts) still runs FIRST so a stale list-time value can never
 * cause a postage re-buy.
 *
 * Pins:
 *   1. Backend queueRouteFor matrix (via withOrderRowWorkflow): test → backend;
 *      existing label → backend; direct selection needing a label →
 *      direct-create; ShipStation → backend.
 *   2. FE classifier consults backendQueueRoute ONLY AFTER the never-buy
 *      ladder (behavioral: options/test/label override a stale direct-create).
 *   3. Wiring: route computes the facts from the shipment + provider id range;
 *      OrdersView passes the DTO value through.
 *
 *   npx tsx scripts/ps-176-queue-route-authority-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import { classifyQueueOrderRoute } from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

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
  canonicalAccountNickname: null,
  selectedRateCarrierCode: null,
  providerAccountId: 607855,
};

function routeFor(facts: Partial<OrderRowWorkflowFacts>): string | undefined {
  const dto = buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' });
  return withOrderRowWorkflow(dto, { ...baseFacts, ...facts }).queueRoute;
}

// ── 1. backend routing matrix ─────────────────────────────────────────────────
check('ShipStation selection needing a label → backend', routeFor({}) === 'backend');
check('direct-carrier selection needing a label → direct-create',
  routeFor({ isDirectCarrierSelection: true }) === 'direct-create');
check('existing queueable label → backend even for direct selections (never re-buy)',
  routeFor({ isDirectCarrierSelection: true, hasQueueableLabel: true }) === 'backend');
check('test order → backend (mock path) even for direct selections',
  routeFor({ isDirectCarrierSelection: true, isTest: true }) === 'backend');

// ── 2. FE never-buy ladder runs BEFORE the backend policy ────────────────────
const NEEDS_LABEL_DIRECT = { hasQueueableLabel: false, isTest: false, isDirectCarrier: true };
check('FE honors the backend policy for the residual decision',
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, isDirectCarrier: false, backendQueueRoute: 'direct-create' }) === 'direct-create' &&
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'backend' }) === 'backend');
check('a LIVE existing label overrides a stale backend direct-create (no re-buy)',
  classifyQueueOrderRoute({ hasQueueableLabel: true, isTest: false, isDirectCarrier: true, backendQueueRoute: 'direct-create' }) === 'backend');
check('a LIVE test fact overrides a stale backend direct-create',
  classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: true, isDirectCarrier: true, backendQueueRoute: 'direct-create' }) === 'backend');
check('operator options override everything',
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'direct-create' }, { existingLabelOnly: true }) === 'backend' &&
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'direct-create' }, { batchTestMode: true }) === 'backend');
check('garbage backend value falls through to the local rule',
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'wat' }) === 'direct-create' &&
  classifyQueueOrderRoute({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: null }) === 'direct-create');

// ── 3. wiring pins ────────────────────────────────────────────────────────────
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('route derives the queueable-label + direct-selection facts',
  /rowHasQueueableLabel/.test(ordersRoute) &&
  /\[object Object\]/.test(ordersRoute) &&
  />= 10_000_000/.test(ordersRoute));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('OrdersView passes the DTO queueRoute into the classifier',
  /backendQueueRoute: toStringValue\(toRecord\(order\.bestRateWorkflow\)\?\.queueRoute\)/.test(ordersView));
const parity = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');
check('classifier consults the backend policy AFTER the never-buy ladder (source order)',
  (() => {
    const start = parity.indexOf('export function classifyQueueOrderRoute');
    const block = parity.slice(start, start + 2400);
    const ladder = block.indexOf("if (input.hasQueueableLabel) return 'backend'");
    const backend = block.indexOf('input.backendQueueRoute');
    return ladder > 0 && backend > ladder;
  })());

// ── 4. PART 2: localStorage holds no purchase authority ───────────────────────
// PS-166 Wave 1a re-anchor: the persistent queue-job machinery (incl.
// createQueueOrderSnapshot) moved VERBATIM to orders-persistent-queue-job.ts.
// The identifiers-only contract is pinned at its new home; resume logic below
// is component-internal and stays pinned in OrdersView.
{
  const queueJobModule = readFileSync('web/src/components/Views/orders-persistent-queue-job.ts', 'utf8');
  const snapStart = queueJobModule.indexOf('export function createQueueOrderSnapshot');
  const snapBlock = queueJobModule.slice(snapStart, queueJobModule.indexOf('\n}', snapStart));
  check('persisted queue snapshot carries IDENTIFIERS ONLY (no money/label payloads)',
    snapStart > 0 &&
    !/bestRate/.test(snapBlock) && !/selectedRate/.test(snapBlock) &&
    !/label:/.test(snapBlock) && !/shipping/.test(snapBlock) && !/raw/.test(snapBlock));
  check('OrdersView consumes the queue-job machinery from the strict module (no local copy)',
    ordersView.includes("from './orders-persistent-queue-job'") &&
    !/\nfunction createQueueOrderSnapshot/.test(ordersView) &&
    !/\nfunction readPersistentQueueJob/.test(ordersView));
}
{
  const resumeStart = ordersView.indexOf('async function resumePersistentQueueJob');
  const resumeEnd = ordersView.indexOf('\n  useEffect', resumeStart);
  const resumeBlock = ordersView.slice(resumeStart, resumeEnd > 0 ? resumeEnd : resumeStart + 9000);
  check('resume NEVER buys labels (no createLabel call in the resume path)',
    resumeStart > 0 && !/apiClient\.createLabel\(/.test(resumeBlock));
  check('interrupted batch-queue jobs hand control back to the operator',
    /Queue send was interrupted/.test(resumeBlock) && /Print to Queue again/.test(resumeBlock));
  check('existing-label resume re-reads the label FRESH from the backend',
    /apiClient\.retrieveLabel\(ref\.orderId, true\)/.test(resumeBlock));
  check('backend-job resume path intact (durable job id re-attach)',
    /job\.backendJobId/.test(resumeBlock) && /pollBackendQueueSendJob\(job\.backendJobId/.test(resumeBlock));
}

if (failures > 0) {
  console.error(`\nFAIL PS-176 queue route authority guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-176 queue route authority guard');
