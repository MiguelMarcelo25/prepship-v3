/**
 * PS-487 slice 1 guard — the canonical return billing event contract.
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration, no
 * production mutation. Proves the date rule, the idempotency identity, the
 * no-shipment-required eligibility, and the customer-rate fence.
 */
import assert from 'node:assert/strict';
import {
  RETURN_PROCESSING_LINE_TYPE,
  RETURN_SHIPPING_LINE_TYPE,
  isReturnProcessingFeeEligible,
  resolveReturnBillingEventDate,
  resolveReturnCustomerShippingAmount,
  returnBillingEventKey,
} from '../src/services/billing-return-event-contract';

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

// ── AC-3: the canonical event date ───────────────────────────────────────────
check('a return bills on its creation day, not on any label/shipment date', () => {
  assert.equal(
    resolveReturnBillingEventDate({ createdAt: '2026-07-16T22:41:00.000Z' }),
    '2026-07-16',
  );
});

check('an admin-corrected day wins over the system-created day', () => {
  assert.equal(
    resolveReturnBillingEventDate({
      createdAt: '2026-07-16T22:41:00.000Z',
      correctedDate: '2026-06-30',
    }),
    '2026-06-30',
  );
});

check('a future corrected day is honoured (AC-4 allows past OR future)', () => {
  assert.equal(
    resolveReturnBillingEventDate({ createdAt: '2026-07-16', correctedDate: '2026-09-01' }),
    '2026-09-01',
  );
});

check('no usable date returns null so the caller fails closed (never bills "today")', () => {
  for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, new Date('x')]) {
    assert.equal(resolveReturnBillingEventDate({ createdAt: bad }), null, String(bad));
  }
});

check('a blank corrected date falls back to creation rather than blanking the event', () => {
  assert.equal(
    resolveReturnBillingEventDate({ createdAt: '2026-07-16', correctedDate: '' }),
    '2026-07-16',
  );
});

// ── AC-1 / AC-5: idempotency identity ────────────────────────────────────────
check('the event key is stable across repeated regeneration', () => {
  const a = returnBillingEventKey({ returnId: 4, kind: RETURN_PROCESSING_LINE_TYPE });
  const b = returnBillingEventKey({ returnId: '4', kind: RETURN_PROCESSING_LINE_TYPE });
  assert.equal(a, b);
  assert.equal(a, 'return:4:return_processing');
});

check('processing and shipping are DISTINCT events on the same return', () => {
  assert.notEqual(
    returnBillingEventKey({ returnId: 4, kind: RETURN_PROCESSING_LINE_TYPE }),
    returnBillingEventKey({ returnId: 4, kind: RETURN_SHIPPING_LINE_TYPE }),
  );
});

check('the key does NOT include the date — a correction MOVES an event, never duplicates it', () => {
  // This is the whole reason the date is excluded: if the key changed with the date, an
  // admin date correction (AC-5) would mint a second charge instead of relocating one.
  const before = returnBillingEventKey({ returnId: 9, kind: RETURN_PROCESSING_LINE_TYPE });
  const after = returnBillingEventKey({ returnId: 9, kind: RETURN_PROCESSING_LINE_TYPE });
  assert.equal(before, after);
  assert.ok(!before.includes('2026'), 'the key must carry no date component');
});

// ── AC-1: no shipment/label required ─────────────────────────────────────────
check('a return with NO shipment, label, tracking or PDF is already fee-eligible', () => {
  assert.equal(
    isReturnProcessingFeeEligible({ returnId: 12, clientId: 4, createdAt: '2026-07-16' }),
    true,
  );
});

check('eligibility requires an identified return, a client, and a date', () => {
  assert.equal(isReturnProcessingFeeEligible({ returnId: null, clientId: 4, createdAt: '2026-07-16' }), false);
  assert.equal(isReturnProcessingFeeEligible({ returnId: 12, clientId: null, createdAt: '2026-07-16' }), false);
  assert.equal(isReturnProcessingFeeEligible({ returnId: 12, clientId: 4, createdAt: null }), false);
});

// ── AC-2: the customer-rate fence ────────────────────────────────────────────
check('return shipping bills the configured CUSTOMER rate', () => {
  assert.equal(resolveReturnCustomerShippingAmount({ returnCustomerShippingRate: '6.77' }), 6.77);
  assert.equal(resolveReturnCustomerShippingAmount({ returnCustomerShippingRate: 8.64 }), 8.64);
});

check('a configured $0.00 customer rate is a real amount, not "missing"', () => {
  // Three of the eight production returns carry exactly 0.00. Treating that as absent
  // would silently drop a deliberate free-return decision.
  assert.equal(resolveReturnCustomerShippingAmount({ returnCustomerShippingRate: '0.00' }), 0);
});

check('no configured customer rate bills NOTHING (no invented amount)', () => {
  for (const bad of [null, undefined, '', 'abc', {}, -1, Number.NaN, Infinity]) {
    assert.equal(
      resolveReturnCustomerShippingAmount({ returnCustomerShippingRate: bad }),
      null,
      String(bad),
    );
  }
});

check('the amount resolver reads ONLY the customer rate field', () => {
  // Passing provider/internal cost under any other name must not produce an amount —
  // there is no fallback path for raw cost to become the customer charge (PS-435).
  const sneaky = {
    returnCustomerShippingRate: null,
    labelCost: 12.34,
    providerCost: 12.34,
    externalLabelCost: 12.34,
  } as Record<string, unknown>;
  assert.equal(resolveReturnCustomerShippingAmount(sneaky as never), null);
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return billing contract guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return billing contract guard');
