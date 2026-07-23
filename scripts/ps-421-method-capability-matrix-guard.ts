import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import * as ts from 'typescript';
import {
  BUSINESS_ROUTE_POLICIES,
  type BusinessRoutePolicyId,
} from '../src/lib/business-route-policy';
import {
  dashboardDailyRevenueForFinancialViewer,
  dashboardSummaryForFinancialViewer,
} from '../src/services/dashboard-financial-redaction';
import { getClientStoreScope } from '../src/lib/client-store-scope';

process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

const {
  evaluateBusinessRoutePolicy,
  requireBusinessRoutePolicy,
} = await import('../src/middleware/auth');
const {
  authorizeRateRequestScope,
  authorizeRateRequestScopes,
} = await import('../src/services/rate-request-authorization');

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`ok: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

type ActualRoute = {
  router: keyof typeof routeFiles;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  policyId: string | null;
};

const routeFiles = {
  inventory: 'src/routes/inventory.ts',
  packages: 'src/routes/packages.ts',
  rates: 'src/routes/rates.ts',
  clients: 'src/routes/clients.ts',
  dashboard: 'src/routes/dashboard.ts',
} as const;
const mutationMethods = new Set(['post', 'put', 'patch', 'delete']);

function mutationRoutes(
  router: keyof typeof routeFiles,
  file: string,
): ActualRoute[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes: ActualRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      mutationMethods.has(node.expression.name.text)
    ) {
      const pathArg = node.arguments[0];
      if (pathArg && ts.isStringLiteral(pathArg)) {
        const policyArg = node.arguments
          .filter(ts.isCallExpression)
          .find((arg) => (
            ts.isIdentifier(arg.expression) &&
            arg.expression.text === 'requireBusinessRoutePolicy'
          ));
        const policyIdArg = policyArg?.arguments[0];
        routes.push({
          router,
          method: node.expression.name.text.toUpperCase() as ActualRoute['method'],
          path: pathArg.text,
          policyId: policyIdArg && ts.isStringLiteral(policyIdArg)
            ? policyIdArg.text
            : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

const actualRoutes = Object.entries(routeFiles).flatMap(([router, file]) => (
  mutationRoutes(router as keyof typeof routeFiles, file)
));
const usedPolicyIds = new Set<string>();
for (const route of actualRoutes) {
  check(
    `${route.method} /${route.router}${route.path} names a business route policy`,
    route.policyId != null,
  );
  if (!route.policyId) continue;
  usedPolicyIds.add(route.policyId);
  const policy = BUSINESS_ROUTE_POLICIES[route.policyId as BusinessRoutePolicyId];
  check(
    `${route.policyId} matrix tuple matches its route`,
    Boolean(
      policy &&
      policy.router === route.router &&
      policy.method === route.method &&
      policy.path === route.path,
    ),
  );
}

for (const [policyId, policy] of Object.entries(BUSINESS_ROUTE_POLICIES)) {
  check(`${policyId} is wired to a route`, usedPolicyIds.has(policyId));
  check(`${policyId} has a named permission`, policy.permission.length > 0);
  check(`${policyId} has an explicit resource predicate`, policy.resourceScope.length > 0);
}
check(
  'matrix and source expose the same number of non-GET business routes',
  actualRoutes.length === Object.keys(BUSINESS_ROUTE_POLICIES).length,
);

const roles = ['client_user', 'read_only_support', 'warehouse'] as const;
for (const [policyId, policy] of Object.entries(BUSINESS_ROUTE_POLICIES)) {
  for (const role of roles) {
    const decision = evaluateBusinessRoutePolicy(
      policyId as BusinessRoutePolicyId,
      { role },
      policy.method,
    );
    if (role === 'read_only_support') {
      check(`${policyId}: read_only_support is denied`, !decision.allowed);
    }
    if (role === 'client_user' && policy.audience === 'internal') {
      check(`${policyId}: client_user cannot cross the internal boundary`, !decision.allowed);
    }
    if (
      role === 'warehouse' &&
      ['settings:write', 'financials:write', 'scope:global'].includes(policy.permission)
    ) {
      check(`${policyId}: warehouse cannot administer catalog/financial/global truth`, !decision.allowed);
    }
  }
}

// Actual middleware proof: every matrix entry rejects read_only_support before
// the handler-side effect spy can run, even if the token claims the permission.
for (const [policyId, policy] of Object.entries(BUSINESS_ROUTE_POLICIES)) {
  let sideEffects = 0;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('role' as never, 'read_only_support' as never);
    c.set('permissions' as never, [policy.permission] as never);
    await next();
  });
  app.all(
    '/',
    requireBusinessRoutePolicy(policyId as BusinessRoutePolicyId),
    (c) => {
      sideEffects += 1;
      return c.json({ ok: true });
    },
  );
  const response = await app.request('/', { method: policy.method });
  check(
    `${policyId}: middleware denial precedes DB/provider/cache/job side effect`,
    response.status === 403 && sideEffects === 0,
  );
}

for (const [policyId, policy] of Object.entries(BUSINESS_ROUTE_POLICIES)) {
  for (const role of ['client_user', 'warehouse'] as const) {
    const decision = evaluateBusinessRoutePolicy(
      policyId as BusinessRoutePolicyId,
      { role },
      policy.method,
    );
    if (decision.allowed) continue;
    let sideEffects = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('role' as never, role as never);
      await next();
    });
    app.all(
      '/',
      requireBusinessRoutePolicy(policyId as BusinessRoutePolicyId),
      (c) => {
        sideEffects += 1;
        return c.json({ ok: true });
      },
    );
    const response = await app.request('/', { method: policy.method });
    check(
      `${policyId}: ${role} denial leaves the ${policy.effect} spy unchanged`,
      response.status === 403 && sideEffects === 0,
    );
  }
}

const clientAScope = getClientStoreScope({
  role: 'client_user',
  clientIds: [10],
  storeIds: [100],
});
const globalScope = getClientStoreScope({ role: 'admin' });
let orderLoads = 0;
const orderLoader = async (orderId: number) => {
  orderLoads += 1;
  return orderId === 1
    ? { clientId: 10, storeId: 100 }
    : orderId === 2
      ? { clientId: 20, storeId: 200 }
      : null;
};
check(
  'rate scope allows client A raw client/store context',
  (await authorizeRateRequestScope(clientAScope, { clientId: 10, storeId: 100 }, orderLoader)).allowed,
);
check(
  'rate scope denies client A raw client B context',
  !(await authorizeRateRequestScope(clientAScope, { clientId: 20, storeId: 200 }, orderLoader)).allowed,
);
check(
  'rate scope denies mixed raw client A/store B context',
  !(await authorizeRateRequestScope(clientAScope, { clientId: 10, storeId: 200 }, orderLoader)).allowed,
);
check(
  'rate scope allows client A order',
  (await authorizeRateRequestScope(clientAScope, { orderId: 1 }, orderLoader)).allowed,
);
check(
  'rate scope denies raw client/store claims that conflict with an in-scope order',
  !(await authorizeRateRequestScope(
    clientAScope,
    { orderId: 1, clientId: 10, storeId: 200 },
    orderLoader,
  )).allowed,
);
check(
  'rate order binding also rejects mismatched raw context for global callers',
  !(await authorizeRateRequestScope(
    globalScope,
    { orderId: 1, clientId: 20, storeId: 200 },
    orderLoader,
  )).allowed,
);
check(
  'rate scope denies client B order to client A',
  !(await authorizeRateRequestScope(clientAScope, { orderId: 2 }, orderLoader)).allowed,
);
check(
  'rate scope rejects a restricted request with no order/client/store context',
  !(await authorizeRateRequestScope(clientAScope, {}, orderLoader)).allowed,
);
check('rate order authorization uses the injected lookup boundary', orderLoads === 4);

let batchLoads = 0;
const batchDecision = await authorizeRateRequestScopes(
  clientAScope,
  [{ orderId: 1 }, { orderId: 2 }],
  async (ids) => {
    batchLoads += 1;
    return new Map(ids.map((id) => [
      id,
      id === 1
        ? { clientId: 10, storeId: 100 }
        : { clientId: 20, storeId: 200 },
    ]));
  },
);
check('bulk rate scope denies when any order belongs to another tenant', !batchDecision.allowed);
check('bulk rate scope resolves all orders in one lookup', batchLoads === 1);

const [
  inventoryRoute,
  packagesRoute,
  ratesRoute,
  clientsRoute,
] = await Promise.all([
  import('../src/routes/inventory'),
  import('../src/routes/packages'),
  import('../src/routes/rates'),
  import('../src/routes/clients'),
]);
function routeApp(role: string, route: Hono, permissions: string[] = []): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('role' as never, role as never);
    c.set('permissions' as never, permissions as never);
    c.set('clientIds' as never, [10] as never);
    c.set('storeIds' as never, [100] as never);
    await next();
  });
  app.route('/', route);
  return app;
}
check(
  'actual inventory create route denies client_user before DB/ledger mutation',
  (await routeApp('client_user', inventoryRoute.default).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 10, sku: 'PS421-DENIED', stockQty: 5 }),
  })).status === 403,
);
check(
  'actual package catalog route denies warehouse before package config mutation',
  (await routeApp('warehouse', packagesRoute.default).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Denied', length: 1, width: 1, height: 1 }),
  })).status === 403,
);
check(
  'actual package receive route denies warehouse before schema/stock mutation',
  (await routeApp('warehouse', packagesRoute.default).request('/1/receive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qty: 1 }),
  })).status === 403,
);
check(
  'actual package receive route denies cost metadata without financial authority',
  (await routeApp('custom_internal', packagesRoute.default, ['settings:write']).request('/1/receive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qty: 1, unitCost: 9.99 }),
  })).status === 403,
);
check(
  'actual rate route denies client A raw client B context before cache/provider work',
  (await routeApp('client_user', ratesRoute.default).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      weightOz: 16,
      toZip: '90210',
      clientId: 20,
      storeId: 200,
    }),
  })).status === 403,
);
check(
  'actual client sync route denies client_user before provider/client mutation',
  (await routeApp('client_user', clientsRoute.default).request('/sync-stores', {
    method: 'POST',
  })).status === 403,
);

const hiddenSummary = dashboardSummaryForFinancialViewer({
  revenue: 150,
  units: 3,
  bySku: [{ sku: 'A', revenue: 100, units30: 2, units7: 1 }],
  dailyRevenue: [{ day: '2026-07-17', revenue: 150 }],
}, false);
check(
  'dashboard summary redacts every revenue field without financials:read',
  hiddenSummary.canViewFinancials === false &&
    hiddenSummary.revenue === null &&
    hiddenSummary.bySku[0]?.revenue === null &&
    hiddenSummary.dailyRevenue[0]?.revenue === null &&
    hiddenSummary.units === 3,
);
const hiddenDaily = dashboardDailyRevenueForFinancialViewer([
  { day: '2026-07-17', clientId: 10, revenue: 150, count: 2 },
], false);
check('dashboard daily client revenue is redacted', hiddenDaily[0]?.revenue === null);

const inventorySource = readFileSync(routeFiles.inventory, 'utf8');
const packageSource = readFileSync(routeFiles.packages, 'utf8');
const clientsSource = readFileSync(routeFiles.clients, 'utf8');
const dashboardSource = readFileSync(routeFiles.dashboard, 'utf8');
const mainSource = readFileSync('src/main.ts', 'utf8');
const rateWorkflowSource = readFileSync('src/services/rate-browse-workflow.ts', 'utf8');
check(
  'warehouse bulk receive cannot auto-create catalog rows without settings:write',
  inventorySource.includes('allowCatalogCreate') &&
    inventorySource.includes('must exist before warehouse receiving'),
);
check(
  'warehouse package receive cannot write unit cost without financials:write',
  packageSource.includes('Financial write permission required for package unit cost') &&
    packageSource.includes("hasInternalAppPermission("),
);
check(
  'client aggregate SQL applies caller client/store scope and orphans are internal-only',
  clientsSource.includes('clientAggregateOrderScopePredicate') &&
    clientsSource.includes('and ${aggregateScopePredicate}') &&
    clientsSource.includes("requireInternalPermission('settings:read')"),
);
check(
  'dashboard cache keys include financial visibility before redacted serialization',
  dashboardSource.includes('financials: canViewFinancials') &&
    dashboardSource.includes('dashboardSummaryForFinancialViewer') &&
    dashboardSource.includes('dashboardDailyRevenueForFinancialViewer'),
);
check(
  'rate workflow snapshots persist the initiating client/store scope for status reads',
  rateWorkflowSource.includes('clientId: finiteNumber(input.body.clientId)') &&
    rateWorkflowSource.includes('storeId: finiteNumber(input.body.storeId)') &&
    ratesRoute.default != null &&
    readFileSync(routeFiles.rates, 'utf8').includes('clientId: snapshot.clientId') &&
    readFileSync(routeFiles.rates, 'utf8').includes('storeId: snapshot.storeId'),
);
check(
  'global protected-route boundary enforces read_only_support method policy after auth',
  mainSource.includes('enforceReadOnlySupportMethods') &&
    mainSource.includes('app.use(prefix, enforceReadOnlySupportMethods)') &&
    mainSource.includes('app.use(`${prefix}/*`, enforceReadOnlySupportMethods)'),
);

if (failures) {
  console.error(`\nPS-421 method/capability/scope guard failed: ${failures}`);
  process.exit(1);
}
console.log(`\nPS-421 method/capability/scope guard passed (${actualRoutes.length} routes).`);
