import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = process.cwd();
let failures = 0;

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function check(label: string, condition: boolean): void {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

function sourceFiles(directory: string): string[] {
  const absolute = resolve(root, directory);
  return readdirSync(absolute).flatMap((name) => {
    const path = resolve(absolute, name);
    if (statSync(path).isDirectory()) return sourceFiles(relative(root, path));
    return /\.(?:ts|tsx)$/.test(name) ? [relative(root, path).replaceAll('\\', '/')] : [];
  });
}

const importedHandlers = sourceFiles('src/lib/imported-handlers');
const typedHandlers = importedHandlers.filter((path) => !path.endsWith('/carriers-verify.ts'));

check('all imported handlers are present', importedHandlers.length === 8);
for (const path of importedHandlers) {
  const source = read(path);
  check(`${path} has no ts-nocheck`, !source.includes('@ts-nocheck'));
  check(`${path} owns no postgres pool`, !/postgres\s*\(/.test(source));
  check(
    `${path} never closes the shared pool`,
    !/\b(?:sql|dbSql)\.end\s*\(/.test(source),
  );
}

for (const path of typedHandlers) {
  const source = read(path);
  check(
    `${path} uses the typed Node adapter contract`,
    source.includes('NodeStyleRequest') && source.includes('NodeStyleResponse'),
  );
}

const nodeHandler = read('src/lib/node-handler.ts');
const credentialHelper = read('src/lib/credential-accounts.ts');
check(
  'node-handler owns the shared typed request/response and JSON boundary',
  nodeHandler.includes('export type NodeStyleRequest') &&
    nodeHandler.includes('export type NodeStyleResponse') &&
    nodeHandler.includes('export async function readNodeJsonBody'),
);
check(
  'credential parsing delegates to the shared Node JSON boundary',
  credentialHelper.includes('readNodeJsonBody as readJsonRequestBody'),
);

for (const path of [
  'src/lib/imported-handlers/walmart-orders.ts',
  'src/lib/imported-handlers/ebay-orders.ts',
  'src/lib/imported-handlers/shopify-orders.ts',
  'src/connectors/carrier/credential-verification.ts',
]) {
  check(`${path} delegates JSON parsing`, read(path).includes('readNodeJsonBody'));
}

const normalRequestDbPaths = [
  'src/lib/imported-handlers/carrier-accounts.ts',
  'src/lib/imported-handlers/store-accounts.ts',
  'src/lib/imported-handlers/walmart-orders.ts',
  'src/lib/imported-handlers/ebay-orders.ts',
  'src/lib/imported-handlers/shopify-orders.ts',
  'src/lib/imported-handlers/ebay-oauth-callback.ts',
  'src/connectors/carrier/credential-verification.ts',
  'src/routes/carriers.ts',
  'src/services/orders-performance-maintenance.ts',
] as const;

for (const path of normalRequestDbPaths) {
  const source = read(path);
  check(
    `${path} delegates connection ownership to db/client`,
    /(?:from ['"].*db\/client(?:\.js)?['"])/.test(source) &&
      !/postgres\s*\(/.test(source) &&
      !/\b(?:sql|dbSql)\.end\s*\(/.test(source),
  );
}

const credentialVerifier = read('src/connectors/carrier/credential-verification.ts');
const walmartFees = read('src/connectors/store/walmart-fees.ts');
check('credential verifier is typechecked', !credentialVerifier.includes('@ts-nocheck'));
check('Walmart fee owner is typechecked', !walmartFees.includes('@ts-nocheck'));

const poolConstructors = sourceFiles('src')
  .filter((path) => /postgres\s*\(/.test(read(path)))
  .sort();
const allowedPoolConstructors = [
  'src/db/client.ts',
  'src/lib/advisory-session-lock.ts',
  'src/routes/health.ts',
  'src/services/sync-job-queue.ts',
  'src/services/sync-lane-lock.ts',
  'src/services/sync-stuck-job-reaper.ts',
  'src/services/worker-status.ts',
].sort();
check(
  'only the app pool and explicitly isolated health/worker/session-lock pools construct connections',
  JSON.stringify(poolConstructors) === JSON.stringify(allowedPoolConstructors),
);
const syncJobQueue = read('src/services/sync-job-queue.ts');
check(
  'sync queue isolated pool is a one-connection consumer-leadership advisory-lock session',
  /shipStationConsumerLeaderSql = postgres\([\s\S]*max: 1[\s\S]*application_name: 'prepship-shipstation-consumer-leader'/.test(syncJobQueue) &&
    /pg_try_advisory_lock\(hashtext\(\$\{SHIPSTATION_CONSUMER_LEADER_LOCK\}\)\)/.test(syncJobQueue),
);
const syncStuckJobReaper = read('src/services/sync-stuck-job-reaper.ts');
check(
  'stuck-job recovery uses an isolated one-connection control-plane pool',
  /reaperSql = postgres\([\s\S]*max: 1[\s\S]*reaperTransactionPoolerCompatibility/.test(syncStuckJobReaper),
);
const workerStatus = read('src/services/worker-status.ts');
check(
  'worker telemetry uses a replaceable isolated one-connection pool',
  /createWorkerStatusSql\(\)[\s\S]*return postgres\([\s\S]*max: 1[\s\S]*workerStatusPoolerCompatibility/.test(workerStatus),
);

const credentialSchema = read('src/services/credential-account-schema.ts');
const renderStoreHandler = read('src/lib/imported-handlers/store-accounts.ts');
const legacyStoreHandler = read('api/store-accounts.ts');
const cutoverMigrationPath = 'drizzle/0063_credential_account_cutover.sql';
const cutoverMigration = existsSync(resolve(root, cutoverMigrationPath))
  ? read(cutoverMigrationPath)
  : '';
check(
  'credential runtime helper contains readiness only',
  credentialSchema.includes('ensureCredentialAccountRuntimeSchema') &&
    !credentialSchema.includes('migrateLegacyStoreCredentialRows'),
);
check(
  'request handlers never migrate credential rows',
  !renderStoreHandler.includes('migrateLegacyStoreCredentialRows') &&
    !legacyStoreHandler.includes('migrateLegacyStoreCredentialRows'),
);
check(
  'migration 0063 owns the credential data cutover',
  cutoverMigration.includes('INSERT INTO store_accounts') &&
    cutoverMigration.includes('DELETE FROM carrier_accounts') &&
    cutoverMigration.includes('store_accounts_id_seq'),
);

if (failures > 0) {
  console.error(`\nFAIL Audit 3.4 imported-handler boundary guard (${failures})`);
  process.exit(1);
}

console.log('\nPASS Audit 3.4 imported-handler boundary guard');
