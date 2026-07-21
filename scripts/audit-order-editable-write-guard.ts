/**
 * Audit 2026-07-13 PL-7: transaction-time order edit lockdown guard.
 *
 * Offline/static only: no DB connection or write, provider call, label/postage,
 * marketplace notification, or production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveOrderLifecycleStatus } from '../src/services/order-lifecycle-status';

const read = (path: string): string => readFileSync(path, 'utf8');
const route = read('src/routes/orders.ts');
const writeOwner = read('src/services/order-editable-write.ts');
const commandOwner = read('src/services/orders-overrides-command.ts');
const comboOwner = read('src/services/combo-package-defaults.ts');
const externalOwner = read('src/services/fulfillment/mark-shipped-externally.ts');
const lifecycleOwner = read('src/services/order-lifecycle-command.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment' }).isTerminal,
  false,
  'ordinary awaiting orders must remain editable',
);
assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment', canonicalStatus: 'cancelled' }).isTerminal,
  true,
  'upstream cancellation must fail the final write guard',
);
assert.equal(
  resolveOrderLifecycleStatus({ orderStatus: 'awaiting_shipment', externallyShipped: true }).isTerminal,
  true,
  'external shipment must fail the final write guard',
);

assert.match(writeOwner, /db\.transaction\(async \(tx\) =>/,
  'final editability check and write must share one DB transaction');
assert.match(writeOwner, /withOrderEditableWriteInTransaction\(tx, orderId, authorization, write\)/,
  'production edits must delegate to the transaction-time boundary used by behavioral proof');
assert.match(writeOwner, /\.for\('update'\)/,
  'final editability owner must lock the order row before deciding');
assert.match(writeOwner, /resolveOrderLifecycleStatus\(\{/,
  'final editability owner must delegate lifecycle truth to the canonical resolver');
assert.match(writeOwner, /lifecycle\.isTerminal && !authorization\.allowTerminal/,
  'terminal lifecycle rows must fail closed unless the audited route authorization allows them');
assert.ok(
  writeOwner.indexOf(".for('update')") < writeOwner.indexOf('value: await write(tx)'),
  'the protected write callback must run only after the lifecycle row lock/check',
);

assert.match(route, /return \{ ok: true, writeAuthorization: \{ allowTerminal: false \} \};/,
  'normal preflight success must carry fail-closed authorization');
assert.equal(
  (route.match(/writeAuthorization: \{ allowTerminal: true \}/g) ?? []).length,
  1,
  'only the audited admin force branch may authorize a terminal write',
);
assert.ok(
  (route.match(/guard\.writeAuthorization/g) ?? []).length >= 9,
  'every guarded order command must carry its authorization into the final write boundary',
);

const guardedRouteBlocks = [
  ["app.patch('/:id{[0-9]+}'", '// v2-parity POST aliases', 'PATCH /:id'],
  ["'/:id{[0-9]+}/residential'", "'/:id{[0-9]+}/selected-pid'", 'POST /:id/residential'],
  ["'/:id{[0-9]+}/selected-pid'", "'/:id{[0-9]+}/apply-best-rate'", 'POST /:id/selected-pid'],
  ["'/:id{[0-9]+}/selected-package-id'", '// PS-037:', 'POST /:id/selected-package-id'],
  ["'/:id{[0-9]+}/best-rate'", "'/:id{[0-9]+}/shipped-external'", 'POST /:id/best-rate'],
  ["'/:id{[0-9]+}/shipped-external'", 'const saveDimsBody', 'POST /:id/shipped-external'],
  ["'/:id{[0-9]+}/save-dims'", "app.get('/:id{[0-9]+}/dims'", 'POST /:id/save-dims'],
] as const;
for (const [startMarker, endMarker, label] of guardedRouteBlocks) {
  const start = route.indexOf(startMarker);
  const end = route.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${label} route block must be discoverable`);
  const block = route.slice(start, end);
  assert.match(block, /assertOrderEditable\(c, id\)/,
    `${label} must retain the fast-path editability guard`);
  assert.match(block, /guard\.writeAuthorization/,
    `${label} must carry authorization into its atomic final write owner`);
}

const patchStart = route.indexOf("app.patch('/:id{[0-9]+}'");
const patchEnd = route.indexOf('// v2-parity POST aliases', patchStart);
const patchBlock = route.slice(patchStart, patchEnd);
assert.ok(
  patchBlock.indexOf('assertOrderEditable(c, id)') >= 0 &&
    patchBlock.indexOf('assertOrderEditable(c, id)') < patchBlock.indexOf('applyOrderOverridesPatch('),
  'PATCH must retain the early route guard before final command delegation',
);
assert.doesNotMatch(patchBlock, /\.insert\(orderOverrides\)|\.update\(orders\)/,
  'PATCH must not bypass the canonical row-locked command with direct writes');

assert.match(commandOwner, /export async function applyOrderOverridesPatch\([\s\S]*?authorization: OrderEditWriteAuthorization/,
  'override command must require the route authorization');
assert.match(commandOwner, /return withOrderEditableWrite\(id, authorization/,
  'override command must run persistence through the final row-lock owner');
assert.doesNotMatch(patchBlock, /externallyShipped:\s*z\.boolean/,
  'generic PATCH must not accept lifecycle state; the dedicated endpoint owns it');
assert.doesNotMatch(comboOwner, /await db\s*\.insert\(orderOverrides\)/,
  'combo propagation/materialization must not write overrides outside the final guard');
assert.ok(
  (comboOwner.match(/withOrderEditableWrite\(/g) ?? []).length >= 3,
  'combo source, propagation, and materialization writes must each re-check lifecycle under lock',
);

assert.match(externalOwner, /applyOrderLifecycleCommand\(\{/,
  'manual external shipment updates must delegate to the lifecycle command owner');
assert.ok(
  (externalOwner.match(/allowCanonicalOverride: input\.writeAuthorization\.allowTerminal/g) ?? []).length >= 2,
  'both mark and unmark commands must carry audited terminal authorization',
);
assert.match(
  lifecycleOwner,
  /\.for\('update'\)[\s\S]*?insert\(orderLifecycleEvents\)[\s\S]*?enqueueInventoryClaimDeduction\([\s\S]*?, tx\)/,
  'row lock, terminal receipt, exact claims, and inventory intent must share one transaction',
);
assert.match(externalOwner, /flag &&\s*statusFlipped &&/,
  'a lost transition race must not notify a marketplace');

assert.ok(packageJson.includes('"test:audit-order-editable-write"'),
  'package must expose the PL-7 guard');
assert.ok(guardPack.includes("'test:audit-order-editable-write'"),
  'mandatory source-of-truth pack must run the PL-7 guard');

console.log('PASS Audit PL-7 transaction-time order edit lockdown guard');
