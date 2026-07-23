import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BILLING_POLICY_LEGACY,
  BILLING_POLICY_WEEKEND_ROLLFORWARD,
  BillingCalendarPolicyError,
  assertBillingWeekdayOperationAllowed,
  resolveBillingActivityInstant,
  resolveBillingCalendarDay,
} from '../src/services/billing-calendar-policy.js';

const effectiveDate = '2026-07-13';
const resolve = (day: string) => resolveBillingCalendarDay({
  actualActivityDay: day,
  effectiveDate,
});

assert.deepEqual(resolveBillingCalendarDay({ actualActivityDay: '2026-07-11' }), {
  actualActivityDay: '2026-07-11',
  billingEffectiveDay: '2026-07-11',
  policyVersion: BILLING_POLICY_LEGACY,
  rolledFromWeekend: false,
});
assert.equal(resolve('2026-07-11').billingEffectiveDay, '2026-07-11');
assert.equal(resolve('2026-07-12').billingEffectiveDay, '2026-07-12');

for (const day of [
  '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
]) {
  const result = resolve(day);
  assert.equal(result.billingEffectiveDay, day);
  assert.equal(result.policyVersion, BILLING_POLICY_WEEKEND_ROLLFORWARD);
  assert.equal(result.rolledFromWeekend, false);
}

assert.deepEqual(resolve('2026-07-18'), {
  actualActivityDay: '2026-07-18',
  billingEffectiveDay: '2026-07-20',
  policyVersion: BILLING_POLICY_WEEKEND_ROLLFORWARD,
  rolledFromWeekend: true,
});
assert.equal(resolve('2026-07-19').billingEffectiveDay, '2026-07-20');

assert.deepEqual(
  resolveBillingActivityInstant({
    activityAt: '2026-07-18T02:30:00.000Z',
    effectiveDate,
  }),
  {
    actualActivityDay: '2026-07-17',
    billingEffectiveDay: '2026-07-17',
    policyVersion: BILLING_POLICY_WEEKEND_ROLLFORWARD,
    rolledFromWeekend: false,
  },
);
assert.equal(resolveBillingActivityInstant({
  activityAt: '2026-03-08T08:30:00.000Z',
  effectiveDate: '2026-01-01',
}).billingEffectiveDay, '2026-03-09');
assert.equal(resolveBillingActivityInstant({
  activityAt: '2026-11-01T08:30:00.000Z',
  effectiveDate: '2026-01-01',
}).billingEffectiveDay, '2026-11-02');

assert.equal(resolveBillingCalendarDay({
  actualActivityDay: '2026-01-31', effectiveDate: '2026-01-01',
}).billingEffectiveDay, '2026-02-02');
assert.equal(resolveBillingCalendarDay({
  actualActivityDay: '2022-12-31', effectiveDate: '2022-01-01',
}).billingEffectiveDay, '2023-01-02');
assert.throws(
  () => resolveBillingCalendarDay({ actualActivityDay: '2026-02-31', effectiveDate }),
  /YYYY-MM-DD/,
);

assert.doesNotThrow(() => assertBillingWeekdayOperationAllowed({
  now: new Date('2026-07-18T18:00:00.000Z'),
}));
assert.throws(() => assertBillingWeekdayOperationAllowed({
  effectiveDate,
  now: new Date('2026-07-18T18:00:00.000Z'),
}), BillingCalendarPolicyError);
assert.doesNotThrow(() => assertBillingWeekdayOperationAllowed({
  effectiveDate,
  now: new Date('2026-07-20T18:00:00.000Z'),
}));

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('drizzle/0071_billing_weekend_rollforward.sql');
const billing = read('src/services/billing.ts');
const calendarPolicy = read('src/services/billing-calendar-policy.ts');
const boxCostBulk = read('src/services/billing-box-cost-bulk.ts');
const boxCostByDims = read('src/services/billing-box-cost-by-dims.ts');
const finalization = read('src/services/billing-finalization-policy.ts');
const invoice = read('src/routes/billing.ts');
const csv = read('src/routes/billing-invoice-csv.ts');
const detailTable = read('web/src/components/Views/BillingDetailTable.tsx');
const readiness = read('scripts/ps-434-billing-rollforward-readiness.ts');

assert.match(migration, /ADD COLUMN IF NOT EXISTS billing_effective_date/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS billing_policy_version/);
assert.match(migration, /billing_li_effective_date_idx[\s\S]*coalesce\(billing_effective_date, ship_date\)/);
assert.match(migration, /coalesce\(NEW\.billing_effective_date, NEW\.ship_date\)/);
assert.doesNotMatch(migration, /UPDATE\s+(?:public\.)?billing_line_items\s+SET/i);
assert.doesNotMatch(migration, /ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)/i);
assert.match(billing, /billingSourceCalendar\.billingEffectiveDay/);
assert.match(calendarPolicy, /export function billingLineEffectiveDayRangeSql/);
assert.match(billing, /billingLineEffectiveDayRangeSql/);
assert.match(boxCostBulk, /billingLineEffectiveDayRangeSql/);
assert.match(boxCostByDims, /billingLineEffectiveDayRangeSql/);
assert.doesNotMatch(billing, /gte\(billingPersistedEffectiveDaySql/);
assert.match(billing, /billingProviderActivityTimestampSql/);
assert.match(billing, /billingEffectiveDate: s\.billingEffectiveDate/);
assert.match(billing, /sourceMissingRow/);
assert.match(billing, /assertBillingWeekdayOperationAllowed/);
assert.match(finalization, /billingFinalizationEffectiveDay/);
assert.match(finalization, /assertBillingWeekdayOperationAllowed/);
assert.match(invoice, /billing_effective_date/);
assert.match(invoice, /billingLineEffectiveDaySql/);
assert.match(csv, /invoiceBillingActivityDateTimeCell/);
assert.match(detailTable, /row\.rolledFromWeekend === true/);
assert.doesNotMatch(detailTable, /getDay\(|getUTCDay\(|Saturday|Sunday/);
assert.match(readiness, /sql\.begin\('read only'/);
assert.match(readiness, /default_transaction_read_only: 'on'/);
assert.match(readiness, /historical_unchanged/);
assert.doesNotMatch(readiness, /\.unsafe\(|\b(?:insert|update|delete|truncate|alter|drop)\s+(?:into|table|from)\b/i);

console.log('PS-434 weekend billing roll-forward guard passed');
