/**
 * PS-499 — the pasted Box Size / Shipping import must be PATCH-ONLY.
 *
 * The July HUGRAB underbilling: `handleBulkImportRow` resent every money field
 * on every row, reading them under non-canonical aliases (`current.pickPack`,
 * `current.additional`, `current.packageCost`, `current.shipping`). The canonical
 * order row is camelCase-only and pins `pickpackTotal` / `additionalTotal` /
 * `packageTotal` / `shippingTotal` (billing-detail-row-sot.ts, ps-362), so those
 * reads were dead by contract and collapsed to 0. The route then read a PRESENT
 * `pickPack: 0` as the durable PS-389 waiver decision and waived prep fees.
 *
 * So this guard asserts KEY PRESENCE, never just values. Correcting the aliases
 * would make the numbers right and still ship the bug: a resent field is still a
 * present field, and presence is what creates durable overrides and waivers.
 * Every assertion below is on own-property keys for that reason.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toBillingBulkImportPatch } from '../web/src/components/Views/billing-bulk-import-patch';
import type { BulkImportReadyRow } from '../web/src/components/Views/billing-bulk-import';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

/** A resolved, ready-to-apply row. Overrides carry the per-test intent. */
function readyRow(overrides: Partial<BulkImportReadyRow> = {}): BulkImportReadyRow {
  return {
    lineNumber: 1,
    orderNumberRaw: '2515',
    orderId: 501,
    packageId: null,
    packageName: null,
    shipping: null,
    description: '',
    status: 'ready',
    detail: '',
    ...overrides,
  } as BulkImportReadyRow;
}

/** Own-property keys, sorted — presence and absence in one comparable value. */
function keysOf(patch: object): string[] {
  return Object.keys(patch).sort();
}

const MONEY_FIELDS = ['pickPack', 'additional', 'packageCost'] as const;

function assertNeverCarriesGeneratedMoney(patch: object, mode: string) {
  for (const field of MONEY_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, field),
      false,
      `${mode} must not carry \`${field}\` — presence is what writes a durable override/waiver`,
    );
  }
}

check('shipping-only import sends shipping and nothing else', () => {
  const patch = toBillingBulkImportPatch(readyRow({ shipping: 20.83 }), 'July HUGRAB correction');
  assert.deepEqual(keysOf(patch), ['reason', 'shipping', 'source']);
  assert.equal(patch.shipping, 20.83);
  assertNeverCarriesGeneratedMoney(patch, 'shipping-only');
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, 'packageId'),
    false,
    'box intent was absent, so packageId must be absent — not the current box resent',
  );
});

check('box-only import sends packageId and nothing else', () => {
  const patch = toBillingBulkImportPatch(readyRow({ packageId: 42, packageName: '9x6x3' }), 'Correct recorded box');
  assert.deepEqual(keysOf(patch), ['packageId', 'reason', 'source']);
  assert.equal(patch.packageId, 42);
  assertNeverCarriesGeneratedMoney(patch, 'box-only');
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, 'shipping'),
    false,
    'shipping was untouched, so an existing shipping override must not be re-pinned',
  );
});

check('combined box + shipping import sends exactly those two intents', () => {
  const patch = toBillingBulkImportPatch(
    readyRow({ packageId: 42, packageName: '9x6x3', shipping: 20.83 }),
    'Correct box and international shipping',
  );
  assert.deepEqual(keysOf(patch), ['packageId', 'reason', 'shipping', 'source']);
  assertNeverCarriesGeneratedMoney(patch, 'combined');
});

check('an explicitly pasted $0 shipping survives as an own property', () => {
  // The one case truthiness filtering would destroy: `0` is falsy, but the
  // operator typed it, so it is an intentional override and must be sent.
  const patch = toBillingBulkImportPatch(readyRow({ shipping: 0 }), 'Waive international shipping');
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, 'shipping'),
    true,
    'an explicit $0 must be SENT, not dropped as falsy',
  );
  assert.equal(patch.shipping, 0);
});

check('a blank shipping cell omits the key rather than sending 0', () => {
  const patch = toBillingBulkImportPatch(readyRow({ packageId: 42 }), 'Correct recorded box');
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, 'shipping'),
    false,
    'blank must be absence — sending 0 is exactly the July defect',
  );
});

check('a blank box cell omits packageId rather than resending the current box', () => {
  const patch = toBillingBulkImportPatch(readyRow({ shipping: 20.83 }), 'Shipping only');
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'packageId'), false);
});

