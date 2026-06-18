/**
 * PS-258 (decomposition cert, next slice) — STATIC arg/DOM-contract guard for the
 * extracted `buildEmptyPanel()` leaf (web/src/components/Views/orders-empty-panel.tsx).
 *
 * `buildEmptyPanel` is the "no order selected" empty-panel JSX that PS-166 (Wave
 * 2a3) moved VERBATIM out of OrdersView.tsx. It is an already-extracted
 * presentational leaf with NO contract guard yet. A future "tidy-up" extraction
 * could rename/add the factory's arg, collapse the optional close-button render
 * branch, or drop one of the DOM anchors (the heading copy, the keyboard-hint
 * <kbd> rows, or the close button's a11y labels) — silently changing the public
 * contract the OrdersView shell renders via `renderSinglePanel()`.
 *
 * The existing ps-258-component-boundary guard pins the shipped/cancelled
 * *lockdown* gating; the empty-state-props guard pins <OrdersResultsEmptyState>.
 * This guard pins the *factory signature + conditional render branch + DOM
 * anchors* of THIS concrete extracted leaf so its contract cannot move
 * underneath the single OrdersView call site.
 *
 * READ-ONLY static-source assertion. No DOM, no network, no runtime change. The
 * leaf is purely presentational (no money/rate/insurance/label verdict lives
 * here — the only input is the optional `onHide` callback), so this guard never
 * has to reason about backend source-of-truth ownership; it only freezes the
 * leaf's public surface.
 *
 * What is pinned:
 *   1. `buildEmptyPanel` is exported as a function taking exactly one OPTIONAL
 *      `onHide?: () => void` arg (no silent add/rename/required-promotion).
 *   2. The close button renders only under `onHide ? (…) : null` (the optional
 *      branch survives — a future extraction cannot make the close button
 *      unconditional, which would render a dead no-op X when no callback exists).
 *   3. The close button wires `onClick={onHide}` and keeps its a11y labels
 *      (aria-label + title) so keyboard/screen-reader users keep the affordance.
 *   4. The DOM-copy anchors survive verbatim: the "No order selected" heading and
 *      the "Click any row to view details" hint.
 *   5. All four keyboard-hint <kbd> rows survive (↑↓ / Enter / Esc / ⌘C) — the
 *      navigation legend cannot silently shrink.
 *   6. OrdersView's single call site passes onHide conditionally (threaded from
 *      `onHideEmptyPanelChange`), never unconditionally — so the optional-arg
 *      contract is honored by the caller, not just declared by the leaf.
 *
 * Run:
 *   npx tsx scripts/ps-258-orders-empty-panel-contract-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const PANEL_PATH = 'web/src/components/Views/orders-empty-panel.tsx';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

const panel = readFileSync(PANEL_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');

// ── 1. factory signature: exported, exactly one OPTIONAL `onHide?: () => void` ──
check('orders-empty-panel exports `buildEmptyPanel`',
  /export function buildEmptyPanel\(/.test(panel));

// Isolate the parameter list. The arg type `() => void` itself contains `()`, so
// anchor the capture on the function-body `{` after the return type instead of a
// naive first-`)` match (which would truncate inside `() => void`).
const argList = panel.match(/export function buildEmptyPanel\(([\s\S]*?)\)\s*\{/)?.[1] ?? '';
check('buildEmptyPanel takes the optional `onHide?: () => void` arg',
  /\bonHide\?:\s*\(\)\s*=>\s*void\b/.test(argList));

// Exactly one declared parameter — no silent second arg sneaking into the leaf.
// Split on top-level commas only (the arrow type has none, so a plain split is
// safe here, but guard against an empty arg list).
const argCount = argList.trim() === '' ? 0 : argList.split(',').length;
check(`buildEmptyPanel declares EXACTLY 1 arg (found ${argCount})`, argCount === 1);

// ── 2. the close button is rendered only under the optional `onHide ? … : null` ──
check('close button is gated behind `onHide ? (` (optional render branch survives)',
  /\{onHide \? \(/.test(panel));
check('the optional branch closes with `) : null}` (no unconditional close button)',
  /\) : null\}/.test(panel));

// ── 3. close button wires onClick + keeps its a11y labels ──
check('close button wires `onClick={onHide}`',
  /onClick=\{onHide\}/.test(panel));
check('close button keeps an aria-label',
  /aria-label="Hide this panel when no order is selected"/.test(panel));
check('close button keeps a matching title',
  /title="Hide this panel when no order is selected"/.test(panel));

// ── 4. DOM-copy anchors the OrdersView shell renders verbatim ──
check('heading copy "No order selected" survives',
  /No order selected/.test(panel));
check('hint copy "Click any row to view details" survives',
  /Click any row to view details/.test(panel));

// ── 5. all four keyboard-hint <kbd> rows survive (legend cannot shrink) ──
const kbdRowCount = (panel.match(/<kbd className=\{kbdCls\}>/g) ?? []).length;
check(`keeps EXACTLY 4 keyboard-hint <kbd> rows (found ${kbdRowCount})`,
  kbdRowCount === 4);
for (const key of ['↑↓', 'Enter', 'Esc', '⌘C']) {
  check(`keyboard legend keeps the \`${key}\` hint`,
    new RegExp(`<kbd className=\\{kbdCls\\}>${key}</kbd>`).test(panel));
}

// ── 6. OrdersView call site passes onHide CONDITIONALLY (honors optional arg) ──
//    The call argument contains `onHideEmptyPanelChange(true)`, whose own `)`
//    would truncate a naive capture — so just assert against the single line that
//    invokes the factory rather than trying to balance parens.
const callLine = ordersView.match(/buildEmptyPanel\([^\n]*/)?.[0] ?? '';
check('OrdersView calls buildEmptyPanel(...)', callLine.length > 0);
check('call site threads onHide conditionally from onHideEmptyPanelChange (not unconditional)',
  /buildEmptyPanel\(onHideEmptyPanelChange \? \(\) => onHideEmptyPanelChange\(true\) : undefined\)/.test(callLine));

if (failures > 0) {
  console.error(`\nFAIL PS-258 orders-empty-panel contract guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 orders-empty-panel contract guard');
