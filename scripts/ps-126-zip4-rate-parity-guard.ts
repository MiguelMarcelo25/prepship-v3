/**
 * PS-126 guard — canonical ShipStation rate paths preserve EXACT ZIP+4 while ZIP5 stays
 * compatible, and direct carriers / fingerprints behave correctly. Pure logic + static
 * source assertions — no DB, no network, no postage, no labels.
 *
 *   npx tsx scripts/ps-126-zip4-rate-parity-guard.ts
 */
import { readFileSync } from 'node:fs';
import { normalizeShippingPostalCode } from '../src/services/shipping-workflow/postal-code';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// 1. Helper normalization (US ZIP5, ZIP+4 hyphen, ZIP+4 digits, blank, non-US)
{
  const hyphen = normalizeShippingPostalCode('11364-2081', 'US');
  check('ZIP+4 hyphen -> exact', hyphen.exact, '11364-2081');
  check('ZIP+4 hyphen -> zip5', hyphen.zip5, '11364');
  const digits = normalizeShippingPostalCode('113642081', 'US');
  check('ZIP+4 digits -> exact', digits.exact, '11364-2081');
  check('ZIP+4 digits -> zip5', digits.zip5, '11364');
  const z5 = normalizeShippingPostalCode('11364', 'US');
  check('ZIP5 -> exact', z5.exact, '11364');
  check('ZIP5 -> zip5', z5.zip5, '11364');
  const blank = normalizeShippingPostalCode('', 'US');
  check('blank -> exact null', blank.exact, null);
  check('blank -> zip5 null', blank.zip5, null);
  const intl = normalizeShippingPostalCode('k1a 0b1', 'CA');
  check('non-US not truncated to 5', intl.exact, 'K1A 0B1');
  check('non-US zip5 == exact', intl.zip5, 'K1A 0B1');
}

// 2. Fingerprint distinguishes ZIP+4 from ZIP5, and ZIP5 is unchanged (no churn)
{
  const base = { version: 'v1', shipDateBucket: '2026-06-09', weightOz: 32, toCountry: 'US' };
  const fp5 = buildShippingRateRequestFingerprint({ ...base, toZip: '11364' });
  const fp9 = buildShippingRateRequestFingerprint({ ...base, toZip: '11364-2081' });
  check('ZIP+4 fingerprint differs from ZIP5', fp5 !== fp9, true);
  check('ZIP+4 fingerprint encodes +4', fp9.includes('z=11364-2081'), true);
  check('ZIP5 fingerprint unchanged (no +4)', fp5.includes('z=11364') && !fp5.includes('11364-'), true);
  const fp9digits = buildShippingRateRequestFingerprint({ ...base, toZip: '113642081' });
  check('ZIP+4 hyphen and digit forms match', fp9, fp9digits);
}

// 3. Static source assertions — canonical=exact, direct=zip5, UI no longer truncates
{
  const rates = readFileSync('src/services/rates.ts', 'utf8');
  check('resolveRateInput keeps EXACT canonical postal', /toZip:\s*normalizeShippingPostalCode\(input\.toZip[^)]*\)\.exact/.test(rates), true);
  check('direct carrier sends zip5 compatibility', /toZip:\s*normalizeShippingPostalCode\(input\.toZip[^)]*\)\.zip5/.test(rates), true);
  check('ShipStation estimate sends input.toZip (exact)', /to_postal_code:\s*input\.toZip/.test(rates), true);
  check('resolveRateInput no longer truncates with normalizeZip(input.toZip)', /toZip:\s*normalizeZip\(input\.toZip\)\s*,/.test(rates), false);

  const fp = readFileSync('src/services/shipping-workflow/rate-fingerprint.ts', 'utf8');
  check('fingerprint preserves +4 (slice 5..9)', /digits\.slice\(5,\s*9\)/.test(fp), true);

  const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
  check('Rate Browser input no longer maxLength 5', /maxLength=\{5\}/.test(modal), false);
  check('Rate Browser input maxLength 10', /maxLength=\{10\}/.test(modal), true);
  check('Rate Browser sanitizes postal (ZIP+4 aware)', /sanitizePostalInput/.test(modal), true);
  check('Rate Browser browseRates sends exact toPostalCode', /toPostalCode:\s*zip/.test(modal), true);

  // PS-166: normalizeRateZip (PS-126 exact-postal preservation) moved VERBATIM to
  // ./orders/rate-request-normalizers; the rate-request draft key feeds it via
  // (`z=${normalizeRateZip(...)}`). Assert at the normalizer owner + at the draft-key owner.
  const normalizers = readFileSync('web/src/components/Views/orders/rate-request-normalizers.ts', 'utf8');
  check('rate-request normalizer draft-key preserves +4', /digits\.slice\(5,\s*9\)/.test(normalizers), true);
  // PS-317: buildRateRequestDraftKey (which builds the `z=${normalizeRateZip(...)}` key part)
  // moved to ./orders/best-rate/rate-request.ts. Read the new owner and assert the delegation
  // there. TEETH: require the moved file's draft-key body to be present (non-empty + the define)
  // so a missing/renamed function fails LOUD instead of a vacuous pass.
  const rateRequest = readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');
  check('rate-request draft-key delegates to normalizeRateZip (preserves +4)',
    /function buildRateRequestDraftKey\(/.test(rateRequest) &&
      /normalizeRateZip/.test(rateRequest) && /z=\$\{normalizeRateZip\(/.test(rateRequest), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-126 ZIP+4 rate parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-126 ZIP+4 rate parity guard');
