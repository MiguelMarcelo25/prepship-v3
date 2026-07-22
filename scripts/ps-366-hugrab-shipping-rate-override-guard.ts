import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { resolveAwaitingBestRatePriceDisplay } from '../web/src/components/Views/orders/best-rate-price-display';

const {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  resolveHugrabShippingRateOverride,
} = await import('../src/services/billing-hugrab-shipping-rate-override');

assert.equal(DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD, 6);
assert.equal(DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT, 7.73);

const configuredWithDefaults = resolveHugrabShippingRateOverride({
  customerShippingRate: 5.7,
  selectedRateCost: 5.7,
  config: { enabled: true },
});

assert.equal(configuredWithDefaults.customerShippingRate, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT);
assert.equal(configuredWithDefaults.selectedRateCost, 5.7);
assert.equal(configuredWithDefaults.overrideApplied, true);
assert.equal(configuredWithDefaults.overrideThreshold, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD);

const custom = resolveHugrabShippingRateOverride({
  customerShippingRate: 5.49,
  selectedRateCost: 5.49,
  config: {
    enabled: true,
    threshold: 6.25,
    amount: 6.15,
  },
});

assert.equal(custom.customerShippingRate, 6.15);
assert.equal(custom.selectedRateCost, 5.49);
assert.equal(custom.overrideApplied, true);
assert.equal(custom.overrideThreshold, 6.25);
assert.equal(custom.overrideAmount, 6.15);

const aboveThreshold = resolveHugrabShippingRateOverride({
  customerShippingRate: 5.88,
  selectedRateCost: 6,
  config: { enabled: true },
});

assert.equal(aboveThreshold.customerShippingRate, 5.88);
assert.equal(aboveThreshold.selectedRateCost, 6);
assert.equal(aboveThreshold.overrideApplied, false);

const aboveFloor = resolveHugrabShippingRateOverride({
  customerShippingRate: 6.82,
  selectedRateCost: 6.82,
  config: { enabled: true },
});

assert.equal(aboveFloor.customerShippingRate, 6.82);
assert.equal(aboveFloor.selectedRateCost, 6.82);
assert.equal(aboveFloor.overrideApplied, false);

const selectedRateTrigger = resolveHugrabShippingRateOverride({
  customerShippingRate: 6.5,
  selectedRateCost: 5.88,
  config: {
    enabled: true,
    threshold: 6,
    amount: 7.73,
  },
});

assert.equal(selectedRateTrigger.customerShippingRate, 7.73);
assert.equal(selectedRateTrigger.selectedRateCost, 5.88);
assert.equal(selectedRateTrigger.overrideApplied, true);

const billingDecision = decideShippingLineBilling({
  labelCost: 5.88,
  cShippingRateAmount: undefined,
  billingMode: 'label_cost',
  isBaselineCarrier: true,
  refUspsRate: 0,
  refUpsRate: 0,
  shippingMarkupPct: 0,
  shippingMarkupFlat: 0,
  hugrabShippingRateOverride: {
    selectedRateCost: 5.88,
    config: { enabled: true, threshold: 6, amount: 7.73 },
  },
});

assert.equal(billingDecision.billedAmount, 7.73);
assert.equal(billingDecision.source, 'label_cost');
assert.equal(billingDecision.markupApplied, false);

const gridMoney = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 5.88,
  labelFinalCost: 5.88,
  markupRule: null,
  insuranceAddOn: null,
  houseMarkedAmount: null,
  clientName: 'HUGRAB',
  hugrabShippingRateOverrideConfig: { enabled: true, threshold: 6, amount: 7.73 },
});

assert.equal(gridMoney?.selectedRateCost, 5.88);
assert.equal(gridMoney?.cShippingRateAmount, billingDecision.billedAmount);
assert.equal(gridMoney?.shippingMarginAmount, 1.85);
assert.equal(gridMoney?.markedAmount, 5.88);

