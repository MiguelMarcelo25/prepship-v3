import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'PRODUCTION_READINESS_SIGNOFF.md';
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
  '## Signoff Matrix',
  '## Release Evidence Template',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredGates = [
  'Local typecheck',
  'Web build',
  'Security guards',
  'Frontend failure guards',
  'Rate system guard',
  'API auth smoke',
  'Secret response smoke',
  'Browser tools smoke',
  'Version parity',
  'Render logs',
  'Supabase health',
  'Migration status',
  'Reconciliation checks',
  'Alert/runbook readiness',
  'Rollback readiness',
];

for (const gate of requiredGates) {
  assert(plan.includes(gate), `${planPath} tracks ${gate}`);
}

const requiredEvidence = [
  'Git commit',
  'Vercel frontend deploy',
  'Render API deploy',
  'Render worker deploy',
  'Migrations applied',
  'Browser smoke passed',
  'API auth/security smoke passed',
  'Rollback plan',
  'Final owner approval',
];

for (const evidence of requiredEvidence) {
  assert(plan.includes(evidence), `${planPath} includes evidence field ${evidence}`);
}

assert(
  packageJson.scripts?.['test:production-signoff'] ===
    'node scripts/production-signoff-guard.mjs',
  'package exposes production signoff guard'
);
