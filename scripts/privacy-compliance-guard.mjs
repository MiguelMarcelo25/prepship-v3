import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'PRIVACY_COMPLIANCE_PLAN.md';
const plan = fs.readFileSync(path.join(root, planPath), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const requiredHeadings = [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Data Class Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredDataClasses = [
  'Customer PII',
  'Order identifiers',
  'Label artifacts',
  'Billing data',
  'Credentials/secrets',
  'Logs/telemetry',
  'User/admin metadata',
  'Generated reports',
];

for (const dataClass of requiredDataClasses) {
  assert(plan.includes(dataClass), `${planPath} tracks ${dataClass}`);
}

const requiredControls = [
  'retention',
  'deletion',
  'field-level',
  'log redaction',
  'least-privilege',
  'quarterly access review',
  'signed',
  'expiring',
  'privacy incident',
  'no raw tokens',
];

for (const control of requiredControls) {
  assert(plan.toLowerCase().includes(control.toLowerCase()), `${planPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:privacy-compliance'] ===
    'node scripts/privacy-compliance-guard.mjs',
  'package exposes privacy compliance guard'
);
