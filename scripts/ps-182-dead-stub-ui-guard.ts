/**
 * PS-182 guard — no-op UI stubs removed (fake 'Revert' button + hardcoded Tax IDs row).
 *
 * THE BUG: two v2-parity leftovers actively misled operators:
 *   - a 'Revert' button next to the address-validation status whose onClick only
 *     toasted "Address reverted" — nothing was reverted, and no address-edit
 *     feature exists that COULD be reverted;
 *   - a "Tax Information: 0 Tax IDs added" row (OrdersView side panel AND
 *     OrderDetailDrawer) hardcoding a count over a tax-id concept that does not
 *     exist anywhere in the backend, plus an 'Add' stub that toasted "Phase 3".
 *
 * THE FIX: both stubs deleted. Reintroduce only WITH a real backend feature.
 *
 * Pins:
 *   1. No fake-revert toast / Revert button in web/src.
 *   2. No hardcoded "Tax IDs added" string in web/src.
 *   3. No 'Add tax ID' stub toast in web/src.
 *   4. The real controls survive: the residential 'change' toggle and the
 *      validation status row are still present.
 *
 *   npx tsx scripts/ps-182-dead-stub-ui-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const files = walk('web/src');
const offendersRevert = files.filter((f) => readFileSync(f, 'utf8').includes("showToast('Address reverted')"));
check('no fake "Address reverted" toast anywhere in web/src', offendersRevert.length === 0, offendersRevert.join(', '));
const offendersTax = files.filter((f) => readFileSync(f, 'utf8').includes('Tax IDs added'));
check('no hardcoded "Tax IDs added" string anywhere in web/src', offendersTax.length === 0, offendersTax.join(', '));
const offendersAdd = files.filter((f) => readFileSync(f, 'utf8').includes("showToast('Add tax ID"));
check('no "Add tax ID" stub toast anywhere in web/src', offendersAdd.length === 0, offendersAdd.join(', '));

// PS-166 Wave 3b re-anchor: the recipient section JSX (the residential
// 'change' control + the validation status row) moved VERBATIM to the
// presentational OrdersPanelSections; the toggleResidential HANDLER still
// lives in OrdersView and is passed as a prop. The stub-removal negatives
// above already scan the whole web/src tree, so they cover the new file.
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const panelSections = readFileSync('web/src/components/Views/OrdersPanelSections.tsx', 'utf8');
check('the REAL residential change control survives',
  /void toggleResidential\(\)/.test(panelSections) &&
  /async function toggleResidential\(\)|toggleResidential={toggleResidential}/.test(ordersView));
check('the validation status row survives',
  /Address Validated/.test(panelSections) && /Address Not Validated/.test(panelSections));

if (failures > 0) {
  console.error(`\nFAIL PS-182 dead stub UI guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-182 dead stub UI guard');
