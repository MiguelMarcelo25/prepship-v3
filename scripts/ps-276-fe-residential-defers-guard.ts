/**
 * PS-276 (slice 3) guard — the FE rate path defers to the backend residential verdict.
 *
 * residentialForRate feeds buildRateRequestDraftKey's r= bit (OrdersView), which mirrors the
 * backend requestFingerprint. So the FE must PREFER the backend's resolved verdict
 * (recipient.residentialClassification, slice 4) over its own derivation — otherwise, once
 * slice 2b's resolver flips an address to commercial, the FE draft key diverges from the
 * backend and the BEST RATE column churns / mis-keys. This pins the prefer-with-fallback shape:
 * read the backend verdict first; keep the legacy local derivation ONLY for deploy-skew.
 *
 *   npx tsx scripts/ps-276-fe-residential-defers-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const start = ordersView.indexOf('function residentialForRate(');
const end = ordersView.indexOf('\n  }', start);
const body = start >= 0 ? ordersView.slice(start, end) : '';

check('residentialForRate exists', start >= 0);
check('reads the backend verdict (top-level OR canonicalOrder.recipient.residentialClassification)',
  /order\?\.residentialClassification \?\? order\?\.canonicalOrder\?\.recipient\?\.residentialClassification/.test(body));
check('backend commercial -> false (defer to backend, not re-derive)',
  /if \(backendClass === 'commercial'\) return false/.test(body));
check('backend residential -> true',
  /if \(backendClass === 'residential'\) return true/.test(body));
// PS-278: the FE no longer re-derives residential from raw provider fields — it FORWARDS the backend
// verdict only. This is the stronger invariant that supersedes slice 3's prefer-with-fallback shape:
// the backend now publishes the money-safe verdict on every order DTO (ps-276-dto-residential-verdict),
// so any raw-field derivation in the FE would be a second owner of a money-path decision.
check('the FE no longer re-derives residential from the raw ShipStation source flag',
  !/order\?\.sourceResidential|sourceResidential/.test(body));
check('the FE no longer re-derives residential from raw shipTo', !/raw\?\.shipTo|rawShipTo/.test(body));
check('verdict absent -> money-safe residential default (return true)', /return true\s*$/.test(body.trimEnd()));

check('package.json wires test:ps-276-fe-residential-defers',
  /test:ps-276-fe-residential-defers/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 FE residential defers guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 FE residential defers guard');
