import assert from 'node:assert/strict';

const {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  resolveHugrabShippingRateOverride,
} = await import('../src/services/billing-hugrab-shipping-rate-override');

const defaulted = resolveHugrabShippingRateOverride({
  clientName: 'HUGRAB',
  customerShippingRate: 5.7,
  selectedRateCost: 5.7,
});

assert.equal(defaulted.customerShippingRate, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT);
assert.equal(defaulted.selectedRateCost, 5.7);
assert.equal(defaulted.overrideApplied, true);
assert.equal(defaulted.overrideThreshold, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD);

const custom = resolveHugrabShippingRateOverride({
  clientName: 'HUGRAB',
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
  clientName: 'HUGRAB',
  customerShippingRate: 6,
  selectedRateCost: 5.88,
});

assert.equal(aboveThreshold.customerShippingRate, 6);
assert.equal(aboveThreshold.selectedRateCost, 5.88);
assert.equal(aboveThreshold.overrideApplied, false);

const disabled = resolveHugrabShippingRateOverride({
  clientName: 'HUGRAB',
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

const notHugrab = resolveHugrabShippingRateOverride({
  clientName: 'Walmart - DJC',
  customerShippingRate: 4.42,
  selectedRateCost: 4.42,
});

assert.equal(notHugrab.customerShippingRate, 4.42);
assert.equal(notHugrab.selectedRateCost, 4.42);
assert.equal(notHugrab.overrideApplied, false);

const invalidTargetNeverLowers = resolveHugrabShippingRateOverride({
  clientName: 'HUGRAB',
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

console.log('PASS PS-366 HUGRAB shipping-rate override guard');
