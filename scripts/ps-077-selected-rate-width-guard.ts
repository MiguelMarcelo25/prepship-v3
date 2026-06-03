import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getColumnMinWidth, resolveColumnPrefs } from '../web/src/components/Views/orders-parity';

// PS-077 — the internal `bestrate` column (relabeled "Selected Rate" in
// Shipped/Cancelled) must be resizable below the old 175px Best Rate floor,
// while Awaiting Shipment "Best Rate" keeps its wider floor. Pure-logic proof
// (no browser): the min-width helper is status-aware and the pref resolver does
// not clamp a saved compact width back up for Shipped/Cancelled.

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── (1) status-aware min width ──────────────────────────────────────────────
check('bestrate min defaults to 175 when no status (back-compat)', getColumnMinWidth('bestrate') === 175);
check('Awaiting "Best Rate" keeps the 175 floor', getColumnMinWidth('bestrate', 'awaiting_shipment') === 175);
check('Shipped "Selected Rate" uses a compact floor (< 175)', getColumnMinWidth('bestrate', 'shipped') < 175);
check('Shipped "Selected Rate" compact floor is 88', getColumnMinWidth('bestrate', 'shipped') === 88);
check('Cancelled "Selected Rate" uses the compact floor', getColumnMinWidth('bestrate', 'cancelled') === 88);
check('test_bestRate (test client) also compacts in Shipped', getColumnMinWidth('test_bestRate', 'shipped') === 88);
check('compact floor is in the 80–95px target range', getColumnMinWidth('bestrate', 'shipped') >= 80 && getColumnMinWidth('bestrate', 'shipped') <= 95);

// ── (2) other columns are unaffected by status ──────────────────────────────
check('sku min unchanged by status', getColumnMinWidth('sku', 'shipped') === 150 && getColumnMinWidth('sku', 'awaiting_shipment') === 150);
check('customer min unchanged by status', getColumnMinWidth('customer', 'shipped') === 120);

// ── (3) saved prefs: compact Shipped width is preserved, Awaiting clamps ─────
const columns = [{ key: 'bestrate' as const, label: 'Best Rate', width: 175 }];

const shipped = resolveColumnPrefs(columns, 'shipped', { views: { shipped: { widths: { bestrate: 90 } } } } as never);
check('Shipped: a saved 90px Selected Rate width resolves to 90 (NOT clamped to 175)', shipped.widths.bestrate === 90);

const cancelled = resolveColumnPrefs(columns, 'cancelled', { views: { cancelled: { widths: { bestrate: 88 } } } } as never);
check('Cancelled: a saved 88px Selected Rate width is preserved', cancelled.widths.bestrate === 88);

const awaiting = resolveColumnPrefs(columns, 'awaiting_shipment', { views: { awaiting_shipment: { widths: { bestrate: 90 } } } } as never);
check('Awaiting: a sub-175 saved width is clamped back to 175 (Best Rate floor preserved)', awaiting.widths.bestrate === 175);

// ── (4) wiring: resize callers pass current status (no hard clamp) ───────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('drag resize passes current status to getColumnMinWidth',
  /getColumnMinWidth\(resizeState\.key,\s*currentStatusRef\.current\)/.test(ordersView));
check('keyboard resize passes current status to getColumnMinWidth',
  /getColumnMinWidth\(column\.key,\s*currentStatusRef\.current\)/.test(ordersView));
const parity = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');
check('getColumnMinWidth is status-aware (signature) and resolver threads status',
  /export function getColumnMinWidth\(\s*key: TableColumnKey,\s*currentStatus\?/.test(parity) &&
  /normalizeColumnWidth\(column\.key, savedWidth, column\.width, currentStatus\)/.test(parity));

if (failures > 0) {
  console.error(`\nFAIL PS-077 selected-rate width guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-077 selected-rate width guard');
