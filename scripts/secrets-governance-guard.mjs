import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const matrixPath = 'SECRETS_GOVERNANCE_MATRIX.md';
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
  '## Credential Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(matrix.includes(heading), `${matrixPath} includes ${heading}`);
}

const requiredCredentialTypes = [
  'Supabase service role key',
  'Supabase JWT secret/JWKS config',
  'Default ShipStation v1 key/secret',
  'Default ShipStation v2 key',
  'Client ShipStation keys',
  'Carrier account credentials',
  'Store account credentials',
  'eBay OAuth refresh token',
  'Walmart/Amazon marketplace secrets',
  'Direct carrier credentials/OAuth',
  'Label PDFs and signed URLs',
];

for (const credentialType of requiredCredentialTypes) {
  assert(matrix.includes(credentialType), `${matrixPath} tracks ${credentialType}`);
}

const requiredControls = [
  'rotation',
  'last-used',
  'audit events',
  'log redaction',
  'production smoke',
  'public client serializer',
  'shared credential-account',
];

for (const control of requiredControls) {
  assert(matrix.toLowerCase().includes(control.toLowerCase()), `${matrixPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:secrets-governance'] === 'node scripts/secrets-governance-guard.mjs',
  'package exposes secrets governance guard'
);
