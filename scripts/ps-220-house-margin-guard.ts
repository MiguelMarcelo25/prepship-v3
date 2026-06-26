/**
 * PS-220 guard — SHIPP house-account next-best-rate resolver.
 *
 * MODEL: SHIPP is DRP's house carrier. When SHIPP wins for an OPTED-IN client, DRP pays the
 * SHIPP rate (drp_cost) but bills the cheapest ELIGIBLE non-SHIPP rate (customer_rate); the
 * spread is DRP's margin (always >= 0). No eligible competitor => customer_rate = drp_cost,
 * margin 0. Not opted in / SHIPP not the winner => no house behavior.
 *
 * This slice (1 of N) pins the PURE resolver + the sidecar table + the lockdown invariants.
 * Capture wiring (projected stamp / realized row), billing, and display land in later slices.
 *
 *   npx tsx scripts/ps-220-house-margin-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  isHouseShippRate,
  resolveNextBestNonHouseRate,
} from '../src/lib/next-best-non-house-rate';
import { houseMarginFromProjection, planRealizedHouseCapture } from '../src/services/shipping-workflow/house-margin-capture';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { houseMarkedAmountForRow } from '../src/services/shipping-workflow/house-row-marked-amount';
import { buildBestRateWorkflowDto, withOrderRowWorkflow } from '../src/services/shipping-workflow/best-rate-workflow-dto';
import { redactOrderFinancials, RATE_MONEY_FIELD_KEYS } from '../src/services/orders-financial-redaction';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { redactRateBrowserMoney, RATE_BROWSER_MONEY_FIELD_KEYS } from '../src/services/rate-browser-money-redaction';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const CONTEXT = { clientId: 10 };
const OPTED_IN = { houseAccountOptIn: true };

// SHIPP (house) — provider IS the only reliable identity. The Shipp connector rewrites
// carrier_code to fedex/ups/etc, so a SHIPP rate can carry carrier_code:'fedex'.
const SHIPP_SUREPOST = { provider: 'shipp', carrier_code: 'ups', service_code: 'ups_surepost', shipping_amount: { amount: 8.5 } };
const SHIPP_AS_FEDEX = { provider: 'shipp', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 8.4 } };
// Real competitors (provider !== shipp).
const FEDEX_GROUND = { provider: 'fedex', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 10.3 } };
const USPS_GA = { provider: 'shipstation', carrier_code: 'stamps_com', service_code: 'usps_ground_advantage', shipping_amount: { amount: 9.64 } };
const UPS_UNPRICED = { provider: 'ups', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 0 } };

// ── isHouseShippRate keys on provider, never carrier_code ─────────────────────
check('isHouseShippRate: provider shipp => true', isHouseShippRate(SHIPP_SUREPOST) === true);
check('isHouseShippRate: SHIPP rewritten to carrier_code fedex is STILL house (provider shipp)',
  isHouseShippRate(SHIPP_AS_FEDEX) === true);
check('isHouseShippRate: real fedex (provider fedex) is NOT house',
  isHouseShippRate(FEDEX_GROUND) === false);
check('isHouseShippRate: real usps is NOT house', isHouseShippRate(USPS_GA) === false);

// ── resolver ──────────────────────────────────────────────────────────────────
{
  // Opted in + SHIPP winner + competitors => cheapest ELIGIBLE non-SHIPP (USPS $9.64 < FedEx $10.30),
  // the SHIPP-as-fedex trap row dropped (provider shipp), the $0 ups dropped (unpriced).
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, SHIPP_AS_FEDEX, FEDEX_GROUND, USPS_GA, UPS_UNPRICED],
    context: CONTEXT,
    client: OPTED_IN,
  });
  check('next-best is the cheapest priced non-SHIPP ($9.64 USPS)',
    r != null && r.total === 9.64 && (r.rate as { provider?: string }).provider === 'shipstation',
    `got ${r ? r.total + ' / ' + (r.rate as { provider?: string }).provider : 'null'}`);
  check('competitorCount counts only priced non-SHIPP (fedex + usps = 2)',
    r != null && r.competitorCount === 2, `got ${r?.competitorCount}`);
  check('next-best is never a SHIPP rate', r != null && !isHouseShippRate(r.rate));
}

{
  // No eligible non-SHIPP competitor => null (caller sets customer_rate = drp_cost, margin 0).
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, SHIPP_AS_FEDEX, UPS_UNPRICED],
    context: CONTEXT,
    client: OPTED_IN,
  });
  check('no priced non-SHIPP competitor => null (pass-through)', r === null);
}

{
  // Not opted in => no house behavior at all, even with competitors present.
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, FEDEX_GROUND, USPS_GA],
    context: CONTEXT,
    client: { houseAccountOptIn: false },
  });
  check('client not opted in => null (no house behavior)', r === null);
}

// ── structural pins ─────────────────────────────────────────────────────────
const resolverSrc = readFileSync('src/lib/next-best-non-house-rate.ts', 'utf8');
check('resolver keys SHIPP on provider, NOT carrier_code',
  /normalizeProviderKey\([\s\S]*?\)\s*===\s*'shipp'/.test(resolverSrc) &&
  !/carrier_?code[^\n]*===[^\n]*'shipp'/i.test(resolverSrc));
check('resolver reuses the canonical eligibility filter (no re-implemented loop)',
  resolverSrc.includes('filterEligibleShippingServices'));
check('resolver uses the same charge basis as the winner (rateTotal + isPricedRate)',
  resolverSrc.includes('rateTotal') && resolverSrc.includes('isPricedRate'));

// ── sidecar table is lockdown-safe (new table, never ALTER orders/shipments) ──
const migration = readFileSync('drizzle/0049_order_competitive_rate.sql', 'utf8');
check('migration creates the sidecar table', /CREATE TABLE IF NOT EXISTS order_competitive_rate/i.test(migration));
check('migration enforces the margin>=0 invariant in the DB', /CHECK\s*\(\s*margin\s*>=\s*0\s*\)/i.test(migration));
check('migration NEVER alters the locked orders/shipments tables',
  !/ALTER\s+TABLE\s+(orders|shipments)\b/i.test(migration) &&
  !/\b(UPDATE|DELETE)\s+(FROM\s+)?(orders|shipments)\b/i.test(migration));

// ── slice 2: DTO carrier + projected stamp + opt-in + redaction ──────────────
const dto = readFileSync('src/services/order-rate-dto.ts', 'utf8');
check('OrderBestRateDto carries nextBestNonHouseRate + houseMargin (survives the whitelist normalizer)',
  /nextBestNonHouseRate:/.test(dto) && /houseMargin:/.test(dto) && dto.includes('normalizeNextBestNonHouseRate'));

const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
// PS-293: the projected house stamp moved OUT of the rates.ts inline block into the shared owner
// src/services/shipping-workflow/house-tuple-stamp.ts (so /rates/browse AND the rates-backfill stamp
// it identically). The behavioral pins below now target that owner; rates.ts must DELEGATE to it.
const houseStamp = readFileSync('src/services/shipping-workflow/house-tuple-stamp.ts', 'utf8');
// houseMargin must be redacted from BOTH the rate (browser) and the orders (list/export) serializers.
// The rates.ts redaction ships in this slice; the orders.ts RATE_MONEY_FIELD_KEYS line ships with the
// orders.ts slice (that file is mid-edit by a parallel ticket). Both MUST land before any client opts
// in (P4 default-off ⇒ houseMargin is never populated until then, so no leak window in between).
check('rates.ts delegates browse money redaction to the pure rate-browser-money-redaction owner (single key set, no drift)',
  ratesRoute.includes('redactRateBrowserMoney') &&
  /from '\.\.\/services\/rate-browser-money-redaction'/.test(ratesRoute));
// BEHAVIORAL browse-leak proof (Blocker B): the projected house stamp writes the competitor's camelCase
// cost keys (shipmentCost/otherCost/totalCost) onto bestRate.nextBestNonHouseRate. The browse redactor
// MUST null them (plus houseMargin and the SHIPP totalCost) for a non-financial / client_user viewer —
// the rates.ts set previously omitted them, leaking the competitor's internal cost the instant a client
// opted in. Non-money identity (carrier/service codes) must survive.
{
  const browseResult = {
    bestRate: {
      carrierCode: 'shipp', totalCost: 8.5, houseMargin: 1.14,
      nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007 },
    },
  };
  const redacted = redactRateBrowserMoney(browseResult) as any;
  check('browse leak FIX: competitor shipmentCost/otherCost/totalCost + houseMargin + SHIPP totalCost all NULLED for a non-financial viewer',
    redacted.bestRate.houseMargin === null &&
    redacted.bestRate.totalCost === null &&
    redacted.bestRate.nextBestNonHouseRate.totalCost === null &&
    redacted.bestRate.nextBestNonHouseRate.shipmentCost === null &&
    redacted.bestRate.nextBestNonHouseRate.otherCost === null);
  check('browse redaction is identity for non-money fields (competitor carrierCode/serviceCode survive)',
    redacted.bestRate.nextBestNonHouseRate.carrierCode === 'stamps_com' &&
    redacted.bestRate.nextBestNonHouseRate.serviceCode === 'usps_ground_advantage');
  check('rate-browser key set includes the camelCase competitor cost keys + houseMargin',
    RATE_BROWSER_MONEY_FIELD_KEYS.has('shipmentCost') && RATE_BROWSER_MONEY_FIELD_KEYS.has('otherCost') &&
    RATE_BROWSER_MONEY_FIELD_KEYS.has('totalCost') && RATE_BROWSER_MONEY_FIELD_KEYS.has('houseMargin'));
}
check('projected stamp fires only for a SHIPP winner + opted-in client, over combinedRates (shared owner)',
  houseStamp.includes('isInternalHouseRate(input.cheapest)') &&
  houseStamp.includes('shippingMarginPolicyForClient') &&
  houseStamp.includes("shippingMarginPolicy.mode !== 'next_best_customer_rate'") &&
  /resolveNextBestNonHouseRate\(\{[\s\S]*?eligibleRates: input\.combinedRates/.test(houseStamp));
check('rates.ts (/rates/browse) DELEGATES the house stamp to the shared stampHouseTuple owner',
  /await stampHouseTuple\(/.test(ratesRoute) && /import \{ stampHouseTuple \}/.test(ratesRoute));

// ── OBJECTIVE correctness: the competitor pool is the cheapest ELIGIBLE non-SHIPP ─
// the client could ACTUALLY use (admin automation-disabled + insurance-incompatible excluded).
{
  const FEDEX_CHEAP = { provider: 'fedex', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 9.0 } };
  const pool = [
    { provider: 'shipp', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 8.5 } },
    FEDEX_CHEAP,
    USPS_GA, // 9.64
  ];
  const noRules = resolveNextBestNonHouseRate({ eligibleRates: pool as never, context: { clientId: 99, storeId: null }, client: { houseAccountOptIn: true } });
  check('objective: with no automation rules the competitor is the cheapest non-SHIPP (fedex 9.0)',
    noRules != null && noRules.total === 9.0);
  const disableFedex = [{ type: 'service', clientId: 99, carrierCode: 'fedex', serviceCode: 'fedex_ground', disabled: true }];
  const withRules = resolveNextBestNonHouseRate({ eligibleRates: pool as never, context: { clientId: 99, storeId: null }, automationRules: disableFedex as never, client: { houseAccountOptIn: true } });
  check('objective FIX: an admin automation-DISABLED competitor is EXCLUDED — customer_rate = cheapest ELIGIBLE non-SHIPP (usps 9.64, NOT the ineligible fedex 9.0)',
    withRules != null && withRules.total === 9.64);
}
check('the stamp owner feeds the resolver the REAL eligibility basis (automationRules + shippingOptions), not empty placeholders',
  /resolveNextBestNonHouseRate\(\{[\s\S]*?automationRules: houseAutomationRules/.test(houseStamp) &&
  /resolveNextBestNonHouseRate\(\{[\s\S]*?insuranceProvider: input\.insuranceProvider/.test(houseStamp));
check('rates.ts passes the REAL insurance basis (result.effectiveInsuranceProvider) into stampHouseTuple',
  /insuranceProvider: result\.effectiveInsuranceProvider/.test(ratesRoute));
check('opt-in column is NOT declared on the drizzle billing_config schema (avoids the runtime-DDL gotcha)',
  !/house_account_enabled|houseAccountEnabled/.test(readFileSync('src/db/schema/billing.ts', 'utf8')));
check('opt-in read is fail-safe (false on error) and idempotently ensures the column',
  /clientHouseAccountEnabled/.test(readFileSync('src/services/house-account-opt-in.ts', 'utf8')) &&
  /ADD COLUMN IF NOT EXISTS house_account_enabled/.test(readFileSync('src/services/house-account-opt-in.ts', 'utf8')));

// ── slice 3: realized capture (reads the projected stamp; freezes the sidecar) ─
{
  const projected = normalizeOrderBestRateDto({
    shipmentCost: 8.5, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_surepost',
    nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007 },
    houseMargin: 1.14,
  });
  const r = houseMarginFromProjection(projected, 8.5);
  check('realized: customer_rate = projected competitor (9.64), margin = 1.14',
    r != null && r.customerRate === 9.64 && r.margin === 1.14 && r.competitorCount === 1, JSON.stringify(r));

  const passThrough = normalizeOrderBestRateDto({ shipmentCost: 8.5, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_surepost', houseMargin: 0 });
  const rp = houseMarginFromProjection(passThrough, 8.5);
  check('realized pass-through (no competitor): customer_rate = drp_cost, margin 0, count 0',
    rp != null && rp.customerRate === 8.5 && rp.margin === 0 && rp.competitorCount === 0);

  const nonHouse = normalizeOrderBestRateDto({ shipmentCost: 9, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_ground' });
  check('non-house order (no projected stamp) => null (no sidecar written)', houseMarginFromProjection(nonHouse, 9) === null);

  const clamped = houseMarginFromProjection(projected, 10.0); // actual SHIPP cost > projected competitor
  check('realized margin is never negative (clamped to 0)', clamped != null && clamped.margin === 0);
}

// ── PS-220-D (Blocker D): the REAL competitor count threads end-to-end ────────
// The resolver counts every eligible priced non-SHIPP rate (competitors.length). That count must
// reach the realized sidecar VERBATIM — not be re-collapsed to the old hardcoded `competitor ? 1 : 0`,
// which silently reported "1" no matter how many competitors actually existed. A projected stamp that
// carries competitorCount: 3 (three real competitors, USPS won) must capture competitor_count = 3.
{
  const projectedMulti = normalizeOrderBestRateDto({
    shipmentCost: 8.5, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_surepost',
    nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007, competitorCount: 3 },
    houseMargin: 1.14,
  });
  const rm = houseMarginFromProjection(projectedMulti, 8.5);
  check('PS-220-D: the REAL competitor count (3) threads through to the realized capture — NOT collapsed to 1',
    rm != null && rm.competitorCount === 3, JSON.stringify(rm));

  // Fallback parity: when the projected stamp carries NO competitorCount (older stamp), fall back to
  // the byte-identical legacy value (competitor present => 1).
  const projectedNoCount = normalizeOrderBestRateDto({
    shipmentCost: 8.5, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_surepost',
    nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007 },
    houseMargin: 1.14,
  });
  const rf = houseMarginFromProjection(projectedNoCount, 8.5);
  check('PS-220-D: absent competitorCount falls back byte-identically to the legacy 1 (competitor present)',
    rf != null && rf.competitorCount === 1, JSON.stringify(rf));
}
// Structural pins: the count is carried on the DTO, stamped from the resolver in rates.ts, and the
// capture uses the threaded value (with the legacy fallback) rather than a bare hardcoded literal.
check('PS-220-D: NextBestNonHouseRateDto carries the optional competitorCount + the normalizer reads it',
  /competitorCount\?: number \| null/.test(dto) && /competitorCount/.test(dto));
check('PS-220-D: the stamp owner stamps the resolver competitorCount onto the projected next-best',
  /competitorCount: nextBest\.competitorCount/.test(houseStamp));
const captureSrc = readFileSync('src/services/shipping-workflow/house-margin-capture.ts', 'utf8');
check('PS-220-D: capture uses the threaded competitorCount (falls back to competitor?1:0 when absent)',
  /competitorCount: competitor\?\.competitorCount \?\? \(competitor \? 1 : 0\)/.test(captureSrc));

// ── realized-capture WRITER GATE (pure, offline-provable) ─────────────────────
// The audit flagged that the IO shell's gate (cost + opt-in + stamp) had NO behavioral test — "green
// proved nothing" about the money-safety invariant. planRealizedHouseCapture now owns the decision so
// it is provable offline: a NON-opted-in client never yields a sidecar row, even with a perfect stamp.
{
  const stamp = normalizeOrderBestRateDto({
    shipmentCost: 8.5, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_surepost',
    nextBestNonHouseRate: { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shipmentCost: 9.64, otherCost: 0, totalCost: 9.64, providerAccountId: 442007 },
    houseMargin: 1.14,
  });
  const ok = planRealizedHouseCapture({ drpCost: 8.5, optedIn: true, best: stamp });
  check('writer-gate: opted-in + valid cost + house stamp => row (customer_rate 9.64, margin 1.14)',
    ok != null && ok.customerRate === 9.64 && ok.margin === 1.14, JSON.stringify(ok));
  // THE money-safety invariant: opt-in is mandatory — a perfect stamp + valid cost still writes nothing.
  check('writer-gate (DEFAULT-OFF): NOT opted in => null even with a valid stamp + cost',
    planRealizedHouseCapture({ drpCost: 8.5, optedIn: false, best: stamp }) === null);
  check('writer-gate: non-positive / non-finite drp_cost => null (unknown cost, never write)',
    planRealizedHouseCapture({ drpCost: 0, optedIn: true, best: stamp }) === null &&
    planRealizedHouseCapture({ drpCost: -1, optedIn: true, best: stamp }) === null &&
    planRealizedHouseCapture({ drpCost: NaN, optedIn: true, best: stamp }) === null);
  const nonHouseStamp = normalizeOrderBestRateDto({ shipmentCost: 9, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_ground' });
  check('writer-gate: opted-in but no house stamp (or null best) => null',
    planRealizedHouseCapture({ drpCost: 9, optedIn: true, best: nonHouseStamp }) === null &&
    planRealizedHouseCapture({ drpCost: 8.5, optedIn: true, best: null }) === null);
  // delegation parity: when the gate opens, it IS the pure core — no drift between the two.
  check('writer-gate: opted-in path delegates to houseMarginFromProjection (no drift)',
    JSON.stringify(planRealizedHouseCapture({ drpCost: 8.5, optedIn: true, best: stamp })) === JSON.stringify(houseMarginFromProjection(stamp, 8.5)));
}
// Structural pin: the IO shell DELEGATES its write decision to the pure gate (still sidecar-INSERT only).
check('writer-gate: captureRealizedHouseMargin delegates to planRealizedHouseCapture with the backend policy (thin IO shell)',
  /const realized = planRealizedHouseCapture\(\{[\s\S]*?drpCost: input\.drpCost[\s\S]*?shippingMarginPolicy[\s\S]*?best/.test(captureSrc));
check('realized capture INSERTs the sidecar and NEVER updates the locked shipments table',
  /INSERT INTO order_competitive_rate/.test(captureSrc) && !/UPDATE\s+shipments/i.test(captureSrc));
const labelsSrc = readFileSync('src/services/labels.ts', 'utf8');
check('realized capture fires only for a SHIPP purchase, best-effort, AFTER the committed ship txn',
  /directProviderKey === 'shipp'/.test(labelsSrc) && labelsSrc.includes('captureRealizedHouseMargin'));

// ── slice 3: billing branch (bill customer_rate, suppress markup) ─────────────
const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
check('billing: the captured customer_rate is loaded by shipment id + fed to the pure shipping-line decision (billed verbatim — proven behaviorally below)',
  /houseCustomerRateByShipmentId/.test(billingSrc) &&
  /decideShippingLineBilling\(\{[\s\S]*?houseCustomerRate,/.test(billingSrc));
check('billing: the sidecar (orderCompetitiveRate / isHouseOrder) supplies the house rate; markup suppression is proven behaviorally (decideShippingLineBilling house => markupApplied=false, suffix empty)',
  billingSrc.includes('orderCompetitiveRate') && /isHouseOrder/.test(billingSrc) &&
  /unitCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingSrc));

// ── slice 4 (P7 money tuple): house mapping + carrier-markup suppression ──────
{
  const houseTuple = buildOrderRowMoneyDisplay({
    isAwaiting: true,
    bestRateBaseAmount: 8.5,        // drp_cost (SHIPP)
    selectedRateBaseAmount: null,
    labelFinalCost: null,
    markupRule: { type: 'percent', value: 50 } as never, // a carrier rule that MUST be ignored for house
    insuranceAddOn: null,
    houseMarkedAmount: 9.64,        // customer_rate (cheapest eligible non-SHIPP)
  });
  check('house tuple: markupSource=house_account, base=drp_cost(8.5), marked=customer_rate(9.64), markup=spread(1.14), carrier rule suppressed',
    houseTuple != null && houseTuple.markupSource === 'house_account' &&
    houseTuple.baseAmount === 8.5 && houseTuple.markedAmount === 9.64 && houseTuple.markupAmount === 1.14,
    JSON.stringify(houseTuple));

  const carrierTuple = buildOrderRowMoneyDisplay({
    isAwaiting: true, bestRateBaseAmount: 10, selectedRateBaseAmount: null, labelFinalCost: null,
    markupRule: null, insuranceAddOn: null,
  });
  check('non-house tuple: markupSource=carrier_markup', carrierTuple != null && carrierTuple.markupSource === 'carrier_markup');
}
// ── slice 4b (producer + FE display): house customer_rate reaches the row tuple, badge renders ──
check('house-row-marked-amount: awaiting reads the PROJECTED next-best total ($9.64), shipped reads the REALIZED customer_rate',
  houseMarkedAmountForRow({ isAwaiting: true, projectedNextBestTotalCost: 9.64, realizedCustomerRate: null }) === 9.64 &&
  houseMarkedAmountForRow({ isAwaiting: false, projectedNextBestTotalCost: null, realizedCustomerRate: 9.64 }) === 9.64);
check('house-row-marked-amount: non-positive / missing source => null (not a house row)',
  houseMarkedAmountForRow({ isAwaiting: true, projectedNextBestTotalCost: 0, realizedCustomerRate: null }) === null &&
  houseMarkedAmountForRow({ isAwaiting: true, projectedNextBestTotalCost: null, realizedCustomerRate: 9.64 }) === null &&
  houseMarkedAmountForRow({ isAwaiting: false, projectedNextBestTotalCost: 9.64, realizedCustomerRate: -1 }) === null);

const dtoSrc = readFileSync('src/services/shipping-workflow/best-rate-workflow-dto.ts', 'utf8');
check('producer DTO: facts.money carries houseMarkedAmount and passes it to buildOrderRowMoneyDisplay',
  /houseMarkedAmount\?: number \| null/.test(dtoSrc) &&
  /houseMarkedAmount: facts\.money\.houseMarkedAmount/.test(dtoSrc));

const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');
check('producer (orders.ts): awaiting houseMarkedAmount sourced from the projected nextBestNonHouseRate.totalCost',
  /houseMarkedAmountForRow\(\{/.test(ordersSrc) &&
  /projectedNextBestTotalCost:[\s\S]*?nextBestNonHouseRate\)\?\.totalCost/.test(ordersSrc));

const rowDisplaySrc = readFileSync('web/src/components/Views/orders-row-display.tsx', 'utf8');
check('FE: getBackendRowMoney exposes markupSource (defaults carrier_markup on deploy-skew); renderHouseBadge exists',
  /markupSource: money\.markupSource === 'house_account'/.test(rowDisplaySrc) &&
  /export function renderHouseBadge\(\)/.test(rowDisplaySrc));

const ordersViewSrc = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-166/PS-306/PS-258 (Wave 2): the Best Rate / Margin / Selected-Rate leaf cell
// bodies (which render the HOUSE badge + house display) moved VERBATIM from
// OrdersView into ./orders/cells/order-cells; the house-display FE assertions
// follow the code to its new home.
const orderCellsSrc = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
check('FE: the Best Rate cell renders the HOUSE badge only when markupSource === house_account',
  /markupSource === 'house_account' \? renderHouseBadge\(\)/.test(orderCellsSrc));

// ── slice 4b-2 (shipped realized Ship Margin) ────────────────────────────────
check('producer (orders.ts): shipped rows bulk-load the REALIZED customer_rate and build a scoped house tuple',
  /houseRealizedByOrderId/.test(ordersSrc) &&
  /orderCompetitiveRate\.isHouseOrder/.test(ordersSrc) &&
  /houseMarkedAmount: realizedHouse\.customerRate/.test(ordersSrc));
check('producer (orders.ts): the shipped house bulk-load is best-effort + gated (financial viewer + shipped page present)',
  /canViewFinancials && joined\.some\(\(r\) => r\.order\.orderStatus === 'shipped'\)/.test(ordersSrc) &&
  /bulk-load skipped/.test(ordersSrc));
check('FE: shipped Selected Rate cell + Margin cell render the house display ONLY on markupSource house_account',
  /shippedBackendMoney\.markupSource === 'house_account'/.test(orderCellsSrc) &&
  /shippedMoney\?\.markupSource === 'house_account'/.test(orderCellsSrc));

// ── slice 4b-3 (P4: per-client opt-in write + toggle UI) ─────────────────────
const optInSrc = readFileSync('src/services/house-account-opt-in.ts', 'utf8');
check('opt-in write: setClientHouseAccountEnabled UPSERTs billing_config (PK client_id) via raw SQL, not swallowed',
  /export async function setClientHouseAccountEnabled/.test(optInSrc) &&
  /INSERT INTO billing_config[\s\S]*?ON CONFLICT \(client_id\) DO UPDATE/.test(optInSrc));
check('opt-in read: houseAccountEnabledClientIds reads ONLY opted-in rows (no IN/ANY array binding)',
  /export async function houseAccountEnabledClientIds/.test(optInSrc) &&
  /WHERE house_account_enabled = true/.test(optInSrc) &&
  !/= ANY\(/.test(optInSrc));

const adminSrc = readFileSync('src/routes/admin.ts', 'utf8');
check('admin endpoint: PATCH /clients/:id/house-account (admin-gated) calls setClientHouseAccountEnabled',
  /\/clients\/:id\{\[0-9\]\+\}\/house-account/.test(adminSrc) &&
  /setClientHouseAccountEnabled\(id, enabled\)/.test(adminSrc));

const billingRouteSrc = readFileSync('src/routes/billing.ts', 'utf8');
check('billing /config read enriches each row with houseAccountEnabled + shippingMarginPolicyMode from the backend policy',
  /houseAccountEnabledClientIds\(\)/.test(billingRouteSrc) &&
  /const houseAccountEnabled = houseAccountIds\.has\(r\.clientId\)/.test(billingRouteSrc) &&
  /shippingMarginPolicyMode: shippingMarginPolicyModeFromEnabled\(houseAccountEnabled\)/.test(billingRouteSrc));

const apiClientSrc = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
check('apiClient.setClientHouseAccount PATCHes the admin opt-in endpoint',
  /setClientHouseAccount\(clientId: number, enabled: boolean\)/.test(apiClientSrc) &&
  /\/admin\/clients\/\$\{clientId\}\/house-account/.test(apiClientSrc));

const configTableSrc = readFileSync('web/src/components/Views/BillingConfigTable.tsx', 'utf8');
check('FE: Billing Config grid has a Margin Mode toggle wired to onToggleHouseAccount',
  /onToggleHouseAccount/.test(configTableSrc) &&
  /Margin Mode/.test(configTableSrc) &&
  /houseAccountEnabled/.test(configTableSrc));

// ── slice 4b-4 (PORTAL serializer proof: internal sees it, client never does) ──
const HOUSE_ROW_FACTS = {
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: 'awaiting_shipment',
  isTest: false, hasCompleteDims: true, hasWeight: true, hasShipment: false,
  hasQueueableLabel: false, isDirectCarrierSelection: false,
  bestRateCarrierCode: 'shipp', bestRateServiceCode: 'ground', canonicalCarrierCode: 'shipp',
  canonicalServiceCode: 'ground', canonicalAccountNickname: 'SHIPP', selectedRateCarrierCode: null,
  providerAccountId: 1,
} as const;
{
  const internal = withOrderRowWorkflow(buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' }), {
    ...HOUSE_ROW_FACTS,
    money: { canViewFinancials: true, bestRateBaseAmount: 8.5, selectedRateBaseAmount: null, labelFinalCost: null, markupRule: null, insuranceAddOn: null, houseMarkedAmount: 9.64 },
  });
  check('portal proof: INTERNAL financial viewer DOES get the house tuple (markupSource=house_account, marked=customer_rate 9.64, base=drp_cost 8.5)',
    internal.money != null && internal.money.markupSource === 'house_account' && internal.money.markedAmount === 9.64 && internal.money.baseAmount === 8.5);

  const portal = withOrderRowWorkflow(buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' }), {
    ...HOUSE_ROW_FACTS,
    money: { canViewFinancials: false, bestRateBaseAmount: 8.5, selectedRateBaseAmount: null, labelFinalCost: null, markupRule: null, insuranceAddOn: null, houseMarkedAmount: 9.64 },
  });
  check('portal proof: NON-financial (client_user portal) viewer gets money === null at BUILD — no base/margin/markupSource leak',
    portal.money === null);
}
// BEHAVIORAL portal-leak proof (was the boss/audit's #1 defect: houseMargin + nextBestNonHouseRate
// leaked via overrides.bestRateJson on the list + both detail routes). Exercise the real redactor.
{
  const leakyRow = {
    id: 1,
    overrides: { bestRateJson: { carrierCode: 'shipp', totalCost: 8.5, houseMargin: 1.14, nextBestNonHouseRate: { carrierCode: 'usps', totalCost: 9.64 } } },
    bestRateWorkflow: { bestRateState: 'fresh', money: { baseAmount: 8.5, markedAmount: 9.64, markupAmount: 1.14, markupSource: 'house_account' }, marketplace: { profit: 5 } },
    bestRate: { amount: 8.5, houseMargin: 1.14 },
  } as Record<string, unknown>;

  const client = redactOrderFinancials(leakyRow, false) as any;
  check('portal leak FIX: client_user (non-financial) gets overrides.bestRateJson.houseMargin + nextBestNonHouseRate.totalCost + the SHIPP totalCost NULLED',
    client.overrides.bestRateJson.houseMargin === null &&
    client.overrides.bestRateJson.totalCost === null &&
    client.overrides.bestRateJson.nextBestNonHouseRate.totalCost === null &&
    client.overrides.bestRateJson.nextBestNonHouseRate.carrierCode === 'usps');
  check('portal leak FIX: client_user gets bestRateWorkflow.money + .marketplace nulled (no base/margin/markupSource)',
    client.bestRateWorkflow.money === null && client.bestRateWorkflow.marketplace === null);
  check('portal leak FIX: houseMargin is in the canonical redaction key set',
    RATE_MONEY_FIELD_KEYS.has('houseMargin'));

  const operator = redactOrderFinancials(leakyRow, true) as any;
  check('redaction is identity for INTERNAL financial viewers (operator sees houseMargin + the money tuple unchanged)',
    operator.overrides.bestRateJson.houseMargin === 1.14 && operator.bestRateWorkflow.money.markupSource === 'house_account');
}
check('portal serializer: redaction extracted to the pure owner + BOTH detail routes apply it (list already did)',
  /from '\.\.\/services\/orders-financial-redaction'/.test(ordersSrc) &&
  (ordersSrc.match(/redactOrderFinancials\(\{/g) || []).length >= 2 &&
  /overrides: redactRateMoneyFields\(row\.overrides\)/.test(readFileSync('src/services/orders-financial-redaction.ts', 'utf8')));

// ── slice 4c (BEHAVIORAL proof of the money-committing billing decision) ──────
{
  const markupCfg = { billingMode: 'label_cost', isBaselineCarrier: false, refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: 20, shippingMarkupFlat: 1 };

  // HOUSE order: bills the captured customer_rate EXACTLY; carrier markup suppressed even when a rule exists.
  const house = decideShippingLineBilling({ labelCost: 8.5, houseCustomerRate: 9.64, ...markupCfg });
  check('billing decision (house): bills customer_rate 9.64 verbatim, NOT the SHIPP drp_cost 8.5, markup suppressed, no suffix',
    house.billedAmount === 9.64 && house.source === 'house_customer_rate' && house.markupApplied === false && house.descriptionSuffix === '');

  // NON-house order with the SAME config: byte-identical to before — label cost + carrier markup (20% + $1).
  const carrier = decideShippingLineBilling({ labelCost: 10, houseCustomerRate: null, ...markupCfg });
  check('billing decision (non-house): label cost 10 + 20% + $1 = 13, markup applied, suffix " (20% + $1.00)" (carrier path byte-identical)',
    carrier.billedAmount === 13 && carrier.source === 'label_cost' && carrier.markupApplied === true && carrier.descriptionSuffix === ' (20% + $1.00)');

  // NON-house, no markup config: bills the bare label cost, no suffix (proves house != "no markup" alias).
  const bare = decideShippingLineBilling({ labelCost: 7.25, houseCustomerRate: null, billingMode: 'label_cost', isBaselineCarrier: false, refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: 0, shippingMarkupFlat: 0 });
  check('billing decision (non-house, no markup): bills bare label cost 7.25, no suffix', bare.billedAmount === 7.25 && bare.descriptionSuffix === '');

  // Reference-rate mode (non-baseline carrier): floors to the cheaper ref but never below the label cost.
  const ref = decideShippingLineBilling({ labelCost: 6, houseCustomerRate: null, billingMode: 'ss_ref_rate', isBaselineCarrier: false, refUspsRate: 9, refUpsRate: 8, shippingMarkupPct: 0, shippingMarkupFlat: 0 });
  check('billing decision (ref-rate): max(labelCost 6, min(9,8)=8) = 8, source reference_rate', ref.billedAmount === 8 && ref.source === 'reference_rate');

  // House order is INDEPENDENT of billing mode (a house order under ss_ref_rate still bills customer_rate, no ref floor).
  const houseUnderRef = decideShippingLineBilling({ labelCost: 6, houseCustomerRate: 9.64, billingMode: 'ss_ref_rate', isBaselineCarrier: false, refUspsRate: 9, refUpsRate: 8, shippingMarkupPct: 20, shippingMarkupFlat: 1 });
  check('billing decision: house order ignores billing mode + ref rates + markup — still bills customer_rate 9.64',
    houseUnderRef.billedAmount === 9.64 && houseUnderRef.source === 'house_customer_rate');

  // PS-220 (Blocker C — defense-in-depth cost floor): a house order must NEVER bill BELOW DRP's own
  // SHIPP cost. The margin>=0 invariant is enforced by the DB CHECK and the capture clamp; this is the
  // third layer at the money-commit point. Under the card's model this never fires (SHIPP won => every
  // competitor >= SHIPP cost), so the happy path (9.64 vs 8.5) is unchanged; it only protects against a
  // stale/forged customer_rate below cost (the FE-carried-stamp risk) — bill cost, margin 0, never a loss.
  const houseBelowCost = decideShippingLineBilling({ labelCost: 10, houseCustomerRate: 9.0, billingMode: 'label_cost', isBaselineCarrier: false, refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: 0, shippingMarkupFlat: 0 });
  check('billing decision (house cost floor): customer_rate 9.0 below SHIPP cost 10 => bills 10 (margin 0), never below cost',
    houseBelowCost.billedAmount === 10 && houseBelowCost.source === 'house_customer_rate' && houseBelowCost.markupApplied === false);
  // Happy path unchanged: customer_rate 9.64 above SHIPP cost 8.5 still bills 9.64 (floor is a no-op).
  const houseAboveCost = decideShippingLineBilling({ labelCost: 8.5, houseCustomerRate: 9.64, billingMode: 'label_cost', isBaselineCarrier: false, refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: 0, shippingMarkupFlat: 0 });
  check('billing decision (house floor no-op on happy path): customer_rate 9.64 above cost 8.5 still bills 9.64',
    houseAboveCost.billedAmount === 9.64);
}
const billingDelegateSrc = readFileSync('src/services/billing.ts', 'utf8');
check('billing.ts delegates the shipping-line amount to the pure decideShippingLineBilling owner (single source of truth)',
  /import \{ decideShippingLineBilling \}/.test(billingDelegateSrc) &&
  /unitCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingDelegateSrc));

const rateMoneySrc = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
// Bound the assertion to the HOUSE branch body only (const houseMarked … markupSource:'house_account').
// A loose [\s\S]*? would run past the branch into the carrier branches, which legitimately call
// applyMarkupToAmount — so isolate the branch, then assert no carrier markup math inside it.
const houseBranchSrc = rateMoneySrc.match(/const houseMarked[\s\S]*?markupSource: 'house_account',/);
check('rate-money: house branch exists and does NOT apply the carrier markupRule (no double markup)',
  houseBranchSrc != null && !/applyMarkupToAmount/.test(houseBranchSrc[0]));

if (failures > 0) {
  console.error(`\nFAIL PS-220 house-margin guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-220 house-margin guard');
