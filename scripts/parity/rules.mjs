// Shared rules + mappings for the parity pipeline.
// Single source of truth for: which directories map to which module, how to
// normalize v2 vs v4 paths for matching, which atom categories exist, and
// how to identify v4's canonical surface for each category.

export const MODULES = [
  'orders',
  'billing',
  'inventory',
  'packages',
  'rates',
  'analysis',
  'manifests',
  'locations',
  'settings',
  // Horizontal slices — not tied to a single View
  '_config',
  '_shipstation',
  '_worker-contracts',
];

export const CATEGORIES = [
  'route',       // HTTP endpoint
  'service',     // exported function in a service/ directory
  'schema',      // DB table / column
  'dto',         // exported type/interface in contracts
  'view-column', // frontend table column
  'view-filter', // frontend filter
  'view-modal',  // frontend modal/drawer
  'view-action', // frontend button / bulk action / keyboard shortcut
  'hook',        // custom React hook
  'context',     // React context provider
  'api-client',  // apiClient method
  'constant',    // business rule constant
  'css-class',   // CSS selector
  'ss-call',     // ShipStation API call
  'worker-job',  // scheduled / background job
];

// Map a v2original file path to one of MODULES. Returns null when the file
// isn't a parity concern (tests, build artifacts, legacy compat code).
export function v2ModuleForPath(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/\/(test|tests|__tests__|dist|build|node_modules)\//.test(p)) return null;
  if (/\.test\.|\.spec\./.test(p)) return null;

  // API modules — canonical source
  let m = p.match(/apps\/api\/src\/modules\/([^/]+)\//);
  if (m) {
    const mod = m[1];
    if (mod === 'queue') return 'orders'; // print queue lives with orders UI
    if (mod === 'products') return 'inventory'; // products are inventory dims
    if (mod === 'init' || mod === 'clients' || mod === 'sync') return '_config';
    if (MODULES.includes(mod)) return mod;
    return '_config';
  }

  // API common — constants + ShipStation client
  if (/apps\/api\/src\/common\/prepship-config\.ts$/.test(p)) return '_config';
  if (/apps\/api\/src\/common\/shipstation\//.test(p)) return '_shipstation';
  if (/apps\/api\/src\/common\//.test(p)) return '_config';

  // API app layer — router + middleware
  if (/apps\/api\/src\/app\//.test(p)) return '_config';
  if (/apps\/api\/src\/config\//.test(p)) return '_config';

  // Frontend views — 1:1 with View name
  m = p.match(/apps\/react\/src\/components\/Views\/([A-Z][a-zA-Z]+)View\.(tsx|css)$/);
  if (m) return m[1].toLowerCase();
  m = p.match(/apps\/react\/src\/components\/Views\/([a-z]+)-parity\.ts$/);
  if (m) return m[1];
  m = p.match(/apps\/react\/src\/components\/Views\/([a-z]+)-(view-filters|panel-state|queue|grouping)\.ts$/);
  if (m) return m[1];

  // Frontend shared
  if (/apps\/react\/src\/hooks\//.test(p)) return inferModuleFromHookName(p);
  if (/apps\/react\/src\/contexts\//.test(p)) return '_config';
  if (/apps\/react\/src\/api\/client\.ts$/.test(p)) return '_config';
  if (/apps\/react\/src\/App\.(tsx|css)$/.test(p)) return '_config';
  if (/apps\/react\/src\/components\/Sidebar\//.test(p)) return '_config';
  if (/apps\/react\/src\/components\/Tables\//.test(p)) return '_config';
  if (/apps\/react\/src\/(main|index)\./.test(p)) return null;

  // Worker
  if (/apps\/worker\//.test(p)) return '_worker-contracts';

  // Contracts + shared packages
  m = p.match(/packages\/contracts\/src\/([a-z-]+)\.ts$/);
  if (m) {
    const mod = m[1];
    if (MODULES.includes(mod)) return mod;
    return '_worker-contracts';
  }
  if (/packages\/(contracts|shared)\//.test(p)) return '_worker-contracts';

  return null;
}

function inferModuleFromHookName(p) {
  const name = p.split('/').pop().replace(/\.tsx?$/, '');
  if (/Order/i.test(name)) return 'orders';
  if (/Location/i.test(name)) return 'locations';
  if (/Shipping|Shipment/i.test(name)) return '_shipstation';
  if (/Rate/i.test(name)) return 'rates';
  if (/Store|Init/i.test(name)) return '_config';
  return '_config';
}

// Same mapping for v4 paths. v4 has a flatter layout (src/routes, src/services,
// src/db/schema, web/src/...).
export function v4ModuleForPath(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/\/(test|tests|__tests__|dist|build|node_modules|drizzle\/meta)\//.test(p)) return null;
  if (/\.test\.|\.spec\./.test(p)) return null;
  if (/scripts\/parity\//.test(p)) return null;

  // Backend routes — filename IS the module
  let m = p.match(/src\/routes\/([a-z-]+)\.ts$/);
  if (m) {
    const mod = m[1];
    if (mod === 'print-queue') return 'orders';
    if (mod === 'products' || mod === 'parent-skus') return 'inventory';
    if (mod === 'shipments') return 'orders';
    if (mod === 'cron' || mod === 'clients' || mod === 'init' || mod === 'admin' || mod === 'health')
      return '_config';
    if (mod === 'labels') return 'orders';
    if (MODULES.includes(mod)) return mod;
    return '_config';
  }

  m = p.match(/src\/services\/([a-z-]+)\.ts$/);
  if (m) {
    const mod = m[1];
    if (mod === 'order-sync' || mod === 'shipment-sync' || mod === 'sync-scheduler')
      return '_worker-contracts';
    if (mod === 'labels' || mod === 'mock-label-generator') return 'orders';
    if (mod === 'ref-rates-fetch' || mod === 'rates-backfill') return 'rates';
    if (mod === 'print-queue') return 'orders';
    if (MODULES.includes(mod)) return mod;
    return '_config';
  }

  m = p.match(/src\/db\/schema\/([a-z-]+)\.ts$/);
  if (m) {
    const t = m[1];
    if (t === 'orders' || t === 'shipments' || t === 'print-queue') return 'orders';
    if (t === 'inventory' || t === 'inventory-sku-parents' || t === 'parent-skus' ||
        t === 'products' || t === 'product-defaults') return 'inventory';
    if (t === 'packages' || t === 'package-ledger') return 'packages';
    if (t === 'billing') return 'billing';
    if (t === 'rates') return 'rates';
    if (t === 'locations') return 'locations';
    if (t === 'settings' || t === 'sync-meta' || t === 'clients') return '_config';
    if (t === 'return-labels' || t === 'mock-labels') return 'orders';
    return '_config';
  }

  // Lib / middleware
  if (/src\/lib\/shipstation\//.test(p)) return '_shipstation';
  if (/src\/lib\//.test(p)) return '_config';
  if (/src\/middleware\//.test(p)) return '_config';

  // Frontend views
  m = p.match(/web\/src\/components\/Views\/([A-Z][a-zA-Z]+)View\.(tsx|css)$/);
  if (m) return m[1].toLowerCase();
  m = p.match(/web\/src\/pages\/([A-Z][a-zA-Z]+)\.tsx$/);
  if (m) {
    const n = m[1].toLowerCase();
    if (n === 'ratebrowser' || n === 'rateshop') return 'rates';
    if (n === 'clients' || n === 'login' || n === 'products' || n === 'picklist' || n === 'invoice')
      return '_config';
    if (MODULES.includes(n) || n === 'manifest') return n === 'manifest' ? 'manifests' : n;
    return '_config';
  }

  if (/web\/src\/hooks\//.test(p)) return inferModuleFromHookName(p);
  if (/web\/src\/contexts\//.test(p)) return '_config';
  if (/web\/src\/lib\/v2-apiClient\.ts$/.test(p)) return '_config';
  if (/web\/src\/lib\//.test(p)) return '_config';
  if (/web\/src\/components\//.test(p)) return '_config';
  if (/web\/src\/types\//.test(p)) return '_worker-contracts';

  return null;
}

// ── Atom ID normalization ───────────────────────────────────────────────────
// Same atom in v2 + v4 must produce the same id string so the matcher can
// join them. Category-specific so e.g. routes key on METHOD+path with v2→v4
// path normalizations baked in.

export function normalizeRouteId(method, path) {
  const m = method.toUpperCase();
  let p = path.toLowerCase();
  // strip /api prefix (v2 mounts at /api, v4 at /)
  p = p.replace(/^\/api\//, '/');
  if (!p.startsWith('/')) p = '/' + p;
  // normalize typed params: /:id{[0-9]+} ≡ /:id ≡ /:id(int)
  p = p.replace(/\{[^}]+\}/g, '').replace(/\(int\)/g, '').replace(/\(string\)/g, '');
  // singularize known v2 path nouns -> v4 equivalents
  p = p
    .replace(/^\/queue(\/|$)/, '/print-queue$1')
    .replace(/\/carrier-accounts(\/|$)/, '/carriers$1')
    .replace(/\/locations\/(\d+|:[a-z]+)\/setdefault/i, '/locations/$1/set-default');
  return `${m} ${p}`;
}

export function normalizeServiceId(name) {
  // Strip common v2→v4 name prefixes so createLabelV2 ≡ createLabel
  return name
    .replace(/V2$/, '')
    .replace(/^(ssV1|ss)/, '')
    .toLowerCase();
}

export function normalizeSchemaId(tableName, columnName) {
  // snake_case both sides for stable compare (drizzle auto-converts)
  const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const t = snake(tableName);
  // v2→v4 table renames
  const tableMap = {
    inventory_skus: 'inventory',
    inventory_parent_skus: 'parent_skus',
    order_local: 'order_overrides',
    rate_cache: 'rates',
    billing_line_items: 'billing_line_items',
    billing_config: 'billing_config',
  };
  const canonicalTable = tableMap[t] ?? t;
  if (!columnName) return `table:${canonicalTable}`;
  // v2→v4 column renames per table (e.g. clientId→client_id is handled by snake)
  const colMap = {
    'inventory.inv_sku_id': 'id',
    'inventory.min_stock': 'reorder_level',
    'orders.order_id': 'id',
    'shipments.shipment_id': 'id',
  };
  const key = `${canonicalTable}.${snake(columnName)}`;
  const col = colMap[key] ?? snake(columnName);
  return `column:${canonicalTable}.${col}`;
}

export function normalizeDtoId(name) {
  return name.replace(/Dto$/, '').replace(/Input$/, '').toLowerCase();
}

export function normalizeConstantId(name) {
  return name.toLowerCase();
}

export function normalizeHookId(name) {
  return name.toLowerCase().replace(/^use/, 'use');
}

export function normalizeApiClientId(name) {
  return name.toLowerCase();
}

export function normalizeViewAtomId(view, kind, key) {
  return `${view}:${kind}:${key.toLowerCase().replace(/\s+/g, '-')}`;
}

export function normalizeCssClassId(className) {
  return className.toLowerCase();
}

export function normalizeSsCallId(path) {
  return path.toLowerCase().replace(/\?.*$/, '');
}

// Atoms that require BEHAVIOR_MATCH (manual human review). These are the
// ~30 non-obvious business rules called out in the plan — anywhere the
// numeric output or decision tree isn't captured by type shape alone.
export const BEHAVIOR_MATCH_ATOMS = new Set([
  'service:findbestrate',
  'service:applymarkups',
  'service:computeshiftwindow',
  'service:billingsummary',
  'service:generatelineitems',
  'service:syncorders',
  'service:syncshipments',
  'service:createlabel',
  'service:createreturnlabel',
  'service:voidlabel',
  'service:retrievelabel',
  'service:applymovement',
  'service:getrates',
  'service:loadcarriermarkups',
  'service:isblockedrate',
  'constant:carrier_accounts_v2',
  'constant:blocked_carrier_ids',
  'constant:blocked_service_codes',
  'constant:expedited_services',
  'constant:media_mail_allowed_stores',
  'route:post /rates',
  'route:post /rates/browse',
  'route:post /labels',
  'route:post /orders/:id/best-rate',
  'route:get /orders/daily-stats',
  'route:post /billing/generate',
  'route:get /billing/summary',
  'route:get /analysis/skus',
  'route:get /analysis/daily-sales',
  'route:post /cron/sync-orders',
]);
