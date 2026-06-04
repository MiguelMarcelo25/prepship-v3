import { readFileSync } from 'node:fs';

function assert(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

const labels = readFileSync('api/carriers/labels.ts', 'utf8');
const shipFrom = readFileSync('src/lib/ship-from.ts', 'utf8');
const locations = readFileSync('src/services/locations.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

// 1. The default-Location ship-from helper exists and is loaded from the same
//    source the ShipStation path uses (getDefaultShipFrom -> default Location).
assert(
  labels.includes('async function applyDefaultLocationShipFrom('),
  'api/carriers/labels.ts defines applyDefaultLocationShipFrom()',
);
assert(
  labels.includes("getDefaultShipFrom = (await import('../../src/lib/ship-from.js')).getDefaultShipFrom"),
  'ensureLabelDeps lazy-loads getDefaultShipFrom from the default-Location source',
);

// 2. It is actually invoked on the direct-label path, right after creds is built
//    (i.e. before any carrier branch reads creds.shipFrom*).
assert(
  labels.includes('await applyDefaultLocationShipFrom(creds)'),
  'direct-label path invokes applyDefaultLocationShipFrom(creds)',
);
{
  const credsIdx = labels.indexOf('const creds = (credentials ?? {}) as Record<string, unknown>;');
  const applyIdx = labels.indexOf('await applyDefaultLocationShipFrom(creds)');
  assert(
    credsIdx !== -1 && applyIdx !== -1 && applyIdx > credsIdx && applyIdx - credsIdx < 400,
    'applyDefaultLocationShipFrom runs immediately after creds is built (before carrier branches)',
  );
}

// 3. The helper overwrites the creds.shipFrom* keys that every direct connector
//    reads first — this is what makes the default Location authoritative and
//    removes the stale SHIPPHQ / 'Seller'/'Warehouse'/'Carson' values.
assert(
  labels.includes('creds.shipFromName = loc.name') &&
    labels.includes('creds.shipFromAddress1 = loc.address_line1') &&
    labels.includes('creds.shipFromCity = loc.city_locality') &&
    labels.includes('creds.shipFromState = loc.state_province') &&
    labels.includes('creds.shipFromZip = loc.postal_code'),
  'applyDefaultLocationShipFrom overwrites creds.shipFrom* from the default Location',
);

// 4. The helper must be best-effort: a missing default Location / env must NOT
//    break label creation (it falls back to prior per-account behavior).
{
  const start = labels.indexOf('async function applyDefaultLocationShipFrom(');
  const body = start !== -1 ? labels.slice(start, start + 1200) : '';
  assert(
    /try\s*\{/.test(body) && /catch\b/.test(body),
    'applyDefaultLocationShipFrom is wrapped in try/catch so a missing default Location never breaks label creation',
  );
}

// 5. The source of truth is the default Location record (Settings -> Location).
assert(
  shipFrom.includes('getDefaultLocation') &&
    shipFrom.includes('export async function getDefaultShipFrom'),
  'ship-from.ts resolves the default ship-from from the default Location record',
);

// 6. ship-from.ts + locations.ts are reachable from a Vercel function, so their
//    relative imports must carry .js runtime extensions (Node ESM).
assert(
  shipFrom.includes("from './env.js'") &&
    shipFrom.includes("from '../services/locations.js'"),
  'ship-from.ts relative imports use .js runtime extensions (Vercel ESM safe)',
);
assert(
  locations.includes("from '../db/client.js'") &&
    locations.includes("from '../db/schema/locations.js'"),
  'locations.ts relative imports use .js runtime extensions (Vercel ESM safe)',
);

// 7. The guard is wired into package scripts.
assert(
  pkg.includes('"test:ship-from-default-location": "node scripts/ship-from-default-location-guard.mjs"'),
  'package.json exposes the ship-from default-location guard script',
);

if (process.exitCode) {
  console.error('\nShip-from default-location guard failed.');
  process.exit(process.exitCode);
}
console.log('\nShip-from default-location guard passed.');
