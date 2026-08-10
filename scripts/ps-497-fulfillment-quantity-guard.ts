// PS-497 — the quantity classifier at its canonical owner, EXECUTED.
//
// The rule this replaces returned `{ quantity: 1 }` for every unusable input: a number nobody
// measured, persisted on a claim row, waiting for a review-queue drain to turn it into a real
// stock deduction. It also collapsed three different provider conditions — nothing supplied,
// zero shipped, unparseable — into one reason code.
//
// Every case below runs `normalizeFulfilledLines` itself. No source text is asserted: this
// card has already lost three guards to source-pattern assertions that stayed green while the
// behaviour was defeated.

import assert from 'node:assert/strict';
import {
  normalizeFulfilledLines,
  normalizeFulfillmentFacts,
} from '../src/services/order-lifecycle-command.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Normalize a single line carrying `quantity`, and return it. */
const one = (quantity: unknown) =>
  normalizeFulfilledLines([{ sku: 'SKU-1', name: 'Thing', quantity }])[0];

// ── deductable: only a proved positive integer ───────────────────────────────
const VALID: Array<[string, unknown, number]> = [
  ['number 1', 1, 1],
  ['number 2', 2, 2],
  ['string "2"', '2', 2],
  ['padded string " 3 "', ' 3 ', 3],
  ['large integer', 1000, 1000],
];
for (const [label, input, expected] of VALID) {
  check(`${label} deducts exactly ${expected}`, () => {
    const line = one(input);
    assert.equal(line.quantity, expected, 'quantity must be exact, never rounded or invented');
    assert.equal(line.reviewReason, undefined);
    assert.equal(line.quantityEvidence, undefined, 'a usable quantity needs no evidence');
  });
}

// ── zero is its own condition ────────────────────────────────────────────────
const ZERO: Array<[string, unknown]> = [
  ['number 0', 0],
  ['negative zero', -0],
  ['string "0"', '0'],
  ['string "0.0"', '0.0'],
  ['string "-0"', '-0'],
];
for (const [label, input] of ZERO) {
  check(`${label} is zero_quantity, not invalid_quantity`, () => {
    const line = one(input);
    assert.equal(line.quantity, null, 'zero must never become a deductable quantity');
    assert.equal(line.reviewReason, 'zero_quantity',
      'zero plausibly means nothing shipped — a different fact from an unparseable value');
    assert.ok(line.quantityEvidence, 'evidence is mandatory on every quantity-review line');
  });
}

// ── invalid ──────────────────────────────────────────────────────────────────
const INVALID: Array<[string, unknown]> = [
  ['negative integer', -1],
  ['negative string', '-1'],
  ['fraction', 1.5],
  ['fraction string', '1.5'],
  ['negative fraction', -1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['string "NaN"', 'NaN'],
  ['string "Infinity"', 'Infinity'],
  ['non-numeric string', 'abc'],
  ['boolean true', true],
  ['boolean false', false],
  ['empty object', {}],
  ['empty array', []],
  ['array containing a number', ['1']],
];
for (const [label, input] of INVALID) {
  check(`${label} is invalid_quantity and never deducts`, () => {
    const line = one(input);
    assert.equal(line.quantity, null, `${label} must not become a deductable quantity`);
    assert.equal(line.reviewReason, 'invalid_quantity');
    assert.ok(line.quantityEvidence, 'evidence is mandatory on every quantity-review line');
  });
}

// `Number(['1'])` is 1, `Number(true)` is 1, `Number([])` is 0. Coercing arbitrary types
// through Number() is how an array turns into a real stock movement.
check('array and boolean inputs are rejected BY TYPE, not coerced through Number()', () => {
  assert.equal(one(['1']).quantity, null, "Number(['1']) is 1 — this must not deduct 1");
  assert.equal(one(true).quantity, null, 'Number(true) is 1 — this must not deduct 1');
  assert.equal(one([]).reviewReason, 'invalid_quantity', 'Number([]) is 0 — not a real zero');
});

// ── missing ──────────────────────────────────────────────────────────────────
const MISSING: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace-only string', '   '],
];
for (const [label, input] of MISSING) {
  check(`${label} is missing_quantity`, () => {
    const line = one(input);
    assert.equal(line.quantity, null);
    assert.equal(line.reviewReason, 'missing_quantity');
    assert.ok(line.quantityEvidence);
  });
}

