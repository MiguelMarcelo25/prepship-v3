/**
 * PS-254 (Card 9) guard — perimeter hardening:
 *   (a) server-rendered mock labels HTML-escape attacker-influenced address fields (XSS),
 *   (b) order-sync's sql.raw store-id update pins its integer invariant (SQLi-by-construction),
 *   (c) the global onError hides 5xx detail (only safe 4xx messages surface).
 *
 * BEHAVIORAL: runs escapeHtml. STATIC: the three sites enforce the above.
 * NOTE: the bundle/log secret-scan (4th Card-9 item) is a separate build-dependent slice — not here.
 *
 *   npx tsx scripts/ps-254-perimeter-hardening-guard.ts
 */
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../src/lib/escape-html';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── (a) escapeHtml behaviour ─────────────────────────────────────────────────────────────────
check('escapes a <script> payload', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
check('escapes & " \' < >', escapeHtml(`a&b"c'd<e>f`) === 'a&amp;b&quot;c&#39;d&lt;e&gt;f');
check('null/undefined -> empty string', escapeHtml(null) === '' && escapeHtml(undefined) === '');
check('plain text unchanged', escapeHtml('123 Main St, Apt 4') === '123 Main St, Apt 4');

// ── (a) the mock label escapes recipient/sender fields ───────────────────────────────────────
const mock = readFileSync('src/services/mock-label-generator.ts', 'utf8');
check('mock label imports escapeHtml', /import \{ escapeHtml \} from '\.\.\/lib\/escape-html\.js'/.test(mock));
for (const field of [
  'escapeHtml(data.shipTo.name)',
  'escapeHtml(data.shipTo.street1)',
  'escapeHtml(data.shipFrom.name)',
  'escapeHtml(data.serviceLabel)',
]) {
  check(`mock label escapes ${field}`, mock.includes(field));
}
// Scope the "no unescaped interpolation" check to the HTML function only — the separate
// PDF path uses pdf-lib page.drawText (plain text, NOT an HTML context; escaping there is wrong).
const htmlFn = mock.slice(
  mock.indexOf('export function generateMockLabelHtml'),
  mock.indexOf('export function generateFakeTrackingNumber'),
);
check('mock label HTML leaves NO unescaped shipTo/shipFrom interpolation',
  htmlFn.length > 0 && !/\$\{data\.ship(To|From)\.(name|street1|city|state|postalCode)\}/.test(htmlFn));

// ── (b) order-sync pins the integer invariant before the sql.raw splice ──────────────────────
const sync = readFileSync('src/services/order-sync.ts', 'utf8');
check('order-sync pins Number.isInteger before inlining store ids/client id',
  /if \(!Number\.isInteger\(cid\) \|\| !storeIds\.every\(Number\.isInteger\)\) continue;/.test(sync));

// ── (c) onError hides 5xx detail ─────────────────────────────────────────────────────────────
const main = readFileSync('src/main.ts', 'utf8');
check('onError returns generic message for non-4xx (only safe 4xx surfaces)',
  /isSafeClientError && err\.message \? err\.message : 'Internal server error'/.test(main));

check('package.json wires test:ps-254-perimeter-hardening',
  /test:ps-254-perimeter-hardening/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-254 perimeter hardening guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-254 perimeter hardening guard');
