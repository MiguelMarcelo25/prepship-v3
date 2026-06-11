import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const docPath = path.join(root, 'docs/source-of-truth-matrix.md');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(dir, files = []) {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return files;

  for (const entry of readdirSync(absolute)) {
    const full = path.join(absolute, entry);
    const relative = path.relative(root, full).replaceAll('\\', '/');
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git'].includes(entry)) continue;
      walk(relative, files);
      continue;
    }
    if (/\.(ts|tsx|mjs|md)$/.test(entry)) files.push(relative);
  }
  return files;
}

assert(existsSync(docPath), 'docs/source-of-truth-matrix.md is required');

const doc = read('docs/source-of-truth-matrix.md');

const requiredSections = [
  '### Orders',
  '### Order Items / SKU Analytics',
  '### Inventory',
  '### Rates',
  '### Carrier Accounts / Credentials',
  '### Labels / Shipments',
  '### Manifests',
  '### Billing',
  '### Reporting / Dashboard / Analysis',
  '### Clients / Stores',
  '### Sync / Worker State',
  '### Settings / Configuration',
  '`orders.items` vs `order_items`',
  '`clients.storeIds` vs Normalized Store Ownership',
  'Client Credential Fields vs Carrier Account Tables',
  'Live Rate vs `rate_cache` vs Selected Shipment Rate',
  'Billing Recalculation vs Frozen `billing_line_items`',
  'Reporting Cache vs Operational Tables',
  'Mock/In-Memory Labels vs Durable `shipments`',
  'Frozen Snapshot Rules',
  '## PS-032 Modular Boundary Matrix',
  '| Domain/module | Authoritative source of truth | Derived/read-model sources | Cache-only sources | Frozen snapshot sources | Mutation owner | Read owner | Current coupling risks | Target boundary |',
  '| Orders / order import |',
  '| Order items |',
  '| Shipping selections / order overrides |',
  '| Rates / rate cache |',
  '| Labels / shipments |',
  '| Print queue |',
  '| Marketplace confirmation / outbox |',
  '| Inventory |',
  '| Inventory ledger |',
  '| Inventory balance / read model |',
  '| Products / SKU defaults |',
  '| Packages / package stock |',
  '| Billing config |',
  '| Billing line items / invoices |',
  '| Analytics / reporting / dashboard |',
  '| Clients / stores / accounts |',
  '| Frontend / app shell / module entitlements |',
  '## Dependency Classification',
  '## Target Module Boundaries',
  '### shipping-core',
  '### wms',
  '### billing',
  '### analytics',
  '### client-portal',
  '### admin/platform',
  '## Non-Negotiable Architecture Rules',
  'Frontend owns UI state and operator intent only; backend owns business truth.',
  '`rate_cache` cannot be billing/audit truth.',
  '`shipments` owns label/tracking/cost snapshots.',
  'Shipping can emit events; WMS, Billing, and Analytics respond if enabled.',
  '## PS-032 Confirmed Coupling Risks',
];

for (const section of requiredSections) {
  assert(
    doc.includes(section),
    `docs/source-of-truth-matrix.md is missing required section: ${section}`,
  );
}

const scanFiles = [
  ...walk('src'),
  ...walk('api'),
  ...walk('web/src'),
  ...walk('scripts'),
  ...walk('docs'),
].filter((file) => !file.endsWith('scripts/source-of-truth-guard.mjs'));