const bestRateDisplay = resolveAwaitingBestRatePriceDisplay({
  markupSource: 'carrier_markup',
  selectedRateCost: gridMoney?.selectedRateCost,
  baseAmount: gridMoney?.baseAmount,
  cShippingRateAmount: gridMoney?.cShippingRateAmount,
  markedAmount: gridMoney?.markedAmount,
  insuranceAddOn: gridMoney?.insuranceAddOn,
  fallbackAmount: 5.88,
  customerRateSource: gridMoney?.customerRateSource,
});

assert.equal(bestRateDisplay.primaryAmount, 5.88);
assert.equal(bestRateDisplay.baseAmount, null);
assert.equal(bestRateDisplay.mode, 'single_amount');

const gridMoneyAtThreshold = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 6,
  labelFinalCost: 6,
  markupRule: null,
  insuranceAddOn: null,
  houseMarkedAmount: null,
  clientName: 'HUGRAB',
  hugrabShippingRateOverrideConfig: { enabled: true, threshold: 6, amount: 7.73 },
});

assert.equal(gridMoneyAtThreshold?.selectedRateCost, 6);
assert.equal(gridMoneyAtThreshold?.cShippingRateAmount, 6);
assert.equal(gridMoneyAtThreshold?.markedAmount, 6);

const disabled = resolveHugrabShippingRateOverride({
  customerShippingRate: 5.5,
  selectedRateCost: 5.5,
  config: {
    enabled: false,
    threshold: 6,
    amount: 6,
  },
});

assert.equal(disabled.customerShippingRate, 5.5);
assert.equal(disabled.selectedRateCost, 5.5);
assert.equal(disabled.overrideApplied, false);

const unconfigured = resolveHugrabShippingRateOverride({
  customerShippingRate: 4.42,
  selectedRateCost: 4.42,
});

assert.equal(unconfigured.customerShippingRate, 4.42);
assert.equal(unconfigured.selectedRateCost, 4.42);
assert.equal(unconfigured.overrideApplied, false);

const invalidTargetNeverLowers = resolveHugrabShippingRateOverride({
  customerShippingRate: 5.75,
  selectedRateCost: 5.75,
  config: {
    enabled: true,
    threshold: 6,
    amount: 5.25,
  },
});

assert.equal(invalidTargetNeverLowers.customerShippingRate, 5.75);
assert.equal(invalidTargetNeverLowers.selectedRateCost, 5.75);
assert.equal(invalidTargetNeverLowers.overrideApplied, false);

const configTable = readFileSync('web/src/components/Views/BillingConfigTable.tsx', 'utf8');
assert.match(configTable, /Selected < \$/);
assert.match(configTable, /Then C\. Ship \$/);

const billingService = readFileSync('src/services/billing.ts', 'utf8');
assert.doesNotMatch(billingService, /resolveHugrabShippingRateOverride/);
assert.match(billingService, /hugrabShippingRateOverride:\s*\{/);

const billingOwner = readFileSync('src/services/billing-shipping-line.ts', 'utf8');
assert.match(billingOwner, /resolveHugrabShippingRateOverride/);

const overrideOwner = readFileSync('src/services/billing-hugrab-shipping-rate-override.ts', 'utf8');
assert.doesNotMatch(overrideOwner, /clientName|upper\(c\.name\)|isHugrabClient/);
assert.match(overrideOwner, /input\.config\?\.enabled === true/);

const rateMoneyOwner = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
assert.match(rateMoneyOwner, /resolveHugrabShippingRateOverride/);
assert.match(rateMoneyOwner, /hugrabShippingRateOverrideConfig/);

const billingParity = readFileSync('web/src/components/Views/billing-parity.ts', 'utf8');
assert.match(billingParity, /hugrabShippingRateOverrideAmount:\s*Number\(c\.hugrabShippingRateOverrideAmount \?\? 7\.73\)/);
assert.match(billingParity, /hugrabShippingRateOverrideAmount:\s*parseNumber\(draft\.hugrabShippingRateOverrideAmount \|\| '7\.73'\)/);

console.log('PASS PS-367 HUGRAB C. Shipping Rate override guard');
