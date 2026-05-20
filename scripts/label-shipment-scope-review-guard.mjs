import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

const planPath = 'LABEL_SHIPMENT_SCOPE_REVIEW.md';
const plan = read(planPath);
const matrix = read('RBAC_CLIENT_SCOPE_MATRIX.md');
const readme = read('DEV_TASKS_README.md');
const enterprise = read('ENTERPRISE_READINESS_AUDIT.md');
const packageJson = JSON.parse(read('package.json'));

const requiredHeadings = [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Route Inventory',
  '## Required Policies',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredRouteEntries = [
  'Phase 12 Batch 3J',
  'No runtime label, shipment, shipped/cancelled, fulfillment, or schema behavior changes are included',
  '`POST` | `src/routes/labels.ts` -> `createLabelV2`',
  '`POST` | `src/routes/labels.ts` -> `createBatchV2`',
  '`/labels/:shipmentId/void`',
  '`/labels/:lookup/retrieve`',
  '`/shipments`',
  '`/shipments/sync`',
];

for (const entry of requiredRouteEntries) {
  assert(plan.includes(entry), `${planPath} covers ${entry}`);
}

const requiredPolicies = [
  'labels:create',
  'labels:void',
  'labels:return',
  'labels:read',
  'shipments:read',
  'shipments:sync',
  'Batch label creation must validate every order before side effects',
  'Label PDFs and label URLs are customer PII',
  'Preserve shipped/cancelled label creation guard',
  'Preserve existing inventory/package auto-deduct kill-switch behavior',
];

for (const policy of requiredPolicies) {
  assert(plan.includes(policy), `${planPath} documents ${policy}`);
}

assert(
  matrix.includes('[x] Label/shipment-sensitive route policy review completed as `LABEL_SHIPMENT_SCOPE_REVIEW.md`.') &&
    matrix.includes('`npm run test:label-shipment-scope-review` guards the label/shipment policy review.'),
  'RBAC matrix records the label/shipment review and guard',
);

assert(
  readme.includes('`LABEL_SHIPMENT_SCOPE_REVIEW.md`') &&
    readme.includes('Phase 12 - Enterprise Readiness | Scoped/started | 98%') &&
    readme.includes('`npm run test:label-shipment-scope-review`'),
  'phase README records Phase 12 label/shipment review progress',
);

assert(
  enterprise.includes('LABEL_SHIPMENT_SCOPE_REVIEW.md') &&
    enterprise.toLowerCase().includes('label/shipment-sensitive route policy review is completed') &&
    enterprise.includes('`npm run test:label-shipment-scope-review`'),
  'enterprise audit records label/shipment review progress',
);

assert(
  packageJson.scripts?.['test:label-shipment-scope-review'] ===
    'node scripts/label-shipment-scope-review-guard.mjs',
  'package exposes label/shipment scope review guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
