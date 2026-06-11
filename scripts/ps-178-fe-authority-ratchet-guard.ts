/**
 * PS-178 (Phase 6, part 1) — FE-authority RATCHET.
 *
 * Phases 1–5 moved rate/money/routing/identity/defaults policy onto backend
 * DTOs and left the FE computations in place ONLY as deploy-skew fallbacks.
 * Phase 6 deletes those fallbacks while decomposing OrdersView. This guard is
 * the ratchet that makes that provable: every remaining FE-authority site has
 * a COUNT CEILING pinned here. Counts may only go DOWN (lower the ceiling in
 * the same PR that deletes a site). A count above its ceiling means frontend
 * authority is REAPPEARING — the exact regression class PS-172 exists to end.
 *
 * Per-ticket guards (ps-173/175/176/177/196) pin that the backend-first paths
 * EXIST and are consulted first; this guard pins that the fallback surface
 * never grows. Both must pass.
 *
 *   npx tsx scripts/ps-178-fe-authority-ratchet-guard.ts
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const parity = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');

function count(haystack: string, pattern: RegExp): number {
  return (haystack.match(pattern) ?? []).length;
}

function ceiling(name: string, actual: number, max: number, deletionPhase: string) {
  check(
    `${name}: ${actual} site(s) ≤ ceiling ${max}`,
    actual <= max,
    `FE authority grew (${actual} > ${max}). New code must consume the backend DTO instead; ` +
      `the fallback is scheduled for deletion in ${deletionPhase}.`,
  );
}

// ── money: FE markup application (backend owner: rate-money.ts + DTO.money) ──
ceiling('OrdersView applyCarrierMarkup calls', count(ordersView, /applyCarrierMarkup\(/g), 5, 'PS-178 fallback deletion');
{
  // The money-math import surface is a fixed allowlist — a NEW file importing
  // the FE markup math is a new money-policy consumer, which Phase 6 forbids.
  const moneyConsumers = execSync(
    'git grep -l "applyCarrierMarkup" -- web/src',
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .sort();
  const allowlist = [
    'web/src/components/Views/OrdersView.tsx',
    'web/src/utils/markups.ts',
  ];
  check(
    'money-math consumer files are exactly the known allowlist',
    JSON.stringify(moneyConsumers) === JSON.stringify(allowlist),
    `consumers: ${moneyConsumers.join(', ')}`,
  );
}

// ── rate selection: no FE best-rate picker, ever ─────────────────────────────
check('no FE pickBestRate resurrection in OrdersView',
  !/function pickBestRate|\.pickBestRate\(|= pickBestRate\(/.test(ordersView));
check('no FE pickBestRate resurrection in orders-parity',
  !/function pickBestRate|\.pickBestRate\(|= pickBestRate\(/.test(parity));

// ── strict recalc: backend decision + persist first (PS-175) ─────────────────
ceiling('OrdersView planStrictBestRateRecalculate calls', count(ordersView, /planStrictBestRateRecalculate\(/g), 1, 'PS-178 fallback deletion');
ceiling('orders-parity planStrictBestRateRecalculate definitions', count(parity, /function planStrictBestRateRecalculate/g), 1, 'PS-178 fallback deletion');
ceiling('OrdersView saveOrderDimsStrict fallback persists', count(ordersView, /saveOrderDimsStrict\(/g), 1, 'PS-178 fallback deletion');
ceiling('OrdersView updateOrderBestRateSelectionStrict fallback persists', count(ordersView, /updateOrderBestRateSelectionStrict\(/g), 2, 'PS-178 fallback deletion');

// ── display: backend tuple first (PS-165b/173) ───────────────────────────────
ceiling('OrdersView resolveDisplayCarrierCode calls', count(ordersView, /resolveDisplayCarrierCode\(/g), 1, 'PS-178 fallback deletion');
ceiling('OrdersView resolveDisplayServiceCode calls', count(ordersView, /resolveDisplayServiceCode\(/g), 1, 'PS-178 fallback deletion');

// ── dims defaults: backend dimsDefaults first (PS-177 part 3) ────────────────
ceiling('OrdersView deriveShipmentDimsFromProductDefaults occurrences (def + fallback call)',
  count(ordersView, /deriveShipmentDimsFromProductDefaults\(/g), 2, 'PS-178 fallback deletion');
ceiling('OrdersView fetchProductsBySku N-per-panel loop sites', count(ordersView, /fetchProductsBySku\(/g), 2, 'PS-178 fallback deletion');

// ── queue routing: backend queueRoute first (PS-176) ─────────────────────────
// classifyQueueOrderRoute stays (it hosts the live never-buy ladder); the pin is
// that OrdersView consults it through the ladder, not a second local rule.
ceiling('OrdersView classifyQueueOrderRoute calls', count(ordersView, /classifyQueueOrderRoute\(/g), 1, 'PS-178 (ladder is permanent; local residual rule deletes)');

// ── decomposition ratchet: OrdersView must shrink, not grow ──────────────────
{
  const lineCount = ordersView.split('\n').length;
  check(
    `OrdersView line count ${lineCount} ≤ 12500 (decomposition ratchet)`,
    lineCount <= 12_500,
    'OrdersView grew past the Phase 6 ceiling. Extract components instead of adding inline; ' +
      'lower this ceiling in each decomposition part.',
  );
}

if (failures > 0) {
  console.error(`\nFAIL PS-178 FE-authority ratchet (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-178 FE-authority ratchet');
