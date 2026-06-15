/**
 * PS-264 guard — cached rates run the same insurance enrichment as live quotes.
 *
 * The live path enriches insured rates (enrichRatesWithInsuranceCost) AFTER
 * eligibility and BEFORE best-rate selection, so rateTotal/pickBestRate/markups
 * all see the insured total. The cached branch did NOT — a cached HUGRAB/insured
 * rate carried a stale/zero insurance_amount and mis-picked by the premium. The
 * cached branch now runs the SAME enrichment with the SAME ctx + per-candidate
 * provider hook. This guard pins both call sites + the cached binding.
 *
 *   npx tsx scripts/ps-264-cached-rate-insurance-enrich-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
const rates = (() => { try { return readFileSync('src/services/rates.ts', 'utf8'); } catch { return ''; } })();
const pkg = (() => { try { return readFileSync('package.json', 'utf8'); } catch { return ''; } })();

// Two enrichment call sites now: the live path AND the cached branch.
const callSites = rates.split('enrichRatesWithInsuranceCost(').length - 1;
check('enrichRatesWithInsuranceCost is called on BOTH the live and cached paths (>=2)', callSites >= 2);

// The cached branch binds the enriched result back to cachedRaw.
check('cached branch binds enriched result to cachedRaw',
  /cachedRaw = enrichRatesWithInsuranceCost\(/.test(rates) && /\)\.resolved;/.test(rates));

// Same ctx as the live path (insuranceProvider/insuredValue/toCountry from input).
check('cached enrich uses the same ctx as live (input.insured*/toCountry)',
  /insuranceProvider: input\.insuranceProvider/.test(rates)
  && /insuredValue: input\.insuredValue/.test(rates)
  && /toCountry: input\.toCountry/.test(rates));

// Same per-candidate provider hook (PS-170 carrier-declared-value gate).
check('cached enrich uses the per-candidate effectiveInsuranceProviderForAccount hook',
  rates.split('effectiveInsuranceProviderForAccount({').length - 1 >= 2);

check('package.json wires test:ps-264-cached-rate-insurance-enrich',
  /test:ps-264-cached-rate-insurance-enrich/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-264 cached-rate insurance-enrich guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-264 cached-rate insurance-enrich guard');
