/**
 * PS-279 — backend Send-to-Queue orchestration guard (offline, no DB/network).
 *
 * Pins that the route decision moved into src/ as a PURE never-buy ladder, that the
 * new route is registered and INERT when PRINT_QUEUE_BACKEND_ORCHESTRATION is OFF,
 * and that the FE buy-path was NOT deleted in this slice:
 *
 *   1. The server-side ladder exists in src/services/print-queue/ and its never-buy
 *      rungs hold: existing label -> 'backend' (queue as-is), test order -> 'backend'
 *      (mock), existingLabelOnly/batchTestMode -> 'backend'. A direct-carrier order
 *      that still needs a label -> 'direct-create'; ShipStation -> 'backend'.
 *   2. planQueueRouteForOrders (the create/recover/queue entrypoint) splits a batch
 *      into backend vs direct-create with no re-derivation needed by the FE.
 *   3. The synthetic-direct floor is REUSED from the canonical owner, not re-hardcoded.
 *   4. The new POST /print-queue/route-plan route is registered, gated on the flag,
 *      and returns 503 FEATURE_DISABLED when OFF; /batch-send is left intact.
 *   5. The flag exists default-OFF in src/lib/env.ts.
 *   6. No FE apiClient.createLabel call was removed (the cutover is DEFERRED).
 *
 * Pure: imports the real orchestrator and reads files as text. No DB, no network.
 *
 *   npx tsx scripts/ps-279-backend-orchestration-guard.ts
 */
// Run from the repo root (like the other tsx guards): readFileSync uses
// repo-root-relative paths. "type": "module" means __dirname is unavailable.
import { readFileSync, existsSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
  type QueueOrderRouteInput,
} from '../src/services/print-queue/queue-route-orchestrator';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

function readText(rel: string): string {
  return existsSync(rel) ? readFileSync(rel, 'utf8') : '';
}

const base = (extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput => ({
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: false,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
  ...extra,
});

// ── 1) the server-side ladder file exists in src/services/print-queue/ ──
check('the orchestrator lives in src/services/print-queue/',
  existsSync('src/services/print-queue/queue-route-orchestrator.ts'));

// ── never-buy rungs (each defers to the backend job — never buys) ──
check('existingLabelOnly -> backend (never buy)',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true }), { existingLabelOnly: true }) === 'backend');
check('batchTestMode -> backend (mock, never buy)',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true }), { batchTestMode: true }) === 'backend');
check('test order -> backend (mock)',
  classifyQueueOrderRouteServer(base({ isTest: true, isDirectCarrier: true })) === 'backend');
check('existing queueable label -> backend (queue as-is, never re-buy)',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend');

// ── residual direct-vs-backend question ──
check('direct-carrier order needing a label -> direct-create',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true })) === 'direct-create');
check('ShipStation order needing a label -> backend',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: false })) === 'backend');
check('explicit synthetic-direct payload id -> direct-create',
  classifyQueueOrderRouteServer(base({ explicitPayloadProviderId: 10_000_001 })) === 'direct-create');
check('explicit ShipStation payload id -> backend',
  classifyQueueOrderRouteServer(base({ explicitPayloadProviderId: 42 })) === 'backend');
check('explicit payload OUTRANKS isDirectCarrier for the residual question',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true, explicitPayloadProviderId: 42 })) === 'backend');
check('backendQueueRoute honored when it spoke (no explicit payload)',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true, backendQueueRoute: 'backend' })) === 'backend');
// never-buy rungs OUTRANK the residual question:
check('hasQueueableLabel OUTRANKS an explicit direct payload (never re-buy)',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, explicitPayloadProviderId: 10_000_001 })) === 'backend');

// ── 2) planQueueRouteForOrders splits the batch (create/recover/queue entrypoint) ──
{
  const plan = planQueueRouteForOrders([
    { orderId: 1, route: base({ isDirectCarrier: true }) },          // direct-create
    { orderId: 2, route: base({ isDirectCarrier: false }) },         // backend (ShipStation)
    { orderId: 3, route: base({ hasQueueableLabel: true }) },        // backend (queue as-is)
    { orderId: 4, route: base({ isTest: true, isDirectCarrier: true }) }, // backend (mock)
  ]);
  check('plan splits direct-create vs backend',
    JSON.stringify(plan.directCreateOrderIds) === JSON.stringify([1]) &&
    JSON.stringify(plan.backendOrderIds) === JSON.stringify([2, 3, 4]));
  check('plan returns a per-order route for every order',
    plan.plans.length === 4 && plan.plans.every((p) => p.route === 'backend' || p.route === 'direct-create'));
}

