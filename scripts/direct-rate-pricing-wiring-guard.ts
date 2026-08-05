/**
 * Direct-rate pricing WIRING guard.
 *
 * Why this exists (found 2026-08-05 during the ungated-guard sweep):
 *
 * Deleting `applyMarkups` from the direct-rate pricing path — which undercharges the
 * customer on every direct-carrier rate — passed the ENTIRE 393-entry sot-guard-pack.
 * So did forcing the EasyPost insurance premium to 0, which gives insurance away free.
 *
 * The rules themselves were well covered and still are:
 *   - ps-307-direct-rate-markup-behavior drives the REAL applyMarkups as a unit and
 *     proves the marked charge and the ranking basis are right;
 *   - ps-177-row-money-display proves rates.ts applyMarkups delegates to the canonical
 *     markup math rather than re-implementing it;
 *   - ps-261-easypost-insurance-cost proves the premium is applied only to EasyPost,
 *     only when insured, and overwrites the direct rate's insurance_amount.
 *
 * What nothing pinned is the CALL SITE: that applyDirectRatePricing actually invokes
 * them. A unit-tested function whose only caller can be deleted silently is not
 * protected. This guard pins the wiring and nothing else — the math stays owned by the
 * guards above, so this one should not need to change when a rate or premium changes.
 *
 * Offline/static: no DB, no network, no provider calls, no postage.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// Normalize CRLF: this repo has files checked out both ways, and any needle spanning a
// line break silently fails to match otherwise.
const rates = readFileSync('src/services/rates.ts', 'utf8').replace(/\r\n/g, '\n');

const PRICING_FN = 'function applyDirectRatePricing(';
const start = rates.indexOf(PRICING_FN);
if (start < 0) {
  console.error(`FAIL anchor is gone from src/services/rates.ts: ${PRICING_FN}`);
  console.error('  (a missing anchor is a broken guard, not a smaller guard — fix the anchor)');
  process.exit(1);
}
// Bound the body at the next top-level declaration rather than a fixed character count,
// so this cannot silently degrade into an arbitrary window if the function grows.
const rest = rates.slice(start + PRICING_FN.length);
const endRel = rest.search(/\n(?:export )?(?:async )?function \w+\(/);
const body = endRel > 0 ? rest.slice(0, endRel) : rest;

check('direct-rate pricing applies carrier markups to the incoming rates',
  /applyMarkups\(rates, directMarkups\)/.test(body));

check('the marked-up rates are what the function goes on to use',
  /const markedUp = applyMarkups\(/.test(body) && /\bmarkedUp\b/.test(body.replace(/const markedUp = applyMarkups\([^)]*\);/, '')));

check('the EasyPost premium comes from the scheduled-premium owner, not a literal',
  /easyPostScheduledPremium\(/.test(body));

check('the premium is written onto the rate as insurance_amount',
  /insurance_amount: \{ amount: easyPostPremium/.test(body));

// Both callers must price through this one function. If a second path builds direct
// rates without it, markups and premiums silently stop applying on that path.
const callSites = (rates.match(/applyDirectRatePricing\(/g) ?? []).length;
check('every direct-rate path prices through applyDirectRatePricing (definition + both callers)',
  callSites >= 3);

check('the cached-rate path prices through it too (a cache hit must not skip markups)',
  /applyDirectRatePricing\(cachedRates, directMarkups/.test(rates));

if (failures > 0) {
  console.error(`\nFAIL direct-rate pricing wiring guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS direct-rate pricing wiring guard');