check('every patch declares its source so the route can discriminate intent', () => {
  const patch = toBillingBulkImportPatch(readyRow({ shipping: 1.23 }), 'reason text');
  assert.equal(patch.source, 'bulk_import');
  assert.equal(patch.reason, 'reason text');
});

check('a description travels only when the row actually carries one', () => {
  const without = toBillingBulkImportPatch(readyRow({ shipping: 1.23 }), 'r');
  assert.equal(
    Object.prototype.hasOwnProperty.call(without, 'orderDescription'),
    false,
    'PS-498: omitting the key is what leaves a stored description alone',
  );

  const withDesc = toBillingBulkImportPatch(readyRow({ shipping: 1.23, description: 'Damaged box' }), 'r');
  assert.equal(withDesc.orderDescription, 'Damaged box');
});

check('a row carrying no box and no shipping is refused, never sent as an empty patch', () => {
  assert.throws(
    () => toBillingBulkImportPatch(readyRow(), 'r'),
    /no patchable intent/i,
    'an intent-free row must fail loudly rather than PATCH nothing',
  );
});

check('handleBulkImportRow no longer reads the current row to refill the payload', () => {
  // The regression this ticket exists to prevent. Reading `current` at all in the
  // import path means untouched fields are being reconstructed and resent.
  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  const fn = view.slice(
    view.indexOf('async function handleBulkImportRow('),
    view.indexOf('async function handleBulkImportFinished('),
  );
  assert.notEqual(fn.length, 0, 'handleBulkImportRow not found — update this guard');

  for (const forbidden of ['detailRows.find', 'current?.', 'billingEditPackagePrices', 'pickPack', 'additional', 'packageCost']) {
    assert.equal(
      fn.includes(forbidden),
      false,
      `handleBulkImportRow must not reference \`${forbidden}\` — the mapper owns payload construction`,
    );
  }
});

check('the route requires an explicit source discriminator', () => {
  // Hermes blocker 1. An optional discriminator defaulting to manual_edit lets a
  // stale pre-PS-499 bundle — no source, every money field — be read as a
  // deliberate full edit, so none of the bulk rejections run and the July
  // override/waiver defect recurs mid-deploy. Stale callers must 400 and refresh.
  const route = readFileSync('src/routes/billing.ts', 'utf8');
  assert.match(
    route,
    /source: z\.enum\(\['manual_edit', 'bulk_import'\]\),/,
    'source must be required in detailPatchSchema — no .optional(), no .default()',
  );
  assert.doesNotMatch(
    route,
    /source: z\.enum\(\['manual_edit', 'bulk_import'\]\)\.(optional|default)/,
    'an optional or defaulted source reopens the stale-bundle bypass',
  );

  const patch = readFileSync('web/src/lib/billing-detail-patch.ts', 'utf8');
  assert.doesNotMatch(patch, /source\?: 'manual_edit'/, 'the manual contract must require source');

  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  assert.match(view, /source: 'manual_edit',/, 'the Edit Billing modal must declare its source');
});

check('a pasted box is intent by PRESENCE, even when it equals the stamped box', () => {
  // Hermes blocker 2. The PS-207 gate detects box decisions by DIFF, which is right
  // for the modal (it always submits every field) and wrong for a paste: pasting the
  // already-stamped box left boxChanged and priceChanged both false, so the durable
  // directive was never written, a stale override_price stayed pinned, and
  // package_cost_missing survived next to a freshly resolved package_cost line.
  const route = readFileSync('src/routes/billing.ts', 'utf8');
  assert.match(
    route,
    /const bulkBoxIntent =\s*\n?\s*isBulkImport && body\.packageId !== undefined && body\.packageId !== null/,
    'bulk box intent must be presence-based',
  );
  assert.match(
    route,
    /if \(bulkBoxIntent \|\| boxChanged \|\| priceChanged\) \{/,
    'the box-resolution block must run for a bulk box intent regardless of diff',
  );
  assert.match(
    route,
    /const overridePrice = bulkBoxIntent\s*\n?\s*\? null/,
    'a bulk import must always clear override_price — it never pins a price',
  );
});

check('the API client no longer accepts an untyped billing patch', () => {
  const client = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
  const fn = client.slice(client.indexOf('updateBillingDetail('), client.indexOf('hugrabBillingShippingFloor('));
  assert.equal(
    fn.includes('data: Record<string, unknown>'),
    false,
    'Record<string, unknown> lets a full-replace bulk payload typecheck — use the discriminated patch contract',
  );
});

if (failures) {
  console.error(`\nFAIL ps-499 bulk import patch guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS ps-499 bulk import patch guard');
