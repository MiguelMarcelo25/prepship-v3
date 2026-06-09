/**
 * PS-135 — Rate Browser consumes the backend's canonical bestRate (no divergent FE re-rank).
 *
 * The modal used to auto-apply `sort(rateDisplayTotal)[0]` — a parallel client-side selector
 * that can diverge from the backend's authoritative pick. It now consumes the backend bestRate
 * matched WITHIN the eligible set (service-class + blocked rules preserved), falling back to the
 * local cheapest only when the backend winner isn't eligible.
 *
 * Pure/static only — no browser, DB, provider calls, labels, postage, or marketplace notifications.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalRateKey, findCanonicalBestRate } from '../web/src/lib/rate-proof';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── (1) canonicalRateKey: natural key = (account, service); null on partial ──────────────
check('canonicalRateKey keys by shippingProviderId + serviceCode',
  canonicalRateKey({ shippingProviderId: 433542, serviceCode: 'usps_ground_advantage' }) === '433542|usps_ground_advantage');
check('canonicalRateKey normalizes a numeric-string pid to the same key',
  canonicalRateKey({ shippingProviderId: '433542', serviceCode: 'usps_ground_advantage' }) === '433542|usps_ground_advantage');
check('canonicalRateKey returns null when the account is missing',
  canonicalRateKey({ serviceCode: 'usps_ground_advantage' }) === null);
check('canonicalRateKey returns null when the service is missing',
  canonicalRateKey({ shippingProviderId: 433542 }) === null);
check('canonicalRateKey returns null on a non-object / empty record',
  canonicalRateKey(null) === null && canonicalRateKey({}) === null && canonicalRateKey('x') === null);

// ── (2) findCanonicalBestRate: consume the backend winner from the eligible set ──────────
type Row = { shippingProviderId: number | string; serviceCode: string; amount: number };
const eligible: Row[] = [
  { shippingProviderId: 433542, serviceCode: 'usps_ground_advantage', amount: 7.45 }, // backend winner
  { shippingProviderId: 433543, serviceCode: 'ups_ground', amount: 6.10 },            // cheaper by display total
  { shippingProviderId: 596001, serviceCode: 'usps_priority_mail', amount: 9.20 },
];

const backendBest = { shippingProviderId: 433542, serviceCode: 'usps_ground_advantage', amount: 7.45 };
const matched = findCanonicalBestRate(backendBest, eligible);
check('findCanonicalBestRate returns the row matching the backend winner (NOT the locally cheapest)',
  matched === eligible[0]);
assert.ok(matched);
check('the consumed best is the backend pick even when another eligible row is cheaper by amount',
  matched.shippingProviderId === 433542 && matched.serviceCode === 'usps_ground_advantage');

// backend winner excluded from the eligible set (e.g. operator service-class filter) → null → caller falls back
const groundOnly: Row[] = eligible.filter((r) => r.serviceCode === 'ups_ground');
check('returns null when the backend winner is NOT in the eligible set (service-class narrowed it out)',
  findCanonicalBestRate(backendBest, groundOnly) === null);

// no backend best returned → null → caller falls back to the local cheapest
check('returns null when no backend best was returned (caller falls back to local pick)',
  findCanonicalBestRate(null, eligible) === null && findCanonicalBestRate(undefined, eligible) === null);

// string-pid backend best still matches a numeric-pid row (translateRateToV2Shape vs row drift)
check('matches across numeric/string pid representations',
  findCanonicalBestRate({ shippingProviderId: '433542', serviceCode: 'usps_ground_advantage' }, eligible) === eligible[0]);

// empty candidate set → null (no throw)
check('empty candidate set returns null safely', findCanonicalBestRate(backendBest, []) === null);

// ── (3) The modal actually consumes the canonical winner (no silent re-rank regression) ──
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('RateBrowserModal imports findCanonicalBestRate from the canonical lib',
  /import \{ findCanonicalBestRate \} from '\.\.\/lib\/rate-proof'/.test(modal));
check('RateBrowserModal captures the backend bestRate from the browse response',
  /canonicalBackendBest = \(browseResult as \{ bestRate\?: unknown \} \| null\)\?\.bestRate \?\? null/.test(modal));
check('auto-apply consumes the backend winner first, then falls back to the local cheapest',
  /const canonicalBest = findCanonicalBestRate\(canonicalBackendBest, available\)/.test(modal) &&
    /const best =\s*canonicalBest \?\?\s*\[\.\.\.available\]\.sort\(\(a, b\) => rateDisplayTotal\(a, markups\) - rateDisplayTotal\(b, markups\)\)\[0\]/.test(modal));
check('the eligible set still applies the service-class filter + blocked rules before selection',
  /const available = filterBySvcClass\(ratesToRank\)\.filter\(\(r\) => !isBlockedRate\(r, order, currentRateShippingOptions\)\)/.test(modal));

if (failures > 0) {
  console.error(`\nFAIL PS-135 rate-browser re-rank guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-135 rate-browser re-rank guard');
