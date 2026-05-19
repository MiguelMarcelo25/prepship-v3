import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'RECONCILIATION_REPORTS_PLAN.md';
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
  '## Reconciliation Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredReports = [
  'ShipStation orders vs local orders',
  '`orders.items` vs `order_items`',
  'ShipStation shipments vs local shipments',
  'Labels vs billing line items',
  'Billing summaries vs billing line items',
  'Inventory ledger vs displayed stock',
  'Package ledger vs package stock',
  'Rate cache vs actual label cost',
  'Fulfillment outbox vs sent confirmations',
  'Clients/stores vs ShipStation stores',
  'Carrier accounts vs credential records',
];

for (const report of requiredReports) {
  assert(plan.includes(report), `${planPath} tracks ${report}`);
}

const requiredControls = [
  'Canonical Source',
  'Local Source',
  'Mismatch Detection',
  'Repair Process',
  'read-only first',
  'dry-run repair',
  'separate from detection',
];

for (const control of requiredControls) {
  assert(plan.toLowerCase().includes(control.toLowerCase()), `${planPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:reconciliation-plan'] === 'node scripts/reconciliation-plan-guard.mjs',
  'package exposes reconciliation plan guard'
);
