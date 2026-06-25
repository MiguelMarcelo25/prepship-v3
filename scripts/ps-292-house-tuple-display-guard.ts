/**
 * PS-292 guard — the SHIPP house-account tuple must SURVIVE the FE boundary so it persists and
 * renders in Rate Browser / Awaiting / Shipped (unblocks PS-220 "Blocker A").
 *
 * ROOT CAUSE pinned by the trace: the backend (src/routes/rates.ts:604-620) correctly stamps
 * bestRate.nextBestNonHouseRate (the customer_rate basis) + bestRate.houseMargin, and the persist
 * normalizer (order-rate-dto.ts:384-385) whitelists them — but the FE's translateRateToV2Shape
 * (web/src/lib/v2-apiClient/shared.ts) is a fixed allowlist that DROPPED them (they survived only
 * under `.raw`), so every FE save persisted best_rate_json WITHOUT the tuple and the UI had nothing
 * to render. The pre-existing ps-220 guard never exercised this FE boundary, so the bug shipped green.
 *
 * This guard is BEHAVIORAL on the pure FE single-owner (web/src/lib/rate-browser-house-tuple.ts) +
 * the backend DTO/render contract, plus STATIC on the three FE wiring sites so the fields cannot be
 * re-dropped. It must FAIL before the fix (the FE sites are not wired) and PASS after.
 *
 *   npx tsx scripts/ps-292-house-tuple-display-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  houseTuplePassThrough,
  houseTupleForRow,
  houseDisplayForRow,
} from '../web/src/lib/rate-browser-house-tuple';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { houseMarkedAmountForRow } from '../src/services/shipping-workflow/house-row-marked-amount';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';
import { houseTupleStatus, shouldRejectHalfHouseSave } from '../src/services/shipping-workflow/house-tuple-save-policy';
import { houseMarginFromProjection } from '../src/services/shipping-workflow/house-margin-capture';
import {
  classifyAwaitingBestRateDisplay,
  AWAITING_BEST_RATE_STATE_LABELS,
} from '../web/src/components/Views/awaiting-best-rate-display-state';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// The DJ screenshot scenario: SHIPP wins at $10.54 (drp_cost); cheapest eligible non-SHIPP is ROCEL
// UPS Ground at $11.21 (customer_rate); houseMargin = 11.21 - 10.54 = 0.67. The backend bestRate
// carries the stamp camelCase top-level (rates.ts:606-619).
const BACKEND_BEST_RATE = {
  carrier_code: 'shipp',
  service_code: 'shipp_ups_ground',
  shipping_amount: { amount: 10.54 },
  serviceCode: 'shipp_ups_ground',
  shippingProviderId: 10000025,
  shipmentCost: 10.54,
  otherCost: 0,
  amount: 10.54,
  nextBestNonHouseRate: {
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    shipmentCost: 11.21,
    otherCost: 0,
    totalCost: 11.21,
    providerAccountId: 31,
    competitorCount: 1,
  },
  houseMargin: 0.67,
};

// ── 1. FE pass-through: the tuple reaches the TOP level (not only under `.raw`) ────────────────
{
  const passed = houseTuplePassThrough(BACKEND_BEST_RATE);
  const nb = passed.nextBestNonHouseRate as { totalCost?: unknown } | null;
  check('houseTuplePassThrough: nextBestNonHouseRate.totalCost surfaces at top level (11.21)',
    !!nb && (nb as { totalCost?: unknown }).totalCost === 11.21);
  check('houseTuplePassThrough: houseMargin surfaces at top level (0.67)', passed.houseMargin === 0.67);
}
{
  // A normal (non-house) rate carries no projection — both keys null, never synthesized.
  const passed = houseTuplePassThrough({ carrier_code: 'stamps_com', shipping_amount: { amount: 9.64 } });
  check('houseTuplePassThrough: non-house rate => nextBestNonHouseRate null', passed.nextBestNonHouseRate === null);
  check('houseTuplePassThrough: non-house rate => houseMargin null', passed.houseMargin === null);
}

// ── 2. FE apply path: the tuple binds ONLY to the canonical best row, by identity ──────────────
const CANONICAL_BEST = {
  serviceCode: 'shipp_ups_ground',
  shippingProviderId: 10000025,
  nextBestNonHouseRate: BACKEND_BEST_RATE.nextBestNonHouseRate,
  houseMargin: 0.67,
};
{
  const matchedRow = { serviceCode: 'shipp_ups_ground', shippingProviderId: 10000025, amount: 10.54 };
  const lifted = houseTupleForRow(matchedRow, CANONICAL_BEST);
  const nb = lifted.nextBestNonHouseRate as { totalCost?: unknown } | undefined;
  check('houseTupleForRow: canonical-best row lifts the tuple (customer_rate 11.21 + margin 0.67)',
    !!nb && (nb as { totalCost?: unknown }).totalCost === 11.21 && lifted.houseMargin === 0.67);
}
{
  // A DIFFERENT row (the ROCEL competitor itself, or any non-best) must NOT receive the house stamp.
  const otherRow = { serviceCode: 'ups_ground', shippingProviderId: 31, amount: 11.21 };
  const lifted = houseTupleForRow(otherRow, CANONICAL_BEST);
  check('houseTupleForRow: a non-canonical-best row gets NO house fields',
    lifted.nextBestNonHouseRate === undefined && lifted.houseMargin === undefined);
}
{
  // No backend projection (plain best) => no house fields even for the matching row.
  const plainBest = { serviceCode: 'usps_ground_advantage', shippingProviderId: 7 };
  const row = { serviceCode: 'usps_ground_advantage', shippingProviderId: 7 };
  const lifted = houseTupleForRow(row, plainBest);
  check('houseTupleForRow: no backend nextBestNonHouseRate => no house fields', lifted.nextBestNonHouseRate === undefined);
}

// ── 3. FE recommended-row render input: customer_rate over drp_cost; redaction hides it ─────────
{
  const matchedRow = { serviceCode: 'shipp_ups_ground', shippingProviderId: 10000025 };
  const disp = houseDisplayForRow(matchedRow, CANONICAL_BEST, 10.54);
  check('houseDisplayForRow: recommended SHIPP row => { drpCost 10.54, customerRate 11.21 } (top over bottom)',
    !!disp && disp.drpCost === 10.54 && disp.customerRate === 11.21);
}
{
  // Non-financial viewers get nextBestNonHouseRate.totalCost nulled by the backend redactor BEFORE it
  // reaches the FE — so the render helper yields null (the tuple is hidden by construction).
  const redactedBest = {
    serviceCode: 'shipp_ups_ground',
    shippingProviderId: 10000025,
    nextBestNonHouseRate: { totalCost: null, shipmentCost: null, otherCost: null },
    houseMargin: null,
  };
  const row = { serviceCode: 'shipp_ups_ground', shippingProviderId: 10000025 };
  check('houseDisplayForRow: redacted (totalCost null) => null, so non-financial viewers see no tuple',
    houseDisplayForRow(row, redactedBest, 10.54) === null);
}

// ── 4. Persist contract: the passed-through tuple survives normalizeOrderBestRateDto ───────────
{
  const passed = houseTuplePassThrough(BACKEND_BEST_RATE);
  // What the FE save path sends as bestRateJson: the v2-shaped rate + the top-level house pass-through.
  const dto = normalizeOrderBestRateDto({
    serviceCode: 'shipp_ups_ground',
    shipmentCost: 10.54,
    otherCost: 0,
    carrierCode: 'shipp',
    ...passed,
  });
  check('normalizeOrderBestRateDto: round-trip preserves nextBestNonHouseRate.totalCost (11.21)',
    dto?.nextBestNonHouseRate?.totalCost === 11.21);
  check('normalizeOrderBestRateDto: round-trip preserves houseMargin (0.67)', dto?.houseMargin === 0.67);
  check('normalizeOrderBestRateDto: round-trip preserves competitorCount (1)',
    dto?.nextBestNonHouseRate?.competitorCount === 1);
}

// ── 5. Awaiting render contract: with the tuple present, the row shows the house display ────────
// Proves the bug is the UPSTREAM persist gap, not the render — this already passes today, and locks it.
{
  const marked = houseMarkedAmountForRow({ isAwaiting: true, projectedNextBestTotalCost: 11.21, realizedCustomerRate: null });
  check('houseMarkedAmountForRow: awaiting reads projected nextBestNonHouseRate.totalCost (11.21)', marked === 11.21);

  const money = buildOrderRowMoneyDisplay({
    isAwaiting: true,
    houseMarkedAmount: 11.21,
    bestRateBaseAmount: 10.54,
    selectedRateBaseAmount: null,
    labelFinalCost: null,
    markupRule: null,
    insuranceAddOn: null,
  } as Parameters<typeof buildOrderRowMoneyDisplay>[0]);
  check('buildOrderRowMoneyDisplay: house tuple => markupSource house_account, marked 11.21 over base 10.54',
    money?.markupSource === 'house_account' && money?.markedAmount === 11.21 && money?.baseAmount === 10.54);
}

// ── 6. Confidentiality preserved: client/non-financial money redaction still nulls the tuple ────
{
  const redacted = redactRateBrowserMoney({
    nextBestNonHouseRate: { totalCost: 11.21, shipmentCost: 11.21, otherCost: 0, competitorCount: 1 },
    houseMargin: 0.67,
  }) as { nextBestNonHouseRate: { totalCost: unknown; shipmentCost: unknown }; houseMargin: unknown };
  check('redactRateBrowserMoney: non-financial viewer gets competitor totalCost/shipmentCost + houseMargin nulled',
    redacted.nextBestNonHouseRate.totalCost === null &&
    redacted.nextBestNonHouseRate.shipmentCost === null &&
    redacted.houseMargin === null);
}

// ── 7. STATIC: the three FE wiring sites consume the single owner (cannot silently re-drop) ─────
const sharedSrc = readFileSync('web/src/lib/v2-apiClient/shared.ts', 'utf8');
check('shared.ts: translateRateToV2Shape passes the house tuple through (houseTuplePassThrough)',
  /houseTuplePassThrough/.test(sharedSrc) && /\.\.\.houseTuplePassThrough\(/.test(sharedSrc));

const modalSrc = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('RateBrowserModal: RbAppliedRate carries the house tuple fields',
  /nextBestNonHouseRate\??:/.test(modalSrc) && /houseMargin\??:/.test(modalSrc));
check('RateBrowserModal: the apply path lifts the tuple via houseTupleForRow (manual click + auto-recommend)',
  /houseTupleForRow\(/.test(modalSrc));

const rowItemSrc = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');
check('RateRowItem: recommended SHIPP row renders the house tuple (houseTuple prop) + HOUSE badge',
  /renderHouseBadge/.test(rowItemSrc) && /houseTuple/.test(rowItemSrc));

// ── 8. CARD ITEM 4 (backend reject): a half-house SHIPP save is rejected; legitimate saves are NOT ──
{
  // SHIPP + opted-in + competitor tuple ABSENT (both null) => needs_refresh => reject.
  const half = houseTupleStatus({ rawProvider: 'shipp', nextBestNonHouseRate: null, houseMargin: null, optedIn: true });
  check('item4: SHIPP + opted-in + missing tuple => needs_refresh', half === 'needs_refresh');
  check('item4: a half-house save is rejected', shouldRejectHalfHouseSave(half) === true);

  // HAPPY PATH — a legitimate SHIPP house win WITH a real competitor must STILL save (no reject).
  const withComp = houseTupleStatus({
    rawProvider: 'shipp', nextBestNonHouseRate: { totalCost: 11.21 }, houseMargin: 0.67, optedIn: true,
  });
  check('item4 HAPPY PATH: SHIPP + real competitor => present', withComp === 'present');
  check('item4 HAPPY PATH: a legitimate SHIPP house win still saves (no reject)',
    shouldRejectHalfHouseSave(withComp) === false);

  // DEFAULT-OFF: a non-opted-in client is never a house row, even with a missing tuple.
  const notOpted = houseTupleStatus({ rawProvider: 'shipp', nextBestNonHouseRate: null, houseMargin: null, optedIn: false });
  check('item4 DEFAULT-OFF: non-opted-in => not_house (no reject)',
    notOpted === 'not_house' && shouldRejectHalfHouseSave(notOpted) === false);

  // A non-SHIPP winner is never a house row (carrier_code trap is moot — identity is provider-only).
  const nonShipp = houseTupleStatus({ rawProvider: 'ups', nextBestNonHouseRate: null, houseMargin: null, optedIn: true });
  check('item4: non-SHIPP winner => not_house (no reject)',
    nonShipp === 'not_house' && shouldRejectHalfHouseSave(nonShipp) === false);
}

// ── 9. SAFETY LINCHPIN: a GENUINE no-competitor SHIPP win (houseMargin 0, nextBest null) is NOT half ─
{
  // stampHouseTuple writes nextBestNonHouseRate=null but houseMargin=0 (NOT null) for a real pass-
  // through — so 'both null' (=> reject) only happens when the save NEVER went through the stamp owner.
  const passThrough = houseTupleStatus({ rawProvider: 'shipp', nextBestNonHouseRate: null, houseMargin: 0, optedIn: true });
  check('linchpin: SHIPP no-competitor pass-through (houseMargin 0) => present, NOT rejected',
    passThrough === 'present' && shouldRejectHalfHouseSave(passThrough) === false);
}

// ── 10. CARD ITEM 2 (verdict persistence): normalizeOrderBestRateDto round-trips houseTupleStatus ───
{
  const dto = normalizeOrderBestRateDto({ serviceCode: 'shipp_ups_ground', shipmentCost: 10.54, carrierCode: 'shipp', houseTupleStatus: 'needs_refresh' });
  check('item2: normalizeOrderBestRateDto round-trips houseTupleStatus (needs_refresh)', dto?.houseTupleStatus === 'needs_refresh');
  const dtoPlain = normalizeOrderBestRateDto({ serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, carrierCode: 'usps' });
  check('item2: a rate with no verdict => null (byte-identical legacy)', dtoPlain?.houseTupleStatus === null);
}

// ── 11. CARD ITEM 2 (FE diagnostic): a needs_refresh row shows the diagnostic, beating show_amount ──
{
  const base = { hasSavedBestRate: true, canDisplaySavedRate: true, isComplete: true, cacheExpiresAt: null, eligibilityVersion: null, requiredEligibilityVersion: null, hasDimsAndWeight: true };
  check('item2 FE: needs_refresh WINS over show_amount (never a confident plain SHIPP amount)',
    classifyAwaitingBestRateDisplay({ ...base, houseTupleNeedsRefresh: true }) === 'house_needs_refresh');
  check('item2 FE: a non-house row is byte-identical (show_amount)',
    classifyAwaitingBestRateDisplay({ ...base }) === 'show_amount');
  check('item2 FE: the diagnostic label is "House rate needs refresh"',
    AWAITING_BEST_RATE_STATE_LABELS.house_needs_refresh === 'House rate needs refresh');
}

// ── 12. CARD ITEM 3 (shipped realized — audit's "absent" REFUTED, already wired): pin the two-tier ──
{
  const projected = normalizeOrderBestRateDto({ shipmentCost: 8.5, carrierCode: 'ups', serviceCode: 'ups_surepost', nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007 }, houseMargin: 1.14 });
  const realized = houseMarginFromProjection(projected, 8.5);
  check('item3: realized two-tier => customer_rate 9.64 over drp_cost 8.5', realized != null && realized.customerRate === 9.64);
  check('item3: a non-house best => no realized tuple (forward-only / historical-plain)',
    houseMarginFromProjection(normalizeOrderBestRateDto({ shipmentCost: 9, carrierCode: 'ups', serviceCode: 'ups_ground' }), 9) === null);
}

// ── 13. STATIC: the SAVE handlers + the shipped read + the opt-in gate are wired (anti-regression) ──
const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');
check('static: orders SAVE rejects a half-house behind the HOUSE_TUPLE_SAVE_GUARD canary',
  /shouldRejectHalfHouseSave\(hStatus\) && process\.env\.HOUSE_TUPLE_SAVE_GUARD === 'on'/.test(ordersSrc));
check('static: orders SAVE stamps the houseTupleStatus verdict onto the persisted best rate (both routes)',
  /houseTupleStatus = hStatus/.test(ordersSrc) && /canonical\.houseTupleStatus = hStatus/.test(ordersSrc));
check('static: item3 shipped realized read present + financially gated (orderCompetitiveRate + canViewFinancials)',
  /orderCompetitiveRate/.test(ordersSrc) && /canViewFinancials/.test(ordersSrc));
const stampSrc = readFileSync('src/services/shipping-workflow/house-tuple-stamp.ts', 'utf8');
check('static: stampHouseTuple still gates on isHouseShippRate + clientHouseAccountEnabled (default-OFF inert)',
  /isHouseShippRate/.test(stampSrc) && /clientHouseAccountEnabled/.test(stampSrc));

// ── 14. A's FE follow-up: a PERSISTED half-house rate (houseTupleStatus 'needs_refresh') must be
//        NON-displayable so the awaiting cell falls through to the 'House rate needs refresh' diagnostic.
//        Without this, the only caller of getAwaitingBestRateDisplayState (gated on
//        hasDisplayableBestRateForCurrentRequest) is bypassed for legacy rows and a confident plain SHIPP
//        amount renders. Static pin on the gate (the function is a closure in OrdersView).
{
  // PS-317: hasDisplayableBestRateForCurrentRequest (which holds this needs_refresh non-displayable
  // gate) moved into ./orders/best-rate/rate-helpers.ts as an indented inner function. The gate
  // invariant is unchanged — re-anchored to the new owner.
  const rateHelpersSrc = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
  check('FE follow-up: the displayable gate treats a persisted needs_refresh half-house rate as NON-displayable',
    /getSavedBestRateRecord\(order\)[\s\S]{0,90}houseTupleStatus === 'needs_refresh'\)[\s\S]{0,40}return false/.test(rateHelpersSrc));
}

if (failures > 0) {
  console.error(`\nFAIL PS-292 house-tuple-display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-292 house-tuple-display guard');
