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

// ── (1) compact min width in EVERY view (Best Rate + Selected Rate) ──────────
check('bestrate uses the compact floor with no status (back-compat)', getColumnMinWidth('bestrate') === 88);
check('Awaiting "Best Rate" can shrink to the compact floor (< 175)', getColumnMinWidth('bestrate', 'awaiting_shipment') < 175);
check('Awaiting "Best Rate" compact floor is 88', getColumnMinWidth('bestrate', 'awaiting_shipment') === 88);
check('Shipped "Selected Rate" uses a compact floor (< 175)', getColumnMinWidth('bestrate', 'shipped') < 175);
check('Shipped "Selected Rate" compact floor is 88', getColumnMinWidth('bestrate', 'shipped') === 88);
check('Cancelled "Selected Rate" uses the compact floor', getColumnMinWidth('bestrate', 'cancelled') === 88);
check('test_bestRate (test client) also compacts in every view', getColumnMinWidth('test_bestRate', 'shipped') === 88 && getColumnMinWidth('test_bestRate', 'awaiting_shipment') === 88);
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
check('Awaiting: a saved 90px Best Rate width is preserved (no longer clamped to 175)', awaiting.widths.bestrate === 90);
const awaitingBelowFloor = resolveColumnPrefs(columns, 'awaiting_shipment', { views: { awaiting_shipment: { widths: { bestrate: 40 } } } } as never);
check('Awaiting: a width below the 88 floor is clamped UP to 88 (not 175)', awaitingBelowFloor.widths.bestrate === 88);

// ── (4) wiring: resize callers pass current status (no hard clamp) ───────────
// PS-317: the resize interaction (drag + keyboard) was extracted out of OrdersView into the
// useColumnResize hook; the status-aware-floor invariant is preserved there, so the resize-caller
// checks now read the hook (not OrdersView). Same assertions — only the owning file moved.
const columnResize = readFileSync('web/src/components/Views/orders/useColumnResize.ts', 'utf8');
// PS-257: the column key carries a type-only `as any` cast (TableColumnKey divergence between
// orders-parity and orders-table-columns); behavior is unchanged. The guard's intent is that the
// resize callers pass currentStatusRef.current (the status) — tolerate the erased cast.
check('drag resize passes current status to getColumnMinWidth',
  /getColumnMinWidth\(resizeState\.key(?: as any)?,\s*currentStatusRef\.current\)/.test(columnResize));
check('keyboard resize passes current status to getColumnMinWidth',
  /getColumnMinWidth\(column\.key(?: as any)?,\s*currentStatusRef\.current\)/.test(columnResize));
const parity = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');
check('bestrate/test_bestRate use the compact floor in getColumnMinWidth',
  /if \(key === 'bestrate' \|\| key === 'test_bestRate'\) return BESTRATE_COMPACT_MIN_WIDTH/.test(parity) &&
  /const BESTRATE_COMPACT_MIN_WIDTH = 88/.test(parity));

if (failures > 0) {
  console.error(`\nFAIL PS-077 selected-rate width guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-077 selected-rate width guard');
