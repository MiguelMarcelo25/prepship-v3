import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calendarStoragePeriodsForRange } from '../src/services/billing-storage';

const read = (path: string) => readFileSync(path, 'utf8');

const weeklyA = calendarStoragePeriodsForRange('2026-07-01', '2026-07-08');
const weeklyB = calendarStoragePeriodsForRange('2026-07-22', '2026-07-29');
assert.deepEqual(
  weeklyA.map((period) => period.monthKey),
  ['2026-07'],
  'a weekly refresh resolves to one calendar-month storage identity',
);
assert.deepEqual(
  weeklyB.map((period) => period.monthKey),
  ['2026-07'],
  'another week in the same month resolves to the same identity',
);
assert.equal(weeklyA[0]?.periodStart.toISOString(), '2026-07-01T00:00:00.000Z');
assert.equal(weeklyA[0]?.periodEnd.toISOString(), '2026-08-01T00:00:00.000Z');
assert.equal(weeklyA[0]?.lineDate.toISOString(), '2026-07-31T00:00:00.000Z');

const migration = read('drizzle/0077_ps462_billing_storage_month.sql');
assert.match(migration, /billing_li_storage_month_unq/);
assert.match(migration, /PS462_STORAGE_MONTH_DUPLICATES/);
assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im);

const billing = read('src/services/billing.ts');
const storageBlock = billing.slice(billing.indexOf('Storage fees (PS-373'));
assert.match(storageBlock, /calendarStoragePeriodsForRange\(input\.dateFrom, input\.dateTo\)/);
assert.match(storageBlock, /`billing-storage:\$\{clientId\}:\$\{monthKey\}`/);
assert.match(storageBlock, /const description = `Storage — \$\{monthKey\}`/);
assert.ok(
  storageBlock.includes('where client_id = any(${intArraySql(storageClientIds)})'),
  'storage loads every catalog row for the billed clients',
);
assert.doesNotMatch(storageBlock, /where client_id = any\([^)]*\) and active = true/s);

const route = read('src/routes/billing.ts');
const editBlock = route.slice(
  route.indexOf("app.patch('/details/:orderId"),
  route.indexOf('// ─── PS-275:'),
);
assert.match(editBlock, /requireAdmin, requirePermission\('financials:write'\)/);
assert.match(route, /reason: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)/);
assert.match(editBlock, /const before = await tx/);
assert.match(editBlock, /const after = await tx/);
assert.match(editBlock, /recordRequiredAuditEventInTransaction\(tx/);
assert.match(editBlock, /resourceType: 'billing_invoice_line_edit'/);
assert.match(editBlock, /reason: body\.reason/);

const auditMigration = read('drizzle/0044_audit_log.sql');
assert.match(auditMigration, /audit_log_no_update_delete/);

console.log('PASS PS-462 billing source-of-truth boundary guard');
