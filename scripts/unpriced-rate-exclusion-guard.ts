/**
 * Unpriced-rate exclusion guard (root cause of "Rate unavailable" / "N/A Recommended").
 *
 * THE BUG (2026-06-16, order 1338387 / KF Goods): every ShipStation-brokered UPS
 * account (ROCEL/GG6381/ORI/GREG) came back with NO usable amount, so each rate's
 * shipping_amount.amount was coerced to 0 (`?? 0`). The cheapest-pick sorts ascending,
 * so a $0/unpriced rate sorted FIRST and was selected as the order's best rate —
 * showing up as the green "Recommended" row rendered "N/A" in the Rate Browser, and as
 * "Rate unavailable · Retry" in the Orders list (the $0 best failed every positive-amount
 * display gate). The direct-carrier path already dropped amount<=0 rates (toDirectRate),
 * but the ShipStation path had no such guard anywhere before selection/persistence/display.
 *
 * THE FIX (architecture-first — at the canonical owners, not the FE):
 *  - rates-combined.ts: the cheapest-pick excludes non-finite/non-positive totals
 *    (exported `isPricedRate` is the single definition of "a rate that can be charged").
 *  - rates.ts fetchLiveRatesWithDiagnostics: drop unpriced ShipStation rates at the
 *    source lift so they never reach the combined set, the cache, the pick, or display;
 *    a carrier that returned only unpriced rates reports 'empty' (→ "unavailable").
 *  - order-rate-dto.ts normalizeListBestRate: a best rate with no positive amount is
 *    rejected regardless of carrier/service presence.
 *
 *   npx tsx scripts/unpriced-rate-exclusion-guard.ts
 */
import { readFileSync } from 'node:fs';
import { combineCarrierUniverses, rateTotal, isPricedRate } from '../src/services/rates-combined';
import { normalizeListBestRate } from '../src/services/order-rate-dto';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── pure helper: what counts as a chargeable (priced) rate ────────────────────
{
  check('isPricedRate: a real $8.45 rate is priced',
    isPricedRate({ shipping_amount: { amount: 8.45 } }) === true);
  check('isPricedRate: a $0 rate is NOT priced',
    isPricedRate({ shipping_amount: { amount: 0 } }) === false);
  check('isPricedRate: an absent-amount rate is NOT priced',
    isPricedRate({ service_code: 'ups_ground' }) === false);
  check('isPricedRate: a NaN/garbage amount is NOT priced',
    isPricedRate({ shipping_amount: { amount: Number.NaN } }) === false);
  check('isPricedRate: a negative amount is NOT priced',
    isPricedRate({ shipping_amount: { amount: -3 } }) === false);
}

// ── the production fixture (order 1338387) ────────────────────────────────────
// Four ShipStation UPS accounts return amountless rows; a priced direct UPS SurePost
// ($8.45) and a priced USPS ($9.35) exist. The cheapest priced rate must win — an
// unpriced $0 rate must NEVER be selected as best.
const SS_UPS_UNPRICED = {
  carrier_id: 'se-461890', // ROCEL C81F70
  service_code: 'ups_ground',
  shipping_amount: { amount: 0 },
  other_amount: { amount: 0 },
  requestFingerprint: 'fp-ss',
};
const SS_UPS_ABSENT = {
  carrier_id: 'se-565317', // GG6381 — no shipping_amount at all
  service_code: 'ups_ground',
  requestFingerprint: 'fp-ss',
};
const DIRECT_SUREPOST_845 = {
  carrier_id: 'se-10000031', // Shipp Carrier (direct)
  service_code: 'ups_surepost',
  shipping_amount: { amount: 8.45 },
  other_amount: { amount: 0 },
  requestFingerprint: 'fp-direct',
};
const SS_USPS_935 = {
  carrier_id: 'se-442007', // GREG PAYABILITY USPS Ground Advantage
  service_code: 'usps_ground_advantage',
  shipping_amount: { amount: 9.35 },
  other_amount: { amount: 0 },
  requestFingerprint: 'fp-ss',
};
const BASE_COMBINE = {
  ssCacheKey: 'ss-key',
  ssCached: false,
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map<string, string>(),
  accountCarrierIds: ['se-461890', 'se-565317', 'se-442007'],
  isCachedOnlyLookup: false,
};

