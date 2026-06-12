/**
 * PS-193 guard — write-path defaults ownership: no silent panel auto-persist.
 *
 * Pre-PS-193, opening the order side panel could mutate the DB with ZERO
 * operator action:
 *  - the 450ms effect auto-matched/auto-CREATED a package for the seeded
 *    dims, persisted the order's selected package, and (saveSku:true) minted
 *    per-unit SKU weight/dims PRODUCT DEFAULTS (weight ÷ qty) that seeded
 *    FUTURE orders' rate inputs;
 *  - the 750ms effect persisted weight/dims/package whenever the form
 *    differed from the last-saved key — programmatic fills included.
 *
 * Now BOTH debounced effects are gated on the operator-edit dirty flag
 * (dimsUserEditedRef — set only in the weight/dims/package input handlers,
 * reset on order switch), the auto path never mints product defaults, and
 * dims suggestions are backend-owned by the PURE order-dims-defaults-policy
 * module (PS-178) which only ever returns a DTO.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const dimsPolicy = read('src/services/order-dims-defaults-policy.ts');
const pkg = read('package.json');

// ── The 450ms auto-package effect: dirty-gated, never mints defaults ───────
const autoPkgStart = ordersView.indexOf("autoPackageDimsKeyRef.current === key");
assert.ok(autoPkgStart > 0, 'auto-package effect must exist');
const autoPkgEffect = ordersView.slice(
  ordersView.lastIndexOf('useEffect(', autoPkgStart),
  ordersView.indexOf('packagesLoaded])', autoPkgStart) + 20,
);
assert.ok(autoPkgEffect.includes('if (!dimsUserEditedRef.current) return'),
  'the auto-package effect must be gated on an actual operator edit');
assert.ok(autoPkgEffect.includes('saveSku: false'),
  'the auto path must never mint SKU product defaults');
assert.ok(!autoPkgEffect.includes('saveSku: true'),
  'saveSku:true is reserved for explicit operator saves / post-label followups');

// ── The 750ms auto-save effect: dirty-gated ─────────────────────────────────
const autoSaveStart = ordersView.indexOf('currentKey === shipmentLastSavedKeyRef.current');
assert.ok(autoSaveStart > 0, 'auto-save effect must exist');
const autoSaveEffect = ordersView.slice(
  ordersView.lastIndexOf('useEffect(', autoSaveStart),
  autoSaveStart,
);
assert.ok(autoSaveEffect.includes('if (!dimsUserEditedRef.current) return'),
  'the debounced auto-persist must be gated on an actual operator edit');

// ── The dirty flag itself: set by operator inputs, reset on order switch ───
assert.ok(/useEffect\(\(\) => \{\s*dimsUserEditedRef\.current = false\s*\}, \[panelOrderId\]\)/.test(ordersView),
  'the dirty flag must reset when the active order changes');
const setterCount = ordersView.split('dimsUserEditedRef.current = true').length - 1;
assert.ok(setterCount >= 6,
  `the dirty flag must be set by the weight/dims/package input handlers (found ${setterCount})`);

// ── Backend suggestions stay a pure DTO (PS-178 ownership, pinned here) ────
// Pin the CALL/DECLARATION shapes — the PS-178 deletion comment legitimately
// names the dead function while documenting where the logic went.
assert.ok(!ordersView.includes('deriveShipmentDimsFromProductDefaults(') &&
  !/function deriveShipmentDimsFromProductDefaults/.test(ordersView),
  'the FE dims-derivation stays deleted — suggestions are backend-owned');
assert.ok(!/from '\.\.\/db|db\.insert|db\.update|db\.delete|db\.execute/.test(dimsPolicy),
  'order-dims-defaults-policy must stay a pure suggestion module (no db access)');

// npm wiring.
assert.ok(pkg.includes('"test:ps-193-dirty-flag-auto-persist"'),
  'guard must be wired into package.json');

console.log('PASS ps-193 dirty-flag auto-persist guard');
