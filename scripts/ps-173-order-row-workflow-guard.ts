/**
 * PS-173 (Phase 1) guard — backend-owned order-row workflow state + action verbs + display tuple.
 *
 * EXTEND-NEVER-PARALLEL: the row workflow lives ON BestRateWorkflowDto via
 * withOrderRowWorkflow(dto, facts) — no second workflow object. This guard pins:
 *   1. The row-state matrix (cancelled/external/shipped trump rate states; dims
 *      gate before rate states; rate lifecycle maps final/pending/stale/missing).
 *   2. Action verbs are NARROWER-OR-EQUAL to today: canCreateLabel keeps its
 *      fresh-only meaning and can only get narrower; shipped rows can queue the
 *      EXISTING label (reprint) but never create; blocked rows can do nothing.
 *   3. The display tuple encodes the PS-079/PS-165 precedence byte-compatibly
 *      (awaiting best-rate-first, shipped canonical-first, test pinned).
 *   4. ADDITIVE guarantee: a legacy buildBestRateWorkflowDto call (no row context)
 *      emits NO new keys — byte-identical output to before PS-173.
 *   5. Route + FE wiring pins (row context passed from the canonical picks; FE
 *      resolvers prefer the backend tuple behind the existing fallbacks).
 *
 *   npx tsx scripts/ps-173-order-row-workflow-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const NOW = new Date('2026-06-11T12:00:00Z');
const FRESH_RATE = {
  amount: 8.95,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  requestFingerprint: 'fp_1',
  isComplete: true,
  cacheExpiresAt: '2026-06-11T18:00:00Z',
};

const baseFacts: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: 'fedex',
  canonicalServiceCode: 'fedex_ground',
  canonicalAccountNickname: 'ROCEL C81F70',
  selectedRateCarrierCode: 'usps',
  providerAccountId: 607855,
};

function dtoFor(savedBestRate: unknown, fingerprint = 'fp_1') {
  return buildBestRateWorkflowDto({
    currentRequestFingerprint: fingerprint,
    backendRequestKey: fingerprint,
    savedBestRate,
    source: 'cache',
    now: NOW,
  });
}

// ── 1. row-state matrix ───────────────────────────────────────────────────────
{
  const dto = withOrderRowWorkflow(dtoFor(FRESH_RATE), baseFacts);
  check('awaiting + dims + fresh → final', dto.rowState === 'final');
  check('final row: all awaiting verbs true + create/queue allowed',
    dto.allowedActions.canCreateLabel === true &&
    dto.allowedActions.canQueueLabel === true &&
    dto.allowedActions.canRate === true &&
    dto.allowedActions.canBrowseRates === true &&
    dto.allowedActions.canRecalculate === true &&
    dto.allowedActions.canMarkExternalShipped === true);
}
{
  const dto = withOrderRowWorkflow(dtoFor(FRESH_RATE), { ...baseFacts, hasCompleteDims: false });
  check('missing dims → needs_dims (trumps a fresh rate)', dto.rowState === 'needs_dims');
  check('needs_dims: create/queue blocked, browse allowed (dims get fixed there)',
    dto.allowedActions.canCreateLabel === false &&
    dto.allowedActions.canQueueLabel === false &&
    dto.allowedActions.canBrowseRates === true &&
    dto.allowedActions.canRate === false);
}
{
  const stale = { ...FRESH_RATE, cacheExpiresAt: '2026-06-11T11:00:00Z' };
  const dto = withOrderRowWorkflow(dtoFor(stale), baseFacts);
  check('expired rate → stale_rate; re-rate verbs on, purchase off',
    dto.rowState === 'stale_rate' &&
    dto.allowedActions.canCreateLabel === false &&
    dto.allowedActions.canRate === true);
}
check('no saved rate → missing_rate',
  withOrderRowWorkflow(dtoFor(null), baseFacts).rowState === 'missing_rate');
{
  const dto = dtoFor(FRESH_RATE);
  dto.bestRateState = 'pending'; // the PS-120 reader override path
  check('PS-120 pending override → rowState pending',
    withOrderRowWorkflow(dto, baseFacts).rowState === 'pending');
}
check('cancelled trumps everything → blocked',
  withOrderRowWorkflow(dtoFor(FRESH_RATE), { ...baseFacts, orderStatus: 'cancelled' }).rowState === 'blocked');
check('upstream cancel (canonicalStatus) → blocked',
  withOrderRowWorkflow(dtoFor(FRESH_RATE), { ...baseFacts, canonicalStatus: 'cancelled' }).rowState === 'blocked');
check('externally shipped → external_shipped (trumps local shipped)',
  withOrderRowWorkflow(dtoFor(null), { ...baseFacts, orderStatus: 'shipped', externallyShipped: true, hasShipment: true }).rowState === 'external_shipped');
{
  const dto = withOrderRowWorkflow(dtoFor(null), { ...baseFacts, orderStatus: 'shipped', hasShipment: true });
  check('shipped with shipment → local_shipped', dto.rowState === 'local_shipped');
  check('local_shipped: queue-existing allowed (reprint), create NEVER',
    dto.allowedActions.canQueueLabel === true && dto.allowedActions.canCreateLabel === false);
}
check('shipped without shipment row → missing_shipment_sync',
  withOrderRowWorkflow(dtoFor(null), { ...baseFacts, orderStatus: 'shipped', hasShipment: false }).rowState === 'missing_shipment_sync');
{
  const dto = withOrderRowWorkflow(dtoFor(FRESH_RATE), { ...baseFacts, orderStatus: 'cancelled' });
  check('blocked row: every verb false',
    dto.allowedActions.canCreateLabel === false &&
    dto.allowedActions.canQueueLabel === false &&
    dto.allowedActions.canRate === false &&
    dto.allowedActions.canBrowseRates === false &&
    dto.allowedActions.canRecalculate === false &&
    dto.allowedActions.canMarkExternalShipped === false);
}

// ── 2. canCreateLabel can only get NARROWER ───────────────────────────────────
{
  const staleDto = dtoFor({ ...FRESH_RATE, cacheExpiresAt: '2026-06-11T11:00:00Z' });
  check('base canCreateLabel=false can never become true in any row state',
    (['awaiting_shipment', 'shipped', 'cancelled'] as const).every((orderStatus) =>
      withOrderRowWorkflow(staleDto, { ...baseFacts, orderStatus, hasShipment: true })
        .allowedActions.canCreateLabel === false));
  check('base purchase semantics untouched (canUseSavedRate/requiresRerate preserved)',
    (() => {
      const enriched = withOrderRowWorkflow(dtoFor(FRESH_RATE), baseFacts);
      return enriched.allowedActions.canUseSavedRate === true && enriched.allowedActions.requiresRerate === false;
    })());
}

// ── 3. display tuple precedence (PS-079/PS-165 byte-compatible) ───────────────
{
  const display = withOrderRowWorkflow(dtoFor(FRESH_RATE), baseFacts).display!;
  check('awaiting → best-rate-first carrier + service',
    display.carrierCode === 'ups' && display.serviceCode === 'ups_ground');
  check('account nickname + provider id pass through the canonical picks',
    display.accountNickname === 'ROCEL C81F70' && display.providerAccountId === 607855);
}
check('shipped → canonical-first carrier + service',
  (() => {
    const display = withOrderRowWorkflow(dtoFor(null), { ...baseFacts, orderStatus: 'shipped', hasShipment: true }).display!;
    return display.carrierCode === 'fedex' && display.serviceCode === 'fedex_ground';
  })());
check('awaiting without best rate falls to canonical, then selected',
  (() => {
    const display = withOrderRowWorkflow(dtoFor(null), { ...baseFacts, bestRateCarrierCode: null, bestRateServiceCode: null }).display!;
    return display.carrierCode === 'fedex' && display.serviceCode === 'fedex_ground';
  })());
check('test order pins the test carrier',
  withOrderRowWorkflow(dtoFor(FRESH_RATE), { ...baseFacts, isTest: true }).display!.carrierCode === 'prepship_test');

// ── 4. ADDITIVE guarantee: legacy output emits no new keys ────────────────────
{
  const legacy = dtoFor(FRESH_RATE) as unknown as Record<string, unknown>;
  check('legacy DTO carries no rowState/display', !('rowState' in legacy) && !('display' in legacy));
  const legacyActions = legacy.allowedActions as Record<string, unknown>;
  check('legacy allowedActions carries ONLY the original three keys',
    Object.keys(legacyActions).sort().join(',') === 'canCreateLabel,canUseSavedRate,requiresRerate');
}

// ── 5. wiring pins ────────────────────────────────────────────────────────────
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('route enriches with withOrderRowWorkflow from the canonical picks',
  /withOrderRowWorkflow\(bestRateWorkflow, \{/.test(ordersRoute) &&
  /canonicalAccountNickname,\s*\n\s*selectedRateCarrierCode/.test(ordersRoute));
check('route payloads emit the enriched DTO (both shapes)',
  (ordersRoute.match(/bestRateWorkflow: bestRateWorkflowRow,/g)?.length ?? 0) === 2);
check('row isTest uses the PS-186 backend authority (testClientIds)',
  /isTest: r\.order\.clientId != null && testClientIds\.has\(r\.order\.clientId\),\s*\n\s*hasCompleteDims/.test(ordersRoute));
const displayLib = readFileSync('web/src/components/Views/order-shipping-display.ts', 'utf8');
check('FE resolvers prefer the backend display tuple behind existing fallbacks',
  /if \(input\.backendDisplayCarrierCode\) return input\.backendDisplayCarrierCode/.test(displayLib) &&
  /if \(input\.backendDisplayServiceCode\) return input\.backendDisplayServiceCode/.test(displayLib));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-178 (Phase 6, part 2): getBestRateServiceCode (the service-tuple consumer)
// moved VERBATIM to orders-row-display.tsx; the carrier consumer
// (getCarrierCodeForDisplay) stayed in OrdersView. Same pins, split homes.
const rowDisplay = readFileSync('web/src/components/Views/orders-row-display.tsx', 'utf8');
check('FE passes the backend tuple into both resolvers',
  /backendDisplayCarrierCode: toStringValue\(toRecord\(order\.bestRateWorkflow\?\.display\)\?\.carrierCode\)/.test(ordersView) &&
  /backendDisplayServiceCode: toStringValue\(toRecord\(order\.bestRateWorkflow\?\.display\)\?\.serviceCode\)/.test(rowDisplay));

if (failures > 0) {
  console.error(`\nFAIL PS-173 order-row workflow guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-173 order-row workflow guard');
