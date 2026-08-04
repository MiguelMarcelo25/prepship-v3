/**
 * PS-203 (stages 1–2) guard — best-rate completeness is relative to the
 * REQUIRED carrier universe.
 *
 * THE BUG (2026-06-11, KF Goods): the saved BEST RATE showed $10.44 (ORI /
 * UPS Ground Saver) while the Rate Browser's combined view showed $9.27
 * (Shipp / SurePost). Every persisting path compared a ShipStation-only
 * universe and self-certified it complete — completeness was computed over
 * the carriers actually queried, not the carriers that SHOULD have been.
 *
 * Stage 1: the side-panel refresh sends includeVisibleDirectCarriers (the
 *   flag Recalculate + passive-live already send) so its persisted winner is
 *   compared against direct carriers too.
 * Stage 2: /rates/cached/bulk completeness is relative to the required
 *   universe — a ShipStation-only cache row for an order whose scope has
 *   visible direct-carrier accounts returns isComplete:false, which stops the
 *   passive fast-path persisting premature winners (the FE gate already
 *   requires isComplete). Stage 3's combined cache rows carry direct
 *   diagnostics (synthetic se-1xxxxxxx ids) and pass the same rule untouched.
 *
 *   npx tsx scripts/ps-203-best-rate-universe-guard.ts
 */
import { readFileSync } from 'node:fs';
import { combineCarrierUniverses, rateTotal } from '../src/services/rates-combined';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── stages 3+5: boundary tests at the canonical combined owner ────────────────
const SS_1044 = {
  carrier_id: 'se-595995',
  service_code: 'ups_ground_saver',
  shipping_amount: { amount: 10.44 },
  other_amount: { amount: 0 },
  requestFingerprint: 'fp-ss',
};
const DIRECT_927 = {
  carrier_id: 'se-10000031',
  service_code: 'ups_surepost',
  shipping_amount: { amount: 9.27 },
  other_amount: { amount: 0 },
  requestFingerprint: 'fp-direct',
};
const BASE_COMBINE = {
  ssCacheKey: 'ss-key',
  ssCached: false,
  ssDiagnostics: [{ carrierId: 'se-595995', status: 'ok', rateCount: 1 }],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map([['se-595995', 'ORI Account']]),
  accountCarrierIds: ['se-595995'],
  isCachedOnlyLookup: false,
};
{
  // THE production fixture: the $9.27 Shipp SurePost must beat the $10.44 ORI
  // Ground Saver once both families are in one comparison.
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [SS_1044],
    directRates: [DIRECT_927],
    directDiagnostics: [{ carrierId: 'se-10000031', status: 'ok', rateCount: 1 }],
  });
  check('combined pick beats the SS-only winner ($9.27 < $10.44)',
    combined.cheapest?.carrier_id === 'se-10000031' && rateTotal(combined.cheapest!) === 9.27);
  check('combined request key carries the direct carrier ids',
    combined.combinedRequestKey === 'ss-key|dc=se-10000031');
  check('clean combined universe is COMPLETE',
    combined.bestRateComplete === true);
}
{
  // A failed direct carrier makes the selection PARTIAL even when ShipStation
  // answered cleanly — a partial winner must never self-certify complete.
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [SS_1044],
    directRates: [],
    directDiagnostics: [{ carrierId: 'se-10000031', status: 'failed', rateCount: 0, error: 'timeout' }],
  });
  check('direct-carrier error ⇒ combined universe INCOMPLETE',
    combined.bestRateComplete === false && combined.cheapest?.carrier_id === 'se-595995');
}
{
  // CHARGE-basis pick: the comparison uses the full customer charge (shipping +
  // other + confirmation + insurance) — a raw-cheap rate that is expensive once
  // its add-ons count loses to a flat cheaper total.
  const rawCheapMarkedExpensive = {
    carrier_id: 'se-10000031',
    service_code: 'ups_ground',
    shipping_amount: { amount: 8.0 },
    other_amount: { amount: 3.5 }, // charge total 11.50
    requestFingerprint: 'fp-direct',
  };
  const flatTen = {
    carrier_id: 'se-595995',
    service_code: 'usps_ground_advantage',
    shipping_amount: { amount: 10.0 },
    other_amount: { amount: 0 }, // charge total 10.00
    requestFingerprint: 'fp-ss',
  };
  const combined = combineCarrierUniverses({
    ...BASE_COMBINE,
    ssRates: [flatTen],
    directRates: [rawCheapMarkedExpensive],
    directDiagnostics: [{ carrierId: 'se-10000031', status: 'ok', rateCount: 1 }],
  });
  check('pick compares the full CHARGE total (raw-cheap/charge-expensive loses)',
    combined.cheapest?.carrier_id === 'se-595995' && rateTotal(combined.cheapest!) === 10.0);
}

// ── stage 1: the panel refresh quotes the COMBINED universe ───────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
{
  const start = ordersView.indexOf('async function refreshPanelBestRate(');
  const block = start >= 0 ? ordersView.slice(start, start + 4000) : '';
  check('refreshPanelBestRate browse call sends includeVisibleDirectCarriers',
    start >= 0 && /includeVisibleDirectCarriers: true/.test(block));
}

