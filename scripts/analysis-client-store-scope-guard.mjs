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

const source = read('src/routes/analysis.ts');

assert(
  source.includes('getClientStoreScope') && source.includes('type ClientStoreScope'),
  'analysis imports client/store scope helpers',
);
assert(
  source.includes('analysisScopeFromContext') &&
    source.includes("c.get('clientIds'") &&
    source.includes("c.get('storeIds'"),
  'analysis builds scope from auth context',
);
assert(
  source.includes('withAnalysisScope') &&
    source.includes('clientIds: scope.clientIds') &&
    source.includes('storeIds: scope.storeIds') &&
    source.includes('scopeRestricted: scope.isRestricted'),
  'analysis attaches auth scope to query helpers',
);
assert(
  source.includes('analysisOrderScopePredicate') &&
    source.includes('analysisShipmentScopePredicate'),
  'analysis defines order and shipment scope predicates',
);
assert(
  source.includes('and ${analysisOrderScopePredicate(scope)}') &&
    source.includes('and ${analysisShipmentScopePredicate(scope)}'),
  'analysis overview applies order and shipment scope predicates',
);
assert(
  source.includes('dailyShipmentsScope') &&
    source.includes('and ${analysisShipmentScopePredicate(dailyShipmentsScope)}'),
  'analysis daily shipments applies shipment scope predicate',
);
assert(
  source.includes('topSkusScope') &&
    source.includes('and ${analysisOrderScopePredicate(topSkusScope)}'),
  'analysis top-skus applies order scope predicate',
);
assert(
  source.includes('getSkuDaily(withAnalysisScope(c, c.req.valid') &&
    source.includes('getSkuBreakdown(withAnalysisScope(c, c.req.valid'),
  'analysis sku routes pass context scope into shared helpers',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