{
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [SS_UPS_UNPRICED, SS_UPS_ABSENT, SS_USPS_935],
    ssDiagnostics: [
      { carrierId: 'se-461890', status: 'ok', rateCount: 1 },
      { carrierId: 'se-565317', status: 'ok', rateCount: 1 },
      { carrierId: 'se-442007', status: 'ok', rateCount: 1 },
    ],
    directRates: [DIRECT_SUREPOST_845],
    directDiagnostics: [{ carrierId: 'se-10000031', status: 'ok', rateCount: 1 }],
  });
  check('cheapest is the priced $8.45 SurePost — NOT the $0 UPS rate',
    combined.cheapest?.carrier_id === 'se-10000031' && rateTotal(combined.cheapest!) === 8.45,
    `got ${combined.cheapest?.carrier_id} @ ${combined.cheapest ? rateTotal(combined.cheapest) : 'n/a'}`);
  check('the cheapest pick is a priced rate',
    combined.cheapest != null && isPricedRate(combined.cheapest));
}

{
  // When EVERY rate is unpriced there is no valid best — cheapest must be null,
  // never a $0 phantom winner.
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [SS_UPS_UNPRICED, SS_UPS_ABSENT],
    ssDiagnostics: [
      { carrierId: 'se-461890', status: 'ok', rateCount: 1 },
      { carrierId: 'se-565317', status: 'ok', rateCount: 1 },
    ],
    directRates: [],
    directDiagnostics: [],
  });
  check('all-unpriced universe ⇒ cheapest is null (no $0 phantom winner)',
    combined.cheapest === null,
    `got ${combined.cheapest ? (combined.cheapest as { carrier_id?: string }).carrier_id : 'null'}`);
}

{
  // Regression: among priced rates the cheapest still wins normally.
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [SS_USPS_935],
    ssDiagnostics: [{ carrierId: 'se-442007', status: 'ok', rateCount: 1 }],
    directRates: [DIRECT_SUREPOST_845],
    directDiagnostics: [{ carrierId: 'se-10000031', status: 'ok', rateCount: 1 }],
  });
  check('regression: cheapest priced rate ($8.45 < $9.35) still wins',
    combined.cheapest?.carrier_id === 'se-10000031' && rateTotal(combined.cheapest!) === 8.45);
}

// ── list-DTO gate: a $0 best with carrier+service must be rejected ─────────────
{
  const zeroWithCarrier = normalizeListBestRate({
    shipmentCost: 0,
    otherCost: 0,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    shippingProviderId: 461890,
  });
  check('normalizeListBestRate rejects a $0 rate even WITH carrier+service',
    zeroWithCarrier === null,
    `got ${JSON.stringify(zeroWithCarrier)}`);

  const priced = normalizeListBestRate({
    shipmentCost: 8.45,
    otherCost: 0,
    carrierCode: 'ups',
    serviceCode: 'ups_surepost',
    shippingProviderId: 10000031,
  });
  check('regression: normalizeListBestRate keeps a priced rate',
    priced != null && (priced as { amount?: number }).amount === 8.45);
}

// ── source-lift guard: the ShipStation fetch drops unpriced rates ─────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('rates.ts imports the shared isPricedRate definition',
  /isPricedRate\b/.test(ratesService) && /from '\.\/rates-combined'/.test(ratesService));
check('rates.ts source lift selects only priced rates before sort/return',
  /\.filter\(isPricedRate\)/.test(ratesService));

// ── canonical owner: the combined pick filters unpriced before sorting ────────
const combinedOwner = readFileSync('src/services/rates-combined.ts', 'utf8');
check('rates-combined.ts exports isPricedRate',
  /export function isPricedRate\(/.test(combinedOwner));
check('combineCarrierUniverses cheapest-pick excludes unpriced candidates',
  /\.filter\(isPricedRate\)[\s\S]*\.sort\(/.test(combinedOwner));

if (failures > 0) {
  console.error(`\nFAIL unpriced-rate exclusion guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS unpriced-rate exclusion guard');
