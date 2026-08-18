import type { ReplacementCustomerPostage } from './replacement-customer-money.js';

/**
 * PS-502 — plan a replacement's billing lines.
 *
 * PURE. No database, no clock of its own, no policy lookups. It turns frozen facts into the
 * complete set of lines that should exist, or into an empty set, or it refuses. The writer
 * persists what it returns.
 *
 * ZERO OR COMPLETE, NEVER PARTIAL
 *
 * A replacement either bills nothing or bills its whole set. A partial plan is the dangerous
 * outcome: postage written without pick/pack looks like a finished row, reconciles against
 * nothing, and the missing half is invisible until someone audits an invoice by hand.
 *
 * `billable = false` produces NO LINE — not a line of $0.00. A zero row asserts that the work
 * was priced and came to nothing; absence asserts it was not charged. Those are different
 * claims and an invoice reader can only tell them apart if we never conflate them.
 *
 * MONEY COMES FROM THE FROZEN TUPLE ONLY
 *
 * `replace_postage` is taken from the replacement shipment's canonical customer-money tuple,
 * captured when the label was purchased. Never a live quote, never a rate re-read at billing
 * time, never portal arithmetic — those can all move after the fact, and a charge that
 * changes after the goods shipped is not a record of what happened.
 */

/** The two line types a replacement may write. Nothing else is a replacement charge. */
export const REPLACEMENT_LINE_TYPES = ['replace_postage', 'replace_pick_pack'] as const;
export type ReplacementLineType = (typeof REPLACEMENT_LINE_TYPES)[number];

export function isReplacementLineType(value: unknown): value is ReplacementLineType {
  return typeof value === 'string' && (REPLACEMENT_LINE_TYPES as readonly string[]).includes(value);
}

export type ReplacementBillingFacts = {
  replacementId: number;
  /** The ORIGINAL order's internal id. Replacement lines hang off it relationally. */
  orderId: number;
  clientId: number;
  /** The ALLOCATED reference — 1321-REPLACE-2 — never string-built from the order number. */
  reference: string;
  replacementShipmentId: number;
  billable: boolean;
  /**
   * PS-502 AC-10 — the customer postage, and ONLY as minted by the fence.
   *
   * This was `money: { shipmentCost, otherCost }` and the plan billed their sum. Those are
   * the CARRIER's numbers, written verbatim from the provider receipt, so the client was
   * charged raw postage cost as though it were a customer rate — no markup, no policy
   * version. The docblock above already claimed money came from the frozen customer tuple;
   * only the type disagreed, and the type is what callers obey.
   *
   * An object, not a number, because a `number` field accepts `shipments.cost` just as
   * happily as a customer rate and nothing could tell them apart. Only
   * `resolveReplacementCustomerPostage` can produce one.
   */
  customerPostage: ReplacementCustomerPostage | null | undefined;
  /** The authoritative client pick/pack charge, resolved by its existing owner. */
  pickPackCharge: number | null | undefined;
  /** Canonical clocks and version, supplied by the billing owner rather than invented here. */
  shipDate: Date;
  billingEffectiveDate: Date;
  billingPolicyVersion: string;
};

export type PlannedReplacementLine = {
  clientId: number;
  orderId: number;
  orderNumber: string;
  shipmentId: number;
  replacementId: number;
  lineType: ReplacementLineType;
  description: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  shipDate: Date;
  billingEffectiveDate: Date;
  billingPolicyVersion: string;
};

export type ReplacementBillingPlanErrorCode =
  | 'REPLACEMENT_BILLING_MONEY_UNAVAILABLE'
  | 'REPLACEMENT_BILLING_PICK_PACK_UNAVAILABLE'
  | 'REPLACEMENT_BILLING_IDENTITY_INVALID';

export class ReplacementBillingPlanError extends Error {
  constructor(
    readonly code: ReplacementBillingPlanErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementBillingPlanError';
  }
}

