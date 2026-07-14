/**
 * Audit 2026-07-13 PL-3: orders route read-model and command extraction guard.
 *
 * Offline only: no DB connection, provider calls, labels/postage, marketplace
 * notifications, or shipped/cancelled mutations.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildCanonicalOrderModel,
  resolveLegacyClientId,
} from '../src/services/orders-read-model';

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function routeBlock(route: string, path: string, nextPath: string): string {
  const start = route.indexOf(path);
  const end = route.indexOf(nextPath, start + path.length);
  return start >= 0 && end > start ? route.slice(start, end) : '';
}

function guardsBefore(block: string, delegation: string): boolean {
  const guard = block.indexOf('assertOrderEditable(c, id)');
  const delegate = block.indexOf(delegation);
  return guard >= 0 && delegate > guard;
}

const route = read('src/routes/orders.ts');
const readModel = read('src/services/orders-read-model.ts');
const command = read('src/services/orders-overrides-command.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.ok(readModel && command, 'dedicated Orders read-model and command owners must exist');
assert.ok(route.split(/\r?\n/).length < 4_500, 'orders route must remain below its pre-extraction 4,937 lines');

for (const owner of [
  'buildCanonicalOrderModel',
  'buildOrderDetailPayload',
  'resolveLegacyClientId',
  'sanitizeAwaitingOverridesForShippingEligibility',
]) {
  assert.ok(readModel.includes(`export function ${owner}(`), `read-model must export ${owner}`);
  assert.ok(!route.includes(`function ${owner}(`), `route must not re-own ${owner}`);
}
assert.ok(!/\bdb\.|\.insert\(|\.update\(|\.delete\(/.test(readModel),
  'read-model owner must stay read-composition-only and perform no persistence');

for (const owner of [
  'applyBoxDimsCoherence',
  'applyOrderOverridesPatch',
  'applyBestRateForOrder',
  'saveBestRateForOrder',
]) {
  assert.ok(command.includes(`export async function ${owner}(`), `command owner must export ${owner}`);
  assert.ok(!route.includes(`function ${owner}(`), `route must not re-own ${owner}`);
}
assert.ok(command.includes('.insert(orderOverrides)') && command.includes('onConflictDoUpdate'),
  'override persistence must live in the command owner');
assert.ok(command.includes('finalizeAppliedBestRateFromSnapshot({') &&
  command.includes("assertPersistedOrderBestRateDto(built.patch.bestRateJson, 'bestRateJson')") &&
  command.includes('shippingRateEligibilityReason(') &&
  command.includes('houseTupleStatus({'),
  'apply command must retain quote finalization, DTO, eligibility, and house-tuple boundaries');

assert.ok(route.includes("const LOCKED_STATUSES = new Set(['shipped', 'cancelled'])"),
  'shipped/cancelled status set must remain in the route boundary');
assert.ok(route.includes('async function assertOrderEditable(') &&
  route.includes('LOCKED_STATUSES.has(rawStatus)'),
  'assertOrderEditable and its locked-status check must remain in the route');

const apply = routeBlock(route, "'/:id{[0-9]+}/apply-best-rate'", "'/:id{[0-9]+}/selected-package-id'");
const best = routeBlock(route, "'/:id{[0-9]+}/best-rate'", "'/:id{[0-9]+}/shipped-external'");
const residential = routeBlock(route, "'/:id{[0-9]+}/residential'", "'/:id{[0-9]+}/selected-pid'");
const selectedPid = routeBlock(route, "'/:id{[0-9]+}/selected-pid'", "'/:id{[0-9]+}/apply-best-rate'");
const selectedPackage = routeBlock(route, "'/:id{[0-9]+}/selected-package-id'", "'/:id{[0-9]+}/save-combo-package-default'");

assert.ok(guardsBefore(apply, 'applyBestRateForOrder('), 'apply-best-rate must guard before command delegation');
assert.ok(guardsBefore(best, 'saveBestRateForOrder('), 'best-rate must guard before command delegation');
assert.ok(guardsBefore(residential, 'applyOrderOverridesPatch('), 'residential must guard before override persistence');
assert.ok(guardsBefore(selectedPid, 'applyOrderOverridesPatch('), 'selected-pid must guard before override persistence');
assert.ok(guardsBefore(selectedPackage, 'applyBoxDimsCoherence(') &&
  guardsBefore(selectedPackage, 'applyOrderOverridesPatch('),
  'selected-package must guard before coherence and persistence');
assert.ok(!/\bdb\.|buildApplyBestRatePatch\(|assertPersistedOrderBestRateDto\(|houseTupleStatus\(/.test(apply + best),
  'dedicated rate routes must remain transport/auth/delegation only');

assert.ok(packageJson.includes('"test:audit-orders-service-boundary"'),
  'package must expose the PL-3 boundary guard');
assert.ok(guardPack.includes("'test:audit-orders-service-boundary'"),
  'mandatory SOT pack must run the PL-3 boundary guard');

assert.equal(resolveLegacyClientId(8, null), 7, 'legacy client parity mapping must be preserved');
assert.equal(resolveLegacyClientId(99, 367706), 7, 'store mapping must take precedence');
const canonical = buildCanonicalOrderModel(
  {
    id: 42,
    orderNumber: 'PL3-42',
    orderStatus: 'awaiting_shipment',
    clientId: 8,
    storeId: 367706,
    weightOz: 12,
    raw: {
      shipTo: { name: 'Test', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      dimensions: { length: 8, width: 6, height: 4, units: 'inches' },
    },
  },
  null,
  7,
  { workflowState: 'ready' },
);
assert.equal(canonical.orderId, 42, 'canonical id must be preserved');
assert.deepEqual(canonical.dimensions, { length: 8, width: 6, height: 4, units: 'inches' },
  'canonical dimensions must be composed by the extracted owner');
assert.equal(canonical.shipping.workflowState, 'ready', 'shipping DTO facts must pass through');

console.log('Audit PL-3 Orders service boundary guard passed.');