check('a line with neither quantity nor qty is missing_quantity', () => {
  const line = normalizeFulfilledLines([{ sku: 'SKU-1', name: 'Thing' }])[0];
  assert.equal(line.quantity, null);
  assert.equal(line.reviewReason, 'missing_quantity');
});

// ── presence-aware field selection ───────────────────────────────────────────
check('an explicit quantity:null does NOT fall through to qty', () => {
  // `item.quantity ?? item.qty` would silently report a clean deduction of 2 here, hiding
  // that the provider explicitly sent a null quantity.
  const line = normalizeFulfilledLines([{ sku: 'SKU-1', quantity: null, qty: 2 }])[0];
  assert.equal(line.quantity, null, 'an explicit null must not be replaced by a sibling field');
  assert.equal(line.reviewReason, 'missing_quantity');
});
check('an explicitly invalid quantity does NOT fall through to qty', () => {
  const line = normalizeFulfilledLines([{ sku: 'SKU-1', quantity: 'abc', qty: 2 }])[0];
  assert.equal(line.quantity, null);
  assert.equal(line.reviewReason, 'invalid_quantity');
});
check('qty is still used when quantity is genuinely absent', () => {
  const line = normalizeFulfilledLines([{ sku: 'SKU-1', qty: 4 }])[0];
  assert.equal(line.quantity, 4, 'the fallback must keep working for payloads that use qty');
});

// ── evidence ─────────────────────────────────────────────────────────────────
check('numeric evidence is kept verbatim, because it is safe and diagnostic', () => {
  assert.deepEqual(one(0).quantityEvidence, { inputType: 'number', token: '0', redacted: false });
  assert.equal(one(1.5).quantityEvidence?.token, '1.5');
  assert.equal(one(Number.NaN).quantityEvidence?.token, 'NaN');
  assert.equal(one(Number.POSITIVE_INFINITY).quantityEvidence?.token, 'Infinity');
});
check('numeric-looking strings keep their exact lexical token', () => {
  const ev = one('0.0').quantityEvidence;
  assert.equal(ev?.inputType, 'string');
  assert.equal(ev?.token, '0.0', 'the exact token distinguishes "0.0" from "0" in a provider bug');
  assert.equal(ev?.redacted, false);
});
check('booleans record which boolean it was', () => {
  assert.equal(one(true).quantityEvidence?.token, 'true');
  assert.equal(one(false).quantityEvidence?.token, 'false');
});
check('an arbitrary string is hashed, never stored', () => {
  const secret = 'customer-note-12 Main St';
  const ev = one(secret).quantityEvidence;
  assert.equal(ev?.token, '[redacted_non_numeric_string]');
  assert.equal(ev?.redacted, true);
  assert.equal(ev?.originalLength, secret.length, 'length is safe and useful');
  assert.match(String(ev?.sha256), /^[0-9a-f]{64}$/, 'a hash correlates repeats without storing content');
  assert.ok(!JSON.stringify(ev).includes('Main St'), 'provider text must never be persisted verbatim');
});
check('the same unsafe string hashes identically, a different one does not', () => {
  const a = one('mystery-value').quantityEvidence?.sha256;
  const b = one('mystery-value').quantityEvidence?.sha256;
  const c = one('other-value').quantityEvidence?.sha256;
  assert.equal(a, b, 'repeat occurrences must be correlatable');
  assert.notEqual(a, c);
});
check('objects and arrays keep only a type marker', () => {
  const obj = one({ nested: 'customer address' }).quantityEvidence;
  assert.equal(obj?.inputType, 'object');
  assert.equal(obj?.token, null, 'a provider object could contain anything');
  assert.ok(!JSON.stringify(obj).includes('customer address'));
  assert.equal(one([]).quantityEvidence?.inputType, 'array');
});
check('control characters are stripped before anything is persisted', () => {
  const ev = one('  2 ').quantityEvidence;
  assert.equal(ev?.token, '2', 'a control-laden numeric token is still numeric once cleaned');
  assert.ok(!/[\x00-\x1F\x7F]/.test(String(ev?.token)));
});
check('an absurdly long numeric token is capped', () => {
  const ev = one('1'.repeat(500)).quantityEvidence;
  assert.equal(String(ev?.token).length, 64, 'unbounded provider text must not be persisted');
});

