import { readFileSync } from 'node:fs';

const audit = readFileSync('RAW_ERROR_RESPONSE_AUDIT.md', 'utf8');
const security = readFileSync('SECURITY_PATCH_PLAN.md', 'utf8');
const devTasks = readFileSync('DEV_TASKS_README.md', 'utf8');
const enterprise = readFileSync('ENTERPRISE_READINESS_AUDIT.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

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
  'safePublicError',
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