const patterns = [
  {
    name: 'raw-orders-items',
    regex: /orders\.items|orders\.items|jsonb_array_elements\([^)]*o\.items|orderItems:\s*orders\.items|from orders o, jsonb_array_elements\(o\.items\)/i,
    suggestion: 'Use order_items for analytics/reporting; keep orders.items as raw import compatibility.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'docs/ps-031-store-connector-source-of-truth.md',
      'docs/prepship-runtime-domain-architecture.md',
      'docs/dashboard-formulas.md',
      'src/db/schema/order-items.ts',
      'src/db/schema/orders.ts',
      'src/services/order-sync.ts',
      'src/services/order-items.ts',
      'src/routes/orders.ts',
      'src/services/billing.ts',
      'src/services/inventory-enrichment.ts',
      'src/routes/inventory.ts',
      'src/routes/analysis.ts',
      'src/services/fulfillment-deductions.ts',
      'scripts/backfill-inventory-ledger.ts',
      'scripts/backfill-inventory-images.ts',
      'scripts/reconciliation-plan-guard.mjs',
      'web/src/components/Views/AnalysisView.tsx',
      'web/src/components/Views/DashboardView.tsx',
      'web/src/components/Views/OrdersView.tsx',
      'web/src/components/Views/orders-parity.ts',
      'web/src/hooks/v2Hooks.ts',
      'web/src/lib/v2-apiClient.ts',
    ],
  },
  {
    name: 'legacy-client-carrier-credentials',
    regex: /ssApiKey|ssApiSecret|ssApiKeyV2|rateSourceClientId/,
    suggestion: 'Use a single carrier credential resolver and carrier_accounts/carrier_account_clients provenance.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/db/schema/clients.ts',
      'src/db/schema/carrier-accounts.ts',
      'src/lib/shipstation/credentials.ts',
      'src/lib/public-client.ts',
      'src/routes/clients.ts',
      'src/routes/admin.ts',
      'src/routes/init.ts',
      'src/services/order-sync.ts',
      'src/services/shipment-sync.ts',
      'src/services/inventory-enrichment.ts',
      'scripts/client-redaction-guard.mjs',
      'scripts/reconcile-shipstation-awaiting.ts',
      'scripts/sync-shipstation-products.ts',
      'web/src/components/ClientModal.tsx',
      'web/src/components/Settings/CarrierIntegrationsCard.tsx',
      'web/src/components/Views/InventoryView.tsx',
      'web/src/hooks/v2Hooks.ts',
      // PS-157: useClients/useAllClients split out of v2Hooks.ts; the
      // rateSourceClientId literal (ClientDto + transformClientRowV4toV2)
      // now lives in v2Hooks-shared.ts, with the consuming hooks in their
      // own modules. Whitelist all three so no new drift warning appears.
      'web/src/hooks/v2Hooks-shared.ts',
      'web/src/hooks/useClients.ts',
      'web/src/hooks/useAllClients.ts',
      'web/src/lib/v2-apiClient.ts',
    ],
  },
  {
    name: 'rate-cache-billing-truth-risk',
    regex: /rateCache|rate_cache/,
    suggestion: 'Keep rate_cache as cache only; use shipments.selectedRateJson for frozen selected-rate truth.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/db/schema/rates.ts',
      'src/services/rates.ts',
      'src/routes/rates.ts',
      'src/routes/orders.ts',
      'scripts/apply-rls-hardening.ts',
      'scripts/migrate-supabase.ts',
      'scripts/parity/rules.mjs',
      'scripts/probe-rate-cache-freshness.ts',
      'scripts/rate-system-hardening-guard.mjs',
      'scripts/verify-ground-saver-fix.ts',
    ],
  },
  {
    name: 'mock-label-state',
    regex: /mockLabels|mock_labels|mock label/i,
    suggestion: 'Production label truth must be durable shipments rows; mock labels are test/dev compatibility only.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/db/schema/mock-labels.ts',
      'src/lib/mock-label-access.ts',
      'src/lib/env.ts',
      'src/routes/admin.ts',
      'src/routes/labels.ts',
      'src/services/print-queue.ts',
      'src/services/labels.ts',
      'scripts/migrate-supabase.ts',
      'scripts/apply-rls-hardening.ts',
      'scripts/print-queue-ownership-guard.mjs',
      'scripts/test-order-queue-label-guard.mjs',
      'web/src/components/Views/OrdersView.tsx',
      'web/src/lib/v2-apiClient.ts',
    ],
  },
  {
    name: 'route-time-schema-ddl',
    regex: /ALTER\s+TABLE/i,
    suggestion: 'Schema changes should live in migrations or explicit maintenance scripts, not request handlers.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/routes/analysis.ts',
      'scripts/apply-order-assignment-migration.ts',
      'scripts/apply-rls-hardening.ts',
      'scripts/apply-selling-fees-migration.ts',
      'scripts/credential-accounts-guard.mjs',
      'scripts/migrate-supabase.ts',
      'scripts/rate-system-hardening-guard.mjs',
    ],
  },
  {
    name: 'shipping-to-wms-deduction-coupling',
    regex: /fulfillment-deductions|deductInventoryForOrder|deductPackageForShipment/,
    suggestion: 'Shipping should emit events and WMS should consume deductions; keep current coupling explicit and kill-switch guarded.',
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/services/fulfillment-deductions.ts',
      'src/services/labels.ts',
      'src/services/order-sync.ts',
      'src/services/shipment-sync.ts',
      'src/routes/orders.ts',
      'scripts/backfill-inventory-ledger.ts',
      'scripts/inventory-auto-deduct-guard.mjs',
      'web/src/components/Views/OrdersView.tsx',
    ],
  },
  {
    name: 'billing-raw-orders-items',
    regex: /orders\.items|orderItems:\s*orders\.items/i,
    suggestion: 'Billing should consume order_items or frozen billing snapshots; raw orders.items is compatibility only.',
    appliesTo: (file) => file.startsWith('src/services/billing') || file.startsWith('src/routes/billing'),
    whitelist: [
      'docs/source-of-truth-matrix.md',
      'src/services/billing.ts',
    ],
  },
];

const warnings = [];

for (const file of scanFiles) {
  const content = read(file);
  for (const pattern of patterns) {
    if (pattern.appliesTo && !pattern.appliesTo(file)) continue;
    if (!pattern.regex.test(content)) continue;
    if (pattern.whitelist.includes(file)) continue;
    warnings.push({
      file,
      pattern: pattern.name,
      suggestion: pattern.suggestion,
    });
  }
}

console.log('PASS source-of-truth required document coverage');

if (warnings.length) {
  console.log('');
  console.log('WARN source-of-truth drift candidates');
  for (const warning of warnings) {
    console.log(`- ${warning.file}: ${warning.pattern}`);
    console.log(`  ${warning.suggestion}`);
  }
  console.log('');
  console.log(`${warnings.length} warning(s); current guard is warning-only for transitional code.`);
} else {
  console.log('No source-of-truth drift warnings found outside the whitelist.');
}
