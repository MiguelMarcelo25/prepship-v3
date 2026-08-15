/**
 * PS-499 — one order rate display contract.
 *
 * THE DEFECT
 *
 * The Orders Best Rate cell and the order-detail panel shared a helper that resolved the
 * displayed amount by precedence:
 *
 *   purchaseAmount = selectedRateCost ?? baseAmount
 *   customerAmount = cShippingRateAmount ?? markedAmount ?? purchaseAmount ?? fallbackAmount
 *   primaryAmount  = customerAmount ?? purchaseAmount ?? fallbackAmount
 *
 * Four DIFFERENT money meanings collapsed by field order: what we paid, the carrier base
 * (both call sites passed bestRateBaseCost as `fallbackAmount`), the customer-billed
 * amount, and the marked-up amount. When the customer amount was absent the cell rendered
 * a cost figure — real money, plausibly sized — under a customer-price label, with nothing
 * marking the substitution.
 *
 * The same substitution existed at three more depths, each of which would have survived
 * the others being fixed:
 *   - renderRateAmountWithMarkup: `markedAmount ?? baseAmount`
 *   - the no-tuple branch: renderRateAmountWithMarkup(bestRateBaseCost, bestRateBaseCost)
 *   - the detail panel: `primaryAmount ?? getBestRateBaseCost(...)` — which would have
 *     silently defeated this ticket, since the unavailable state IS a null primaryAmount
 * and mirrored once, in getBestRateBaseCost, which fell through to CUSTOMER amounts under
 * a cost meaning.
 *
 * BEHAVIOURAL, not just textual. The resolver is executed across AC-5's cases: complete,
 * partial, house, carrier, insurance and deploy-skew. A guard that only grepped for the
 * chain would pass against a rewritten chain that still picked by field order.
 *
 * Offline and pure — no database, no network, no mutation.
 */
import { readFileSync } from 'node:fs';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import {
  resolveAwaitingBestRatePriceDisplay,
  type AwaitingBestRatePriceDisplayInput,
} from '../web/src/components/Views/orders/best-rate-price-display';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const read = (path: string) => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};
const strip = (src: string) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const base = (over: Partial<AwaitingBestRatePriceDisplayInput> = {}): AwaitingBestRatePriceDisplayInput => ({
  markedAmount: 12,
  markupSource: 'carrier_markup',
  selectedRateCost: 10,
  baseAmount: 10,
  cShippingRateAmount: 12,
  insuranceAddOn: null,
  customerAmountState: 'available',
  ...over,
});

// ── AC-1 / AC-2 — the display contract, executed ─────────────────────────────
console.log('\ndisplay contract (resolveAwaitingBestRatePriceDisplay)');

{
  const r = resolveAwaitingBestRatePriceDisplay(base());
  check('COMPLETE carrier row shows the customer amount, with the cost as the breakdown base',
    r.primaryAmount === 12 && r.baseAmount === 10 && r.mode === 'carrier_marked_breakdown');
}

{
  // The defect, stated as a test. Cost fields are present and plausible; the customer
  // amount is not. Nothing may be shown in the customer-price slot.
  const r = resolveAwaitingBestRatePriceDisplay(
    base({ cShippingRateAmount: null, customerAmountState: 'unavailable' }));
  check('PARTIAL row renders UNAVAILABLE, never the purchase or base amount',
    r.mode === 'customer_amount_unavailable' && r.primaryAmount === null,
    `mode=${r.mode} primaryAmount=${String(r.primaryAmount)}`);
  check('the unavailable row exposes no base amount either (nothing to mistake for a price)',
    r.baseAmount === null);
}

{
  const r = resolveAwaitingBestRatePriceDisplay(base({ markupSource: 'house_account' }));
  check('HOUSE row shows DJR purchase cost under its own meaning, with the badge',
    r.mode === 'house_purchase_only' && r.primaryAmount === 10 && r.showHouseBadge === true);
}

{
  // No visible markup => a single amount, not a breakdown claiming a 0 markup.
  const r = resolveAwaitingBestRatePriceDisplay(base({ cShippingRateAmount: 10 }));
  check('CARRIER row with no visible markup renders a single amount',
    r.mode === 'single_amount' && r.primaryAmount === 10 && r.baseAmount === null);
}