function money(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cents(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * The complete plan, or an empty one.
 *
 * Refuses rather than guessing whenever a required fact is absent. A missing money tuple on a
 * billable replacement is not a $0.00 charge and not a skipped line — it is a replacement that
 * cannot be billed correctly, and shipping it unbilled is a decision nobody made.
 */
export function planReplacementBillingLines(
  facts: ReplacementBillingFacts,
): PlannedReplacementLine[] {
  // Identity first: every line must be attributable, and a line that cannot be is worse than
  // no line at all — it is money on an invoice pointing nowhere.
  if (!facts.replacementShipmentId || !facts.orderId || !facts.clientId || !facts.reference) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_IDENTITY_INVALID',
      'a replacement billing line requires client, original order, replacement and shipment ' +
        'identity plus the allocated reference',
      {
        replacementId: facts.replacementId,
        hasShipment: Boolean(facts.replacementShipmentId),
        hasReference: Boolean(facts.reference),
      },
    );
  }

  // Not billable: NO line. Not a zero line.
  if (!facts.billable) return [];

  // The fence has already refused anything that did not come from a reconciling,
  // policy-versioned customer tuple. Absence here means it refused, and a refusal is not a
  // $0.00 charge.
  const customerPostage = facts.customerPostage;
  if (!customerPostage || !Number.isFinite(customerPostage.amount)) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_MONEY_UNAVAILABLE',
      `replacement ${facts.reference} has no frozen customer-money tuple, so its postage cannot ` +
        'be billed. A live quote is not a substitute: a charge that changes after the goods ' +
        'shipped is not a record of what happened.',
      { replacementId: facts.replacementId },
    );
  }

  const pickPack = money(facts.pickPackCharge);
  if (pickPack === null) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_PICK_PACK_UNAVAILABLE',
      `replacement ${facts.reference} has no authoritative pick/pack charge. Route input or ` +
        'portal arithmetic is not an authority.',
      { replacementId: facts.replacementId },
    );
  }

  // Customer money, with the markup and flooring its owner applied — never the carrier cost
  // the two former fields carried.
  const postage = customerPostage.amount;
  const common = {
    clientId: facts.clientId,
    // The ORIGINAL order relationally, the REPLACEMENT reference visibly.
    orderId: facts.orderId,
    orderNumber: facts.reference,
    shipmentId: facts.replacementShipmentId,
    replacementId: facts.replacementId,
    shipDate: facts.shipDate,
    billingEffectiveDate: facts.billingEffectiveDate,
    billingPolicyVersion: facts.billingPolicyVersion,
    qty: '1',
  };

  // Descriptions are PRESENTATION. Identity lives in replacement_id + line_type, which is why
  // a reword cannot mint a second charge — the partial unique index in 0097 keys on those.
  return [
    {
      ...common,
      lineType: 'replace_postage',
      description: `Replacement postage ${facts.reference}`,
      unitCost: cents(postage),
      totalCost: cents(postage),
    },
    {
      ...common,
      lineType: 'replace_pick_pack',
      description: `Replacement pick/pack ${facts.reference}`,
      unitCost: cents(pickPack),
      totalCost: cents(pickPack),
    },
  ];
}

/**
 * Cross-table invariants no CHECK constraint can express.
 *
 * The database can require that a replacement line HAS a shipment and a replacement; it
 * cannot require that they are THIS replacement's. Asserted here so a planner or writer bug
 * fails loudly instead of filing one replacement's postage against another's shipment.
 */
export function assertReplacementLineInvariants(
  line: Pick<PlannedReplacementLine, 'orderId' | 'shipmentId' | 'replacementId'>,
  replacement: { id: number; orderId: number; replacementShipmentId: number | null },
): void {
  if (line.replacementId !== replacement.id
    || line.orderId !== replacement.orderId
    || line.shipmentId !== replacement.replacementShipmentId) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_IDENTITY_INVALID',
      'a planned line does not match its replacement: line.shipment_id must equal ' +
        'replacement.replacement_shipment_id and line.order_id must equal replacement.order_id',
      { line, replacement },
    );
  }
}