// ── 3) the synthetic floor is reused from the canonical owner, not re-hardcoded ──
{
  const src = readText('src/services/print-queue/queue-route-orchestrator.ts');
  check('orchestrator imports DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR (no fresh magic number)',
    src.includes('DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR') &&
    src.includes("from '../shipping-workflow/rate-fingerprint'"));
  check('orchestrator is pure (no db/network imports)',
    !/from ['"].*\/db['"]/.test(src) && !src.includes('drizzle') && !src.includes('fetch('));
}

// ── 4) the new route is registered, flag-gated, and inert when OFF; /batch-send intact ──
{
  const route = readText('src/routes/print-queue.ts');
  check("POST /route-plan is registered", route.includes("app.post('/route-plan'"));
  check('route-plan is gated on PRINT_QUEUE_BACKEND_ORCHESTRATION',
    route.includes('env.PRINT_QUEUE_BACKEND_ORCHESTRATION'));
  check('route-plan returns 503 FEATURE_DISABLED when OFF (inert)',
    route.includes("'FEATURE_DISABLED'") && route.includes('503'));
  check('route-plan delegates to the server orchestrator (no FE re-derivation)',
    route.includes('planQueueRouteForOrders'));
  check('existing /batch-send route is left intact',
    route.includes("app.post('/batch-send'") &&
    route.includes("app.get('/batch-send/status/:jobId'"));
  // The OFF path must check the flag BEFORE doing any work in the handler.
  const handlerStart = route.indexOf("app.post('/route-plan'");
  const flagCheck = route.indexOf('env.PRINT_QUEUE_BACKEND_ORCHESTRATION', handlerStart);
  const planCall = route.indexOf('planQueueRouteForOrders(', handlerStart);
  check('route-plan checks the flag BEFORE computing the plan',
    handlerStart >= 0 && flagCheck > handlerStart && (planCall === -1 || flagCheck < planCall));
}

// ── 5) the flag exists default-OFF ──
{
  const envText = readText('src/lib/env.ts');
  check('PRINT_QUEUE_BACKEND_ORCHESTRATION is declared default-OFF booleanFlag(false)',
    envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
}

// ── 6) FE cutover is FLAG-GATED (default OFF); the local fallback is PRESERVED ──
{
  const orders = readText('web/src/components/Views/OrdersView.tsx');
  // The local classifier + the direct createLabel path remain as the OFF/fallback.
  check('FE OrdersView still calls apiClient.createLabel (fallback preserved)',
    orders.includes('apiClient.createLabel'));
  check('FE classifyQueueOrderRoute is still the fallback (not deleted)',
    orders.includes('classifyQueueOrderRoute('));
  // The new delegation only runs behind the backend flag, with a per-order fallback.
  check('FE reads the backend printQueueBackendOrchestration flag',
    orders.includes('printQueueBackendOrchestration'));
  check('FE delegates to the backend ONLY behind the flag (default OFF => no call)',
    /if \(printQueueBackendOrchestration\)[\s\S]{0,500}resolveBackendRoutePlan\(/.test(orders));
  check('FE route uses the backend plan with a per-order fallback to the local classifier',
    /backendRoutePlan\?\.get\(order\.orderId\) \?\? classifyQueueOrderRoute\(/.test(orders));
  check('FE posts to /print-queue/route-plan via the isolated helper',
    orders.includes("api.post('/print-queue/route-plan'") && orders.includes('resolveBackendRoutePlan'));

  // The helper is fail-safe: returns null on any error so the caller falls back.
  const helper = readText('web/src/lib/resolve-backend-route-plan.ts');
  check('the route-plan helper exists and returns null on failure (fail-safe)',
    helper.includes('export async function resolveBackendRoutePlan') &&
    /catch\s*\{[\s\S]{0,200}return null/.test(helper));

  // Backend exposes the flag in /users/me so the FE gates without reading env.
  const users = readText('src/routes/users.ts');
  check('GET /users/me exposes printQueueBackendOrchestration from the env flag',
    /printQueueBackendOrchestration:\s*env\.PRINT_QUEUE_BACKEND_ORCHESTRATION/.test(users));
}

if (failures > 0) {
  console.error(`\nFAIL PS-279 backend orchestration guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 backend orchestration guard');
