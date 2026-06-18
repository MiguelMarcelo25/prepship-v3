/**
 * PS-274 guard — Shipp insurance CERTAINTY is honest (identity FIRST, carrier family second).
 *
 * The #1502 dishonesty class: a Shipp-BROKERED UPS rate carries a declared value (customsValue)
 * but no final-label proof the carrier applied declared value at purchase. Stamping it
 * 'carrier_declared_value' / "explicitly included" asserts coverage we have not proven. This guard
 * pins the canonical resolver AND the surfaces that consume it:
 *   (1) resolveInsuranceCertainty: Shipp brokered + declared value -> requested_application_uncertain
 *       (NEVER explicitly_included); verified-direct UPS -> explicitly_included; no declared -> not_included.
 *   (2) the Shipp connector stamps the certainty onto each rate (rates path / Rate Browser consume it).
 *   (3) persistCreatedLabel NEVER records carrier_declared_value for a brokered Shipp label and
 *       persists the certainty state into selected_rate_json.
 *   (4) the Rate Browser has a render-ready certainty-tag helper (display-only, additive).
 *
 *   npx tsx scripts/ps-274-shipp-insurance-certainty-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  resolveInsuranceCertainty,
  isShippBrokered,
} from '../src/services/shipping-workflow/insurance-certainty';
import {
  buildShippingRateRequestFingerprint,
  selectedRateAuthorityKey,
  validateExactSelectedRate,
  type ShippingRateRequestFingerprintInput,
} from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── resolveInsuranceCertainty: identity FIRST ─────────────────────────────────
// (1) Shipp-brokered UPS with a declared value but no verified-direct proof -> UNCERTAIN.
const shippUps = resolveInsuranceCertainty({
  provider: 'shipp',
  serviceCode: 'shipp_ups_ground',
  insuredValue: 100,
  isDirectVerifiedAccount: false,
});
check('Shipp brokered + declared value -> requested_application_uncertain',
  shippUps.certainty === 'requested_application_uncertain');
check('Shipp brokered + declared value is NEVER explicitly_included',
  shippUps.certainty !== 'explicitly_included');
check('Shipp brokered certainty proofSource names the brokered path',
  shippUps.proofSource === 'shipp_brokered_declared_value');
check('Shipp uncertain tag tone is caution (not positive)', shippUps.tagTone === 'caution');

// Identity wins even when isDirectVerifiedAccount is (wrongly) passed true — a `shipp_` service
// or 'shipp' provider can never be treated as a direct verified carrier.
check('Shipp identity beats a stray isDirectVerifiedAccount=true (service prefix)',
  resolveInsuranceCertainty({ provider: 'ups', serviceCode: 'shipp_ups_ground', insuredValue: 100, isDirectVerifiedAccount: true }).certainty
    === 'requested_application_uncertain');
check('Shipp identity beats a stray isDirectVerifiedAccount=true (provider shipp)',
  resolveInsuranceCertainty({ provider: 'shipp', serviceCode: 'ups_ground', insuredValue: 100, isDirectVerifiedAccount: true }).certainty
    === 'requested_application_uncertain');

// (2) DIRECT verified UPS with a declared value -> explicitly_included (the ONLY carrier_declared_value path).
const directUps = resolveInsuranceCertainty({
  provider: 'ups',
  serviceCode: 'ups_ground',
  insuredValue: 100,
  isDirectVerifiedAccount: true,
});
check('verified direct UPS + declared value -> explicitly_included', directUps.certainty === 'explicitly_included');
check('verified direct UPS proofSource names carrier declared value',
  directUps.proofSource === 'direct_verified_carrier_declared_value');

// (3) No declared value -> not_included (insured-but-zero / uninsured).
check('no declared value -> not_included',
  resolveInsuranceCertainty({ provider: 'ups', serviceCode: 'ups_ground', insuredValue: 0, isDirectVerifiedAccount: true }).certainty
    === 'not_included');
check('negative / non-finite declared value -> not_included',
  resolveInsuranceCertainty({ provider: 'shipp', insuredValue: -5 }).certainty === 'not_included'
  && resolveInsuranceCertainty({ provider: 'shipp', insuredValue: Number.NaN }).certainty === 'not_included');

// A non-Shipp, non-verified declared value is honest 'proof_unavailable' (never a false include).
check('declared value on a non-Shipp non-verified account -> proof_unavailable',
  resolveInsuranceCertainty({ provider: 'ups', serviceCode: 'ups_ground', insuredValue: 100, isDirectVerifiedAccount: false }).certainty
    === 'proof_unavailable');

// Unsupported provenance -> unsupported (never falsely included).
check('unsupported provenance -> unsupported',
  resolveInsuranceCertainty({ provider: 'walmart_shipping', insuredValue: 100, provenance: 'unsupported' }).certainty === 'unsupported');

// isShippBrokered identity detection (provider / account / `shipp_` service).
check('isShippBrokered: provider shipp', isShippBrokered({ provider: 'shipp' }));
check('isShippBrokered: shipp_ service code', isShippBrokered({ serviceCode: 'shipp_fedex_home_delivery' }));
check('isShippBrokered: "Shipp" account identity', isShippBrokered({ accountIdentity: 'Shipp' }));
check('isShippBrokered: a direct UPS account is NOT brokered',
  !isShippBrokered({ provider: 'ups', serviceCode: 'ups_ground', accountIdentity: 'ORION' }));

// ── shipp.ts: the connector stamps the certainty onto each rate ───────────────
const shipp = read('src/connectors/carrier/shipp.ts');
check('shipp.ts imports resolveInsuranceCertainty', shipp.includes('resolveInsuranceCertainty'));
check('shipp.ts attaches insuranceCertainty onto the mapped rate',
  /insuranceCertainty,?\s*\n/.test(shipp) && shipp.includes('insuranceCertainty'));
check('shipp.ts pins isDirectVerifiedAccount: false (Shipp is never a verified direct carrier)',
  /isDirectVerifiedAccount:\s*false/.test(shipp));

// ── labels.ts persistCreatedLabel: brokered Shipp NEVER carrier_declared_value ─
const labels = read('src/services/labels.ts');
check('labels.ts imports the certainty resolver + isShippBrokered',
  labels.includes('resolveInsuranceCertainty') && labels.includes('isShippBrokered'));
check('persist guards carrier_declared_value behind !shippBrokered',
  /insuranceProvider === 'carrier' && !shippBrokered\s*\n?\s*\?\s*'carrier_declared_value'/.test(labels)
  || /!shippBrokered[\s\S]{0,40}'carrier_declared_value'/.test(labels));
check('persist computes shippBrokered via isShippBrokered', /const shippBrokered = isShippBrokered\(/.test(labels));
check('persist records insuranceCertainty into selected_rate_json',
  /insuranceCertainty: insuranceCertainty\.certainty/.test(labels));
check('the override is cited in labels.ts (PS-274 / 2026-06-17)',
  /Per user override unlock shipped data on 2026-06-17[\s\S]{0,120}PS-274/.test(labels)
  || /PS-274[\s\S]{0,120}unlock shipped data on 2026-06-17/.test(labels));

// ── RateBrowserModal.tsx: render-ready certainty tag (display-only, additive) ──
const modal = read('web/src/components/RateBrowserModal.tsx');
check('RateBrowserModal exports formatInsuranceCertaintyTag',
  /export function formatInsuranceCertaintyTag\(/.test(modal));
check('RateBrowserModal carries insuranceCertainty through the rate row/applied DTO',
  modal.includes('insuranceCertainty'));
check('certainty tag returns null when the backend stamped no certainty (additive)',
  /if \(!certainty\) return null;/.test(modal));

// ── RateRowItem.tsx: the certainty tag is actually RENDERED in the rate row ─────
// The helper existing is not enough — the prior slice exported it but never
// rendered it. Pin that the row consumes the backend-stamped field and tones it.
const rateRow = read('web/src/components/RateRowItem.tsx');
check('RateRowItem imports the certainty tag helpers',
  rateRow.includes('formatInsuranceCertaintyTag') && rateRow.includes('rbInsuranceCertaintyTone'));
check('RateRowItem renders the certainty tag from the row DTO (formatInsuranceCertaintyTag(r.insuranceCertainty))',
  /formatInsuranceCertaintyTag\(r\.insuranceCertainty\)/.test(rateRow));
check('RateRowItem tones the tag via rbInsuranceCertaintyTone(tag.tone)',
  /rbInsuranceCertaintyTone\(tag\.tone\)/.test(rateRow));

// ── card req 5: certainty rides the rate FINGERPRINT + selected-rate proof ─────
// An uncertain Shipp verdict must survive save/purchase: the certainty state is
// woven into the request fingerprint AND the selected-rate authority key so an
// uncertain rate can never round-trip as proven-insured. Additive/optional —
// absent certainty leaves the fingerprint and authority key byte-identical.
const baseFp: ShippingRateRequestFingerprintInput = {
  version: 'ps-274',
  shipDateBucket: '2026-06-17',
  weightOz: 16,
  toZip: '11364',
  toCountry: 'US',
};
const fpNoCertainty = buildShippingRateRequestFingerprint(baseFp);
const fpUncertain = buildShippingRateRequestFingerprint({ ...baseFp, insuranceCertainty: 'requested_application_uncertain' });
const fpIncluded = buildShippingRateRequestFingerprint({ ...baseFp, insuranceCertainty: 'explicitly_included' });

check('fingerprint omits the certainty segment when none is supplied (byte-identical for legacy callers)',
  fpNoCertainty === buildShippingRateRequestFingerprint({ ...baseFp }) && !fpNoCertainty.includes('ic='));
check('an uncertain Shipp certainty changes the request fingerprint',
  fpUncertain !== fpNoCertainty && fpUncertain.includes('ic=requested_application_uncertain'));
check('uncertain vs explicitly_included produce DIFFERENT fingerprints (cannot collide)',
  fpUncertain !== fpIncluded);

// The selected-rate authority key binds the stamped certainty state, so a rate
// quoted UNCERTAIN cannot masquerade as an explicitly_included eligible rate.
const baseRate = {
  shippingProviderId: 'se-565377',
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
  packageCode: 'package',
  shipmentCost: 12.34,
  otherCost: 0,
};
const uncertainRate = { ...baseRate, insuranceCertainty: { certainty: 'requested_application_uncertain' } };
const includedRate = { ...baseRate, insuranceCertainty: { certainty: 'explicitly_included' } };
check('authority key omits certainty when the rate carries none (byte-identical)',
  selectedRateAuthorityKey(baseRate) === selectedRateAuthorityKey({ ...baseRate }) && !selectedRateAuthorityKey(baseRate).includes('ic='));
check('authority key changes when the rate is stamped uncertain',
  selectedRateAuthorityKey(uncertainRate) !== selectedRateAuthorityKey(baseRate)
  && selectedRateAuthorityKey(uncertainRate).includes('requested_application_uncertain'));
check('an uncertain rate and an explicitly_included rate have DIFFERENT authority keys',
  selectedRateAuthorityKey(uncertainRate) !== selectedRateAuthorityKey(includedRate));

// THE GUARD: an uncertain Shipp rate cannot round-trip as proven-insured. The
// eligible set quoted it uncertain; a proof claiming explicitly_included is
// rejected (not_in_current_eligible_rates) BEFORE any postage spend.
const fp = buildShippingRateRequestFingerprint({ ...baseFp, insuranceCertainty: 'requested_application_uncertain' });
const honestUncertain = validateExactSelectedRate({
  currentRequestFingerprint: fp,
  selectedRate: { ...uncertainRate, requestFingerprint: fp },
  eligibleRates: [uncertainRate],
});
check('an honestly-uncertain Shipp rate still validates against its uncertain eligible set', honestUncertain.ok);
const upgradedProof = validateExactSelectedRate({
  currentRequestFingerprint: fp,
  selectedRate: { ...includedRate, requestFingerprint: fp },
  eligibleRates: [uncertainRate],
});
check('an uncertain Shipp rate CANNOT round-trip as proven-insured (proof upgraded to explicitly_included is rejected)',
  !upgradedProof.ok && upgradedProof.reason === 'not_in_current_eligible_rates');

if (failures > 0) {
  console.error(`\nFAIL PS-274 Shipp insurance-certainty guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-274 Shipp insurance-certainty guard');
