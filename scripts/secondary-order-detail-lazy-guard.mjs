import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const billingPath = path.join(root, 'web/src/components/Views/BillingView.tsx');
const packagesPath = path.join(root, 'web/src/components/Views/PackagesView.tsx');
const packagePath = path.join(root, 'package.json');

const billing = fs.readFileSync(billingPath, 'utf8');
const packages = fs.readFileSync(packagesPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  pkg.scripts?.['test:secondary-order-detail-lazy'] === 'node scripts/secondary-order-detail-lazy-guard.mjs',
  'package.json exposes test:secondary-order-detail-lazy',
);

for (const [name, source] of [['BillingView', billing], ['PackagesView', packages]]) {
  assert(
    source.includes('import { lazy, Suspense') || source.includes('import { Suspense, lazy'),
    `${name} imports lazy and Suspense from React`,
  );
  assert(
    !source.includes("import OrderDetailDrawer from '../OrderDetailDrawer'"),
    `${name} does not eagerly import OrderDetailDrawer`,
  );
  assert(
    source.includes("const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))"),
    `${name} lazily imports OrderDetailDrawer`,
  );
  assert(
    source.includes('<Suspense fallback={null}>') && source.includes('<OrderDetailDrawer'),
    `${name} renders OrderDetailDrawer inside Suspense`,
  );
}

assert(
  billing.includes('{orderDetailModalId != null ? ('),
  'BillingView only mounts OrderDetailDrawer after order detail intent',
);

assert(
  packages.includes('{orderDetailModal ? ('),
  'PackagesView only mounts OrderDetailDrawer after ledger order detail intent',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
