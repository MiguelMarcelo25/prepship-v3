import fs from 'node:fs';
import path from 'node:path';
// PS-259 (Card 14): converted from substring-only to BEHAVIORAL. Import the real
// scope-enforcement owners and RUN them — these assertions FAIL if the enforcement
// in src/lib/scope-predicates.ts or src/lib/client-store-scope.ts is deleted/broken.
// These modules are pure (no env/DB at load), so a static `from '../src/...'` import
// is safe and also satisfies the PS-259 behavioral ratchet.
import {
  assertResourceInScope,
  isResourceInScope,
  ResourceScopeError,
} from '../src/lib/scope-predicates';
import { getClientStoreScope, GLOBAL_SCOPE } from '../src/lib/client-store-scope';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

// ─── BEHAVIORAL: run the real label/shipment scope enforcement ──────────────────
// A restricted client_user scoped to client 7 must be DENIED a label/shipment row
// belonging to client 9, and ALLOWED its own client 7 row. A global/admin scope and
// the trusted GLOBAL_SCOPE must pass everything. Every assertion below executes the
// imported owner functions, so deleting or weakening the predicate fails this guard.
{
  // Restricted portal caller: scoped to client 7 only.
  const restricted = getClientStoreScope({ role: 'client_user', clientIds: [7] });
  assert(restricted.isRestricted === true, 'behavioral: client_user with clientIds is a RESTRICTED scope');

  // Out-of-scope label/shipment row (another tenant) must be denied.
  const otherTenantShipment = { clientId: 9, storeId: null };
  assert(
    isResourceInScope(restricted, otherTenantShipment) === false,
    'behavioral: restricted client_user CANNOT see another tenant label/shipment (client 9)',
  );

  let threw = false;
  try {
    assertResourceInScope(restricted, otherTenantShipment, 'Shipment not found');
  } catch (err) {
    threw = err instanceof ResourceScopeError && err.code === 'RESOURCE_OUT_OF_SCOPE';
  }
  assert(
    threw,
    'behavioral: assertResourceInScope THROWS ResourceScopeError for an out-of-scope shipment',
  );

  // In-scope row (same tenant) must be allowed.
  const ownShipment = { clientId: 7, storeId: null };
  assert(
    isResourceInScope(restricted, ownShipment) === true,
    'behavioral: restricted client_user CAN access its own client 7 label/shipment',
  );
  let ownAllowed = true;
  try {
    assertResourceInScope(restricted, ownShipment);
  } catch {
    ownAllowed = false;
  }
  assert(ownAllowed, 'behavioral: assertResourceInScope does NOT throw for an in-scope shipment');

  // Global/admin scope passes everything (no per-tenant restriction).
  const adminScope = getClientStoreScope({ role: 'admin' });
  assert(adminScope.isRestricted === false, 'behavioral: admin role yields an UNRESTRICTED (global) scope');
  assert(
    isResourceInScope(adminScope, otherTenantShipment) === true,
    'behavioral: admin/global scope can access any tenant label/shipment',
  );

  // Trusted internal GLOBAL_SCOPE (durable workers / batch fan-out) also passes.
  assert(
    isResourceInScope(GLOBAL_SCOPE, otherTenantShipment) === true,
    'behavioral: GLOBAL_SCOPE (trusted system caller) bypasses per-resource restriction',
  );
}

const planPath = 'LABEL_SHIPMENT_SCOPE_REVIEW.md';
const plan = read(planPath);
const matrix = read('RBAC_CLIENT_SCOPE_MATRIX.md');
const readme = read('DEV_TASKS_README.md');
const enterprise = read('ENTERPRISE_READINESS_AUDIT.md');
const packageJson = JSON.parse(read('package.json'));

const requiredHeadings = [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Route Inventory',
  '## Required Policies',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredRouteEntries = [
  'Phase 12 Batch 3J',
  'No runtime label, shipment, shipped/cancelled, fulfillment, or schema behavior changes are included',
  '`POST` | `src/routes/labels.ts` -> `createLabelV2`',
  '`POST` | `src/routes/labels.ts` -> `createBatchV2`',
  '`/labels/:shipmentId/void`',
  '`/labels/:lookup/retrieve`',
  '`/shipments`',
  '`/shipments/sync`',
];

for (const entry of requiredRouteEntries) {
  assert(plan.includes(entry), `${planPath} covers ${entry}`);
}

const requiredPolicies = [
  'labels:create',
  'labels:void',
  'labels:return',
  'labels:read',
  'shipments:read',
  'shipments:sync',
  'Batch label creation must validate every order before side effects',
  'Label PDFs and label URLs are customer PII',
  'Preserve shipped/cancelled label creation guard',
  'Preserve existing inventory/package auto-deduct kill-switch behavior',
];

for (const policy of requiredPolicies) {
  assert(plan.includes(policy), `${planPath} documents ${policy}`);
}

assert(
  matrix.includes('[x] Label/shipment-sensitive route policy review completed as `LABEL_SHIPMENT_SCOPE_REVIEW.md`.') &&
    matrix.includes('`npm run test:label-shipment-scope-review` guards the label/shipment policy review.'),
  'RBAC matrix records the label/shipment review and guard',
);

assert(
  readme.includes('`LABEL_SHIPMENT_SCOPE_REVIEW.md`') &&
    readme.includes('Phase 12 - Enterprise Readiness | Scoped/started | 98%') &&
    readme.includes('`npm run test:label-shipment-scope-review`'),
  'phase README records Phase 12 label/shipment review progress',
);

assert(
  enterprise.includes('LABEL_SHIPMENT_SCOPE_REVIEW.md') &&
    enterprise.toLowerCase().includes('label/shipment-sensitive route policy review is completed') &&
    enterprise.includes('`npm run test:label-shipment-scope-review`'),
  'enterprise audit records label/shipment review progress',
);

// PS-259: this guard now imports TS owners, so it MUST run via tsx. Accept the tsx
// invocation as canonical; the legacy `node` form is tolerated only during the
// package.json flip (it cannot actually execute the TS imports). Either way the
// script must point at THIS guard file.
assert(
  packageJson.scripts?.['test:label-shipment-scope-review'] ===
    'tsx scripts/label-shipment-scope-review-guard.mjs' ||
    packageJson.scripts?.['test:label-shipment-scope-review'] ===
      'node scripts/label-shipment-scope-review-guard.mjs',
  'package exposes label/shipment scope review guard (run via tsx — imports TS owners)',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
