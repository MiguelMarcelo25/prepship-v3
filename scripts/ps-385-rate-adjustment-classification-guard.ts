/**
 * PS-385 guard - rate adjustment classification separates true cost from profit.
 *
 * Pure/offline: no DB, no network, no labels, no provider calls, no shipment writes.
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'guard-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'guard-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'guard-jwt-secret';

const {
  buildOrderRowMoneyDisplay,
  parseMarkupSettingValue,
} = await import('../src/services/shipping-workflow/rate-money');
const {
  applyCanonicalMarkup,
  markupRuleToCanonical,
  resolveCanonicalMarkup,
} = await import('../src/services/shipping-workflow/markup-resolver');
const { decideShippingLineBilling } = await import('../src/services/billing-shipping-line');
const { applyMarkups } = await import('../src/services/rates');
const { rateCostTotal, rateTotal } = await import('../src/services/rates-combined');

const trueCostRule = parseMarkupSettingValue(
  JSON.stringify({ type: 'pct', value: 15, basis: 'true_cost_uplift' }),
)!;
assert.equal(trueCostRule.type, 'percent');
assert.equal(trueCostRule.value, 15);
assert.equal(trueCostRule.adjustmentKind, 'true_cost_uplift');

const profitRule = parseMarkupSettingValue(
  JSON.stringify({ type: 'pct', value: 15, basis: 'customer_profit_markup' }),
)!;
assert.equal(profitRule.adjustmentKind, 'customer_profit_markup');

const legacyRule = parseMarkupSettingValue(JSON.stringify({ type: 'pct', value: 15 }))!;
assert.equal(
  'adjustmentKind' in legacyRule,
  false,
  'legacy markup JSON must keep the old parsed shape unless classification is explicit',
);

const rate = {
  carrier_id: 'se-orion',
  carrier_code: 'ups',
  service_code: 'ups_ground',
  shipping_amount: { amount: 100, currency: 'USD' },
  other_amount: { amount: 0, currency: 'USD' },
} as any;

const [trueCostRate] = applyMarkups([rate], new Map<string, any>([['se-orion', trueCostRule]]));
assert.equal(rateCostTotal(trueCostRate), 115, 'true-cost uplift belongs in selected/internal cost');
assert.equal(rateTotal(trueCostRate), 115, 'true-cost uplift is the Best Rate ranking cost');
assert.equal((trueCostRate as any).shippingMarginAmount, 0, 'true-cost uplift is not profit margin');
assert.equal((trueCostRate as any).rateAdjustmentKind, 'true_cost_uplift');
assert.equal((trueCostRate as any).rateCostSource, 'carrier_true_cost_uplift');

const [profitRate] = applyMarkups([rate], new Map<string, any>([['se-orion', profitRule]]));
assert.equal(rateCostTotal(profitRate), 100, 'profit markup must not change selected/internal cost');
assert.equal(rateTotal(profitRate), 115, 'profit markup changes customer/ranking display amount');
assert.equal((profitRate as any).shippingMarginAmount, 15, 'profit markup creates shipping margin');
assert.equal((profitRate as any).rateAdjustmentKind, 'customer_profit_markup');

const trueCostRow = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 100,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: trueCostRule,
  markupRuleCanonical: undefined,
  insuranceAddOn: null,
})!;
assert.equal(trueCostRow.selectedRateCost, 115, 'row Selected/Best Rate true cost includes true-cost uplift');
assert.equal(trueCostRow.cShippingRateAmount, 115, 'row C. Shipping matches true cost when no profit markup exists');
assert.equal(trueCostRow.shippingMarginAmount, 0, 'true-cost uplift is not row margin');
assert.equal(trueCostRow.rateAdjustmentKind, 'true_cost_uplift');
assert.equal(trueCostRow.rateCostSource, 'carrier_true_cost_uplift');

const profitRow = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 100,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: profitRule,
  markupRuleCanonical: undefined,
  insuranceAddOn: null,
})!;
assert.equal(profitRow.selectedRateCost, 100, 'row Selected/Best Rate excludes profit markup');
assert.equal(profitRow.cShippingRateAmount, 115, 'row C. Shipping includes profit markup');
assert.equal(profitRow.shippingMarginAmount, 15, 'profit markup remains margin');
assert.equal(profitRow.rateAdjustmentKind, 'customer_profit_markup');

const trueCostCanonical = markupRuleToCanonical(trueCostRule)!;
assert.equal(trueCostCanonical.adjustmentKind, 'true_cost_uplift');
assert.equal(applyCanonicalMarkup(100, trueCostCanonical), 115);

const resolvedTrueCost = resolveCanonicalMarkup({
  carrierAccountMarkup: trueCostRule,
  clientShippingMarkupPct: 12,
  clientShippingMarkupFlat: 0,
})!;
assert.equal(resolvedTrueCost.adjustmentKind, 'true_cost_uplift', 'per-account true-cost override wins');

const trueCostBilling = decideShippingLineBilling({
  labelCost: 115,
  billingMode: 'label_cost',
  isBaselineCarrier: true,
  refUspsRate: 0,
  refUpsRate: 0,
  shippingMarkupPct: resolvedTrueCost.pct,
  shippingMarkupFlat: resolvedTrueCost.flat,
  shippingMarkupKind: resolvedTrueCost.adjustmentKind,
});
assert.equal(
  Math.round(trueCostBilling.billedAmount * 100) / 100,
  115,
  'Billing must not reapply true-cost uplift as customer profit markup',
);
assert.equal(trueCostBilling.markupApplied, false);

const profitBilling = decideShippingLineBilling({
  labelCost: 100,
  billingMode: 'label_cost',
  isBaselineCarrier: true,
  refUspsRate: 0,
  refUpsRate: 0,
  shippingMarkupPct: 15,
  shippingMarkupFlat: 0,
  shippingMarkupKind: 'customer_profit_markup',
});
assert.equal(Math.round(profitBilling.billedAmount * 100) / 100, 115, 'Billing still applies customer profit markup');
assert.equal(profitBilling.markupApplied, true);

console.log('PASS PS-385 rate adjustment classification guard');
