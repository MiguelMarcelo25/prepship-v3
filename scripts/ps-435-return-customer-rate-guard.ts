import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret';

const {
  assertReturnCustomerShippingPolicyConfigured,
  resolveCustomerShippingMoney,
  ReturnCustomerShippingPolicyUnavailableError,
} = await import('../src/services/customer-shipping-money');

assert.throws(
  () => assertReturnCustomerShippingPolicyConfigured({
    clientName: 'Unconfigured Client',
    hugrabOverrideEnabled: false,
    billingMode: 'per_shipment',
    carrierCode: 'ups',
    refUspsRate: null,
    refUpsRate: null,
    hasResolvedMarkup: false,
  }),
  ReturnCustomerShippingPolicyUnavailableError,
  'missing/all-zero config cannot rename provider cost as customer return postage',
);

assert.doesNotThrow(() => assertReturnCustomerShippingPolicyConfigured({
  clientName: 'HUGRAB',
  hugrabOverrideEnabled: true,
  billingMode: 'per_shipment',
  carrierCode: 'stamps_com',
  refUspsRate: null,
  refUpsRate: null,
  hasResolvedMarkup: false,
}));

assert.doesNotThrow(() => assertReturnCustomerShippingPolicyConfigured({
  clientName: 'Configured Markup Client',
  hugrabOverrideEnabled: false,
  billingMode: 'per_shipment',
  carrierCode: 'ups',
  refUspsRate: null,
  refUpsRate: null,
  hasResolvedMarkup: true,
}));

assert.doesNotThrow(() => assertReturnCustomerShippingPolicyConfigured({
  clientName: 'Configured Reference Client',
  hugrabOverrideEnabled: false,
  billingMode: 'reference_rate',
  carrierCode: 'ups',
  refUspsRate: 8.25,
  refUpsRate: null,
  hasResolvedMarkup: false,
}));

for (const selectedRateCost of [5.70, 5.58]) {
  const decision = resolveCustomerShippingMoney({
    selectedRateCost,
    billingMode: 'per_shipment',
    carrierCode: 'stamps_com',
    clientName: 'HUGRAB',
    hugrabShippingRateOverride: { enabled: true, threshold: 6, amount: 7.73 },
  });
  assert.equal(decision.cShippingRateAmount, 7.73);
  assert.notEqual(
    decision.cShippingRateAmount,
    selectedRateCost,
    `fixture ${selectedRateCost.toFixed(2)} returns customer policy money, not provider cost`,
  );
}

const owner = fs.readFileSync('src/services/customer-shipping-money.ts', 'utf8');
const route = fs.readFileSync('src/routes/client-portal/integrations.ts', 'utf8');
const audit = fs.readFileSync('scripts/ps-437-return-money-audit.ts', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};
const previewBlock = route.slice(
  route.indexOf("'/customer-shipping-money/return-preview'"),
  route.indexOf("'/customer-shipping-money/return-preview'") + 2600,
);

assert.match(owner, /requireExplicitReturnPolicy:\s*true/);
assert.match(owner, /Never let the generic label-cost fallback become a customer return rate/);
assert.match(owner, /decision\.cShippingRateAmount - decision\.selectedRateCost/);
assert.match(route, /customer-shipping-money\/return-preview/);
assert.match(previewBlock, /isClientVisibleToScope/);
assert.match(previewBlock, /cShippingRateAmount:\s*preview\.cShippingRateAmount/);
assert.doesNotMatch(
  previewBlock,
  /selectedRateCost:\s*preview|shippingMarginAmount:\s*preview|shippingMarginPct:\s*preview/,
);
for (const category of [
  'snapshot_equals_raw_cost',
  'missing_frozen_snapshot',
  'missing_return_customer_shipping_rate',
  'zero_or_offline_snapshot',
  'billing_return_postage_mismatch',
]) {
  assert.match(audit, new RegExp(category));
}
assert.match(audit, /mode:\s*'read-only'/);
assert.equal(
  pkg.scripts?.['audit:ps-435-return-customer-rate'],
  'tsx scripts/ps-437-return-money-audit.ts',
);

console.log('PS-435 return customer-rate source-of-truth guard passed.');
