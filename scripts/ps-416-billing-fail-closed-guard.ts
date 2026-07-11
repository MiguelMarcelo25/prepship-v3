import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BILLING_REGENERATION_BLOCKED_CODE,
  BillingRegenerationBlockedError,
  requireBillingRegenerationRead,
} from '../src/services/billing-regeneration-readiness.js';

// Per user override unlock shipped data on 2026-07-11: offline-only PS-416
// proof; this guard performs no database, provider, or production writes.

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function functionSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

const cause = new Error('simulated unavailable source');
await assert.rejects(
  () => requireBillingRegenerationRead('test money sidecar', async () => {
    throw cause;
  }),
  (error: unknown) => {
    assert.ok(error instanceof BillingRegenerationBlockedError);
    assert.equal(error.code, BILLING_REGENERATION_BLOCKED_CODE);
    assert.equal(error.regenerationAllowed, false);
    assert.equal(error.source, 'test money sidecar');
    assert.equal(error.cause, cause);
    return true;
  },
);
assert.equal(
  await requireBillingRegenerationRead('available source', async () => 42),
  42,
);

const billing = read('src/services/billing.ts');
const generate = functionSlice(
  billing,
  'export async function generateLineItems',
  'export type BillingSummaryRow',
);
const preflightAt = generate.indexOf("requireBillingRegenerationRead(\n    'billing freshness status'");
const firstDeleteAt = generate.indexOf('.delete(billingLineItems)');
assert.ok(preflightAt >= 0, 'canonical generator must verify backend freshness');
assert.ok(firstDeleteAt > preflightAt, 'freshness verification must precede every billing delete');
assert.match(generate, /requireBillingRegenerationRead\('house shipping-rate sidecar'/);
assert.doesNotMatch(
  functionSlice(generate, 'const cShippingRateByShipmentId', '// PS-275:'),
  /catch\s*[({]/,
  'house-rate failure must not fall back to carrier/default billing',
);
assert.match(generate, /'billing fee-waiver sidecar'/);
assert.match(generate, /'manual billing-override sidecar'/);
assert.match(generate, /finalizedBillingOrderIdsForRange/);
assert.match(generate, /billingLineItemIsEditablePredicate\(\)/);

for (const [path, signature, nextSignature] of [
  [
    'src/services/billing-fee-waiver-store.ts',
    'export async function readBillingFeeWaivers',
    'export async function readBillingFeeWaiver',
  ],
  [
    'src/services/billing-manual-overrides.ts',
    'export async function readBillingManualOverrides',
    'export async function upsertBillingManualOverride',
  ],
] as const) {
  const source = read(path);
  const loader = functionSlice(source, signature, nextSignature);
  assert.doesNotMatch(loader, /catch\s*[({]/, `${signature} must propagate read failure`);
}

const route = read('src/routes/billing.ts');
assert.match(route, /isBillingRegenerationBlockedError\(error\)/);
assert.match(route, /regenerationAllowed: error\.regenerationAllowed/);
assert.match(route, /}, 503\)/);
assert.match(
  functionSlice(route, "app.get('/generate/status'", "app.get('/summary'"),
  /requireBillingRegenerationRead/,
);

const apiClient = read('web/src/lib/v2-apiClient.ts');
const statusClient = functionSlice(
  apiClient,
  'fetchBillingGenerationStatus(',
  'fetchBillingSummary(',
);
assert.match(statusClient, /return api\.get/);
assert.doesNotMatch(statusClient, /\bsafe\s*\(/);
assert.doesNotMatch(statusClient, /upToDate:\s*false/);

console.log('PS-416 billing fail-closed guard passed');
