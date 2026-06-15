/**
 * PS-276 (slice 4-UI) guard — the resi/comm tag is DISPLAY of the backend verdict, at 3 sites.
 *
 * Pins: (1) the shared ResidentialTag reads the verdict off the DTO (residentialClassification,
 * top-level OR canonicalOrder.recipient, with a legacy-boolean deploy-skew fallback) and NEVER
 * classifies (no classifyShippingAddress import); (2) trusted commercial = green, untrusted
 * commercial = amber (money-risk flag), residential = neutral; (3) it renders at all three
 * rate-decision sites — side panel, Orders table customer cell, Rate Browser modal header.
 *
 *   npx tsx scripts/ps-276-resi-comm-tag-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. The shared component reads the DTO verdict + never re-classifies ────────
const tag = readFileSync('web/src/components/ui/ResidentialTag.tsx', 'utf8');
check('residentialTagFacts reads the verdict top-level OR canonicalOrder.recipient',
  /order\.residentialClassification \?\? rec\?\.residentialClassification/.test(tag));
check('residentialTagFacts has a legacy-boolean deploy-skew fallback',
  /order\.residential \?\? order\.sourceResidential/.test(tag));
check('the tag NEVER classifies (no classifier import — display only)',
  !/classifyShippingAddress|residentialForShipping|address-classification/.test(tag));
check('trusted commercial -> emerald (green)', /emerald/.test(tag) && /TRUSTED/.test(tag));
check('untrusted commercial -> amber (money-risk warning)', /amber/.test(tag));
check('residential -> neutral surface', /bg-surface-2 text-ink-2 ring-line/.test(tag));

// ── 2. Rendered at all three rate-decision sites ──────────────────────────────
const panel = readFileSync('web/src/components/Views/OrdersPanelSections.tsx', 'utf8');
check('side panel imports + renders ResidentialTag from the panelOrder',
  /import \{ ResidentialTag, residentialTagFacts \} from '\.\.\/ui\/ResidentialTag'/.test(panel) &&
    /<ResidentialTag facts=\{residentialTagFacts\(panelOrder\)\} \/>/.test(panel));
check('side panel dropped the old inline residential/commercial pill (uses the shared tag now)',
  !/\(manual\)' : '\(auto\)/.test(panel));

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('Orders table customer cell imports + renders the compact ResidentialTag',
  /import \{ ResidentialTag, residentialTagFacts \} from '\.\.\/ui\/ResidentialTag'/.test(ordersView) &&
    /<ResidentialTag facts=\{residentialTagFacts\(order\)\} \/>/.test(ordersView));

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('Rate Browser modal DTO declares the verdict fields',
  /residentialClassification\?: 'residential' \| 'commercial' \| null/.test(modal));
check('Rate Browser modal header imports + renders ResidentialTag',
  /import \{ ResidentialTag, residentialTagFacts \} from '\.\/ui\/ResidentialTag'/.test(modal) &&
    /<ResidentialTag facts=\{residentialTagFacts\(order\)\} \/>/.test(modal));

// ── 3. package.json wiring ────────────────────────────────────────────────────
check('package.json wires test:ps-276-resi-comm-tag',
  /test:ps-276-resi-comm-tag/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 resi/comm tag guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 resi/comm tag guard');
