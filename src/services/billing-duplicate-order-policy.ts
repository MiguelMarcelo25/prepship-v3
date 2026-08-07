/**
 * Canonical owner: when one order number exists as several `orders` rows, which copy
 * does the invoice charge for?
 *
 * PS-491. The same marketplace order can land in `orders` more than once, because order
 * de-duplication is keyed on `(source_provider, source_account_id, source_order_id)` and
 * ShipStation reassigns its `orderId` when an order is edited/split. Measured 2026-08-07:
 * 369 duplicated `(store_id, order_number)` groups, 367 of which carry a DIFFERENT
 * `source_order_id` on each copy, so `orders_source_unique_idx` never fires. That root
 * cause is a separate fix at the identity owner (`order-source-identity.ts`) and is not
 * what this file solves.
 *
 * What this file solves is the money. The invoice export groups by `b.order_id`
 * (`src/routes/billing.ts`), so two copies become two invoice rows and the customer is
 * charged twice for one shipment. The Billing TABLE already treats this as a known
 * condition — `billing-detail-row-sot.ts` badges both copies "Duplicate order #" and
 * deliberately does not merge them. The export inherits none of that, which is where a
 * flagged-and-visible condition turns into a silent double charge.
 *
 * Backend-owned on purpose (PS-316): "which copy is authoritative" decides money, so it
 * is not a rendering concern. Routes and exporters call this and render the answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE, and why it is not simply "charge once"
 *
 * A duplicated order number has two very different causes and they must not be collapsed
 * the same way. Production, 2026-08-07, over all 369 groups:
 *
 *   A. Exactly ONE copy carries paid shipping — 133 groups, 128 of which have exactly one
 *      distinct tracking number. One physical shipment recorded twice. Collapse.
 *   B. NO copy carries paid shipping — 164 groups, 155 with no tracking at all. Only
 *      pick/pack and package_cost were duplicated. Collapse.
 *   C. TWO OR MORE copies carry paid shipping — 72 groups, and **72 of 72 have multiple
 *      distinct tracking numbers**. Two labels were bought and two shipments went out.
 *      These are real split shipments. Collapsing them would UNDERCHARGE.
 *
 * That 72/72 correlation is the whole reason this is a classifier and not a dedupe. A
 * naive "one order number = one charge" would have silently erased ~$1,348 of legitimate
 * postage revenue.
 *
 * Under this rule, on the data as it stood: 200 groups collapse, $347.60 of duplicate
 * billing is zeroed across 261 line items, $1,882.66 is retained, and none of it had been
 * invoiced yet.
 */

/** What the invoice should do with a given order copy. */
export type DuplicateOrderDecision =
  /** Charge this copy normally. Either not duplicated, or the copy that owns the shipment. */
  | { kind: 'authoritative' }
  /** Do not charge. A different copy of the same order number is authoritative. */
  | { kind: 'duplicate'; duplicateOfOrderId: number }
  /**
   * Several copies each carry real postage, so this is a split shipment rather than a
   * duplicate. Charge every copy, but say so — the operator should confirm it.
   */
  | { kind: 'split_shipment' };

export type DuplicateOrderPolicyRow = {
  orderId: number | null;
  orderNumber: string | null;
  /** Billed shipping for this row. Rows of the same order are summed before deciding. */
  shippingAmount: number;
  /** Presence of a shipment is the tie-break when no copy has paid shipping. */
  shipmentId: number | null;
  /** Adjustment rows are not orders and never participate. */
  billingAdjustmentId: string | null;
  /**
   * PS-491: ShipStation's OWN statement that this order was split or merged
   * (`advancedOptions.mergedOrSplit` / `parentId`), when known.
   *
   * The paid-shipping test below infers split-vs-duplicate from an effect — whether two
   * labels were bought. This is the cause, stated by the system that did the splitting, so
   * it wins when present. Null means unknown, which is the case for every order ingested
   * before raw-payload policy v2 started retaining these fields.
   */
  shipStationSplit?: boolean | null;
};

