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
const ordersSource = read('src/routes/orders.ts');
const manifestsSource = read('src/routes/manifests.ts');
const packagesSource = read('src/routes/packages.ts');
const ratesSource = read('src/routes/rates.ts');
const matrixSource = read('RBAC_CLIENT_SCOPE_MATRIX.md');
const readmeSource = read('DEV_TASKS_README.md');

assert(
  ordersSource.includes('hasAppPermission') &&
    ordersSource.includes('canViewOrderFinancials') &&
    ordersSource.includes("'financials:read'"),
  'orders route checks financials:read for order financial fields',
);
assert(
  ordersSource.includes('redactOrderFinancials') &&
    ordersSource.includes('redactRateMoneyFields') &&
    ordersSource.includes('labelCost: canViewFinancials ? labelCost : null') &&
    ordersSource.includes('selectedRateAmount: canViewFinancials ? selectedRateAmount : null') &&
    ordersSource.includes('bestRateAmount: canViewFinancials ? bestRatePick.value : null'),
  'orders list redacts label/rate costs without financials:read',
);
assert(
  ordersSource.includes('const canViewFinancials = canViewOrderFinancials(c);') &&
    ordersSource.includes("const exportBestRateAmount = canViewFinancials ? bestRateAmount : '';") &&
    ordersSource.includes("const exportLabelCost = canViewFinancials ? labelCost : '';") &&
    ordersSource.includes("const exportShipMargin = canViewFinancials ? shipMargin : '';"),
  'orders export blanks best rate, label cost, and margin without financials:read',
);

assert(
  manifestsSource.includes('hasAppPermission') &&
    manifestsSource.includes('canViewManifestFinancials') &&
    manifestsSource.includes("'financials:read'"),
  'manifests route checks financials:read for manifest label costs',
);
assert(
  manifestsSource.includes('const canViewFinancials = filters.canViewFinancials !== false;') &&
    manifestsSource.includes('labelCost: canViewFinancials ? row.labelCost : null'),
  'manifests payload redacts labelCost without financials:read',
);

assert(
  packagesSource.includes('hasAppPermission') &&
    packagesSource.includes('canViewPackageFinancials') &&
    packagesSource.includes("'financials:read'"),
  'packages route checks financials:read for package costs',
);
assert(
  packagesSource.includes('publicPackageRow') &&
    packagesSource.includes('unitCost: canViewFinancials ? row.unitCost : null') &&
    packagesSource.includes('redactPackageMutationResult'),
  'packages route redacts unitCost from read and mutation DTOs without financials:read',
);

assert(
  ratesSource.includes('hasAppPermission') &&
    ratesSource.includes('canViewRateFinancials') &&
    ratesSource.includes('canViewRateAccountMetadata') &&
    ratesSource.includes("'financials:read'") &&
    ratesSource.includes("'credentials:read'"),
  'rates route checks financial and credential permissions for rate DTOs',
);
assert(
  ratesSource.includes('redactRateMoneyFields') &&
    ratesSource.includes('publicRatesResult') &&
    ratesSource.includes('publicRateCacheRow') &&
    ratesSource.includes('sourceClientId: canViewAccountMetadata ?') &&
    ratesSource.includes('sourceClientName: canViewAccountMetadata ?'),
  'rates route redacts money fields and account source metadata by permission',
);

assert(
  matrixSource.includes('[x] Extended field-level financial guard') &&
    matrixSource.includes('Orders export/list') &&
    matrixSource.includes('Manifests label cost') &&
    matrixSource.includes('Packages unit cost') &&
    matrixSource.includes('Rate Browser rate/account DTOs'),
  'RBAC matrix records extended field-level guard progress',
);
assert(
  readmeSource.includes('Orders export/list label costs redact without `financials:read`') &&
    readmeSource.includes('Rate Browser rate money fields redact without `financials:read`'),
  'phase README records extended field-level progress',
);
assert(
  packageJson.scripts?.['test:field-level-rbac-extended'] ===
    'node scripts/field-level-rbac-extended-guard.mjs',
  'package exposes extended field-level RBAC guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
