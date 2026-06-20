import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const webSrc = path.join(root, 'web/src');
const routesDir = path.join(root, 'src/routes');
const apiDir = path.join(root, 'api');
const mainPath = path.join(root, 'src/main.ts');

const routeFileByMount = new Map([
  ['orders', 'orders.ts'],
  ['shipments', 'shipments.ts'],
  ['packages', 'packages.ts'],
  ['clients', 'clients.ts'],
  ['rates', 'rates.ts'],
  ['labels', 'labels.ts'],
  ['sync', 'sync.ts'],
  ['inventory', 'inventory.ts'],
  ['locations', 'locations.ts'],
  ['settings', 'settings.ts'],
  ['billing', 'billing.ts'],
  ['manifests', 'manifests.ts'],
  ['analysis', 'analysis.ts'],
  ['dashboard', 'dashboard.ts'],
  ['print-queue', 'print-queue.ts'],
  ['parent-skus', 'parent-skus.ts'],
  ['products', 'products.ts'],
  ['init', 'init.ts'],
  ['admin', 'admin.ts'],
  ['carrier-accounts', 'carrier-accounts.ts'],
  ['carriers', 'carriers.ts'],
  ['users', 'users.ts'],
  ['worker', 'worker.ts'],
  ['observability', 'observability.ts'],
  ['cron', 'cron.ts'],
  ['health', 'health.ts'],
  ['store-accounts', 'store-accounts.ts'],
  ['automation', 'automation.ts'],
]);

const ignoredFrontendPaths = [
  // External/same-origin pages, object URLs, and browser-only flows.
  /^https?:\/\//,
  /^blob:/,
  /^data:/,
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function stripQuery(value) {
  return value.split('?')[0];
}

function normalizeTemplatePath(value) {
  const staticPath = value
    // Query-string helpers such as `/orders${qs(query)}` do not change the
    // route shape; keep the static route path and ignore the generated query.
    .replace(/\$\{qs[\s\S]*$/g, '')
    .replace(/\$\{[^}]*\?[^}]*\}/g, '')
    .replace(/\$\{(?:detailsQs|queryString|[^}]*Qs)\}$/g, '')
    // Conditional suffixes are too dynamic for this lightweight guard. Keep
    // the static route prefix so the guard still verifies the owning endpoint.
    .replace(/\$\{[^}]+$/g, '');

  return stripQuery(staticPath)
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\s+/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function routeToRegex(pathPattern) {
  const normalized = normalizeTemplatePath(pathPattern)
    .replace(/:\w+\{\[[^}]+\]\}/g, ':param')
    .replace(/:\w+/g, ':param');

  const escaped = normalized
    .split('/')
    .map((part) => {
      if (part === ':param' || part.startsWith(':')) return '[^/]+';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  return new RegExp(`^${escaped}/?$`);
}

function joinRoute(prefix, child) {
  const cleanPrefix = `/${prefix}`.replace(/\/+/g, '/').replace(/\/$/, '');
  if (child === '/' || child === '') return cleanPrefix;
  return `${cleanPrefix}/${child.replace(/^\//, '')}`.replace(/\/+/g, '/');
}

function extractHonoRoutes() {
  const main = readFileSync(mainPath, 'utf8');
  const mountedPrefixes = [...main.matchAll(/app\.route\('\/([^']+)'/g)].map((match) => match[1]);
  const routes = [];

  for (const prefix of mountedPrefixes) {
    const routeFile = routeFileByMount.get(prefix);
    if (!routeFile) continue;
    const routePath = path.join(routesDir, routeFile);
    if (!existsSync(routePath)) continue;
    const source = readFileSync(routePath, 'utf8');
    const routeMatches = source.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g);

    for (const match of routeMatches) {
      routes.push({
        method: match[1].toUpperCase(),
        path: joinRoute(prefix, match[2]),
        source: path.relative(root, routePath),
      });
    }
  }

  return routes;
}

function extractVercelApiRoutes() {
  return walk(apiDir).map((file) => {
    const relative = path.relative(apiDir, file).replaceAll('\\', '/').replace(/\.ts$/, '');
    const route = relative.endsWith('/index') ? relative.slice(0, -'/index'.length) : relative;
    return {
      method: 'ALL',
      path: `/api/${route}`,
      source: path.relative(root, file),
    };
  });
}

function extractFrontendCalls() {
  const calls = [];
  const files = walk(webSrc);

  const patterns = [
    {
      kind: 'render-api',
      regex: /api\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"`])([\s\S]*?)\2/g,
      methodIndex: 1,
      pathIndex: 3,
      prefix: '',
    },
    {
      kind: 'vercel-api',
      regex: /callVercelFunction(?:<[^>]*>)?\(\s*(['"`])([\s\S]*?)\1/g,
      methodIndex: null,
      pathIndex: 2,
      prefix: '/api',
    },
    {
      kind: 'direct-fetch',
      regex: /fetch\(\s*(['"`])([\s\S]*?)\1/g,
      methodIndex: null,
      pathIndex: 2,
      prefix: '',
    },
  ];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern.regex)) {
        const rawPath = match[pattern.pathIndex];
        if (!rawPath || rawPath.includes('\n')) continue;

        let requestPath = normalizeTemplatePath(rawPath);
        if (!requestPath.startsWith('/')) continue;
        if (ignoredFrontendPaths.some((ignored) => ignored.test(requestPath))) continue;

        if (pattern.kind === 'direct-fetch' && !requestPath.startsWith('/api/')) continue;
        if (pattern.prefix && !requestPath.startsWith(pattern.prefix)) {
          requestPath = `${pattern.prefix}${requestPath}`;
        }

        calls.push({
          method: pattern.methodIndex == null ? 'ALL' : match[pattern.methodIndex].toUpperCase(),
          path: requestPath,
          kind: pattern.kind,
          source: path.relative(root, file),
        });
      }
    }
  }

  return calls;
}

function routeMatchesCall(route, call) {
  if (route.method !== 'ALL' && call.method !== 'ALL' && route.method !== call.method) return false;
  return routeToRegex(route.path).test(call.path);
}

const backendRoutes = [...extractHonoRoutes(), ...extractVercelApiRoutes()];
const frontendCalls = extractFrontendCalls();
const missing = frontendCalls.filter((call) => !backendRoutes.some((route) => routeMatchesCall(route, call)));

const uniqueMissing = new Map();
for (const call of missing) {
  const key = `${call.method} ${call.path}`;
  if (!uniqueMissing.has(key)) uniqueMissing.set(key, []);
  uniqueMissing.get(key).push(call.source);
}

if (uniqueMissing.size > 0) {
  console.error('Missing backend handlers for frontend calls:');
  for (const [key, sources] of uniqueMissing.entries()) {
    console.error(`- ${key}`);
    for (const source of [...new Set(sources)].slice(0, 5)) {
      console.error(`  from ${source}`);
    }
  }
}

assert.equal(uniqueMissing.size, 0, 'Frontend API calls must have matching Render/Hono routes or Vercel /api handlers');

console.log('PASS backend connectivity guard');
console.log(`checked frontend calls=${frontendCalls.length} backend routes=${backendRoutes.length}`);