// ── stage 2: cached/bulk completeness vs the required universe ────────────────
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const rateBrowseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
check('cached/bulk loads the direct-carrier visibility evaluator ONCE per request',
  /const hasVisibleDirectCarriers = await loadDirectCarrierVisibilityEvaluator\(\)/.test(ratesRoute));
check('exact AND rough cache hits evaluate the required universe',
  (ratesRoute.match(/requiredDirectCarriersUncovered:\s*\n?\s*hasVisibleDirectCarriers\(directContextForItem\(it\)\) &&\s*\n?\s*!rateCacheRowCoversDirectCarriers\(eligibleHit\)/g)?.length ?? 0) === 2);
check('cached/bulk resolves exact provider account context from scoped orders',
  /sourceAccountId: orders\.sourceAccountId/.test(ratesRoute) &&
  /orderScopePredicate\(scopeFromContext\(c\)\)/.test(ratesRoute) &&
  /const directContextForItem/.test(ratesRoute));
check('completeness gates on the required universe (uncovered direct carriers ⇒ incomplete)',
  /coversRequiredUniverse = options\.requiredDirectCarriersUncovered !== true/.test(ratesRoute) &&
  /isComplete = fresh && rates\.length > 0 && coversRequiredUniverse/.test(ratesRoute));
check('direct coverage = synthetic se- ids ≥ 10,000,000 in the row diagnostics (stage-3-ready)',
  /rateCacheRowCoversDirectCarriers/.test(ratesRoute) &&
  />= 10_000_000/.test(ratesRoute));
check('uncovered rows are marked for observability (requiredCarrierUniverse)',
  /requiredCarrierUniverse: 'missing-direct'/.test(ratesRoute));

// ── the evaluator lives at the carrier-universe owner ─────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('rates service owns the visibility evaluator (one account load, per-context closure)',
  /export async function loadDirectCarrierVisibilityEvaluator/.test(ratesService) &&
  /directCarrierVisibleForScope\(account, \{/.test(ratesService));
check('evaluator failure degrades to legacy completeness (never breaks the cache read)',
  /direct-carrier visibility load skipped/.test(ratesService));

// ── stage 3 wiring: ONE owner of the combine + uniform charge basis ───────────
check('direct rates pass the SAME markup rules at the source (uniform charge basis)',
  /const directMarkups = await loadCarrierMarkups\(\)/.test(ratesService) &&
  /const rates = applyMarkups\(/.test(ratesService));
check('/browse delegates the merge/pick/completeness to the canonical owner',
  /produceRateBrowsePayload/.test(ratesRoute) &&
  /const combined = combineCarrierUniverses\(\{/.test(rateBrowseProducer) &&
  !/const cheapest = \[\.\.\.combinedRates\]\.sort/.test(ratesRoute + rateBrowseProducer));

// ── stage 4 wiring: the backfill persists the COMBINED winner, raw amounts ────
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
check('backfill delegates to the same combined owner',
  /combineCarrierUniverses\(\{/.test(backfill) &&
  /getDirectCarrierRatesForRateInput\(\{/.test(backfill) &&
  /includeVisibleDirectCarriers: true/.test(backfill));
// Repointed 2026-08-04. This pinned the local `rawAmountBest`, which was renamed
// to `persistedFinalizedBest` when the raw restore moved to AFTER finalization so
// proof stamps survive the spread (rates-backfill.ts:1500-1509) -- a correctness
// reordering, not a weakening. The second-best path gained the same treatment as
// `rawAmountSecondBest` (:1370-1375), so there are now TWO strip sites where this
// pinned one.
//
// The property is unchanged and still enforced in both: the carrier's
// original_amount is restored into shipping_amount, and original_amount + markup
// are deleted before persisting, so a marked amount can never be persisted and
// marked again. Match the strip, not the variable that happens to hold it.
check('backfill persists the RAW carrier amount (kills the double-markup display)',
  /original_amount\s*\n?\s*\?\s*\{ shipping_amount: \(?[A-Za-z]*[Bb]est[^)]*\)?\.?original_amount|original_amount \? \{ shipping_amount: [A-Za-z]*\.?original_amount/.test(backfill) &&
  /delete \w+\.original_amount/.test(backfill) &&
  /delete \w+\.markup/.test(backfill));
check('backfill completeness + fingerprint come from the combined universe',
  /isComplete: combined\.bestRateComplete/.test(backfill) &&
  /requestFingerprint: combined\.combinedRequestKey/.test(backfill));
check('a wholesale direct-fetch failure marks the universe incomplete (synthetic failed diagnostic)',
  /carrierId: 'se-direct-fetch'/.test(backfill) &&
  /status: 'failed' as const/.test(backfill));

if (failures > 0) {
  console.error(`\nFAIL PS-203 best-rate universe guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-203 best-rate universe guard');
