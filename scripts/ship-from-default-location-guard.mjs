import { readFileSync } from 'node:fs';

function assert(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) process.exitCode = 1;
}

// PS-209/PS-202: api/carriers/labels.ts is a retired 410 stub. The direct-label
// purchase path is now the v4 owner src/services/labels.ts (createLabelV2), which
// resolves the ship-from from the SAME default-Location source (getDefaultShipFrom)
// and maps every Location field into the connector ship-from. The invariant —
// default Location is the authoritative ship-from, best-effort, before the carrier
// connector runs — is unchanged; repointed to the new owner + shape.
const labels = readFileSync('src/services/labels.ts', 'utf8');
const shipFrom = readFileSync('src/lib/ship-from.ts', 'utf8');
const locations = readFileSync('src/services/locations.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

// 1. The default-Location ship-from is resolved from the same source-of-truth the
//    ShipStation path uses (getDefaultShipFrom -> default Location record).
assert(
  labels.includes("import { getDefaultShipFrom } from '../lib/ship-from'"),
  'src/services/labels.ts imports getDefaultShipFrom from the default-Location source',
);
assert(
  labels.includes('const fromLoc = await getDefaultShipFrom();'),
  'createLabelV2 resolves the default-Location ship-from via getDefaultShipFrom()',
);

// 2. It is invoked on the direct-label path and the resolved shipFrom flows into
//    the connector call (i.e. before any carrier branch ships the package).
{
  const resolveIdx = labels.indexOf('const fromLoc = await getDefaultShipFrom();');
  const connectorIdx = labels.indexOf('shipFrom,', resolveIdx);
  assert(
    resolveIdx !== -1 && connectorIdx !== -1 && connectorIdx > resolveIdx,
    'default-Location ship-from is resolved before it is passed to the carrier connector',
  );
}

// 3. Every default-Location field is mapped into the connector ship-from — this is
//    what makes the default Location authoritative and removes stale SHIPPHQ /
//    'Seller'/'Warehouse'/'Carson' values.
assert(
  labels.includes('name: fromLoc.name') &&
    labels.includes('street1: fromLoc.address_line1') &&
    labels.includes('city: fromLoc.city_locality') &&
    labels.includes('state: fromLoc.state_province') &&
    labels.includes('postalCode: fromLoc.postal_code'),
  'createLabelV2 maps the default-Location fields into the connector ship-from',
);

// 4. It must be best-effort: a missing default Location / env must NOT break label
//    creation (it falls back to defaultShipFromAddress()).
{
  const start = labels.indexOf('const fromLoc = await getDefaultShipFrom();');
  const body = start !== -1 ? labels.slice(Math.max(0, start - 200), start + 600) : '';
  assert(
    /try\s*\{/.test(body) && /catch\b/.test(body) && /defaultShipFromAddress\(\)/.test(body),
    'the default-Location ship-from resolution is wrapped in try/catch so a missing default Location never breaks label creation',
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
