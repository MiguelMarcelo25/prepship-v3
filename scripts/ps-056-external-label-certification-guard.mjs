import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const reconcileScript = readFileSync('scripts/reconcile-external-shipped-orders.ts', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const ordersSpec = readFileSync('web/e2e/orders-column-integrity.spec.js', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

assert.match(
  reconcileScript,
  /alreadyFlaggedExternal/,
  'PS-056 certification must report shipped missing-local rows already flagged external.',
);
assert.match(
  reconcileScript,
  /missingLocalUnflagged/,
  'PS-056 certification must report shipped rows missing local shipment data and not externally flagged.',
);
assert.match(
  reconcileScript,
  /classifiedExternal/,
  'PS-056 certification must separately report rows classified external by the upstream-none rule.',
);
assert.match(
  reconcileScript,
  /classifiedRecoverable/,
  'PS-056 certification must separately report rows classified recoverable by upstream shipment/fulfillment evidence.',
);
assert.match(
  reconcileScript,
  /lookupFailures/,
  'PS-056 certification must separately report lookup failures.',
);
assert.match(
  reconcileScript,
  /PS-056/,
  'PS-056 certification output should be identifiable in logs/reports.',
);
assert.equal(
  packageJson.scripts['test:ps-056-external-label-certification'],
  'node scripts/ps-056-external-label-certification-guard.mjs',
  'package.json must expose the immutable PS-056 guard.',
);
assert.equal(
  packageJson.scripts['certify:external-shipped'],
  'npm run shipstation:external-shipped:dry-run',
  'package.json must expose a read-only external-shipped certification/report command.',
);
assert.match(
  ordersSpec,
  /LOCAL.*RECOVERABLE_MISSING_SYNC.*EXTERNAL/s,
  'Orders column-integrity E2E must explicitly document the three PS-056 shipped states.',
);
assert.match(
  ordersSpec,
  /SHIPPED-980002[\s\S]*Ext\. Label[\s\S]*SHIPPED-980003[\s\S]*Missing shipment sync/,
  'Orders column-integrity E2E must assert Ext. Label and Missing shipment sync separately.',
);
assert.match(
  ordersView,
  /Per user override unlock shipped data on 2026-06-01: PS-056/,
  'PS-056 shipped-display changes must carry the required shipped-data override comment.',
);

console.log('PASS PS-056 external-label classification certification guard');