function finite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decide, per order id, what the invoice should do.
 *
 * PRECONDITION: `rows` are one client's rows for one invoice period. Order numbers are
 * unique per STORE, not globally, and the export row carries no store id — so passing
 * two clients' rows together could collapse unrelated orders. Every caller today derives
 * `rows` from a query already filtered by `client_id`. Verified 2026-08-07: of 176
 * per-client duplicated order numbers in production, ZERO span more than one store, so
 * the grouping is sound on real data as well as by construction.
 *
 * Returns decisions ONLY for order ids that need one; an order id absent from the map is
 * ordinary and should be charged. Callers must treat "absent" as authoritative rather
 * than assuming every row is present.
 */
export function classifyDuplicateOrderCopies(
  rows: readonly DuplicateOrderPolicyRow[],
): Map<number, DuplicateOrderDecision> {
  // Per order number: the set of order ids, and per order id the evidence we rank on.
  const byOrderNumber = new Map<string, Map<number, {
    shipping: number; shipments: number; declaredSplit: boolean;
  }>>();

  for (const row of rows) {
    // Adjustments are client-level money with no order identity; they are never duplicates.
    if (row.billingAdjustmentId) continue;
    if (row.orderId == null) continue;
    const orderNumber = String(row.orderNumber ?? '').trim();
    if (!orderNumber) continue;

    let copies = byOrderNumber.get(orderNumber);
    if (!copies) {
      copies = new Map();
      byOrderNumber.set(orderNumber, copies);
    }
    const evidence = copies.get(row.orderId)
      ?? { shipping: 0, shipments: 0, declaredSplit: false };
    // One order can span several rows (multi-package); sum before ranking, or a
    // two-package order would look like two weaker candidates instead of one strong one.
    evidence.shipping += finite(row.shippingAmount);
    if (row.shipmentId != null) evidence.shipments += 1;
    if (row.shipStationSplit === true) evidence.declaredSplit = true;
    copies.set(row.orderId, evidence);
  }

  const decisions = new Map<number, DuplicateOrderDecision>();

  for (const copies of byOrderNumber.values()) {
    if (copies.size < 2) continue; // The ordinary case: one order number, one order.

    const entries = [...copies.entries()];
    const paid = entries.filter(([, e]) => e.shipping > 0);

    // PS-491, raw-payload policy v2. If ShipStation itself says any copy in this group was
    // split or merged, that settles it — no inference required. This is strictly safer
    // than the paid-shipping test that follows: it can only PREVENT a wrongful collapse,
    // never cause one. Null/absent for orders ingested before v2, which is every order in
    // the table today, so this branch is inert until the evidence accumulates.
    if (entries.some(([, e]) => e.declaredSplit)) {
      for (const [orderId] of entries) decisions.set(orderId, { kind: 'split_shipment' });
      continue;
    }

    // Case C. Two or more copies each bought postage — a split shipment, not a duplicate.
    // Charge all of them and mark them so a human confirms. Erring toward charging is
    // deliberate: an over-charge is visible to the customer and gets corrected, while a
    // silent under-charge is revenue that no one ever notices is missing.
    if (paid.length > 1) {
      for (const [orderId] of entries) decisions.set(orderId, { kind: 'split_shipment' });
      continue;
    }

    // Cases A and B. Exactly one shipment's worth of money is in play, so one copy is
    // authoritative. Rank: paid shipping first, then having a shipment row at all, then
    // the lowest order id purely so the choice is deterministic and reproducible across
    // runs (the earliest row is also the label-purchase write in the observed data).
    const [keepId] = entries.sort((a, b) =>
      (b[1].shipping > 0 ? 1 : 0) - (a[1].shipping > 0 ? 1 : 0)
      || b[1].shipments - a[1].shipments
      || a[0] - b[0],
    )[0]!;

    for (const [orderId] of entries) {
      decisions.set(orderId, orderId === keepId
        ? { kind: 'authoritative' }
        : { kind: 'duplicate', duplicateOfOrderId: keepId });
    }
  }

  return decisions;
}

/** The invoice-facing note for a non-authoritative copy. */
export function duplicateOrderStatusLabel(decision: DuplicateOrderDecision): string | null {
  if (decision.kind === 'duplicate') return `Duplicate of order ${decision.duplicateOfOrderId}`;
  if (decision.kind === 'split_shipment') return 'Split shipment — review';
  return null;
}

/** True when the copy must contribute no money to the invoice. */
export function isNonBillableDuplicate(decision: DuplicateOrderDecision | undefined): boolean {
  return decision?.kind === 'duplicate';
}