// ── every line survives ──────────────────────────────────────────────────────
check('no line is ever dropped for a bad quantity', () => {
  const lines = normalizeFulfilledLines([
    { sku: 'A', quantity: 1 },
    { sku: 'B', quantity: 0 },
    { sku: 'C', quantity: 'abc' },
    { sku: 'D', quantity: null },
  ]);
  assert.equal(lines.length, 4,
    'dropping a line erases the provider fact and hides a provider defect');
  assert.deepEqual(lines.map((l) => l.quantity), [1, null, null, null]);
});

// ── the order 3388 shape ─────────────────────────────────────────────────────
// A SHAPE regression fixture, not a reconstruction: the third line's real value is
// unrecoverable, so this asserts the structure that produced claim 3116, not the value.
check('order 3388 shape: two valid lines deduct, the third is quarantined', () => {
  const lines = normalizeFulfilledLines([
    { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
    { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
    { sku: 'HU-10', name: 'Leeds Line V2', quantity: 'not-a-number' },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.lineKey, l.quantity, l.reviewReason ?? null]),
    [
      ['Booster-gel-001:1', 2, null],
      ['HU-10:2', 1, null],
      ['HU-10:3', null, 'invalid_quantity'],
    ],
  );
  assert.ok(lines[2].quantityEvidence, 'the value that caused this must now be preserved');
});
check('order 3388 shape with a zero third line is classified separately', () => {
  const lines = normalizeFulfilledLines([
    { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
    { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
    { sku: 'HU-10', name: 'Leeds Line V2', quantity: 0 },
  ]);
  assert.equal(lines[2].reviewReason, 'zero_quantity',
    'if the historical value was 0 this is the shape — but that remains unproven');
  assert.equal(lines[2].quantityEvidence?.token, '0');
});

// ── duplicate SKUs are NOT deduplicated ──────────────────────────────────────
check('two valid lines with the same SKU stay separate and both deduct', () => {
  const lines = normalizeFulfilledLines([
    { sku: 'HU-10', quantity: 1 },
    { sku: 'HU-10', quantity: 3 },
  ]);
  assert.equal(lines.length, 2, 'split lines, bundles and partial fulfilment are legitimate');
  assert.deepEqual(lines.map((l) => l.quantity), [1, 3], 'their inventory effect sums naturally');
  assert.notEqual(lines[0].lineKey, lines[1].lineKey, 'each needs its own idempotent claim');
});

// ── the unavailable line carries no quantity either ──────────────────────────
// This path mints 2,950 of production's review claims, every one holding a fabricated `1`.
// Nothing was measured there either, so it must record null for the same reason.
check('an unavailable-facts line records null, not a fabricated 1', () => {
  const lines = normalizeFulfillmentFacts({ kind: 'unavailable', description: 'no line facts' }, 'shipped');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, null,
    'a 1 here is a measurement nobody made — it is what 2,950 production rows already carry');
  assert.equal(lines[0].reviewReason, 'fulfillment_lines_unavailable');
  assert.equal(lines[0].sku, null);
});
check('exact facts that yield no usable lines fall back to the same null-quantity line', () => {
  const lines = normalizeFulfillmentFacts({ kind: 'exact', lines: [] }, 'external_shipped');
  assert.equal(lines[0].quantity, null);
  assert.equal(lines[0].reviewReason, 'fulfillment_lines_unavailable');
});
check('exact facts with a bad quantity still produce a real line, not the unavailable fallback', () => {
  // A line the provider DID send must be recorded as itself, with its evidence — not
  // collapsed into the generic "no facts available" receipt, which carries no evidence.
  const lines = normalizeFulfillmentFacts({ kind: 'exact', lines: [{ sku: 'A', quantity: 'x' }] }, 'shipped');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reviewReason, 'invalid_quantity');
  assert.ok(lines[0].quantityEvidence);
});

if (failures > 0) {
  console.error(`\nPS-497 fulfillment quantity guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 fulfillment quantity guard');
console.log('Canonical owner executed directly. No database, no network, no production access.');
