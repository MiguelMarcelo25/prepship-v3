/**
 * PS-119 — Passive best-rate cached-negative live-retry + dims-first classification guard.
 *
 * Proves: (1) a cached/unproven NEGATIVE best-rate response triggers a live retry before
 * the passive table marks the row unavailable; (2) a proven live empty does NOT retry;
 * (3) missing/incomplete dims or weight resolves to an actionable "add-dims" state and
 * WINS over backend workflow 'missing'/'blocked' (never "Rate unavailable"); (4) the
 * passive path is wired to do the bounded live retry. Pure logic + static source checks —
 * no DB, no network, no postage.
 *
 *   npx tsx scripts/ps-119-passive-best-rate-live-retry-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  cachedNegativeNeedsLiveRetry,
  classifyAwaitingRateCellStateWithWorkflow,
  type AwaitingRateCellStateInput,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── 1) cachedNegativeNeedsLiveRetry — when a negative warrants a live retry ──
check('null response -> retry', cachedNegativeNeedsLiveRetry(null), true);
check('cache-sourced negative (source=cache) -> retry',
  cachedNegativeNeedsLiveRetry({ bestRate: null, source: 'cache', cacheAgeMs: 1200 }), true);
check('cached:true negative -> retry',
  cachedNegativeNeedsLiveRetry({ bestRate: null, cached: true }), true);
check('negative with NO carrier attempt -> retry',
  cachedNegativeNeedsLiveRetry({ bestRate: null, source: 'live', carrierStatuses: [] }), true);
check('negative with a still-loading carrier -> retry',
  cachedNegativeNeedsLiveRetry({ bestRate: null, source: 'live', carrierStatuses: [{ status: 'loading' }] }), true);
check('PROVEN live empty (all carriers terminal, no rate) -> NO retry',
  cachedNegativeNeedsLiveRetry({ bestRate: null, source: 'live', carrierStatuses: [{ status: 'empty' }, { status: 'error' }] }), false);
check('response already has a bestRate -> NO retry',
  cachedNegativeNeedsLiveRetry({ bestRate: { carrierCode: 'usps', amount: 6.5 }, source: 'cache' }), false);

// ── 2) Missing dims/weight wins over backend workflow unavailable/error ──────
const base: AwaitingRateCellStateInput = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  hasCarrierContext: true,
  accountsLoading: false,
  isAutoRatingActive: true,
};
check('workflow missing + NO dims -> add-dims (NOT unavailable)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'missing' }, { ...base, hasDims: false }), 'add-dims');
check('workflow missing + NO weight -> add-dims (NOT unavailable)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'missing' }, { ...base, hasWeight: false }), 'add-dims');
check('workflow blocked + NO dims -> add-dims (NOT error)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'blocked' }, { ...base, hasDims: false }), 'add-dims');
check('workflow missing + dims+weight present -> unavailable (unchanged)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'missing' }, { ...base }), 'unavailable');
check('partial_carrier_failure + dims+weight present -> error (unchanged)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'partial_carrier_failure' }, { ...base }), 'error');
check('displayable best rate wins even if dims missing (order IS rateable)',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'fresh' }, { ...base, hasDims: false, hasDisplayableBestRate: true }), 'ready');

// ── 3) Passive path is wired to do the bounded live retry ────────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('passive auto-rating imports the retry decision helper',
  /cachedNegativeNeedsLiveRetry/.test(ordersView), true);
check('passive does a cache-allowed first pass (forceRefresh:false)',
  /\.\.\.baseRateRequest,\s*forceRefresh: false/.test(ordersView), true);
check('passive does a guarded live retry (cachedNegativeNeedsLiveRetry -> forceLive+forceRefresh)',
  /if \(cachedNegativeNeedsLiveRetry\(response\)\)/.test(ordersView)
    && /\.\.\.baseRateRequest,\s*forceLive: true,\s*forceRefresh: true/.test(ordersView), true);
check('passive still persists null only AFTER the (possibly retried) response',
  /apiClient\.saveOrderBestRate\(order\.orderId, null, request\.dimsLabel\)/.test(ordersView), true);
check('add-dims cell is actionable (opens the order detail panel, not a dead state)',
  /data-rate-state="add-dims"[\s\S]{0,200}onClick=\{\(\) => onActiveOrderIdChange\?\.\(order\.orderId\)\}/.test(ordersView), true);

if (failures > 0) {
  console.error(`\nFAIL PS-119 passive best-rate live-retry guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-119 passive best-rate live-retry guard');
