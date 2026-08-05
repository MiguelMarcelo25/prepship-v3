/**
 * PS-400 - ShipStation awaiting freshness / split-child import guard.
 *
 * Root cause: live ShipStation split children can have a new orderId while the
 * original orderNumber is already shipped locally. PrepShip must import the new
 * source identity as an awaiting row, not reopen the shipped row. That only
 * works if order sync stays fresh and does not waste main-account work on
 * stores that belong to per-client ShipStation credentials.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { buildSyncAccountsFromClientRows } = await import('../src/services/order-sync');

const accounts = buildSyncAccountsFromClientRows([
  {
    id: 4,
    name: 'HUGRAB',
    storeIds: [378060],
    ssApiKey: null,
    ssApiSecret: null,
  },
  {
    id: 11,
    name: 'KF Goods',
    storeIds: [277422],
    ssApiKey: 'client-key',
    ssApiSecret: 'client-secret',
  },
]);

const main = accounts.find((account) => account.label === 'main');
const kf = accounts.find((account) => account.label === 'client:KF Goods');
assert.deepEqual(main?.storeIds, [378060], 'main account must not also pull per-client credential stores');
assert.deepEqual(kf?.storeIds, [277422], 'per-client ShipStation account keeps its own stores');
assert.equal(kf?.ownerClientId, 11, 'per-client imports keep owner client attribution');

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
assert.match(orderSync, /const DEFAULT_ORDER_SYNC_PAGE_SIZE = 100;/);
assert.match(orderSync, /opts\.pageSize \?\? DEFAULT_ORDER_SYNC_PAGE_SIZE/);
assert.match(orderSync, /while \(!syncRunBudgetTimeExhausted\(budget\)\)/);
assert.match(orderSync, /sortDir: 'DESC'/, 'status catch-up must pull newest modified statuses first');
assert.match(
  orderSync,
  /args\.sortDir \?\? 'ASC'/,
  'ShipStation order import dedupe key must include sortDir',
);
assert.match(
  orderSync,
  /for \(const target of awaitingTargets\) \{[\s\S]{0,150}if \(syncRunBudgetTimeExhausted\(budget\)\) \{[\s\S]*complete = false;[\s\S]*break;/,
  'awaiting store passes must check the run budget before starting another provider call',
);
const shipstationConnector = readFileSync('src/connectors/store/shipstation.ts', 'utf8');
assert.match(
  shipstationConnector,
  /sortDir: input\.sortDir === 'DESC' \? 'DESC' : 'ASC'/,
  'ShipStation connector must pass the backend-owned sort direction through to v1 orders',
);

const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');
assert.match(shipmentSync, /const DEFAULT_SHIPMENT_SYNC_PAGE_SIZE = 100;/);
assert.match(shipmentSync, /opts\.pageSize \?\? DEFAULT_SHIPMENT_SYNC_PAGE_SIZE/);
assert.match(
  shipmentSync,
  /while \(!opts\.signal\?\.aborted && !syncRunBudgetTimeExhausted\(budget\)\)/,
);
assert.match(
  shipmentSync,
  // Repointed 2026-08-05: accounts are now ordered for fairness before the loop
  // (orderShipmentSyncAccountsByWatermark), so the header became
  // `for (const accountProgressEntry of fairAccounts)` with the account unpacked on the
  // next line. The budget check still guards every iteration, one line further down.
  // Allow the unpack between the header and the check; what matters is that no account
  // starts without the budget being consulted.
  /for \(const \w+ of \w+\) \{\s*(?:const \w+ = [^\n]*\n\s*)?if \(opts\.signal\?\.aborted \|\| syncRunBudgetTimeExhausted\(budget\)\) break;/,
  'shipment sync must check the run budget before starting another account',
);

console.log('PASS PS-400 sync freshness split-child guard');
