/**
 * PS-488 AC-1 guard — Billing row visible reference and type.
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingRowIdentity } from '../src/services/billing-row-reference';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

check('an outbound order renders #1234 / Outbound', () => {
  assert.deepEqual(billingRowIdentity({ orderNumber: '1234', orderId: 99 }), {
    rowType: 'Outbound',
    displayReference: '#1234',
  });
});

check('a return renders its STORED reference as a separate #1234-RETURN / Return row', () => {
  assert.deepEqual(
    billingRowIdentity({ orderNumber: '1234', orderId: 99, returnId: 7, returnReference: '1234-RETURN' }),
    { rowType: 'Return', displayReference: '#1234-RETURN' },
  );
});

check('additional returns keep the portal-assigned -2 / -3 numbering', () => {
  for (const ref of ['1234-RETURN-2', '1234-RETURN-3']) {
    assert.equal(
      billingRowIdentity({ orderNumber: '1234', returnId: 8, returnReference: ref }).displayReference,
      `#${ref}`,
    );
  }
});

check('PrepShip never MINTS a -RETURN suffix', () => {
  // The portal generates the suffix from a count of the order's existing returns. A
  // second generator here cannot see that count, so it would render #1234-RETURN for a
  // return already stored as #1234-RETURN-2 — one return, two visible identities.
  const r = billingRowIdentity({ orderNumber: '1234', orderId: 99, returnId: 7, returnReference: null });
  assert.equal(r.rowType, 'Return');
  assert.equal(r.displayReference, null, 'a missing stored reference must not be invented');

  const src = readFileSync('src/services/billing-row-reference.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/`\$\{[^}]*\}-RETURN/.test(src) && !/'-RETURN'|"-RETURN"/.test(src),
    'this module must not construct a -RETURN string');
});

check('row type comes from the relational returnId, not from the reference text', () => {
  // An outbound order number legitimately containing "RETURN" must stay Outbound.
  const r = billingRowIdentity({ orderNumber: 'RETURN-1234', orderId: 99 });
  assert.equal(r.rowType, 'Outbound');
  assert.equal(r.displayReference, '#RETURN-1234');
});

check('a stored reference that already carries # is not doubled', () => {
  assert.equal(
    billingRowIdentity({ returnId: 3, returnReference: '#1234-RETURN' }).displayReference,
    '#1234-RETURN',
  );
  assert.equal(billingRowIdentity({ orderNumber: '#1234' }).displayReference, '#1234');
});

check('a row is never anonymous, but never shows #null or #0 either', () => {
  assert.equal(billingRowIdentity({ orderNumber: null, orderId: 4242 }).displayReference, '#4242');
  assert.equal(billingRowIdentity({ orderNumber: '   ', orderId: 4242 }).displayReference, '#4242');
  for (const bad of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(
      billingRowIdentity({ orderNumber: null, orderId: bad as number }).displayReference,
      null,
      String(bad),
    );
  }
});

check('the display reference is NOT used as an idempotency key anywhere', () => {
  // AC-1: relational ids stay canonical. PS-487 keys return billing on return:<id>:<kind>
  // so a display string can change without moving money. If billing lines ever keyed on
  // this, renaming an order would mint a duplicate charge.
  const planner = readFileSync('src/services/billing-return-line-planner.ts', 'utf8');
  assert.ok(!/billingRowIdentity|displayReference/.test(planner),
    'the line planner must not key on a display reference');
});

if (failures > 0) {
  console.error(`\nFAIL PS-488 billing row reference guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-488 billing row reference guard');
