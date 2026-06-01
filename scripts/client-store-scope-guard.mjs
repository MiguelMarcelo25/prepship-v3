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

const authSource = read('src/middleware/auth.ts');
const scopeSource = fs.existsSync(path.join(root, 'src/lib/client-store-scope.ts'))
  ? read('src/lib/client-store-scope.ts')
  : '';
const clientsSource = read('src/routes/clients.ts');
const initSource = read('src/routes/init.ts');

assert(authSource.includes('clientIds?: number[]'), 'auth vars include clientIds');
assert(authSource.includes('storeIds?: number[]'), 'auth vars include storeIds');
assert(authSource.includes('clientIds') && authSource.includes('client_ids'), 'auth reads camel/snake client scope claims');
assert(authSource.includes('storeIds') && authSource.includes('store_ids'), 'auth reads camel/snake store scope claims');
assert(authSource.includes("c.set('clientIds'") && authSource.includes("c.set('storeIds'"), 'auth stores scope vars on context');

assert(scopeSource.includes('getClientStoreScope'), 'client/store scope helper exposes getClientStoreScope');
assert(scopeSource.includes('filterClientsForScope'), 'client/store scope helper filters client rows');
assert(scopeSource.includes('isClientVisibleToScope'), 'client/store scope helper checks single client visibility');
assert(scopeSource.includes('client_user') && scopeSource.includes('read_only_support'), 'client/store scope helper handles externally scoped roles');
assert(scopeSource.includes('scope:global'), 'client/store scope helper supports explicit global scope permission');
assert(
  scopeSource.includes('if (explicitGlobal)') &&
    scopeSource.includes('clientIds: []') &&
    scopeSource.includes('storeIds: []') &&
    scopeSource.includes('isRestricted: false'),
  'global admins ignore assigned client/store claims and keep unrestricted scope',
);

assert(
  clientsSource.includes('filterClientsForScope') &&
    clientsSource.includes('getClientStoreScope') &&
    clientsSource.includes('isClientVisibleToScope'),
  'clients route uses client/store scope helpers',
);
assert(
  clientsSource.includes('filterClientsForScope(safeRows') &&
    clientsSource.includes('isClientVisibleToScope(safeRow'),
  'clients list/detail responses are scope filtered',
);

assert(
  initSource.includes('filterClientsForScope') &&
    initSource.includes('getClientStoreScope'),
  'init route uses client/store scope helpers',
);
assert(
  initSource.includes('visibleClients') &&
    initSource.includes('clients: visibleClients') &&
    initSource.includes('for (const cli of visibleClients'),
  'init-data and stores payloads use scoped clients',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
