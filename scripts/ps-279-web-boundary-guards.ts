/**
 * PS-279 (slice 1) — web shipping-route AUTHORITY lives at a lib boundary, not a component module.
 *
 * classifyQueueOrderRoute is a MONEY-PATH decision (buy-then-queue vs backend create/recover job). Its
 * home must be the shareable web/src/lib boundary, NOT web/src/components/Views. This pins the move:
 * the function lives in web/src/lib/shipping-routes.ts, the component module (orders-parity) no longer
 * defines it, and OrdersView imports it from the lib path. The full routing BEHAVIOR matrix is pinned
 * by ps-176 / ps-204 / direct-carrier-queue-route; this guard owns the BOUNDARY (where authority lives).
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
  /import \{ classifyQueueOrderRoute \} from '\.\.\/\.\.\/lib\/shipping-routes'/.test(ov));

// ── smoke: the moved function still decides correctly (full matrix lives in ps-176/204) ──
const shipStation: QueueOrderRoute = classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: false, isDirectCarrier: false });
check('moved classifier: ShipStation needing a label -> backend', shipStation === 'backend');
check('moved classifier: direct carrier needing a label -> direct-create',
  classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: false, isDirectCarrier: true }) === 'direct-create');
check('moved classifier: existing label never re-buys -> backend',
  classifyQueueOrderRoute({ hasQueueableLabel: true, isTest: false, isDirectCarrier: true }) === 'backend');

check('package.json wires test:ps-279-web-boundary-guards',
  /test:ps-279-web-boundary-guards/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-279 web boundary guards (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 web boundary guards');
