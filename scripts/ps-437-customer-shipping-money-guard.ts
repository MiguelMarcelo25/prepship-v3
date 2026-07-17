import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret';

const {
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  readFrozenCustomerShippingMoney,
  resolveCustomerShippingMoney,
} = await import('../src/services/customer-shipping-money');
const {
  getInternalOpsClientStoreScope,
  isClientVisibleToScope,
} = await import('../src/lib/client-store-scope');
const { hasAppPermission } = await import('../src/middleware/auth');

const below = resolveCustomerShippingMoney({
  selectedRateCost: 5.70,
  billingMode: 'per_shipment',
  carrierCode: 'stamps_com',
  clientName: 'HUGRAB',
  hugrabShippingRateOverride: { enabled: true, threshold: 6, amount: 6.77 },
});
assert.equal(below.selectedRateCost, 5.70);
assert.equal(below.cShippingRateAmount, 6.77);
assert.equal(below.shippingMarginAmount, 1.07);
assert.equal(below.customerRateSource, 'hugrab_shipping_rate_override');

const exact = resolveCustomerShippingMoney({
  selectedRateCost: 6,
  clientName: 'HUGRAB',
  hugrabShippingRateOverride: { enabled: true, threshold: 6, amount: 6.77 },
});
assert.equal(exact.cShippingRateAmount, 6, 'exact threshold does not trigger');

const above = resolveCustomerShippingMoney({
  selectedRateCost: 6.01,
  clientName: 'HUGRAB',
  hugrabShippingRateOverride: { enabled: true, threshold: 6, amount: 6.77 },
});
assert.equal(above.cShippingRateAmount, 6.01, 'above threshold follows normal pricing');

assert.throws(
  () => resolveCustomerShippingMoney({ selectedRateCost: 0 }),
  /selected\/purchased label cost/i,
  'missing policy input fails closed instead of renaming raw/zero cost',
);

assert.equal(readFrozenCustomerShippingMoney({
  selectedRateCost: 5.70,
  cShippingRateAmount: 6.77,
  shippingMarginAmount: 1.07,
  shippingMarginPct: 15.8,
  customerRateSource: 'hugrab_shipping_rate_override',
  rateCostSource: 'label_final_cost',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
})?.cShippingRateAmount, 6.77);
assert.equal(readFrozenCustomerShippingMoney({
  selectedRateCost: 5.70,
  cShippingRateAmount: 6.77,
}), null, 'partial/legacy rate objects are not promoted to frozen truth');

const portalScope = getInternalOpsClientStoreScope({
  role: 'client_user',
  clientIds: [41],
  storeIds: [901],
});
assert.equal(isClientVisibleToScope({ id: 41 }, portalScope), true);
assert.equal(isClientVisibleToScope({ id: 42, storeIds: [901] }, portalScope), true);
assert.equal(isClientVisibleToScope({ id: 42, storeIds: [902] }, portalScope), false);
assert.equal(
  getInternalOpsClientStoreScope({ role: 'operator' }).isGlobal,
  true,
  'internal operators retain global operations scope',
);
assert.equal(
  hasAppPermission({ role: 'client_user' }, 'billing:generate'),
  true,
  'portal clients can call the scoped freeze endpoint',
);
assert.equal(
  hasAppPermission({ role: 'read_only_support' }, 'billing:generate'),
  false,
  'read-only support cannot freeze shipment money',
);

const billing = fs.readFileSync('src/services/billing.ts', 'utf8');
const route = fs.readFileSync('src/routes/client-portal/integrations.ts', 'utf8');
const owner = fs.readFileSync('src/services/customer-shipping-money.ts', 'utf8');
const reconciliation = fs.readFileSync('scripts/ps-437-reconcile-return-money.ts', 'utf8');
assert.match(billing, /resolveCustomerShippingMoney\(\{/);
assert.match(route, /customer-shipping-money\/freeze/);
assert.match(route, /requirePermission\('billing:generate'\)/);
assert.match(route, /isClientVisibleToScope\(\{ id: target\.clientId, storeIds: target\.storeIds \}, scope\)/);
assert.match(owner, /const selectedRateCost = finiteNumber\(row\.selectedRateCost\)/);
assert.doesNotMatch(owner, /resolveBillingSelectedRateCost/);
assert.match(owner, /previewShipmentCustomerShippingMoneyWithSelectedRateCost/);
assert.match(owner, /Per user override unlock shipped data on 2026-05-23: PS-437/);
assert.match(reconciliation, /--confirm-production/);
assert.match(reconciliation, /--expected-count=/);
assert.match(reconciliation, /DryRunRollback/);
assert.match(reconciliation, /from billing_line_items/);
assert.match(reconciliation, /for update of r, s/);
assert.match(reconciliation, /Per user override unlock shipped data on 2026-05-23: PS-437/);
assert.doesNotMatch(reconciliation, /createExternalLabel|purchaseLabel|notifyMarketplace/);
const responseBlock = route.slice(route.indexOf("'/customer-shipping-money/freeze'"), route.indexOf("'/customer-shipping-money/freeze'") + 2200);
assert.doesNotMatch(responseBlock, /selectedRateCost:\s*snapshot|shippingMarginAmount:\s*snapshot/);

console.log('PS-437 canonical customer shipping money guard passed.');
