/**
 * PS-376 — every $0 Billing shipping row is flagged for review, WITH a
 * backend-owned reason distinguishing cancelled / bundled / missing-proof /
 * unknown. Offline (no db):
 *   Layer 1 — decideZeroShippingReview classifies the reason from canonical facts.
 *   Layer 2 — the grouped billing-detail DTO (the /billing/details read model the
 *             FE + Invoice consume) carries the reason to the collapsed order row.
 *   Layer 3 — source pins: billing.ts sources order_status + the bundle signal and
 *             emits the reason; the FE badge renders it verbatim.
 *
 *   npx tsx scripts/ps-376-zero-shipping-review-reason-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideZeroShippingReview } from '../src/services/billing-shipping-policy';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL ${name} — ${err instanceof Error ? err.message : err}`); }
}
const read = (p: string) => readFileSync(p, 'utf8');

// ── Layer 1: reason classification from canonical facts ──────────────────────
check('positive shipping → no review, no reason', () => {
  const d = decideZeroShippingReview({ shippingAmount: 5, orderStatus: 'shipped', hasShipmentRow: true });
  assert.equal(d.needsReview, false);
  assert.equal(d.reason, null);
});

check('missing/unknown shipping (null) is NOT $0 → no review (stays the missing-cost path)', () => {
  assert.equal(decideZeroShippingReview({ shippingAmount: null }).needsReview, false);
  assert.equal(decideZeroShippingReview({ shippingAmount: undefined }).needsReview, false);
});

check('$0 + cancelled order → cancelled_or_not_shipped (warn)', () => {
  const d = decideZeroShippingReview({ shippingAmount: 0, orderStatus: 'cancelled', hasShipmentRow: true });
  assert.equal(d.needsReview, true);
  assert.equal(d.reason, 'cancelled_or_not_shipped');
  assert.equal(d.severity, 'warn');
  assert.ok(d.label.length > 0);
});

check('$0 + bundle child → bundled_with_order (info — prep fee likely valid)', () => {
  const d = decideZeroShippingReview({ shippingAmount: 0, orderStatus: 'shipped', isBundledChild: true, hasShipmentRow: true });
  assert.equal(d.reason, 'bundled_with_order');
  assert.equal(d.severity, 'info');
});

check('$0 + no shipment row → missing_shipping_proof (warn)', () => {
  const d = decideZeroShippingReview({ shippingAmount: 0, orderStatus: 'shipped', hasShipmentRow: false });
  assert.equal(d.reason, 'missing_shipping_proof');
  assert.equal(d.severity, 'warn');
});

check('$0 + shipped + shipment row + not bundled → zero_shipping_unknown (a real recorded $0 label)', () => {
  const d = decideZeroShippingReview({ shippingAmount: 0, orderStatus: 'shipped', hasShipmentRow: true });
  assert.equal(d.reason, 'zero_shipping_unknown');
});

check('priority: cancelled beats bundled (a cancelled bundled row reads as cancelled)', () => {
  const d = decideZeroShippingReview({ shippingAmount: 0, orderStatus: 'cancelled', isBundledChild: true, hasShipmentRow: true });
  assert.equal(d.reason, 'cancelled_or_not_shipped');
});

// ── Layer 2: the grouped DTO carries the reason to the order row ──────────────
check('grouped DTO: a $0-shipping order carries the review flag + reason on the order row', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 1, lineType: 'pick_pack', totalCost: '2.00' },
    {
      orderId: 1, lineType: 'shipping', totalCost: '0.00',
      shippingZeroNeedsReview: true,
      zeroShippingReviewReason: 'cancelled_or_not_shipped',
      zeroShippingReviewLabel: 'Cancelled — review prep fee',
      zeroShippingReviewSeverity: 'warn',
    },
  ]);
  assert.equal(dto.shippingZeroNeedsReview, true);
  assert.equal(dto.zeroShippingReviewReason, 'cancelled_or_not_shipped');
  assert.equal(dto.zeroShippingReviewLabel, 'Cancelled — review prep fee');
  assert.equal(dto.zeroShippingReviewSeverity, 'warn');
});

check('grouped DTO: a positive-shipping order is not flagged', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 2, lineType: 'shipping', totalCost: '7.50' },
  ]);
  assert.equal(dto.shippingZeroNeedsReview === true, false);
  assert.ok(dto.zeroShippingReviewReason == null);
});

// ── Layer 3: source pins ─────────────────────────────────────────────────────
check('billing.ts selects orders.orderStatus for the detail query', () => {
  const billing = read('src/services/billing.ts');
  assert.ok(/orderStatus: orders\.orderStatus/.test(billing));
});

check('billing.ts sources the reason from order status + the bundle signal, and EVERY $0 line (bundled too)', () => {
  const billing = read('src/services/billing.ts');
  assert.ok(/decideZeroShippingReview\(\{[\s\S]*orderStatus: row\.orderStatus,[\s\S]*isBundledChild: isBundleIncludedShippingLine/.test(billing),
    'must pass order status + the bundle-child signal into the policy owner');
  assert.ok(/zeroShippingReviewReason: zeroShippingReview\.reason/.test(billing) &&
    /zeroShippingReviewSeverity: zeroShippingReview\.severity/.test(billing),
    'must emit the reason/severity on the detail DTO');
  // The pre-PS-376 code excluded bundle-included lines from the review with a
  // `!isBundleIncludedShippingLine &&` guard on the flag — that must be gone.
  assert.ok(!/!isBundleIncludedShippingLine &&\s*\n?\s*decideZeroShippingReview/.test(billing),
    'bundle-included $0 lines must no longer be excluded from the review');
});

check('billing-detail-row-sot carries the reason fields to the order row', () => {
  const sot = read('src/services/billing-detail-row-sot.ts');
  assert.ok(/'zeroShippingReviewReason'/.test(sot) && /'zeroShippingReviewLabel'/.test(sot) && /'zeroShippingReviewSeverity'/.test(sot));
});

check('FE badge renders the backend classification verbatim (no FE policy math)', () => {
  const badge = read('web/src/components/Views/BillingZeroShippingBadge.tsx');
  assert.ok(/row\.shippingZeroNeedsReview === true/.test(badge));
  assert.ok(/zeroShippingReviewReason/.test(badge) && /zeroShippingReviewLabel/.test(badge) && /data-billing-badge="ZERO_SHIPPING_REVIEW"/.test(badge));
});

check('detail table shows the badge in the Shipping cell for every $0-review row', () => {
  const table = read('web/src/components/Views/BillingDetailTable.tsx');
  assert.ok(/case 'shipping'/.test(table) && /hasBillingZeroShippingReview\(row\)/.test(table) && /<BillingZeroShippingBadge row=\{row\}/.test(table));
});

if (failures > 0) {
  console.error(`\nPS-376 zero-shipping review reason guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-376 zero-shipping review reason guard passed.');
