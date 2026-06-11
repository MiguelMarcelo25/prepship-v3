/**
 * PS-177 (Phase 5, part 2) guard — order-row MONEY display is backend-owned.
 *
 * THE GAP: the markup math lived twice (rates.ts applyMarkups for browse
 * responses; web markups.ts applyCarrierMarkup for the row Best Rate / Margin
 * cells) and the ROW application ran client-side from an FE-fetched settings
 * map — money policy in the frontend.
 *
 * THE FIX: pure shipping-workflow/rate-money.ts owns parse + math + row rule
 * precedence + the assembled tuple; rates.ts delegates; the orders route loads
 * the SAME rules once per request and passes money facts into the row workflow
 * DTO; the FE prefers DTO.money and keeps its computation only as a
 * deploy-skew fallback (Phase 6 deletes it).
 *
 *   npx tsx scripts/ps-177-row-money-display-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  applyMarkupToAmount,
  buildOrderRowMoneyDisplay,
  extractInsuranceAddOn,
  parseMarkupSettingValue,
  resolveOrderRowMarkupRule,
  type MarkupRule,
} from '../src/services/shipping-workflow/rate-money';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── parse (loadCarrierMarkups normalization parity) ──────────────────────────
check('parse: flat → amount', JSON.stringify(parseMarkupSettingValue('{"type":"flat","value":1.5}')) === '{"type":"amount","value":1.5}');
check('parse: pct → percent', JSON.stringify(parseMarkupSettingValue('{"type":"pct","value":10}')) === '{"type":"percent","value":10}');
check('parse: zero value → no rule', parseMarkupSettingValue('{"type":"amount","value":0}') === null);
check('parse: garbage/unknown type → no rule',
  parseMarkupSettingValue('not json') === null &&
  parseMarkupSettingValue('{"type":"wat","value":3}') === null &&
  parseMarkupSettingValue(null) === null);

// ── math (rates.ts applyMarkups + FE applyCarrierMarkup parity) ──────────────
check('math: percent 10% on $10 → $11', applyMarkupToAmount(10, { type: 'percent', value: 10 }) === 11);
check('math: flat $1.50 on $10 → $11.50', applyMarkupToAmount(10, { type: 'amount', value: 1.5 }) === 11.5);
check('math: no rule → base unchanged (rounded)', applyMarkupToAmount(10.567, null) === 10.57);
check('math: cents rounding', applyMarkupToAmount(9.99, { type: 'percent', value: 7 }) === 10.69);

// ── row rule precedence (FE getCarrierMarkup + row identity parity) ───────────
const RULES = new Map<string, MarkupRule>([
  ['607855', { type: 'percent', value: 10 }],
  ['ups', { type: 'amount', value: 2 }],
  ['999', { type: 'amount', value: 5 }],
]);
const LOOKUP_BASE = {
  isAwaiting: true,
  bestRateProviderAccountId: null as number | null,
  canonicalProviderAccountId: null as number | null,
  selectedRateProviderAccountId: null as number | null,
  bestRateCarrierCode: null as string | null,
  canonicalCarrierCode: null as string | null,
  selectedRateCarrierCode: null as string | null,
};
check('lookup: provider id beats carrier code',
  resolveOrderRowMarkupRule({ ...LOOKUP_BASE, bestRateProviderAccountId: 607855, bestRateCarrierCode: 'ups' }, RULES)?.type === 'percent');
check('lookup: carrier code fallback when pid has no rule',
  resolveOrderRowMarkupRule({ ...LOOKUP_BASE, bestRateProviderAccountId: 123, bestRateCarrierCode: 'ups' }, RULES)?.value === 2);
check('lookup: awaiting uses the BEST-RATE identity (rate pid first)',
  resolveOrderRowMarkupRule({ ...LOOKUP_BASE, bestRateProviderAccountId: 999, canonicalProviderAccountId: 607855 }, RULES)?.value === 5);
check('lookup: shipped is canonical-first',
  resolveOrderRowMarkupRule({ ...LOOKUP_BASE, isAwaiting: false, canonicalProviderAccountId: 607855, selectedRateProviderAccountId: 999 }, RULES)?.type === 'percent' &&
  resolveOrderRowMarkupRule({ ...LOOKUP_BASE, isAwaiting: false, selectedRateProviderAccountId: 999 }, RULES)?.value === 5);
check('lookup: no match → null', resolveOrderRowMarkupRule({ ...LOOKUP_BASE, bestRateCarrierCode: 'fedex' }, RULES) === null);

// ── insurance extraction (FE getBackendInsuranceAddOn parity) ─────────────────
check('insurance: direct positive number', extractInsuranceAddOn({ insuranceCost: 1.09 }) === 1.09);
check('insurance: nested { amount }', extractInsuranceAddOn({ insuranceCost: { amount: 2.5 } }) === 2.5);
check('insurance: zero/negative/absent → null',
  extractInsuranceAddOn({ insuranceCost: 0 }) === null &&
  extractInsuranceAddOn({ insuranceCost: -1 }) === null &&
  extractInsuranceAddOn({}) === null && extractInsuranceAddOn(null) === null);

// ── assembled tuple ───────────────────────────────────────────────────────────
const MONEY_BASE = {
  isAwaiting: true,
  bestRateBaseAmount: 10 as number | null,
  selectedRateBaseAmount: null as number | null,
  labelFinalCost: null as number | null,
  markupRule: { type: 'percent', value: 10 } as MarkupRule | null,
  insuranceAddOn: null as number | null,
};
{
  const m = buildOrderRowMoneyDisplay(MONEY_BASE)!;
  check('awaiting: base $10 + 10% → marked $11, markup $1, margin 10%',
    m.baseAmount === 10 && m.markedAmount === 11 && m.markupAmount === 1 && m.marginPercent === 10 && m.source === 'best_rate');
}
check('awaiting: no base → no tuple', buildOrderRowMoneyDisplay({ ...MONEY_BASE, bestRateBaseAmount: null }) === null);
check('awaiting: no rule → marked = base, no margin',
  (() => {
    const m = buildOrderRowMoneyDisplay({ ...MONEY_BASE, markupRule: null })!;
    return m.markedAmount === 10 && m.markupAmount === 0 && m.marginPercent === null;
  })());
check('negative markup is clamped at 0 (FE breakdown clamp)',
  buildOrderRowMoneyDisplay({ ...MONEY_BASE, markupRule: { type: 'amount', value: -2 } })!.markupAmount === 0);
check('shipped: selected base prices the rule',
  (() => {
    const m = buildOrderRowMoneyDisplay({ ...MONEY_BASE, isAwaiting: false, bestRateBaseAmount: null, selectedRateBaseAmount: 8, markupRule: { type: 'amount', value: 2 } })!;
    return m.baseAmount === 8 && m.markedAmount === 10 && m.markupAmount === 2 && m.source === 'selected_rate';
  })());
check('shipped: only final label cost known → marked set, base/markup hidden (FE parity)',
  (() => {
    const m = buildOrderRowMoneyDisplay({ ...MONEY_BASE, isAwaiting: false, bestRateBaseAmount: null, labelFinalCost: 7.25 })!;
    return m.baseAmount === null && m.markedAmount === 7.98 && m.markupAmount === null;
  })());
check('insurance passes through positively only',
  buildOrderRowMoneyDisplay({ ...MONEY_BASE, insuranceAddOn: 1.09 })!.insuranceAddOn === 1.09 &&
  buildOrderRowMoneyDisplay({ ...MONEY_BASE, insuranceAddOn: 0 })!.insuranceAddOn === null);

// ── DTO emission discipline ───────────────────────────────────────────────────
const ROW_FACTS: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: null,
  canonicalServiceCode: null,
  canonicalAccountNickname: null,
  selectedRateCarrierCode: null,
  providerAccountId: 607855,
};
const baseDto = buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' });
check('DTO: no money facts → no money key (legacy callers byte-identical)',
  !('money' in withOrderRowWorkflow(baseDto, ROW_FACTS)));
check('DTO: money facts + financial viewer → tuple emitted',
  withOrderRowWorkflow(baseDto, {
    ...ROW_FACTS,
    money: { canViewFinancials: true, bestRateBaseAmount: 10, selectedRateBaseAmount: null, labelFinalCost: null, markupRule: { type: 'percent', value: 10 }, insuranceAddOn: null },
  }).money?.markedAmount === 11);
check('DTO: redacted viewer → money null (never leaks amounts)',
  withOrderRowWorkflow(baseDto, {
    ...ROW_FACTS,
    money: { canViewFinancials: false, bestRateBaseAmount: 10, selectedRateBaseAmount: null, labelFinalCost: null, markupRule: null, insuranceAddOn: null },
  }).money === null);

// ── wiring pins ───────────────────────────────────────────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('rates.ts applyMarkups delegates the math to the canonical owner',
  /amount: applyMarkupToAmount\(orig, m\)/.test(ratesService));
check('rates.ts loadCarrierMarkups is exported and parses via the canonical owner',
  /export async function loadCarrierMarkups/.test(ratesService) &&
  /parseMarkupSettingValue\(row\.value\)/.test(ratesService));
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('orders route loads the markup rules once per request (additive-safe)',
  /carrierMarkupRules = await loadCarrierMarkups\(\)/.test(ordersRoute) &&
  /markup rules lookup skipped/.test(ordersRoute));
check('orders route resolves the row rule via the pure module and passes money facts',
  /resolveOrderRowMarkupRule\(/.test(ordersRoute) &&
  /markupRule: rowMarkupRule/.test(ordersRoute) &&
  /insuranceAddOn: extractInsuranceAddOn\(rowIsAwaiting \? bestRateRecord : selectedRateRecord\)/.test(ordersRoute));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('FE Best Rate cell prefers the backend tuple',
  /const backendMoney = getBackendRowMoney\(displayOrder\)/.test(ordersView) &&
  /renderRateAmountWithMarkup\(backendMoney\.baseAmount, backendMoney\.markedAmount, backendMoney\.insuranceAddOn\)/.test(ordersView));
check('FE Margin cell prefers the backend tuple',
  /backendMoney\.markupAmount/.test(ordersView) && /backendMoney\.marginPercent/.test(ordersView));
check('FE deploy-skew fallback retained until Phase 6 (applyCarrierMarkup still wired)',
  /applyCarrierMarkup\(\{/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-177 row money display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-177 row money display guard');
