import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildOrderSourceIdentity,
  orderSourceIdentityKey,
} from '../src/services/order-source-identity';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const importer = read('src/services/store-order-import.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

const helperStart = importer.indexOf('export function dedupeNormalizedStoreOrdersForImport');
assert(helperStart >= 0, 'store-order-import must expose a batch source-identity de-dupe helper');

const helperEnd = importer.indexOf('async function claimLegacyOrderSourceIdentities', helperStart);
assert(helperEnd > helperStart, 'batch de-dupe helper must live before legacy identity claiming');
const helper = importer.slice(helperStart, helperEnd);

assert(
  helper.includes('buildOrderSourceIdentity(order.source)'),
  'batch de-dupe must build the canonical source identity from each normalized order',
);
assert(
  helper.includes('orderSourceIdentityKey(identity)'),
  'batch de-dupe must key by the source identity owner',
);
assert(
  helper.includes('bySourceIdentity.set(orderSourceIdentityKey(identity), order)'),
  'batch de-dupe must keep the latest provider row for a repeated source identity',
);
assert(
  helper.includes('passthrough.push(order)'),
  'batch de-dupe must preserve rows without a complete source identity instead of dropping them',
);

const dedupeCall = importer.indexOf('const importOrders = dedupeNormalizedStoreOrdersForImport(ordersIn);');
const rowsMap = importer.indexOf('const rows: Row[] = importOrders.map');
const legacyClaim = importer.indexOf('await claimLegacyOrderSourceIdentities(rows);');
assert(dedupeCall >= 0, 'upsertNormalizedStoreOrders must de-dupe the incoming batch');
assert(rowsMap > dedupeCall, 'upsertNormalizedStoreOrders must map rows from the de-duped batch');
assert(legacyClaim > rowsMap, 'legacy identity claiming must run after rows are built from de-duped input');
assert(
  !/const rows: Row\[\] = ordersIn\.map/.test(importer),
  'upsertNormalizedStoreOrders must not bulk-upsert the raw provider batch',
);

const first = buildOrderSourceIdentity({
  sourceProvider: ' ShipStation ',
  sourceAccountId: 'store:378060',
  sourceOrderId: 2313,
});
const second = buildOrderSourceIdentity({
  sourceProvider: 'shipstation',
  sourceAccountId: 'store:378060',
  sourceOrderId: '2313',
});
assert(first && second, 'fixture source identities should be complete');
assert.equal(
  orderSourceIdentityKey(first),
  orderSourceIdentityKey(second),
  'source identity owner must collapse equivalent ShipStation identities',
);

assert.equal(
  packageJson.scripts?.['test:store-order-import-batch-dedupe'],
  'tsx scripts/store-order-import-batch-dedupe-guard.ts',
  'package.json must expose the store import batch de-dupe guard',
);

console.log('PASS store-order-import batch de-dupe guard');
