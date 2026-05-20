import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'JWT_SESSION_EXPIRATION_PLAN.md';
const plan = fs.readFileSync(path.join(root, planPath), 'utf8');
const devTasks = fs.readFileSync(path.join(root, 'DEV_TASKS_README.md'), 'utf8');
const securityPlan = fs.readFileSync(path.join(root, 'SECURITY_PATCH_PLAN.md'), 'utf8');
const enterpriseAudit = fs.readFileSync(path.join(root, 'ENTERPRISE_READINESS_AUDIT.md'), 'utf8');
const verifier = fs.readFileSync(path.join(root, 'src/lib/auth/verify-supabase-jwt.ts'), 'utf8');
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
  '## Phase 13 Checklist',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredPolicyText = [
  '7-day maximum Supabase session lifetime',
  'Access JWTs remain short-lived',
  'Time-box user sessions',
  'not a 7-day access-token policy',
  'https://supabase.com/docs/guides/auth/sessions',
  'STRICT_JWT_CLAIMS',
  'jose',
  '1 hour',
  '168',
  'hours',
];

for (const text of requiredPolicyText) {
  assert(plan.toLowerCase().includes(text.toLowerCase()), `${planPath} documents ${text}`);
}

assert(
  devTasks.includes('Phase 13 - JWT Session Expiration') &&
    devTasks.includes('JWT_SESSION_EXPIRATION_PLAN.md') &&
    devTasks.includes('npm run test:jwt-session-policy') &&
    devTasks.includes('168'),
  'DEV_TASKS_README.md tracks Phase 13, its guard, and the 168-hour dashboard value',
);

assert(
  securityPlan.includes('JWT_SESSION_EXPIRATION_PLAN.md') &&
    securityPlan.includes('Supabase Auth time-box') &&
    securityPlan.includes('access JWT expiry remains short-lived') &&
    securityPlan.includes('168'),
  'SECURITY_PATCH_PLAN.md references JWT session policy and 168-hour dashboard value',
);

assert(
  enterpriseAudit.includes('JWT_SESSION_EXPIRATION_PLAN.md') &&
    enterpriseAudit.includes('### JWT Session Expiration') &&
    enterpriseAudit.includes('Phase 13 JWT/session expiration') &&
    enterpriseAudit.includes('168'),
  'ENTERPRISE_READINESS_AUDIT.md references JWT session policy and 168-hour dashboard value',
);

assert(
  verifier.includes('jwtVerify(') && verifier.includes('JWTVerifyOptions'),
  'backend verifier still uses jose jwtVerify for JWT exp/signature validation',
);

assert(
  packageJson.scripts?.['test:jwt-session-policy'] ===
    'node scripts/jwt-session-policy-guard.mjs',
  'package exposes JWT session policy guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
