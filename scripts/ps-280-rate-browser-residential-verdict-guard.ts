/**
 * PS-280 — the Rate Browser shows the BACKEND residential/commercial verdict (never "always
 * residential") and forwards the SAME backend-verdict rule as OrdersView into the browse request.
 *
 * BEHAVIORAL: imports + RUNS the shared residentialForRate rule on the 3 required cases (commercial ->
 * residential:false, residential -> true, missing -> residential-safe true) — fails if the forward
 * rule were broken. STATIC: RateBrowserModal renders the verdict (shared ResidentialTag), has no
 * "(always)"/hardcoded "Residential Address" copy, forwards residentialForRate(order) into browse, and
 * OrdersView delegates to the SAME shared rule (one FE owner, no drift).
 *
 *   npx tsx scripts/ps-280-rate-browser-residential-verdict-guard.ts
 */
import { readFileSync } from 'node:fs';
import { residentialForRate } from '../web/src/lib/residential-for-rate';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: the shared FE-forward rule (the 3 required PS-280 cases + provenance + forward-only) ──
check('commercial backend verdict -> residential:false (commercial quote request)',
  residentialForRate({ residentialClassification: 'commercial' }) === false);
check('residential backend verdict -> residential:true',
  residentialForRate({ residentialClassification: 'residential' }) === true);
check('missing verdict -> residential-safe true (no under-quote)',
  residentialForRate({}) === true && residentialForRate(null) === true && residentialForRate(undefined) === true);
check('reads canonicalOrder.recipient verdict when the top-level field is absent',
  residentialForRate({ canonicalOrder: { recipient: { residentialClassification: 'commercial' } } }) === false);
check('forward-only: a legacy-boolean-only order (no backend verdict) stays residential-safe',
  residentialForRate({ residential: false, sourceResidential: false } as any) === true);

// ── static: RateBrowserModal renders the verdict + forwards the shared rule ──
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('no "(always)" residential copy', !/\(always\)/.test(modal));
check('no hardcoded "Residential Address" label', !/Residential Address/.test(modal));
check('imports the shared residentialForRate rule',
  /import \{ residentialForRate \} from '\.\.\/lib\/residential-for-rate'/.test(modal));
check('quote forwarding uses the shared rule (not legacy re-derivation)',
  /const residentialForQuote = residentialForRate\(order\)/.test(modal));
check('browse request forwards residentialForQuote',
  /residential:\s*residentialForQuote/.test(modal));
check('no hardcoded residential: true in any browse request',
  !/residential:\s*true\b/.test(modal));
check('renders the backend verdict via the shared ResidentialTag (Ship To area)',
  /residentialTagFacts\(order\)/.test(modal) && /<ResidentialTag\b/.test(modal));
check('deploy-skew shows a safe fallback label, never "always"',
  /Residential[^<]{0,12}fallback/.test(modal));

// ── single FE owner: OrdersView delegates residentialForRate to the SAME shared rule ──
// PS-317: residentialForRate moved to ./orders/best-rate/rate-request — include it so the delegation pin resolves.
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8') + readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');
check('OrdersView delegates residentialForRate to the shared rule (one owner, no drift)',
  /residentialForRate as residentialForRateRule/.test(ordersView) &&
    /return residentialForRateRule\(order\)/.test(ordersView));

check('package.json wires test:ps-280-rate-browser-residential-verdict',
  /test:ps-280-rate-browser-residential-verdict/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-280 rate-browser residential verdict guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-280 rate-browser residential verdict guard');
