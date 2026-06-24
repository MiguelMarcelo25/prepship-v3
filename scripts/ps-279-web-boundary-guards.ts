/**
 * PS-279 (slice 1) — web shipping-route AUTHORITY lives at a lib boundary, not a component module.
 *
 * classifyQueueOrderRoute is a MONEY-PATH decision (buy-then-queue vs backend create/recover job). Its
 * home must be the shareable web/src/lib boundary, NOT web/src/components/Views. This pins the move:
 * the function lives in web/src/lib/shipping-routes.ts, the component module (orders-parity) no longer
 * defines it, and OrdersView imports it from the lib path. The full routing BEHAVIOR matrix is pinned
 * by ps-176 / ps-204 / direct-carrier-queue-route; this guard owns the BOUNDARY (where authority lives).
 *
 * PS-317 A4 update: the FE no longer BUYS anything for queue. createDirectCarrierLabelThenQueue (the
 * only FE direct-carrier apiClient.createLabel buy) was DELETED — every queue order now routes to the
 * backend create/recover job. This guard now asserts that FE buy is GONE (anti-regression) and that the
 * proof / account-binding / no-silent-postage protections it used to carry were RELOCATED, not lost:
 *  - to the INTENT payload buildQueueSendOrderPayload (testLabel + selectedRateProof + shippingProviderId
 *    + rate-quote ref), and
 *  - to the backend rate owner (labels.ts createLabelV2: direct-carrier detection +
 *    assertLabelPurchaseRateSelection proof/binding gate; print-queue.ts feeds the FE intent to it).
 *
 *   npx tsx scripts/ps-279-web-boundary-guards.ts
 */
import { readFileSync } from 'node:fs';
import { classifyQueueOrderRoute, type QueueOrderRoute } from '../web/src/lib/shipping-routes';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── the authority lives at the lib boundary ──
const lib = readFileSync('web/src/lib/shipping-routes.ts', 'utf8');
check('shipping-routes.ts exports classifyQueueOrderRoute', /export function classifyQueueOrderRoute/.test(lib));
check('shipping-routes.ts exports the QueueOrderRoute type', /export type QueueOrderRoute/.test(lib));

// ── the component module no longer OWNS it ──
const parity = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');
check('orders-parity no longer defines classifyQueueOrderRoute', !/export function classifyQueueOrderRoute/.test(parity));
check('orders-parity no longer defines the QueueOrderRoute type', !/export type QueueOrderRoute/.test(parity));

// ── OrdersView imports the classifier FROM the lib boundary (not the component module) ──
const ov = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('OrdersView imports classifyQueueOrderRoute from the lib boundary',
  /import \{[^}]*\bclassifyQueueOrderRoute\b[^}]*\} from '\.\.\/\.\.\/lib\/shipping-routes'/.test(ov));

// ── smoke: the moved function still decides correctly (full matrix lives in ps-176/204) ──
const shipStation: QueueOrderRoute = classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: false, isDirectCarrier: false });
check('moved classifier: ShipStation needing a label -> backend', shipStation === 'backend');
check('moved classifier: direct carrier needing a label -> direct-create',
  classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: false, isDirectCarrier: true }) === 'direct-create');
check('moved classifier: existing label never re-buys -> backend',
  classifyQueueOrderRoute({ hasQueueableLabel: true, isTest: false, isDirectCarrier: true }) === 'backend');

// ── the FE no longer OWNS the direct-carrier label BUY — it moved to the backend ──
// PS-317 A4 DELETED createDirectCarrierLabelThenQueue (the only FE path that bought a
// direct-carrier label via apiClient.createLabel for a queue-send). The frontend now
// buys NOTHING for queue: every queue order routes to the backend create/recover job.
// These checks are ANTI-REGRESSION — the FE direct-buy and its synthetic-id detection
// must NOT reappear in OrdersView, so a future change can't silently re-home a money
// decision in React (CLAUDE.md "Backend owns business truth").
check('OrdersView: createDirectCarrierLabelThenQueue is GONE (no FE direct-carrier buy)',
  !/createDirectCarrierLabelThenQueue/.test(ov));
