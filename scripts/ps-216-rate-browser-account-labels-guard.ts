/**
 * PS-216 guard — Rate Browser account labels are human, never provider ids.
 *
 * DJ report: the HUGRAB sidebar showed "GREG PAYABILITY 6/17 · se-442006" /
 * "· se-442007" — the duplicate-nickname disambiguator appended
 * carrierId/directCarrierAccountId/shippingProviderId. Operator-facing labels
 * must disambiguate with HUMAN facts ("(USPS)" / "(UPS)") owned by the
 * carriers-for-store read DTO (display_disambiguator ←
 * carrierFamilyDisplayLabel), with a same-shaped FE fallback that can never
 * emit an identifier.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { carrierFamilyDisplayLabel } from '../src/lib/carrier-family-label';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── Behavioral matrix on the pure backend owner ─────────────────────────────
assert.equal(carrierFamilyDisplayLabel('stamps_com'), 'USPS');
assert.equal(carrierFamilyDisplayLabel('usps'), 'USPS');
assert.equal(carrierFamilyDisplayLabel('ups'), 'UPS');
assert.equal(carrierFamilyDisplayLabel('ups_walleted'), 'UPS');
assert.equal(carrierFamilyDisplayLabel('UPS'), 'UPS', 'case-insensitive');
assert.equal(carrierFamilyDisplayLabel('fedex'), 'FedEx');
assert.equal(carrierFamilyDisplayLabel('fedex_walleted'), 'FedEx');
assert.equal(carrierFamilyDisplayLabel('shipp'), 'Shipp');
assert.equal(carrierFamilyDisplayLabel('walmart_shipping'), 'Walmart Shipping');
// Unknown but word-like codes prettify safely.
assert.equal(carrierFamilyDisplayLabel('royal_mail'), 'Royal Mail');
// Anything id-like NEVER becomes a label — show no suffix instead.
assert.equal(carrierFamilyDisplayLabel('442006'), null);
assert.equal(carrierFamilyDisplayLabel('se-442006'), null);
assert.equal(carrierFamilyDisplayLabel('10000025'), null);
assert.equal(carrierFamilyDisplayLabel(''), null);
assert.equal(carrierFamilyDisplayLabel(null), null);
assert.equal(carrierFamilyDisplayLabel(undefined), null);

// ── Source pins ─────────────────────────────────────────────────────────────
const ratesSvc = read('src/services/rates.ts');
const shared = read('web/src/lib/v2-apiClient/shared.ts');
const modal = read('web/src/components/RateBrowserModal.tsx');
const pkg = read('package.json');
const familyModule = read('src/lib/carrier-family-label.ts');

// Backend read DTO owns the safe display fact.
assert.ok(ratesSvc.includes('display_disambiguator: carrierFamilyDisplayLabel(carrier.carrier_code)'),
  'carriers-for-store DTO must stamp the backend-owned display disambiguator');

// The FE normalizer carries the backend-owned field. Direct-account labels and
// their family disambiguator are also minted by the backend rate read model.
assert.ok(shared.includes("displayDisambiguator: c?.display_disambiguator ?? c?.displayDisambiguator ?? null"),
  'normalizeCarrierAccountDto must carry the disambiguator');
assert.ok(ratesSvc.includes('nickname: account.displayIdentity') &&
  ratesSvc.includes('display_disambiguator: carrierFamilyDisplayLabel(provider)'),
  'backend direct-account DTO must use safe display identity and human provider label');

// The sidebar formatter: extract the function block and prove it cannot emit
// an identifier.
const fmtStart = modal.indexOf('function formatSidebarAccountDisplay');
assert.ok(fmtStart > 0, 'formatSidebarAccountDisplay must exist');
const fmtEnd = modal.indexOf('\n  function ', fmtStart + 10);
const fmtBlock = modal.slice(fmtStart, fmtEnd > fmtStart ? fmtEnd : fmtStart + 800);
assert.ok(!fmtBlock.includes('carrierId') &&
  !fmtBlock.includes('directCarrierAccountId') &&
  !fmtBlock.includes('shippingProviderId'),
  'the duplicate-name suffix must not reference ANY id field');
assert.ok(fmtBlock.includes('sidebarAccountDisambiguator(account)'),
  'duplicates must disambiguate via the human-label helper');
assert.ok(/return family \? `\$\{label\} \(\$\{family\}\)` : label/.test(fmtBlock),
  'no human label derivable → NO suffix, never an id');
// The old suffix template is gone from the whole file.
assert.ok(!modal.includes('`${label} · ${suffix}`'),
  'the id-suffix template must stay deleted');
// The helper prefers the backend DTO field and falls back to families only.
assert.ok(modal.includes('toDisplayLabel(account.displayDisambiguator)'),
  'the helper must consume the backend display field first');
assert.ok(modal.includes('SIDEBAR_FAMILY_FALLBACK[code] ?? null'),
  'the FE fallback must be the family map or nothing');

// The pure module stays import-free (guard runs it offline).
assert.ok(!familyModule.includes('import '), 'carrier-family-label must stay zero-import pure');

// npm wiring.
assert.ok(pkg.includes('"test:ps-216-rate-browser-account-labels"'),
  'guard must be wired into package.json');

console.log('PASS ps-216 rate browser account labels guard');
