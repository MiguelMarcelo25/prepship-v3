import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
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

const helper = read('src/lib/credential-accounts.ts');
const service = read('src/services/credential-accounts.ts');
const schemaFallback = read('src/services/credential-account-schema.ts');
const migration = read('drizzle/0027_credential_accounts_source_of_truth.sql');
const handlers = [
  ['api/carrier-accounts.ts', read('api/carrier-accounts.ts')],
  ['api/store-accounts.ts', read('api/store-accounts.ts')],
  [
    'src/lib/imported-handlers/carrier-accounts.ts',
    read('src/lib/imported-handlers/carrier-accounts.ts'),
  ],
];

assert(
  helper.includes('CREDENTIAL_PROVIDER_PATTERN') &&
    helper.includes('ALLOWED_ACCOUNT_SOURCES') &&
    helper.includes('normalizeCredentialAccountBody') &&
    helper.includes('readJsonRequestBody'),
  'credential account helper owns provider/source/body parsing primitives',
);

assert(
  service.includes('listCredentialAccounts') &&
    service.includes('upsertCredentialAccount') &&
    service.includes('deleteCredentialAccount') &&
    service.includes('replaceCarrierAccountClientAssignments'),
  'credential account service owns shared list/upsert/delete/assignment database operations',
);

for (const [file, source] of handlers) {
  assert(
    source.includes('normalizeCredentialAccountBody'),
    `${file} uses shared credential account body normalization`,
  );
  assert(
    source.includes('readJsonRequestBody'),
    `${file} uses shared JSON body reader`,
  );
  assert(
    !/const\s+PROVIDER_PATTERN\s*=/.test(source),
    `${file} does not define local provider pattern`,
  );
  assert(
    !/const\s+ALLOWED_SOURCES\s*=/.test(source),
    `${file} does not define local source allowlist`,
  );
  assert(!/await\s+readBody\(/.test(source), `${file} no longer calls local readBody`);
  assert(
    !/res\.status\(500\)\.json\(\{\s*error:\s*msg\s*\}\)/.test(source),
    `${file} returns production-safe generic 500 errors`,
  );
  assert(
    source.includes('listCredentialAccounts') &&
      source.includes('upsertCredentialAccount') &&
      source.includes('deleteCredentialAccount'),
    `${file} uses shared credential account database service`,
  );
  assert(
    source.includes('ensureCredentialAccountRuntimeSchema'),
    `${file} uses centralized runtime schema fallback`,
  );
  assert(
    !source.includes('CREATE TABLE IF NOT EXISTS ${TABLE}'),
    `${file} does not own credential account table DDL`,
  );
}

assert(
  service.includes('patchCredentialAccount') &&
    service.includes('getCredentialAccountSnapshot'),
  'credential account service owns shared patch/snapshot database operations',
);

assert(
  schemaFallback.includes('ensureCredentialAccountRuntimeSchema') &&
    schemaFallback.includes('migrateLegacyStoreCredentialRows'),
  'credential account runtime schema fallback is centralized',
);

assert(
  migration.includes('CREATE TABLE IF NOT EXISTS "store_accounts"') &&
    migration.includes('CREATE TABLE IF NOT EXISTS "carrier_account_clients"'),
  'credential account tables and assignment junction are represented in migrations',
);

assert(
  handlers[0][1].includes("if (req.method === 'PATCH')") &&
    handlers[1][1].includes("if (req.method === 'PATCH')") &&
    handlers[2][1].includes("if (req.method === 'PATCH')"),
  'carrier/store handlers share PATCH source/label update support',
);

assert(
  handlers[0][1].includes('promotePortal: true') &&
    handlers[2][1].includes('promotePortal: true'),
  'Vercel and Render carrier assignment paths both promote portal rows',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