check('OrdersView: no FE synthetic direct-carrier provider-id detection (directLabelAccountRefFromProviderId)',
  !/directLabelAccountRefFromProviderId/.test(ov));

// ── the test-order NO-SILENT-POSTAGE protection now travels in the INTENT payload ──
// The deleted FE buy used to gate a test row before apiClient.createLabel. That intent
// is now carried into buildQueueSendOrderPayload: a backend-fact `isBackendTestOrder`
// stamps `testLabel` on the queue payload (orderIsTest), and the proof/account-binding
// the buy used to enforce locally now travel as selectedRateProof + shippingProviderId
// + the rate-quote ref. The Render job (createLabelV2) re-applies the SAME proof gate.
{
  const builderMatch = /function buildQueueSendOrderPayload\([\s\S]*?\r?\n  }\r?\n/.exec(ov);
  const builder = builderMatch ? builderMatch[0] : '';
  check('OrdersView: buildQueueSendOrderPayload body located', builder.length > 0);
  // backend-fact test detection (heuristics must never shape a label payload)
  check('OrdersView: queue payload derives test-row status from the backend fact (isBackendTestOrder)',
    /isBackendTestOrder\s*\(\s*order\s*\)/.test(builder));
  check('OrdersView: queue payload stamps testLabel so the backend forces the $0 mock path for a test row',
    /testLabel:\s*(?:Boolean\(options\.batchTestMode\)\s*\|\|\s*)?orderIsTest/.test(builder));
  // proof + account binding the deleted buy carried now ride INTENT to the backend gate
  check('OrdersView: queue payload carries the account-bound selectedRateProof (PS-204 binding)',
    /selectedRateProof:\s*buildSelectedRateProofPayload\(order,[^)]*shippingProviderId\)/.test(builder));
  check('OrdersView: queue payload carries the rate-quote ref + shippingProviderId binding',
    /buildRateQuoteRefForOrder\(order,[^)]*shippingProviderId\)/.test(builder) &&
      /shippingProviderId:\s*shippingProviderId\s*\?\?\s*undefined/.test(builder));
}

// ── the backend rate owner is where the BUY + proof gate + direct detection now live ──
// labels.ts createLabelV2 detects direct carriers via directLabelAccountRefFromProviderId
// and runs the SAME selected-rate-proof + PS-204 account-binding gate
// (assertLabelPurchaseRateSelection w/ purchaseShippingProviderId) ahead of BOTH the
// direct and ShipStation provider calls. print-queue.ts processQueueSendOrder feeds the
// FE intent (order.label) into createLabelV2 — so the queue buy is fully backend-owned.
const labelsSvc = readFileSync('src/services/labels.ts', 'utf8');
check('labels.ts: backend createLabelV2 owns the label BUY',
  /function createLabelV2/.test(labelsSvc));
check('labels.ts: backend detects direct carriers (directLabelAccountRefFromProviderId)',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsSvc));
check('labels.ts: backend enforces the selected-rate proof + PS-204 account binding before purchase',
  /assertLabelPurchaseRateSelection\(\{[\s\S]*?selectedRateProof:\s*body\.selectedRateProof[\s\S]*?purchaseShippingProviderId:\s*body\.shippingProviderId[\s\S]*?\}\)/.test(labelsSvc));
const printQueueSvc = readFileSync('src/services/print-queue.ts', 'utf8');
check('print-queue.ts: the queue worker buys via the backend createLabelV2 (not the FE)',
  /createLabelV2\(\{[\s\S]*?\.\.\.order\.label/.test(printQueueSvc));

check('package.json wires test:ps-279-web-boundary-guards',
  /test:ps-279-web-boundary-guards/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-279 web boundary guards (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 web boundary guards');
