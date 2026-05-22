import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const docPath = path.join(root, 'docs', 'enterprise-readiness-closeout.md');
const doc = readFileSync(docPath, 'utf8');

function pass(message) {
  console.log(`PASS ${message}`);
}

function check(condition, message) {
  assert(condition, message);
  pass(message);
}

const requiredHeadings = [
  '# Enterprise Readiness Closeout',
  '## Status Legend',
  '## Executive Summary',
  '## Readiness Category Matrix',
  '## Required Evidence For Signoff',
  '## Runtime Label / Shipment Scope Enforcement',
  '## Client / Store Isolation',
  '## RBAC Enforcement',
  '## Secret Redaction',
  '## Shipped / Cancelled Lockdown',
  '## Production Smoke Evidence',
  '## Secrets Rotation / Last-Used / Audit',
  '## Append-Only Audit Logging',
  '## Durable Jobs',
  '## Reconciliation Artifacts',
  '## Alerting',
  '## Restore / Rollback',
  '## CI Billing / Spend-Limit Blocker',
  '## Migration Status',
  '## Sync Worker Status',
  '## API Health',
  '## Supabase Health Assumptions',
  '## Final Go / No-Go Summary',
];

for (const heading of requiredHeadings) {
  check(doc.includes(heading), `closeout doc includes ${heading}`);
}

const requiredStatuses = [
  '[OK] Complete',
  '[PARTIAL] Partial',
  '[BLOCKED] Blocked',
  '[MUST-FIX] Must fix before production',
];
for (const status of requiredStatuses) {
  check(doc.includes(status), `closeout doc defines status ${status}`);
}

const requiredCategories = [
  'Runtime label/shipment scope enforcement',
  'Client/store isolation',
  'RBAC enforcement',
  'Secret redaction',
  'Shipped/cancelled lockdown',
  'Production smoke evidence',
  'Secrets rotation / last-used / audit',
  'Append-only audit logging',
  'Durable jobs',
  'Reconciliation artifacts',
  'Alerting',
  'Restore/rollback',
  'CI billing/spend-limit blocker',
  'Migration status',
  'Sync worker status',
  'API health',
  'Supabase health assumptions',
];

const lowerDoc = doc.toLowerCase();
for (const category of requiredCategories) {
  check(lowerDoc.includes(category.toLowerCase()), `closeout doc covers ${category}`);
}

const requiredSafetyTerms = [
  'Do not paste secrets',
  'No production-destructive action',
  'sanitized evidence',
  'approved test order',
  'explicit human override',
  'Desired package script name',
  'guard:enterprise-readiness-closeout',
];

for (const term of requiredSafetyTerms) {
  check(lowerDoc.includes(term.toLowerCase()), `closeout doc includes safety/control term: ${term}`);
}

const secretPatterns = [
  {
    name: 'OpenAI/Stripe-like secret key',
    regex: /\b(?:sk|rk)_(?:live|test|proj)_[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    name: 'GitHub token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'Slack token',
    regex: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    name: 'JWT-looking value',
    regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'password/token/secret assignment',
    regex: /\b(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/gi,
  },
  {
    name: 'Postgres connection string',
    regex: /\bpostgres(?:ql)?:\/\/[^ \n"'`]+/gi,
  },
];

for (const { name, regex } of secretPatterns) {
  const matches = [...doc.matchAll(regex)];
  check(matches.length === 0, `closeout doc has no ${name}`);
}

console.log('PASS enterprise readiness closeout guard');
