/**
 * PS-175 (Phase 3, part 1) guard — the strict recalculation DECISION is backend-owned.
 *
 * The side-panel Recalculate rule (any non-live carrier blocks; clean no-rate
 * clears; only a clean live best with full identity applies) used to live in the
 * frontend. /rates/browse now computes it server-side (strictRecalculate: true →
 * response.strictRecalculation) via the pure port in
 * src/services/rates-recalculate.ts. The FE consumes the backend verdict; its
 * local copy survives ONLY as a deploy-skew fallback until Phase 6.
 *
 * Pins:
 *   1. Backend decision matrix — the SAME semantics the FE guard
 *      (recalculate-best-rate-strict) pins on the FE copy, run against the
 *      backend port (parity by fixtures, not by trust).
 *   2. /browse wiring: zod accepts strictRecalculate; the decision is computed
 *      from the combined statuses + cheapest and attached to the payload.
 *   3. FE wiring: the recalc browse call sends strictRecalculate: true; the
 *      response applier prefers the backend verdict (apply requires a present
 *      best rate) and falls back to the local plan only when the field is absent.
 *   4. Persistence endpoints unchanged (decision-only phase — part 2 moves the
 *      persist orchestration server-side).
 *
 *   npx tsx scripts/ps-175-strict-recalc-decision-guard.ts
 */
import { readFileSync } from 'node:fs';
import { planStrictRecalculateDecision } from '../src/services/rates-recalculate';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. backend decision matrix (mirrors the FE strict guard fixtures) ─────────
const LIVE = [{ carrierId: 'se-1', nickname: 'USPS Chase x7439', status: 'live' }];
check('clean live response with usable best → apply with identity',
  (() => {
    const d = planStrictRecalculateDecision({
      liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'usps_ground_advantage', carrierStatuses: LIVE,
    });
    return d.action === 'apply' && d.selectedPid === 433542 && d.serviceCode === 'usps_ground_advantage';
  })());
check('any carrier error blocks the update',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'usps_ground_advantage',
    carrierStatuses: [...LIVE, { carrierId: 'se-2', status: 'error' }],
  }).action === 'blocked');
check('a CACHED carrier blocks strict live recalculation',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'usps_ground_advantage',
    carrierStatuses: [{ carrierId: 'se-1', status: 'cached' }],
  }).action === 'blocked');
check('unavailable carriers do NOT block (parity with the FE rule)',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'usps_ground_advantage',
    carrierStatuses: [...LIVE, { carrierId: 'se-3', status: 'unavailable' }],
  }).action === 'apply');
check('clean no-rate response clears the saved best rate',
  planStrictRecalculateDecision({
    liveBestAmount: null, providerAccountId: null, serviceCode: null, carrierStatuses: LIVE,
  }).action === 'clear');
check('zero/negative amount clears (never applies a worthless rate)',
  planStrictRecalculateDecision({
    liveBestAmount: 0, providerAccountId: 433542, serviceCode: 'x', carrierStatuses: LIVE,
  }).action === 'clear');
check('missing provider account blocks; missing service blocks',
  planStrictRecalculateDecision({ liveBestAmount: 7.45, providerAccountId: null, serviceCode: 'x', carrierStatuses: LIVE }).action === 'blocked' &&
  planStrictRecalculateDecision({ liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: null, carrierStatuses: LIVE }).action === 'blocked');
check('no carrier statuses at all blocks (cannot confirm completion)',
  planStrictRecalculateDecision({ liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'x', carrierStatuses: [] }).action === 'blocked');
check('blocked messages name the carrier + status (operator-actionable)',
  (() => {
    const d = planStrictRecalculateDecision({
      liveBestAmount: 7.45, providerAccountId: 433542, serviceCode: 'x',
      carrierStatuses: [{ carrierId: 'se-9', nickname: 'ROCEL C81F70', status: 'loading' }],
    });
    return d.action === 'blocked' && /ROCEL C81F70/.test(d.message) && /loading/.test(d.message);
  })());

// ── 2. /browse wiring ─────────────────────────────────────────────────────────
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
check('zod accepts strictRecalculate', /strictRecalculate: z\.boolean\(\)\.optional\(\)/.test(ratesRoute));
check('decision computed from combined statuses + cheapest and attached to the payload',
  /planStrictRecalculateDecision\(\{[\s\S]{0,400}carrierStatuses: combinedCarrierStatuses/.test(ratesRoute) &&
  /\.\.\.\(strictRecalculation \? \{ strictRecalculation \} : \{\}\)/.test(ratesRoute));

// ── 3. FE wiring ──────────────────────────────────────────────────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('recalc browse call sends strictRecalculate: true',
  /includeVisibleDirectCarriers: true,[\s\S]{0,300}strictRecalculate: true,/.test(ordersView));
check('FE prefers the backend verdict; apply requires a present best rate',
  /backendAction === 'apply' && liveBest/.test(ordersView) &&
  /toRecord\(response\?\.strictRecalculation\)/.test(ordersView));
check('local plan survives only as the deploy-skew fallback',
  /: planStrictBestRateRecalculate\(\{/.test(ordersView));

// ── 4. PART 2: server-side persistence of the strict outcome ─────────────────
const persistService = readFileSync('src/services/rates-recalculate-persist.ts', 'utf8');
check('persist writer refuses non-awaiting orders (same lock as the guarded routes)',
  /orderStatus !== 'awaiting_shipment'/.test(persistService) &&
  /not editable/.test(persistService));
check('blocked decisions never write',
  /action === 'blocked'[\s\S]{0,120}persisted: false/.test(persistService));
check('persist reuses the canonical normalizer + eligibility re-check',
  /normalizeOrderBestRateDto\(rateWithMetadata, 'bestRateJson'\)/.test(persistService) &&
  /evaluateShippingServiceEligibility\(/.test(persistService));
check('persist touches order_overrides only (never orders/shipments writes)',
  !/db\s*\.\s*update\(\s*orders\b/.test(persistService) &&
  !/db\s*\.\s*update\(\s*shipments\b/.test(persistService) &&
  !/insert\(\s*shipments\b/.test(persistService) &&
  /insert\(orderOverrides\)/.test(persistService));
check('persist carries the shipped-data override citation',
  /Per user override unlock shipped data on 2026-06-12/.test(persistService));
check('/browse persists the outcome only when the request carries an orderId',
  /typeof body\.orderId === 'number' && body\.orderId > 0/.test(ratesRoute) &&
  /persistStrictRecalculateOutcome\(\{/.test(ratesRoute));
check('FE skips its own strict persist when the backend persisted',
  /backendPersisted = backendStrict\?\.persisted === true/.test(ordersView) &&
  (ordersView.match(/if \(!backendPersisted\) \{/g)?.length ?? 0) >= 3);
check('FE strict endpoints retained as the not-persisted fallback',
  /apiClient\.updateOrderBestRateSelectionStrict\(order\.orderId/.test(ordersView) &&
  /apiClient\.saveOrderDimsStrict\(order\.orderId/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-175 strict recalc decision guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-175 strict recalc decision guard');
