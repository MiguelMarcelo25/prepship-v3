/**
 * PS-303 (Per user override unlock shipped data on 2026-06-23) — REAL execution test
 * for the binding cutover of the buy-vs-defer queue route.
 *
 * The PS-306 dependency-gate audit found PS-303's central claim unmet: the backend
 * route plan was a NON-binding override (OrdersView did `backendRoutePlan?.get(id) ??
 * classifyQueueOrderRoute(...)`), so the FRONTEND remained the live source of truth for
 * the money-path route decision even when the FE-delegation flag was on. This guard pins
 * the cutover: bindOrFallbackQueueRoute makes the plan BINDING when delegation is ON
 * (the frontend no longer decides), defers an omitted order to 'backend' (never a silent
 * FE direct-buy), and stays byte-identical to the local classifier when the flag is OFF.
 *
 * It DRIVES the real decision function (not a marker-string grep), so re-introducing the
 * FE fallback on the ON path would fail here. Offline/pure: no DB, no network, no labels,
 * no postage, no shipped/cancelled mutation.
 */
import { bindOrFallbackQueueRoute } from '../web/src/lib/resolve-backend-route-plan';
import type { QueueOrderRoute } from '../web/src/lib/shipping-routes';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const plan = new Map<number, QueueOrderRoute>([
  [1, 'direct-create'],
  [2, 'backend'],
]);

// Flag OFF (the default): always the local classifier fallback, even if a plan exists —
// byte-identical to the pre-cutover behavior.
check('flag OFF -> local classifier fallback, plan ignored',
  bindOrFallbackQueueRoute(false, plan, 1, () => 'backend') === 'backend' &&
  bindOrFallbackQueueRoute(false, null, 2, () => 'direct-create') === 'direct-create');

// Flag ON but no plan (resolveBackendRoutePlan returned null on 503/failure) -> fallback.
check('flag ON + null plan -> local classifier fallback',
  bindOrFallbackQueueRoute(true, null, 1, () => 'backend') === 'backend');

// Flag ON + plan present: the plan is BINDING — the route comes from the backend, NOT
// the FE fallback (the fallback returns the opposite value to prove binding wins).
check('flag ON + plan entry direct-create -> BINDING direct-create',
  bindOrFallbackQueueRoute(true, plan, 1, () => 'backend') === 'direct-create');
check('flag ON + plan entry backend -> BINDING backend',
  bindOrFallbackQueueRoute(true, plan, 2, () => 'direct-create') === 'backend');

// THE CUTOVER LINCHPIN: flag ON + plan present but the order OMITTED -> defers to
// 'backend' (the create/recover job), NEVER the FE fallback. So a partial plan can never
// trigger a silent FE direct-buy; the backend stays authoritative.
check('flag ON + MISSING plan entry -> defers to backend, NOT the FE fallback',
  bindOrFallbackQueueRoute(true, plan, 999, () => 'direct-create') === 'backend');

if (failures > 0) {
  console.error(`\nPS-303 FE route-binding guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-303 FE route-binding guard passed.');
