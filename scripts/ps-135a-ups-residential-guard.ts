/**
 * PS-135(a) — UPS direct-carrier residential threading.
 *
 * Static-source guard (the UPS connector makes a live OAuth + Rating/Shipping call before building
 * the body, so it cannot be exercised offline). Pins the invariants that make the residential
 * surcharge correct on BOTH the rate quote and the label charge:
 *   - UPS ResidentialAddressIndicator is PRESENCE-based: emit 'Y' for residential, OMIT entirely for
 *     commercial. There is NO 'N'/false form — a present value (incl. '' or false) wrongly surcharges
 *     a commercial address. So we assert the conditional spread AND the absence of any 'N'/false form.
 *   - Residential is sourced SERVER-SIDE from the PS-127 classifier (rate + label), never the FE — so
 *     the UPS quote, the UPS label, and the ShipStation path all classify identically (quote == bill).
 *
 * Offline / pure: readFileSync only. No DB, no network, no live UPS call, no postage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ups = readFileSync('src/connectors/carrier/ups.ts', 'utf8');
const rates = readFileSync('src/services/rates.ts', 'utf8');
// PS-276 (276.E re-anchor): the label classification + the rate↔label money-safety block live in the
// v4 backend (src/services/labels.ts createLabelV2), NOT the legacy api/carriers/labels.ts that PS-200
// decommissioned. Re-pointed here so the guard verifies the FUNCTIONING path (was failing on the dead file).
const labels = readFileSync('src/services/labels.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── (1) UPS connector emits the presence-based indicator, conditional on residential ──
check('ratesFromUps reads residential from input',
  /const residential = input\.residential === true;/.test(ups));
check('createLabelUps reads residential (top-level OR stamped shipTo.residential)',
  /const residential =\s*input\.residential === true \|\| \(shipTo as \{ residential\?: unknown \} \| null\)\?\.residential === true;/.test(ups));
// Both ShipTo.Address blocks must spread the indicator ONLY when residential, and as 'Y' (presence).
check('UPS emits ResidentialAddressIndicator: \'Y\' conditionally in BOTH rate + label (2 occurrences)',
  (ups.match(/\.\.\.\(residential \? \{ ResidentialAddressIndicator: 'Y' \} : \{\}\)/g)?.length ?? 0) === 2);

// ── (2) COMMERCIAL = OMIT. No 'N'/false form anywhere (a present value over-charges). ──
check('UPS never sends a commercial ResidentialAddressIndicator value (no \'N\' / false / empty form)',
  !/ResidentialAddressIndicator:\s*'N'/.test(ups) &&
  !/ResidentialAddressIndicator:\s*false/.test(ups) &&
  !/ResidentialAddressIndicator:\s*''/.test(ups) &&
  !/ResidentialAddressIndicator:\s*'no'/i.test(ups));

// ── (3) Rate path: direct-carrier residential is the canonical classifier, NOT the raw FE value ──
check('rates.ts defines the single canonical classifyRateInputResidential helper',
  /function classifyRateInputResidential\(input: RateInput\)/.test(rates));
check('resolveRateInput (ShipStation path) uses the shared helper',
  /const residentialClassification = classifyRateInputResidential\(\{\s*\.\.\.input,/.test(rates));
check('getDirectCarrierRatesForRateInput resolves residential via the helper (not raw input.residential)',
  /const resolvedResidential = residentialForShipping\(classifyRateInputResidential\(input\)\);/.test(rates) &&
  /residential: resolvedResidential,/.test(rates));

// ── (4) Label path (v4 src/services/labels.ts createLabelV2): server-side classification stamped on
//        the shipTo the carrier sees + the rate↔label money-safety block (billing-critical). ──
check('labels.ts classifies server-side via the PS-127 classifier (classifyShippingAddress + residentialForShipping)',
  /classifyShippingAddress\(\{/.test(labels) && /residentialForShipping\b/.test(labels));
check('label residential is the classifier verdict, stamped onto the shipTo the carrier sees',
  /const labelResidential = residentialForShipping\(labelClassification\);/.test(labels) &&
  /shipTo\.residential = labelResidential;/.test(labels));
check('label manual override sourced from order_overrides.residential (not dropped)',
  /manualOverrideResidential:\s*[\s\S]{0,80}?typeof overrides\?\.residential === 'boolean' \? overrides\.residential : null/.test(labels));
check('label source flag sourced from the raw ShipStation shipTo.residential',
  /sourceResidential:\s*[\s\S]{0,90}?typeof rawShipTo\.residential === 'boolean'/.test(labels));
check('rate↔label parity BLOCKS a commercial-quoted label vs a trusted-residential classification (money-safety net)',
  /labelTrusted && quotedResidential !== null && quotedResidential !== labelResidential/.test(labels) &&
  /RATE_LABEL_RESIDENTIAL_MISMATCH/.test(labels));

if (failures > 0) {
  console.error(`\nFAIL PS-135(a) UPS residential guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-135(a) UPS residential guard');
