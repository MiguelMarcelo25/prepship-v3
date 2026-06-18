/**
 * PS-258 (component-boundary lockdown) — STATIC selection/lockdown gating guard.
 *
 * As OrdersView.tsx is decomposed into smaller children (PS-178 row-display,
 * PS-166 OrdersBatchPanel, …), the shipped/cancelled read-only lockdown gating
 * must survive each extraction. This guard is a READ-ONLY static-source assertion
 * over the orders row/selection surfaces. It does NOT change runtime behavior —
 * it pins the *existing* `isReadOnly` gating so a future extraction cannot
 * silently drop the row-checkbox / Select-All / batch-panel suppression.
 *
 * What is pinned (the five canonical lockdown consumer sites):
 *   1. OrdersView declares the single `isReadOnly` lockdown flag (one source).
 *   2. The per-row `select` cell early-returns null under isReadOnly
 *      (no interactive row checkbox on Shipped/Cancelled).
 *   3. Select-All is gated (`isReadOnly ? null : …`) so it cannot bypass the
 *      hidden per-row checkboxes.
 *   4. The SKU-group select-all is gated the same way.
 *   5. The batch-actions panel is suppressed: OrdersView passes isReadOnly into
 *      <OrdersBatchPanel> AND that extracted child early-returns null under it.
 *
 * Behavior-only static check (no DOM, no network). Run:
 *   npx tsx scripts/ps-258-component-boundary-lockdown-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';
const BATCH_PANEL_PATH = 'web/src/components/Views/OrdersBatchPanel.tsx';

const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
const batchPanel = readFileSync(BATCH_PANEL_PATH, 'utf8');

// Count helper — how many gating uses of isReadOnly survive in OrdersView.
const isReadOnlyUses = (ordersView.match(/isReadOnly/g) ?? []).length;

// ── 1. single lockdown flag lives in OrdersView (one source of truth) ──
check('OrdersView declares the isReadOnly lockdown flag',
  /const isReadOnly = /.test(ordersView));
check('OrdersView keeps the shipped/cancelled lockdown comment block (re-enable note)',
  /SHIPPED \/ CANCELLED LOCKDOWN/.test(ordersView) &&
  /search isReadOnly/.test(ordersView));

// ── 2. per-row select checkbox is gated (no row checkbox on shipped/cancelled) ──
check('OrdersView row select cell early-returns null under isReadOnly',
  /if \(isReadOnly\) return null/.test(ordersView));

// ── 3. Select-All is hidden under the lockdown ──
check('OrdersView Select-All is gated (isReadOnly ? null : …)',
  /\{isReadOnly \? null : \(/.test(ordersView));

// ── 4. there are at least two `isReadOnly ? null :` ternary gates ──
//     (Select-All + the SKU-group select-all). This catches a future
//     extraction that pulls one of them out without re-gating.
check('OrdersView keeps >= 2 `isReadOnly ? null :` selection gates (Select-All + SKU-group)',
  (ordersView.match(/isReadOnly \? null :/g) ?? []).length >= 2);

// ── 5. batch panel suppression: prop threaded + child honors it ──
check('OrdersView passes isReadOnly into <OrdersBatchPanel>',
  /<OrdersBatchPanel[\s\S]{0,400}?isReadOnly=\{isReadOnly\}/.test(ordersView));
check('OrdersBatchPanel declares isReadOnly: boolean in its strict props',
  /isReadOnly: boolean/.test(batchPanel));
check('OrdersBatchPanel early-returns null under isReadOnly (panel suppressed)',
  /if \(isReadOnly\) return null/.test(batchPanel));

// ── ratchet: the lockdown surface area must not shrink silently ──
//    Five canonical sites: declaration + row-cell guard + 2 ternary gates +
//    the <OrdersBatchPanel isReadOnly={isReadOnly}> pass-through. Floor of 5
//    references documents the gating without freezing exact line numbers.
check(`OrdersView retains >= 5 isReadOnly references (found ${isReadOnlyUses})`,
  isReadOnlyUses >= 5);

if (failures > 0) {
  console.error(`\nFAIL PS-258 component-boundary lockdown guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 component-boundary lockdown guard');
