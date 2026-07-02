import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://user:pass@localhost:5432/prepship_test';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ||= 'test-jwt-secret';

const {
  HUGRAB_TARGET_SHIPPING,
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
assert.equal(floor.currentTotal, 11.77);
assert.equal(floor.newTotal, 15.46);
assert.equal(floor.delta, 3.69);
assert.equal(floor.sampleRows[0]?.nextShipping, HUGRAB_TARGET_SHIPPING);

const revert = summarizeHugrabBillingShippingFloorCandidates('revert', rows.map((row) => ({
  ...row,
  currentShipping: HUGRAB_TARGET_SHIPPING,
})));
assert.equal(revert.action, 'revert');
assert.equal(revert.count, 2);
assert.equal(revert.currentTotal, 15.46);
assert.equal(revert.newTotal, 11.77);
assert.equal(revert.delta, -3.69);
assert.equal(revert.sampleRows[0]?.nextShipping, 5.7);

const empty = summarizeHugrabBillingShippingFloorCandidates('floor', []);
assert.equal(empty.count, 0);
assert.equal(empty.currentTotal, 0);
assert.equal(empty.newTotal, 0);
assert.deepEqual(empty.sampleRows, []);

console.log('PASS HUGRAB billing shipping floor behavior');
