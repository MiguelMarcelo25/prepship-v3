import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const docPath = 'docs/security-readiness-checklist.md';
const reportPath = 'reports/security-readiness/latest.md';
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};

const requiredScripts = [
  'test:auth-coverage',
  'test:raw-error-response-audit',
  'test:rbac-permissions',
  'test:client-store-scope',
  'test:marketplace-order-auth-cors',
  'test:dashboard-client-scope',
  'test:analysis-client-scope',
  'test:inventory-client-scope',
  'test:billing-client-scope',
  'test:print-queue-client-scope',
  'test:orders-manifests-scope',
  'test:field-level-rbac',
  'test:field-level-rbac-extended',
  'test:label-shipment-scope-review',
  'test:print-queue-ownership',
  'test:secrets-governance',
  'test:audit-logging',
  'test:privacy-compliance',
  'test:jwt-session-policy',
  'test:auth-logout',
  'test:frontend-auth-cache',
];

const requiredDocPhrases = [
  'SOC 2 Type I',
  'SOC 2 Type II',
  'PrepShip is not SOC 2 compliant until a qualified third-party auditor completes the report',
  'SOC 2-aligned controls/readiness work',
  'multi-tenant/client/store data isolation',
  'tenant/client/store data isolation',
  'auth/RBAC/MFA',
  'portal vs internal admin permission boundary',
  'label/postage safety',
  'marketplace/source confirmation lifecycle',
  'secrets management',
  'PII/data privacy/redaction',
  'audit logging',
  'secure API design',
  'database/RLS/backups/restore',
  'dependency/supply-chain security',
  'webhook security',
  'incident response',
  'monitoring/availability',
  'SOC 2 evidence readiness',
  'Vendor/security inventory template',
  'GitHub',
  'Vercel',
  'Render',
  'Supabase',
  'ShipStation',
  'EasyPost',
  'Walmart',
  'eBay',
  'Shopify',
  'Stripe',
  'Sentry',
  'Google Workspace',
  'Discord',
  'Trello',
  'Client A cannot view/query/update Client B orders',
  'browser filters are not authorization',
  'Duplicate active label attempts',
  'Tests must never buy postage or create real labels',
  'Local shipped state is not proof of marketplace/source confirmation',
  'No API keys/tokens in repo or docs',
  'No full customer addresses in logs/reports',
  'Admin/user-management actions audited',
  'Backup/restore expectations',
  'MFA enabled screenshots',
  'GitHub branch protection screenshots/settings export',
  'backup restore test result',
  'secret rotation records',
];

const forbiddenLeakPatterns = [
  { pattern: /sk_live_[A-Za-z0-9]+/i, label: 'Stripe live secret key' },
  { pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, label: 'JWT-like token' },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: 'private key block' },
  { pattern: /https?:\/\/[^\s)]+label[^\s)]*(?:token|signature|X-Amz-Signature|sig)=/i, label: 'signed/raw label URL' },
  { pattern: /\b\d{1,6}\s+[A-Za-z0-9.'-]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b/, label: 'full street address' },
];

const checks = [];

function assert(condition, message) {
  checks.push({ message, pass: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

function readIfExists(relPath) {
  const abs = path.join(root, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

const doc = readIfExists(docPath);

assert(Boolean(scripts['test:security-readiness']), 'package exposes test:security-readiness');
assert(
  typeof scripts['test:security-readiness'] === 'string' &&
    scripts['test:security-readiness'].includes('node scripts/security-readiness-guard.mjs'),
  'test:security-readiness runs security-readiness-guard first'
);

for (const scriptName of requiredScripts) {
  assert(Boolean(scripts[scriptName]), `package exposes ${scriptName}`);
  assert(
    typeof scripts['test:security-readiness'] === 'string' &&
      scripts['test:security-readiness'].includes(`npm run ${scriptName}`),
    `test:security-readiness includes ${scriptName}`
  );
}

assert(fs.existsSync(path.join(root, docPath)), `${docPath} exists`);
for (const phrase of requiredDocPhrases) {
  assert(doc.includes(phrase), `${docPath} includes "${phrase}"`);
}

const unsafeComplianceClaims = [
  /\bPrepShip\s+is\s+SOC 2 compliant\b/i,
  /\bwe\s+are\s+SOC 2 compliant\b/i,
  /\bSOC 2 compliant\b(?!\s+until a qualified third-party auditor completes the report)/i,
];
assert(
  unsafeComplianceClaims.every((pattern) => !pattern.test(doc)),
  'readiness doc avoids unsupported SOC 2 compliant claims'
);

for (const { pattern, label } of forbiddenLeakPatterns) {
  assert(!pattern.test(doc), `${docPath} does not include ${label}`);
}

const reportDir = path.join(root, 'reports/security-readiness');
fs.mkdirSync(reportDir, { recursive: true });
const passed = checks.filter((check) => check.pass).length;
const failed = checks.length - passed;
const status = failed === 0 ? 'conditional' : 'blocked';
const report = `# PrepShip Security Readiness Gate Report

Generated by: \`npm run test:security-readiness\`

SOC 2 status: PrepShip is not SOC 2 compliant until a qualified third-party auditor completes the report. This report covers SOC 2-aligned controls/readiness work only.

Final readiness status: ${status}

## Summary

| Category | Status | Evidence |
|---|---:|---|
| Checklist artifact | ${doc ? 'pass' : 'fail'} | \`${docPath}\` |
| Package security gate wiring | ${scripts['test:security-readiness'] ? 'pass' : 'fail'} | \`package.json\` |
| Existing auth/RBAC/scope guard coverage | ${requiredScripts.every((scriptName) => scripts[scriptName]) ? 'pass' : 'fail'} | package scripts |
| PII/secret redaction in readiness doc | ${forbiddenLeakPatterns.every(({ pattern }) => !pattern.test(doc)) ? 'pass' : 'fail'} | static pattern scan |
| SOC 2 wording safety | ${unsafeComplianceClaims.every((pattern) => !pattern.test(doc)) ? 'pass' : 'fail'} | static wording scan |

## Known Blockers Before External Sales

- A formal SOC 2 audit has not been completed; customer wording must stay "SOC 2-aligned" or "preparing for SOC 2."
- Business owners still need to collect live evidence such as MFA screenshots, branch protection exports, access reviews, backup restore tests, incident drill notes, vendor reviews, policy acknowledgements, and secret rotation records.
- Live shipping, marketplace notification, and billing paths remain manual-gated for certification evidence unless DJ explicitly approves a live test.

## Gate Checks

${checks.map((check) => `- ${check.pass ? 'PASS' : 'FAIL'}: ${check.message}`).join('\n')}
`;

fs.writeFileSync(path.join(root, reportPath), report, 'utf8');
assert(fs.existsSync(path.join(root, reportPath)), `${reportPath} generated`);

if (process.exitCode) {
  console.error(`\nSecurity readiness guard failed. Report written to ${reportPath}`);
  process.exit(process.exitCode);
}

console.log(`\nPASS security readiness guard. Report written to ${reportPath}`);
