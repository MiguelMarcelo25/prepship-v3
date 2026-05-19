import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'DURABLE_JOBS_PLAN.md';
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
  '## Job Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredJobs = [
  'Sync scheduler orders',
  'Sync scheduler shipments',
  'Reporting refresh',
  'Rate backfill best rates',
  'Billing reference-rate fetch',
  'Print queue batch send',
  'Print queue PDF merge',
  'Fulfillment outbox',
];

for (const job of requiredJobs) {
  assert(plan.includes(job), `${planPath} tracks ${job}`);
}

const requiredControls = [
  'Restart Behavior',
  'Multi-Instance Risk',
  'Idempotency Key',
  'Durable Target',
  'client ids',
  'store ids',
  'cancellation',
  'artifact',
  'signed/expiring',
  'Do not change label purchase',
];

for (const control of requiredControls) {
  assert(plan.toLowerCase().includes(control.toLowerCase()), `${planPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:durable-jobs-plan'] ===
    'node scripts/durable-jobs-plan-guard.mjs',
  'package exposes durable jobs plan guard'
);
