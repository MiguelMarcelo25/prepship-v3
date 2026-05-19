import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md';
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
  '## Runbook Matrix',
  '## Deployment / Rollback Matrix',
  '## Disaster Recovery Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredRunbooks = [
  'Rates not loading',
  'Label creation failing',
  'ShipStation outage',
  'Direct carrier outage',
  'Sync stuck',
  'Inventory mismatch',
  'Billing totals missing or zero',
  'Print queue stuck',
  'Frontend white screen',
  'User locked out',
  'Credential rotation',
  'Database restore',
  'Rollback deploy',
  'Suspicious access/security event',
];

for (const runbook of requiredRunbooks) {
  assert(plan.includes(runbook), `${planPath} tracks ${runbook}`);
}

const requiredControls = [
  'Owner',
  'Verification',
  'Rollback Step',
  'Supabase database backups',
  'Environment variables',
  'RTO/RPO',
  'restore drill',
  'staging',
  'alert',
  'preserve evidence',
];

for (const control of requiredControls) {
  assert(plan.toLowerCase().includes(control.toLowerCase()), `${planPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:operational-runbooks'] ===
    'node scripts/operational-runbooks-guard.mjs',
  'package exposes operational runbooks guard'
);
