import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const matrixPath = 'AUDIT_LOGGING_MATRIX.md';
const matrix = fs.readFileSync(path.join(root, matrixPath), 'utf8');
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
  '## Audit Event Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(matrix.includes(heading), `${matrixPath} includes ${heading}`);
}

const requiredActions = [
  'user login/logout',
  'admin role/user permission change',
  'client create/update/delete',
  'client ShipStation credential update',
  'carrier account create/update/delete',
  'store account create/update/delete',
  'marketplace OAuth callback/token refresh',
  'label create/void/return',
  'order manual edit',
  'shipped/cancelled force override',
  'inventory receive/adjust',
  'package receive/adjust/delete',
  'settings changes',
  'billing config/generation/export',
  'sync/backfill/reporting job lifecycle',
  'print queue add/clear/delete/print job',
];

for (const action of requiredActions) {
  assert(matrix.includes(action), `${matrixPath} tracks ${action}`);
}

const requiredControls = [
  'append-only',
  'Actor Captured?',
  'Before/After Captured?',
  'Required Event Fields',
  'never store raw credentials',
  'separate reviewed batch',
];

for (const control of requiredControls) {
  assert(matrix.toLowerCase().includes(control.toLowerCase()), `${matrixPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:audit-logging'] === 'node scripts/audit-logging-guard.mjs',
  'package exposes audit logging guard'
);