{
  const r = resolveAwaitingBestRatePriceDisplay(base({ insuranceAddOn: 3.5 }));
  check('INSURANCE add-on rides through untouched', r.insuranceAddOn === 3.5);
  const unavailable = resolveAwaitingBestRatePriceDisplay(
    base({ cShippingRateAmount: null, customerAmountState: 'unavailable', insuranceAddOn: 3.5 }));
  check('insurance still renders when the customer amount is unavailable',
    unavailable.insuranceAddOn === 3.5);
}

{
  // DEPLOY SKEW: an older backend omits customerAmountState. Absence must degrade to the
  // TRUTH (the amount's own presence), never to a substitution.
  const withAmount = resolveAwaitingBestRatePriceDisplay(base({ customerAmountState: undefined }));
  check('deploy skew WITH an amount still shows it',
    withAmount.primaryAmount === 12 && withAmount.mode !== 'customer_amount_unavailable');
  const withoutAmount = resolveAwaitingBestRatePriceDisplay(
    base({ customerAmountState: undefined, cShippingRateAmount: null }));
  check('deploy skew WITHOUT an amount renders unavailable, not the cost',
    withoutAmount.mode === 'customer_amount_unavailable' && withoutAmount.primaryAmount === null,
    `primaryAmount=${String(withoutAmount.primaryAmount)}`);
}

{
  // The substitution must be UNAVAILABLE to write, not merely unused: the fields it fed on
  // are gone from the input type. Passing them is a type error, so this asserts the shape.
  const src = read('web/src/components/Views/orders/best-rate-price-display.ts');
  const type = /export type AwaitingBestRatePriceDisplayInput = \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
  const body = strip(src);
  // fallbackAmount was pure substitution — the carrier base under a customer-price label —
  // so it is gone from the contract entirely and cannot be passed.
  check('fallbackAmount is no longer an input to the display contract', !/\bfallbackAmount\b/.test(type));
  // markedAmount REMAINS, but only for the PS-366 branch below. What must never come back
  // is its use as a FALLBACK, which is what made it a substitution.
  check('markedAmount is never a fallback for the customer amount',
    !/cShippingRateAmount\s*\)?\s*\?\?[^\n]*markedAmount/.test(body) &&
    !/markedAmount\s*\)?\s*\?\?[^\n]*(purchaseAmount|fallbackAmount|baseAmount)/.test(body));
  check('selectedRateCost and baseAmount are unreachable as a customer price',
    !/customerAmount[^\n]*\?\?[^\n]*(purchaseAmount|selectedRateCost|baseAmount)/.test(body));
}

{
  // PS-366, restored after this ticket first broke it: on a HUGRAB override row the
  // customer is BILLED cShippingRateAmount while the Best Rate cell shows the quoted RATE
  // (markedAmount). Billed money and displayed rate are different facts, and the selection
  // between them is a backend-stated source, not a null-check.
  const overrideRow = resolveAwaitingBestRatePriceDisplay(base({
    cShippingRateAmount: 7.73,
    markedAmount: 5.88,
    selectedRateCost: 5.88,
    baseAmount: 5.88,
    customerRateSource: 'hugrab_shipping_rate_override',
  }));
  check('HUGRAB override row displays the quoted rate, not the overridden billed amount',
    overrideRow.primaryAmount === 5.88,
    `primaryAmount=${String(overrideRow.primaryAmount)} (7.73 would be the BILLED amount)`);

  const normalRow = resolveAwaitingBestRatePriceDisplay(base({
    cShippingRateAmount: 7.73,
    markedAmount: 5.88,
    customerRateSource: 'best_rate_marked_amount',
  }));
  check('a NON-override row still displays the customer amount, not markedAmount',
    normalRow.primaryAmount === 7.73,
    `primaryAmount=${String(normalRow.primaryAmount)}`);
}

// ── AC-3 — the backend stamps the verdict ────────────────────────────────────
console.log('\nbackend stamps customerAmountState (rate-money.ts)');

{
  const money = buildOrderRowMoneyDisplay({
    isAwaiting: true,
    bestRateBaseAmount: 10,
    selectedRateBaseAmount: null,
    labelFinalCost: null,
    markupRule: { type: 'percent', value: 20 },
    insuranceAddOn: null,
  });
  check('a normal carrier row is stamped available', money?.customerAmountState === 'available',
    `got ${String(money?.customerAmountState)}`);
  check('the stamped state agrees with the customer amount it describes',
    money != null && (money.cShippingRateAmount != null) === (money.customerAmountState === 'available'));
}

