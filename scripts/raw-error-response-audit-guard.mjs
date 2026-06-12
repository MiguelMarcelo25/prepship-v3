import { existsSync, readFileSync } from 'node:fs';

const audit = readFileSync('RAW_ERROR_RESPONSE_AUDIT.md', 'utf8');
const security = readFileSync('SECURITY_PATCH_PLAN.md', 'utf8');
const devTasks = readFileSync('DEV_TASKS_README.md', 'utf8');
const enterprise = readFileSync('ENTERPRISE_READINESS_AUDIT.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const safeErrorHelperPath = 'api/_lib/safe-error.ts';

const checks = [];

function expect(name, condition) {
  checks.push({ name, condition: Boolean(condition) });
}

for (const heading of [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
]) {
  expect(`audit includes ${heading}`, audit.includes(heading));
}

for (const phrase of [
  'generic production-safe `500`',
  'full detail logs server-side',
  'api/carriers/labels.ts',
  'api/carriers/rates.ts',
  'api/carriers/walmart/orders.ts',
  'api/carriers/ebay/orders.ts',
  'src/routes/labels.ts',
  'sendInternalServerError',
  'forced-failure tests',
  'Label and shipment handlers need separate review',
]) {
  expect(`audit covers ${phrase}`, audit.includes(phrase));
}

expect(
  'package exposes raw error audit guard',
  packageJson.scripts?.['test:raw-error-response-audit'] ===
    'node scripts/raw-error-response-audit-guard.mjs'
);

expect('safe error helper exists', existsSync(safeErrorHelperPath));
if (existsSync(safeErrorHelperPath)) {
  const safeErrorHelper = readFileSync(safeErrorHelperPath, 'utf8');
  expect(
    'safe error helper keeps public 500 generic',
    safeErrorHelper.includes('INTERNAL_SERVER_ERROR') &&
      safeErrorHelper.includes('sendInternalServerError') &&
      safeErrorHelper.includes('Internal server error')
  );
}

for (const file of [
  'api/carriers/validate-address.ts',
  'api/carriers/ups/probe.ts',
  'api/carriers/walmart/probe-carriers.ts',
  'api/carriers/walmart/fees.ts',
  'api/cron/sync-walmart-fees.ts',
  'api/carriers/walmart/orders.ts',
  'api/carriers/ebay/orders.ts',
  'api/carriers/rates.ts',
  // api/carriers/verify.ts and src/lib/imported-handlers/carriers-verify.ts are
  // one-line re-export shims for the real handler below; assert the handler.
  'src/connectors/carrier/credential-verification.ts',
  'src/lib/imported-handlers/carrier-accounts.ts',
  // PS-200 part 2 (2026-06-12): api/migrate-from.ts and
  // api/admin/fix-marketplace-timestamps.ts were one-shot tools, deleted —
  // an absent endpoint can't leak raw errors, so dropping their entries
  // keeps the audit's intent (no raw 500 bodies) with no weakening.
]) {
  const content = readFileSync(file, 'utf8');
  expect(`${file} uses safe 500 helper`, content.includes('sendInternalServerError'));
}

expect(
  'security plan references raw error response audit',
  security.includes('RAW_ERROR_RESPONSE_AUDIT.md') &&
    security.includes('test:raw-error-response-audit')
);

expect(
  'phase tracker references raw error response audit',
  devTasks.includes('RAW_ERROR_RESPONSE_AUDIT.md') &&
    devTasks.includes('test:raw-error-response-audit')
);

expect(
  'enterprise audit references raw error response audit',
  enterprise.includes('RAW_ERROR_RESPONSE_AUDIT.md') &&
    enterprise.includes('test:raw-error-response-audit')
);

const failed = checks.filter((check) => !check.condition);
if (failed.length) {
  console.error('Raw error response audit guard failed:');
  for (const check of failed) console.error(`- ${check.name}`);
  process.exit(1);
}

console.log(`Raw error response audit guard passed (${checks.length} checks).`);
