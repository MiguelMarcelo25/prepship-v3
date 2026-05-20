import fs from 'node:fs';
import path from 'node:path';

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

const packageJson = JSON.parse(read('package.json'));
const authSource = read('src/middleware/auth.ts');
const analysisSource = read('src/routes/analysis.ts');
const inventorySource = read('src/routes/inventory.ts');
const billingSource = read('src/routes/billing.ts');
const matrixSource = read('RBAC_CLIENT_SCOPE_MATRIX.md');

function roleBlock(role) {
  const match = authSource.match(new RegExp(`${role}:\\s*\\[([\\s\\S]*?)\\],`));
  return match?.[1] ?? '';
}

assert(
  authSource.includes("'financials:read'"),
  'auth middleware defines financials:read permission',
);
assert(
  roleBlock('operator').includes("'financials:read'"),
  'operator role receives default financials:read permission',
);
assert(
  !roleBlock('warehouse').includes("'financials:read'"),
  'warehouse role does not receive default financials:read permission',
);
assert(
  !roleBlock('client_user').includes("'financials:read'"),
  'client_user role does not receive default financials:read permission',
);
assert(
  !roleBlock('read_only_support').includes("'financials:read'"),
  'read_only_support role does not receive default financials:read permission',
);

assert(
  analysisSource.includes('hasAppPermission') &&
    analysisSource.includes('canViewAnalysisFinancials') &&
    analysisSource.includes("hasAppPermission(") &&
    analysisSource.includes("'financials:read'"),
  'analysis route gates cost/margin fields through financials:read',
);
assert(
  analysisSource.includes('shippingCostMonth: canViewFinancials') &&
    analysisSource.includes("total_cost: '0'") &&
    analysisSource.includes('q.canViewFinancials !== false'),
  'analysis route redacts overview, daily, and SKU financial fields without permission',
);

assert(
  inventorySource.includes('hasAppPermission') &&
    inventorySource.includes('canViewInventoryFinancials') &&
    inventorySource.includes("'financials:read'"),
  'inventory route gates shipping-cost fields through financials:read',
);
assert(
  inventorySource.includes('const visibleShippingSummary = canViewFinancials ? shippingSummary : null') &&
    inventorySource.includes('const visibleRows = canViewFinancials') &&
    inventorySource.includes('shipping_cost: null') &&
    inventorySource.includes('standard_shipping_total: null'),
  'inventory SKU-order analytics redacts shipping-cost fields without permission',
);

assert(
  billingSource.includes("requirePermission('financials:read')") &&
    billingSource.includes("app.use('*', requirePermission('financials:read'))"),
  'billing route requires financials:read before exposing billing data',
);

assert(
  matrixSource.includes('[x] Field-level DTO guard') ||
    matrixSource.includes('[x] Add field-level DTO tests'),
  'RBAC matrix records field-level DTO guard progress',
);
assert(
  packageJson.scripts?.['test:field-level-rbac'] ===
    'node scripts/field-level-rbac-guard.mjs',
  'package exposes field-level RBAC guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