{
  // The reachable 'unavailable' case, and the reason this ticket is not cosmetic.
  //
  // A markup rule that zeroes the amount (a -100% rule, or a flat -10 against a 10 base)
  // produces cShippingRateAmount = null with markedAmount = 0. The OLD frontend chain
  // `cShippingRateAmount ?? markedAmount ?? ...` therefore fell to 0 and rendered $0.00 as
  // the customer's price — a real number, in the customer-price slot, on a row whose
  // customer amount does not exist.
  //
  // This case also keeps the stamping honest: without it every fixture here has a customer
  // amount, so hardcoding customerAmountState to 'available' would pass unnoticed.
  for (const [label, rule] of [
    ['-100% markup', { type: 'percent' as const, value: -100 }],
    ['flat -10 markup', { type: 'amount' as const, value: -10 }],
  ]) {
    const zeroed = buildOrderRowMoneyDisplay({
      isAwaiting: true,
      bestRateBaseAmount: 10,
      selectedRateBaseAmount: null,
      labelFinalCost: null,
      markupRule: rule as { type: 'amount' | 'percent'; value: number },
      insuranceAddOn: null,
    });
    check(`a zeroed customer amount (${label}) is stamped UNAVAILABLE`,
      zeroed?.customerAmountState === 'unavailable' && zeroed?.cShippingRateAmount === null,
      `state=${String(zeroed?.customerAmountState)} cShipping=${String(zeroed?.cShippingRateAmount)}`);
    check(`...and its markedAmount is 0, which is what the old chain would have displayed (${label})`,
      zeroed?.markedAmount === 0);
  }
}

{
  const house = buildOrderRowMoneyDisplay({
    isAwaiting: true,
    bestRateBaseAmount: 10,
    selectedRateBaseAmount: null,
    labelFinalCost: null,
    markupRule: null,
    insuranceAddOn: null,
    houseMarkedAmount: 14,
  });
  check('a HOUSE row is stamped too (the field is not carrier-only)',
    house?.customerAmountState === 'available' && house?.markupSource === 'house_account');
}

// ── AC-1 — the two surfaces cannot drift ─────────────────────────────────────
console.log('\nboth surfaces consume one contract');

{
  const cells = strip(read('web/src/components/Views/orders/cells/order-cells.tsx'));
  const panel = strip(read('web/src/components/Views/OrdersDetailSidePanel.tsx'));
  const keysOf = (src: string) => {
    const call = /resolveAwaitingBestRatePriceDisplay\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? '';
    return [...call.matchAll(/(\w+):/g)].map((m) => m[1]).sort().join(',');
  };
  const cellKeys = keysOf(cells);
  const panelKeys = keysOf(panel);
  check('the Orders cell and the detail panel pass the SAME input keys', cellKeys === panelKeys,
    `cell=[${cellKeys}] panel=[${panelKeys}]`);
  check('both surfaces actually call the shared resolver',
    cellKeys.length > 0 && panelKeys.length > 0);
}

// ── AC-2 / AC-4 — no substitution survives anywhere on the path ──────────────
console.log('\nno cost-for-customer substitution survives');

{
  const rowDisplay = strip(read('web/src/components/Views/orders-row-display.tsx'));
  check('renderRateAmountWithMarkup no longer falls back to baseAmount',
    !/const displayAmount = markedAmount \?\? baseAmount/.test(rowDisplay));
  check('getBestRateBaseCost is COST-only (no customer-amount rungs)',
    !/getBestRateBaseCost[\s\S]{0,240}cShippingRateAmount/.test(rowDisplay));

  const cells = strip(read('web/src/components/Views/orders/cells/order-cells.tsx'));
  check('the no-tuple branch does not pass a base cost as the customer amount',
    !/renderRateAmountWithMarkup\(bestRateBaseCost, bestRateBaseCost/.test(cells));

  const panel = strip(read('web/src/components/Views/OrdersDetailSidePanel.tsx'));
  check('the detail panel does not fall back to a base cost when the amount is unavailable',
    !/primaryAmount \?\? getBestRateBaseCost/.test(panel));
}

console.log(`\n${failures === 0 ? 'PS-499 order rate display contract guard passed.' : `PS-499 order rate display contract guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
