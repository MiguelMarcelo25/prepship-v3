import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const views = [
  {
    name: 'OrdersView',
    path: 'web/src/components/Views/OrdersView.tsx',
    intentMarker: '{detailDrawerOrderId != null ? (',
  },
  {
    name: 'InventoryView',
    path: 'web/src/components/Views/InventoryView.tsx',
    intentMarker: '{orderDetailModal ? (',
  },
  {
    name: 'AnalysisView',
    path: 'web/src/components/Views/AnalysisView.tsx',
    intentMarker: '{orderDetailDrawer ? (',
  },
  {
    name: 'BillingView',
    path: 'web/src/components/Views/BillingView.tsx',
    intentMarker: '{orderDetailModalId != null ? (',
  },
  {
    name: 'PackagesView',
    path: 'web/src/components/Views/PackagesView.tsx',
    intentMarker: '{orderDetailModal ? (',
  },
];

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
  pkg.scripts?.['test:order-detail-drawer-lazy'] === 'node scripts/order-detail-drawer-lazy-guard.mjs',
  'package.json exposes test:order-detail-drawer-lazy',
);

for (const view of views) {
  const source = fs.readFileSync(path.join(root, view.path), 'utf8');

  assert(
    source.includes('import { lazy, Suspense') || source.includes('import { Suspense, lazy'),
    `${view.name} imports lazy and Suspense from React`,
  );
  assert(
    !source.includes("import OrderDetailDrawer from '../OrderDetailDrawer'"),
    `${view.name} does not eagerly import OrderDetailDrawer`,
  );
  assert(
    source.includes("const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))"),
    `${view.name} lazily imports OrderDetailDrawer`,
  );
  assert(
    source.includes('<Suspense fallback={null}>') && source.includes('<OrderDetailDrawer'),
    `${view.name} renders OrderDetailDrawer inside Suspense`,
  );
  assert(
    source.includes(view.intentMarker),
    `${view.name} only mounts OrderDetailDrawer after order detail intent`,
  );
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
