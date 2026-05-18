import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const secretKeys = ['ssApiKey', 'ssApiSecret', 'ssApiKeyV2'];

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

const publicClient = read('src/lib/public-client.ts');
const clientsRoute = read('src/routes/clients.ts');
const initRoute = read('src/routes/init.ts');
const clientModal = read('web/src/components/ClientModal.tsx');
const v2Hooks = read('web/src/hooks/v2Hooks.ts');
const v2ApiClient = read('web/src/lib/v2-apiClient.ts');

assert(
  /const\s*\{\s*ssApiKey,\s*ssApiSecret,\s*ssApiKeyV2,\s*\.\.\.safe\s*\}\s*=\s*row/.test(
    publicClient,
  ),
  'publicClient strips ShipStation secret fields',
);
assert(
  publicClient.includes('hasShipStationV1Credentials') &&
    publicClient.includes('hasShipStationV2Credentials'),
  'publicClient emits credential presence booleans',
);

assert(
  clientsRoute.includes("import { publicClient } from '../lib/public-client'"),
  'clients route imports publicClient mapper',
);
assert(
  (clientsRoute.match(/publicClient/g) ?? []).length >= 5,
  'clients route uses publicClient on list, detail, create, and update responses',
);
assert(
  !/return\s+c\.json\(\s*(rows|row)\s*[,)]/.test(clientsRoute),
  'clients route does not return raw client rows',
);
assert(
  /clients:\s*clientsRows\.map\(publicClient\)/.test(initRoute),
  'init-data maps client rows through publicClient',
);
assert(
  !/clients:\s*clientsRows\s*[,}]/.test(initRoute),
  'init-data does not return raw clientsRows',
);

const lightweightMatch = clientsRoute.match(
  /function\s+lightweightClient[\s\S]*?\n}\n\nconst\s+body/,
);
assert(Boolean(lightweightMatch), 'lightweight client serializer is present');
if (lightweightMatch) {
  for (const key of secretKeys) {
    assert(
      !lightweightMatch[0].includes(key),
      `lightweight client serializer does not expose ${key}`,
    );
  }
}

const rawResponseDependencyChecks = [
  ['ClientModal existing ssApiKey', clientModal, /existing\?\.ssApiKey/],
  ['ClientModal existing ssApiSecret', clientModal, /existing\?\.ssApiSecret/],
  ['ClientModal existing ssApiKeyV2', clientModal, /existing\?\.ssApiKeyV2/],
  ['v2Hooks row.ssApiKey', v2Hooks, /row\.ssApiKey/],
  ['v2Hooks row.ssApiSecret', v2Hooks, /row\.ssApiSecret/],
  ['v2Hooks row.ssApiKeyV2', v2Hooks, /row\.ssApiKeyV2/],
  ['v2-apiClient row?.ssApiKey', v2ApiClient, /row\?\.ssApiKey/],
  ['v2-apiClient row?.ssApiSecret', v2ApiClient, /row\?\.ssApiSecret/],
  ['v2-apiClient row?.ssApiKeyV2', v2ApiClient, /row\?\.ssApiKeyV2/],
  ['v2-apiClient row?.ss_api_key', v2ApiClient, /row\?\.ss_api_key/],
  ['v2-apiClient row?.ss_api_secret', v2ApiClient, /row\?\.ss_api_secret/],
];

for (const [label, source, pattern] of rawResponseDependencyChecks) {
  assert(!pattern.test(source), `${label} is not used to infer credential presence`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
