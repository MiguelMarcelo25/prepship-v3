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

// ── PS-234: verify the RUNTIME audit logging is implemented, not just the matrix ──
function readMaybe(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

const auditSchema = readMaybe('src/db/schema/audit-log.ts');
const auditService = readMaybe('src/services/audit-log.ts');
const auditMigration = readMaybe('drizzle/0044_audit_log.sql');

// 1. Append-only table + schema.
assert(/pgTable\(\s*'audit_log'/.test(auditSchema), 'audit-log schema defines the audit_log table');
assert(
  ['eventType', 'actorId', 'actorEmail', 'resourceType', 'resourceId', 'action', 'details', 'ip']
    .every((col) => auditSchema.includes(col)),
  'audit_log schema has the required columns'
);

// 2. Migration enforces append-only at the DB level.
assert(auditMigration.includes('CREATE TABLE IF NOT EXISTS audit_log'), 'migration 0044 creates audit_log');
assert(
  /BEFORE UPDATE OR DELETE ON audit_log/.test(auditMigration) && /RAISE EXCEPTION/.test(auditMigration),
  'migration 0044 enforces append-only via an UPDATE/DELETE-blocking trigger'
);
assert(auditMigration.includes('ENABLE ROW LEVEL SECURITY'), 'migration 0044 enables RLS on audit_log');

// 3. Service: best-effort writer + redaction + migration-readiness delegation.
assert(auditService.includes('export async function recordAuditEvent('), 'audit service exports recordAuditEvent');
assert(auditService.includes('export async function ensureAuditLogSchema('), 'audit service exports ensureAuditLogSchema');
assert(auditService.includes('export function redactAuditDetails('), 'audit service exports redactAuditDetails');
assert(auditService.includes('export function auditActorFromContext('), 'audit service exports auditActorFromContext');
assert(/catch \(err\)[\s\S]*console\.warn/.test(auditService), 'recordAuditEvent is best-effort (never throws into the caller)');
assert(/secret|token|credential/i.test(auditService) && auditService.includes('[redacted]'), 'audit service redacts secret-shaped fields');
assert(
  auditService.includes('assertRuntimeSchemaReady') &&
    !/CREATE TABLE|CREATE TRIGGER|ALTER TABLE/i.test(auditService),
  'ensureAuditLogSchema delegates to migration readiness without runtime DDL',
);

// 4. Writers wired at the carded mutation points (credentials, labels, orders incl. ?force=1, billing, settings).
const writerFiles = {
  'settings write': 'src/routes/settings.ts',
  'carrier credential': 'src/routes/carrier-accounts.ts',
  'store credential': 'src/routes/store-accounts.ts',
  'billing generation': 'src/routes/billing.ts',
  'label create/void/return': 'src/routes/labels.ts',
  'order force-override + manual': 'src/routes/orders.ts',
};
for (const [label, rel] of Object.entries(writerFiles)) {
  assert(readMaybe(rel).includes('recordAuditEvent('), `${label} route records an audit event`);
}
// The ?force=1 lockdown override specifically must be audited.
assert(readMaybe('src/routes/orders.ts').includes("action: 'force_override'"), 'shipped/cancelled ?force=1 override is audited');

// 5. Self-wiring.
assert(packageJson.scripts?.['test:audit-logging'] === 'node scripts/audit-logging-guard.mjs', 'audit-logging guard wired');
