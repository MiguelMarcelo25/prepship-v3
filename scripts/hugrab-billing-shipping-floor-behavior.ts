import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://user:pass@localhost:5432/prepship_test';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ||= 'test-jwt-secret';

const {
  DEFAULT_HUGRAB_SELECTED_RATE_BELOW,
  DEFAULT_HUGRAB_TARGET_SHIPPING,
  summarizeHugrabBillingShippingFloorCandidates,
} = await import('../src/services/hugrab-billing-shipping-floor');

type HugrabBillingShippingFloorCandidate = {
  billingLineId: number;
  orderId: number | null;
  orderNumber: string | null;
  shipDate: string | null;
  currentShipping: number;
  selectedRateCost: number;
};

const rows: HugrabBillingShippingFloorCandidate[] = [
  {
    billingLineId: 101,
    orderId: 1,
    orderNumber: '2101',
    shipDate: '2026-07-01T10:00:00.000Z',
    currentShipping: 5.7,
    selectedRateCost: 5.7,
  },
  {
    billingLineId: 102,
    orderId: 2,
    orderNumber: '2102',
    shipDate: '2026-07-01T11:00:00.000Z',
    currentShipping: 6.07,
    selectedRateCost: 6.07,
  },
];

const floor = summarizeHugrabBillingShippingFloorCandidates('floor', rows);
assert.equal(floor.action, 'floor');
assert.equal(floor.count, 2);
assert.equal(floor.selectedRateBelow, DEFAULT_HUGRAB_SELECTED_RATE_BELOW);
assert.equal(floor.targetShipping, DEFAULT_HUGRAB_TARGET_SHIPPING);
assert.equal(floor.currentTotal, 11.77);
assert.equal(floor.newTotal, 15.46);
assert.equal(floor.delta, 3.69);
assert.equal(floor.sampleRows[0]?.nextShipping, DEFAULT_HUGRAB_TARGET_SHIPPING);

const customFloor = summarizeHugrabBillingShippingFloorCandidates('floor', rows, {
  selectedRateBelow: 6.25,
  targetShipping: 6.15,
});
assert.equal(customFloor.selectedRateBelow, 6.25);
assert.equal(customFloor.targetShipping, 6.15);
assert.equal(customFloor.currentTotal, 11.77);
assert.equal(customFloor.newTotal, 12.3);
assert.equal(customFloor.delta, 0.53);
assert.equal(customFloor.sampleRows[0]?.nextShipping, 6.15);

const revert = summarizeHugrabBillingShippingFloorCandidates('revert', rows.map((row) => ({
  ...row,
  currentShipping: DEFAULT_HUGRAB_TARGET_SHIPPING,
})));
assert.equal(revert.action, 'revert');
assert.equal(revert.count, 2);
assert.equal(revert.currentTotal, 15.46);
assert.equal(revert.newTotal, 11.77);
assert.equal(revert.delta, -3.69);
assert.equal(revert.sampleRows[0]?.nextShipping, 5.7);

const customRevert = summarizeHugrabBillingShippingFloorCandidates(
  'revert',
  rows.map((row) => ({ ...row, currentShipping: 6.15 })),
  { selectedRateBelow: 6.25, targetShipping: 6.15 },
);
assert.equal(customRevert.currentTotal, 12.3);
assert.equal(customRevert.newTotal, 11.77);
assert.equal(customRevert.delta, -0.53);

const empty = summarizeHugrabBillingShippingFloorCandidates('floor', []);
assert.equal(empty.count, 0);
assert.equal(empty.currentTotal, 0);
assert.equal(empty.newTotal, 0);
assert.deepEqual(empty.sampleRows, []);

console.log('PASS HUGRAB billing shipping floor behavior');
