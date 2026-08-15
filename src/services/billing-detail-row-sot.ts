import { roundMoney } from '../lib/money';
import { NO_BOX_COST_BILLING_BADGE, resolveBillingBoxCostAlert } from './billing-box-cost-alert';
import { isCancelledNoChargeBillingRow } from './billing-cancelled-no-charge';
import {
  isBillingReturnLineType,
  isBillingReturnPostageLineType,
  isBillingReturnProcessingLineType,
  resolveBillingReturnRowStatus,
} from './billing-row-status';
import {
  INTERNATIONAL_BILLING_BADGE,
  classifyDestinationCountry,
  type BillingDestination,
} from './billing-destination-international';
import { billingRowIdentity, type BillingRowType } from './billing-row-reference';

// PS-368 — the TYPED canonical billing detail order-row boundary.
//
// Before this card the module operated on Record<string, unknown>, read every
// field as `camelCase ?? snake_case ?? lineType-inference`, and mirrored BOTH
// casings on every write. That casing tolerance was the root cause behind the
// FE recompute fallbacks (PS-369) and the `??` cascade density across billing:
// every new consumer grew another cascade. The backend read model owns the row
// shape; FE and exports consume it verbatim (camelCase-only).
//
// Mirrors the shipping-rate-money-normalizer pattern (e9762409): one typed
// owner, one ingest edge, no dual-casing on output.

/** Raw input line (the billingDetails assembly / SQL-adjacent shape). */
export type BillingDetailReadModelRow = Record<string, unknown>;

/**
 * The canonical billing detail ORDER row (one row per order, fee lines
 * collapsed). camelCase-only — no snake_case duplicates are emitted; the
 * ps-362 guard pins this. The index signature carries the raw-line
 * passthrough fields (id, clientId, description, qty, unitCost, invoiced,
 * createdAt, providerAccountId, trackingNumber, ...) the first line of each
 * order contributes via spread.
 */
export interface BillingDetailRowDto {
  [key: string]: unknown;
  lineType: 'billing_order';
  // Money totals — always present, always numbers (the PS-369 FE contract).
  pickpackTotal: number;
  additionalTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  adjustmentTotal: number;
  pickPackFeeTotal: number;
  fulfillmentFeeTotal: number;
  grandTotal: number;
  /** Always 0 on aggregated order rows (line-level cost is folded into the totals). */
  totalCost: number;
  // Box-cost review surface.
  hasPackageCostLine: boolean;
  boxCostNoCharge: boolean;
  boxCostAlert: boolean;
  billingBadges: string[];
  billingLifecycleStatus?: string;
  billingStatusLabel?: string;
  billingStatusTone?: string;
  billingZeroReason?: string | null;
  billingStatusBadge?: string | null;
  fulfillmentConflictCode?: string | null;
  fulfillmentConflictLabel?: string | null;
  fulfillmentConflictReason?: string | null;
  displayQty?: string;
  /** Normalized destination country code, or null when the order carries none. */
  destinationCountry?: string | null;
  /** Backend-owned: true only for destinations outside the US domestic postal area. */
  destinationIsInternational?: boolean;
  /**
   * PS-488 AC-2 — what the Destination COLUMN shows: Domestic / International /
   * Needs Review. Distinct from `destinationIsInternational`, which drives the badge and
   * is two-state: a badge cannot say "we don't know", a column can and must.
   */
  destination?: BillingDestination;
  /** PS-488 AC-6 — return money in its own columns, never inferred by the FE. */
  returnPostageTotal?: number;
  returnProcessingTotal?: number;
  /**
   * PS-505 — the Return row's own total, owned here rather than reassembled downstream.
   *
   * Distinct from `grandTotal` on purpose: grandTotal is the row's money whatever kind of
   * row it is, while this is specifically the return economics. Both exist because the
   * invoice row-total fallback and the Return Total column are different questions, and
   * having one of them derived by a caller is how return money previously ended up
   * double-counted through an outbound bucket.
   */
  returnTotal?: number;
  /**
   * PS-505 — the PROVEN cost of the return shipment, resolved from
   * `returns.return_shipment_id`, or null when there is no return shipment or no
   * persisted cost on it.
   *
   * Null is a real answer and must survive to the cell. It is never the outbound
   * shipment's cost: the two events merely share an order, which is not evidence of
   * anything about the return.
   */
  returnSelectedRateCost?: number | null;
  /**
   * PS-505 — backend-owned shipping margin, `number | null`.
   *
   * Previously computed in React as `shipping - (Number(selectedRateCost ?? 0) || 0)`,
   * which turned an UNKNOWN cost into a real-looking zero and therefore reported the
   * full charge as profit. Margin is money truth, so it is decided here: null when the
   * cost is unknown, a number only when it was proven.
   */
  margin?: number | null;
  /**
   * PS-488 M3 — PRESENCE, distinct from amount.
   *
   * `returnPostageTotal === 0` cannot tell a reader whether the return was charged
   * nothing for postage or was never charged postage at all. These flags carry that
   * difference all the way to the rendered cell, so an absent fee shows blank and a real
   * zero shows $0.00. Every serializer must branch on these, not on the number.
   */
  hasReturnPostageLine?: boolean;
  hasReturnProcessingLine?: boolean;
  /**
   * PS-488 M3 — the deduplicated, sorted set of line types that formed this aggregate.
   * Sorted because the set is a property of the row, not of its components' arrival order.
   */
  lineTypes?: string[];
  /** PS-488 AC-1 — Outbound or Return, from the relational returnId. */
  rowType?: BillingRowType;
  /** PS-488 AC-1 — `#1234` or `#1234-RETURN`. Display/search identity, never a key. */
  displayReference?: string | null;
  relatedOrderId?: number | string | null;
  returnId?: number | string | null;
  /** returns.return_reference as persisted by the Client Portal (AC-1). */
  returnReference?: string | null;
  manualBillingOverrideLineTypes?: string[];
  manualBillingOverrideLabels?: string[];
  /**
   * PS-498 — the operator's own sentence explaining why this order's invoice line
   * was corrected, plus who saved it and when. Free text authored by a human, so
   * unlike every other text field here it is NOT a backend classification: the FE
   * renders it read-only and never sends it back from the Edit modal.
   *
   * Named `orderDescription`, not `description`: the DTO already receives a
   * generator-owned `description` key from billing_line_items via the first-line
   * spread, and that one is parsed by regex elsewhere.
   *
   * `orderDescriptionSavedAt` is an ISO STRING, not a Date — carryText below is
   * `typeof value === 'string'` gated and would silently drop a Date.
   */
  orderDescription?: string | null;
  orderDescriptionSavedBy?: string | null;
  orderDescriptionSavedAt?: string | null;
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * PS-505 — absent money must stay absent.
 *
 * `numberValue` answers 0 for null/''/unparseable, which is correct for a total that is
 * genuinely zero but wrong for a cost nobody proved. Margin and selected-rate cost need
 * the distinction: `Number(null) === 0` is exactly the coercion that made an unknown
 * carrier cost render as a 100% margin.
 */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

function nonEmpty(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function orderKeyFromId(orderId: unknown): string {
  return `order:${String(orderId)}`;
}

function orderNumberValue(row: BillingDetailReadModelRow): string | null {
  return textValue(row.orderNumber);
}

function formatBillingDisplayQty(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  const text = String(value).trim();
  if (!text) return '0';
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return text;
  if (Number.isInteger(parsed)) return String(parsed);
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function uniqueOrderKeyByOrderNumber(rows: BillingDetailReadModelRow[]): Map<string, string> {
  const orderKeysByNumber = new Map<string, Set<string>>();
  for (const row of rows) {
    if (isBillingReturnLineType(row.lineType)) continue;
    if (!nonEmpty(row.orderId)) continue;
    const orderNumber = orderNumberValue(row);
    if (!orderNumber) continue;
    let keys = orderKeysByNumber.get(orderNumber);
    if (!keys) {
      keys = new Set<string>();
      orderKeysByNumber.set(orderNumber, keys);
    }
    keys.add(orderKeyFromId(row.orderId));
  }

  const result = new Map<string, string>();
  for (const [orderNumber, orderKeys] of orderKeysByNumber) {
    if (orderKeys.size === 1) {
      const [onlyKey] = orderKeys;
      if (onlyKey) result.set(orderNumber, onlyKey);
    }
  }
  return result;
}

function duplicateOrderNumbers(rows: BillingDetailReadModelRow[]): Set<string> {
  const orderKeysByNumber = new Map<string, Set<string>>();
  for (const row of rows) {
    if (isBillingReturnLineType(row.lineType)) continue;
    if (!nonEmpty(row.orderId)) continue;
    const orderNumber = orderNumberValue(row);
    if (!orderNumber) continue;
    let keys = orderKeysByNumber.get(orderNumber);
    if (!keys) {
      keys = new Set<string>();
      orderKeysByNumber.set(orderNumber, keys);
    }
    keys.add(orderKeyFromId(row.orderId));
  }

  const result = new Set<string>();
  for (const [orderNumber, orderKeys] of orderKeysByNumber) {
    if (orderKeys.size > 1) result.add(orderNumber);
  }
  return result;
}

// The single SQL-row→DTO ingest edge. The billingDetails query selects
// camelCase aliases (drizzle .select map), so the reads here are camel-only;
// missing totals fall back to the lineType inference exactly as before.
function billingLineMetrics(row: BillingDetailReadModelRow) {
  if (isCancelledNoChargeBillingRow(row)) {
    // A cancelled no-charge row bills nothing, return money included (PS-377).
    return {
      pickPack: 0, additional: 0, packageCost: 0, shipping: 0, storage: 0, adjustment: 0, total: 0,
      returnPostage: 0, returnProcessing: 0, returnTotal: 0,
    };
  }

  const lineType = row.lineType;
  const lineTotal = numberValue(row.totalCost);

  // PS-505 — return money is classified FIRST, and a return line can never reach an
  // outbound bucket.
  //
  // PS-488 AC-4/AC-6 added the dedicated return buckets but LEFT the older aliases in
  // place: return_processing / return_processing_fee also fed pickPack, and
  // return_label / return_postage / return also fed shipping. One return charge
  // therefore occupied two semantic buckets at once, and because fulfillmentFeeTotal
  // sums pickPack + additional + packageCost + shipping + storage, a return charge was
  // reported to the operator and to the invoice as a Fulfillment Fee.
  //
  // The guard is on the LINE TYPE, not on the amount, and it wraps every outbound
  // bucket rather than only the two that carried aliases — a return line must not reach
  // an outbound total even via a pre-computed column on the source row.
  const isReturnLine = isBillingReturnLineType(lineType);
  const isReturnPostageLine = isBillingReturnPostageLineType(lineType);
  const isReturnProcessingLine = isBillingReturnProcessingLineType(lineType);

  const returnPostage = isReturnPostageLine ? lineTotal : 0;
  const returnProcessing = isReturnProcessingLine ? lineTotal : 0;
  // The bare legacy `return` type is a governed return line but is neither postage nor
  // processing, so it matches neither predicate above. It previously reached the row
  // total through `shipping`; removing that alias without giving it a home would
  // silently drop real historical money from a frozen invoice. It funds the return
  // total without being attributed to a component it cannot evidence, so no presence
  // flag is set for it and neither breakout column claims it.
  const returnOther = isReturnLine && !isReturnPostageLine && !isReturnProcessingLine
    ? lineTotal
    : 0;
  const returnTotal = returnPostage + returnProcessing + returnOther;

  const pickPack = isReturnLine ? 0 : numberValue(
    row.pickpackTotal ?? (lineType === 'pick_pack' || lineType === 'pickpack' ? lineTotal : 0),
  );
  const additional = isReturnLine ? 0 : numberValue(
    row.additionalTotal ??
      (lineType === 'additional_unit' || lineType === 'additional' ? lineTotal : 0),
  );
  const packageCost = isReturnLine ? 0 : numberValue(
    row.packageTotal ?? (lineType === 'package_cost' ? lineTotal : 0),
  );
  const shipping = isReturnLine ? 0 : numberValue(
    row.shippingTotal ?? (lineType === 'shipping' ? lineTotal : 0),
  );
  const storage = isReturnLine ? 0 : numberValue(
    row.storageTotal ?? (lineType === 'storage' ? lineTotal : 0),
  );
  const adjustment = isReturnLine ? 0 : numberValue(
    row.adjustmentTotal ?? (lineType === 'billing_adjustment' ? lineTotal : 0),
  );
  // PS-501 AC-3 — the two spellings must AGREE, not take turns.
  //
  // This was `nonEmpty(grandTotal) ? grandTotal : nonEmpty(total) ? total : null`, which
  // let field order decide silently. The production detail query selects neither column,
  // so the chain was dead there — but every hand-built row (the guard scripts, any future
  // caller) goes through this same ingest edge, which is precisely where a legacy payload
  // carrying a stale `total` beside a fresh `grandTotal` would enter and win nothing but
  // the coin toss. Disagreement is now a contract error rather than a precedence rule.
  const canonicalTotal = nonEmpty(row.grandTotal) ? numberValue(row.grandTotal) : null;
  const legacyTotal = nonEmpty(row.total) ? numberValue(row.total) : null;
  if (canonicalTotal !== null && legacyTotal !== null
      && Math.abs(canonicalTotal - legacyTotal) > 0.005) {
    throw new Error(
      `PS-501: billing row ${String(row.orderNumber ?? row.orderId ?? 'unknown')} disagrees ` +
        `with itself — grandTotal=${canonicalTotal} but total=${legacyTotal}. These are two ` +
        'spellings of one value; field order must not pick the winner.',
    );
  }
  const explicitTotal = canonicalTotal ?? legacyTotal;
  // returnTotal is a term here because return money no longer arrives through an
  // outbound bucket. Without it the fallback total for a Return row would be zero.
  const total = explicitTotal ??
    pickPack + additional + packageCost + shipping + storage + adjustment + returnTotal;

  return {
    pickPack, additional, packageCost, shipping, storage, adjustment, total,
    returnPostage, returnProcessing, returnTotal,
  };
}

function rowKey(row: BillingDetailReadModelRow, orderNumberKey: Map<string, string>): string {
  if (isBillingReturnLineType(row.lineType)) {
    if (nonEmpty(row.returnId)) return `return:${String(row.returnId)}`;
    if (nonEmpty(row.id)) return `return-line:${String(row.orderId ?? 'none')}:${String(row.id)}`;
    return [
      'return',
      String(row.orderId ?? ''),
      String(row.description ?? ''),
      String(row.lineType ?? ''),
    ].join(':');
  }
  const orderId = row.orderId;
  if (nonEmpty(orderId)) return orderKeyFromId(orderId);
  const orderNumber = orderNumberValue(row);
  if (orderNumber) return orderNumberKey.get(orderNumber) ?? `order-number:${orderNumber}`;
  return [
    'storage',
    String(row.description ?? ''),
    String(row.lineType ?? ''),
    String(row.id ?? ''),
  ].join(':');
}

function carryText(target: BillingDetailRowDto, source: BillingDetailReadModelRow, key: string): void {
  if (textValue(target[key])) return;
  const value = textValue(source[key]);
  if (value) target[key] = value;
}

function carryValue(target: BillingDetailRowDto, source: BillingDetailReadModelRow, key: string): void {
  if (nonEmpty(target[key])) return;
  if (nonEmpty(source[key])) target[key] = source[key];
}

function carryBooleanOr(target: BillingDetailRowDto, source: BillingDetailReadModelRow, key: string): void {
  target[key] = target[key] === true || source[key] === true;
}

// Carry tables — camelCase-only (PS-368 deleted the snake_case twins).
const TEXT_CARRY_FIELDS = [
  'shipDate',
  'actualActivityDate',
  'billingEffectiveDate',
  'billingPolicyVersion',
  'carrierCode',
  'carrierNickname',
  'providerAccountNickname',
  'itemNames',
  'itemSkus',
  'packageName',
  'packageCostReviewReason',
  // PS-376: the $0-shipping review reason/label/severity ride on the order's
  // shipping line; carry them to the collapsed order row so the FE badge (and
  // Invoice) render the backend classification verbatim.
  'zeroShippingReviewReason',
  'zeroShippingReviewLabel',
  'zeroShippingReviewSeverity',
  // PS-377: the backend-owned cancelled-order status marker ('CANCELLED').
  'billingStatusBadge',
  'orderNumber',
  // PS-393: explicit backend-owned Billing Status column fields. The FE and
  // exports render these verbatim instead of inferring status from dollars.
  'billingLifecycleStatus',
  'billingStatusLabel',
  'billingStatusTone',
  'billingZeroReason',
  'fulfillmentConflictCode',
  'fulfillmentConflictLabel',
  'fulfillmentConflictReason',
  'sourceFinalizationId',
  'billingAdjustmentId',
  'adjustmentKind',
  'adjustmentSource',
  // PS-498: the operator's per-order description + attribution. Every line row of
  // an order carries the same value (the lookup is keyed by orderId), so the
  // first-line spread already carries it — but the spread is an accident of which
  // line sorts first, and this table is the DECLARED owner of what survives the
  // collapse. Listed here so the guarantee does not depend on row order.
  'orderDescription',
  'orderDescriptionSavedBy',
  'orderDescriptionSavedAt',
  // PS-488 M3: the persisted return reference. Every line under one return identity
  // resolves it from the same relational row, so the value is identical across them —
  // but it survived the collapse only through the first-line spread, which is the
  // accident this table exists to remove. Declared so the guarantee holds regardless
  // of which component line arrives first.
  'returnReference',
] as const;

const VALUE_CARRY_FIELDS = [
  'orderId',
  'shipmentId',
  'packageId',
  'providerAccountId',
  'labelProvider',
  'trackingNumber',
  'totalQty',
  'selectedRateCost',
  'refUpsRate',
  'refUspsRate',
  'feeWaiverDecision',
  'destinationCountry',
  'billingBadges',
  'relatedOrderId',
  'returnId',
  // PS-505 — the return's own shipment and that shipment's proven cost. Carried so the
  // value survives the collapse regardless of which component line arrives first, the
  // same reason returnReference is in the text table.
  'returnShipmentId',
  'returnSelectedRateCost',
  'manualBillingOverrideLineTypes',
  'manualBillingOverrideLabels',
] as const;

const BOOLEAN_OR_FIELDS = [
  'hasPackageCostLine',
  'boxCostNoCharge',
  'boxCostAlert',
  'stalePackagePrice',
  'packageCostNeedsReview',
  'shippingZeroNeedsReview',
  'feeWaived',
  'rolledFromWeekend',
] as const;

function applyBoxCostAlert(row: BillingDetailRowDto): void {
  const result = resolveBillingBoxCostAlert({
    packageCost: row.packageTotal,
    hasPackageCostLine: row.hasPackageCostLine === true,
    packageCostNeedsReview: row.packageCostNeedsReview === true,
    isNoChargeBoxCostLine: row.boxCostNoCharge === true,
    canAlertMissing: nonEmpty(row.orderId),
    // PS-372(b): tri-state passthrough of the emitter's box-pricing gate —
    // explicitly false suppresses the missing-cost alert (the generator
    // intentionally emits no box line for unpriced clients); absent keeps
    // the historical behavior.
    clientHasBoxPricing:
      row.clientHasBoxPricing === true ? true : row.clientHasBoxPricing === false ? false : undefined,
    existingBadges: row.billingBadges,
  });
  row.boxCostAlert = result.boxCostAlert;
  row.billingBadges = result.billingBadges;
}

function appendBillingBadge(row: BillingDetailRowDto, badge: string): void {
  const badges = Array.isArray(row.billingBadges) ? row.billingBadges : [];
  row.billingBadges = badges.includes(badge) ? badges : [...badges, badge];
}

function applyCancelledNoCharge(row: BillingDetailRowDto): void {
  if (!isCancelledNoChargeBillingRow(row)) return;
  if (textValue(row.fulfillmentConflictCode)) return;

  // PS-488 M3 — a Return row is never zeroed by the outbound order's cancellation.
  //
  // The aggregate rewrites lineType to the generic order type before this runs, so the
  // line-type exclusion inside isCancelledNoChargeBillingRow can no longer recognise a
  // return and the row reached the zeroing below on its related order's state alone.
  // That produced a visible contradiction: the return breakout fields kept their money
  // (they are not in the list below) while Total and every generic bucket read zero.
  //
  // A return is its own business event. Cancelling the outbound order does not refund
  // what the return cost, so the Return row keeps its persisted money. The outbound
  // row's cancelled-no-charge behaviour is unchanged.
  if (row.rowType === 'Return') return;

  // Per user override unlock shipped data on 2026-07-06: cancelled Billing rows
  // remain visible for audit, but stale prep/box/shipping generated lines and
  // their review badges cannot contribute money or review noise.
  row.pickpackTotal = 0;
  row.additionalTotal = 0;
  row.packageTotal = 0;
  row.shippingTotal = 0;
  row.storageTotal = 0;
  row.adjustmentTotal = 0;
  row.pickPackFeeTotal = 0;
  row.fulfillmentFeeTotal = 0;
  row.grandTotal = 0;
  row.totalCost = 0;
  row.hasPackageCostLine = false;
  row.boxCostNoCharge = false;
  row.boxCostAlert = false;
  row.packageCostNeedsReview = false;
  row.shippingZeroNeedsReview = false;
  row.packageCostReviewReason = null;
  row.zeroShippingReviewReason = null;
  row.zeroShippingReviewLabel = null;
  row.zeroShippingReviewSeverity = null;
  row.billingBadges = Array.isArray(row.billingBadges)
    ? row.billingBadges.filter((badge) => badge !== NO_BOX_COST_BILLING_BADGE)
    : [];
}

function applyDestinationInternational(row: BillingDetailRowDto): void {
  // The backend decides; the FE only renders the badge. `destinationCountry` is the raw
  // provider value projected from orders.raw->'shipTo'->>'country' — it is carried onto
  // the DTO so operators can see WHICH country, but the international decision itself
  // comes from the canonical classifier, never from a comparison at a call site.
  const { countryCode, isInternational, destination } = classifyDestinationCountry(row.destinationCountry);
  row.destinationCountry = countryCode;
  row.destinationIsInternational = isInternational;
  // AC-2: the column value. `Needs Review` is a real answer, not an absent one — the
  // badge above still stays off for it, because an unknown country is not evidence of a
  // foreign destination.
  row.destination = destination;
  if (isInternational) appendBillingBadge(row, INTERNATIONAL_BILLING_BADGE);
}

function applyRowIdentity(row: BillingDetailRowDto): void {
  // PS-488 AC-1. Read from the canonical owner rather than assembled here, so the
  // "PrepShip never mints a -RETURN suffix" rule has exactly one home.
  const { rowType, displayReference } = billingRowIdentity({
    orderNumber: nonEmpty(row.orderNumber) ? String(row.orderNumber) : null,
    orderId: typeof row.orderId === 'number' ? row.orderId : Number(row.orderId) || null,
    returnId: typeof row.returnId === 'number' ? row.returnId : Number(row.returnId) || null,
    returnReference: nonEmpty(row.returnReference) ? String(row.returnReference) : null,
  });
  row.rowType = rowType;
  row.displayReference = displayReference;
}

/**
 * PS-488 M3 — make a Return aggregate describe ITSELF, not one of its components.
 *
 * Two separate defects, both of which made a component masquerade as the whole row:
 *
 * 1. STATUS. resolveBillingRowStatus runs per LINE upstream, so the postage line resolves
 *    to 'return_postage' and the processing line to 'return_processing_fee'. The collapse
 *    kept whichever initialised the row, so the status of a two-line return depended on
 *    arrival order. Re-resolved here through the shared owner, from the row's own type.
 *
 * 2. DESCRIPTION / QTY / UNIT COST. These belong to one component line. Pinning them to
 *    the highest component id (the previous fix) made the choice deterministic, but
 *    deterministic is not truthful: "Return postage" as the description of a row that is
 *    postage AND processing is simply wrong, and a unit cost of 7.73 against a total of
 *    10.73 invites the reader to conclude the quantity is wrong. There is no honest
 *    single-component answer, and PrepShip must not invent a synthetic one, so they are
 *    cleared and the renderers show blank.
 *
 * Scoped to Return rows on purpose. An outbound aggregate's qty is a real quantity that
 * ps-394's displayQty depends on; nothing about outbound rows changes here.
 */
function applyReturnAggregate(row: BillingDetailRowDto): void {
  if (row.rowType !== 'Return') return;

  const status = resolveBillingReturnRowStatus({
    lineTypes: Array.isArray(row.lineTypes) ? row.lineTypes : [],
    returnId: (row.returnId ?? null) as number | string | null,
    relatedOrderId: (row.relatedOrderId ?? null) as number | string | null,
  });
  row.billingLifecycleStatus = status.billingLifecycleStatus;
  row.billingStatusLabel = status.billingStatusLabel;
  row.billingStatusTone = status.billingStatusTone;
  row.billingZeroReason = status.billingZeroReason;
  row.billingStatusBadge = status.billingStatusBadge;

  row.description = null;
  row.qty = null;
  row.unitCost = null;
  row.totalQty = null;
}

/**
 * PS-505 — selected-rate cost and margin, decided at the owner instead of in React.
 *
 * Two defects collapse into one fix. The FE did
 * `const ourCost = Number(selectedRateCost ?? 0) || 0; const margin = shipping - ourCost`,
 * which (a) turned an unproven cost into a real-looking $0.00 and reported the entire
 * charge as margin, and (b) left a money rule living in a table component. Both are
 * resolved by answering here, in `number | null`, and letting the cell render blank.
 *
 * A Return row's rate truth is its OWN shipment's, resolved from
 * `returns.return_shipment_id`. Assigning it here is also a fence: even if a caller
 * leaked the related order's outbound shipment cost onto a return's source line, it
 * cannot reach a Return row's Selected Rate or Margin cell. Two events sharing an order
 * is not evidence of anything about the return.
 */
function applyRateEconomics(row: BillingDetailRowDto): void {
  if (row.rowType === 'Return') {
    const cost = numberOrNull(row.returnSelectedRateCost);
    row.returnSelectedRateCost = cost;
    row.selectedRateCost = cost;
    // PS-505 corrective: BOTH facts must be known. An explicit zero on either side is a
    // fact and yields a margin; an ABSENT charge is not. Presence, not the number —
    // `returnPostageTotal === 0` cannot by itself distinguish "postage was waived" from
    // "this return was never charged postage", and only the first supports a margin.
    const hasPostage = row.hasReturnPostageLine === true;
    row.margin = cost === null || !hasPostage
      ? null
      // Rounded through the canonical money owner: 6.77 - 5.58 is 1.1900000000000004 in
      // IEEE754, and a margin is money, not a float.
      : roundMoney(numberValue(row.returnPostageTotal) - cost);
    return;
  }
  const cost = numberOrNull(row.selectedRateCost);
  row.selectedRateCost = cost;
  // An outbound row has no return shipment by definition. Stated rather than left
  // undefined so every serializer sees the same explicit absence.
  row.returnSelectedRateCost = null;
  row.margin = cost === null ? null : roundMoney(numberValue(row.shippingTotal) - cost);
}

function applyDisplayFields(row: BillingDetailRowDto, duplicatedOrderNumbers: Set<string>): BillingDetailRowDto {
  // PS-488 M3 — identity FIRST. applyCancelledNoCharge must know whether this is a
  // Return row before it decides whether to zero it, and rowType is what tells it.
  // Running the zeroing first meant the decision was made with the answer missing.
  applyRowIdentity(row);
  applyReturnAggregate(row);
  applyCancelledNoCharge(row);
  // PS-505 — after cancellation zeroing, so a cancelled row's margin is computed against
  // the money it actually bills rather than the stale generated amount.
  applyRateEconomics(row);
  applyDestinationInternational(row);
  row.displayQty = formatBillingDisplayQty(nonEmpty(row.totalQty) ? row.totalQty : row.qty);
  const orderNumber = orderNumberValue(row);
  if (orderNumber && duplicatedOrderNumbers.has(orderNumber)) {
    appendBillingBadge(row, 'Duplicate order #');
  }
  return row;
}

export function toBillingDetailOrderRows(rows: BillingDetailReadModelRow[]): BillingDetailRowDto[] {
  const byKey = new Map<string, BillingDetailRowDto>();
  const order: string[] = [];
  const orderNumberKey = uniqueOrderKeyByOrderNumber(rows);
  const duplicatedOrderNumbers = duplicateOrderNumbers(rows);

  for (const row of rows) {
    const key = rowKey(row, orderNumberKey);
    const metrics = billingLineMetrics(row);
    const lineType = row.lineType;
    const hasPackageCostLine =
      lineType === 'package_cost' || row.hasPackageCostLine === true;
    const boxCostNoCharge = row.boxCostNoCharge === true;
    const existing = byKey.get(key);

    if (!existing) {
      // boxCostAlert/billingBadges intentionally come from the spread (the
      // generator's per-line values) — applyBoxCostAlert immediately below
      // normalizes and stamps both, so the DTO guarantee holds on return.
      const next = {
        ...row,
        lineType: 'billing_order',
        pickpackTotal: metrics.pickPack,
        additionalTotal: metrics.additional,
        packageTotal: metrics.packageCost,
        shippingTotal: metrics.shipping,
        returnPostageTotal: metrics.returnPostage,
        returnProcessingTotal: metrics.returnProcessing,
        returnTotal: metrics.returnTotal,
        storageTotal: metrics.storage,
        adjustmentTotal: metrics.adjustment,
        pickPackFeeTotal: metrics.pickPack + metrics.additional,
        // PS-505 corrective: fulfillment SERVICE fees ONLY — Pick & Pack + Additional
        // Units + Box Cost. Shipping is a pass-through carrier charge and Storage is a
        // separate service; including them made this field equal the row total, so the
        // column labelled "Fulfillment Fee" rendered 12.44 on #3074 instead of 4.49 and
        // its own footer rendered a different number under the same heading.
        // Return money is excluded by construction — every outbound bucket is 0 on a
        // Return row — which keeps fulfillmentFeeTotal at 0 there.
        fulfillmentFeeTotal: metrics.pickPack + metrics.additional + metrics.packageCost,
        grandTotal: metrics.total,
        totalCost: 0,
        hasPackageCostLine,
        boxCostNoCharge,
        // PS-488 M3 — PRESENCE, tracked separately from amount.
        //
        // A return that was never charged processing and one that was charged $0.00
        // processing are different facts, and both collapsed to the number 0 here. A
        // processing-only return therefore showed postage as $0.00 — indistinguishable
        // from a waived postage charge, on a document a client is billed from. Presence
        // is what makes "no such fee" renderable as blank while a real zero stays $0.00.
        hasReturnPostageLine: isBillingReturnPostageLineType(lineType),
        hasReturnProcessingLine: isBillingReturnProcessingLineType(lineType),
        // The line types that formed this aggregate. Needed to resolve ONE stable status
        // for the row rather than inheriting whichever component happened to arrive first.
        lineTypes: nonEmpty(lineType) ? [String(lineType)] : [],
      } as BillingDetailRowDto;
      applyBoxCostAlert(next);
      byKey.set(key, next);
      order.push(key);
      continue;
    }

    existing.pickpackTotal = numberValue(existing.pickpackTotal) + metrics.pickPack;
    existing.additionalTotal = numberValue(existing.additionalTotal) + metrics.additional;
    existing.packageTotal = numberValue(existing.packageTotal) + metrics.packageCost;
    existing.shippingTotal = numberValue(existing.shippingTotal) + metrics.shipping;
    existing.returnPostageTotal = numberValue(existing.returnPostageTotal) + metrics.returnPostage;
    existing.returnProcessingTotal = numberValue(existing.returnProcessingTotal) + metrics.returnProcessing;
    existing.returnTotal = numberValue(existing.returnTotal) + metrics.returnTotal;
    existing.storageTotal = numberValue(existing.storageTotal) + metrics.storage;
    existing.adjustmentTotal = numberValue(existing.adjustmentTotal) + metrics.adjustment;
    existing.pickPackFeeTotal = existing.pickpackTotal + existing.additionalTotal;
    // PS-505 corrective: same definition as the first-row branch above. These two must
    // never drift — a one-line order would otherwise report a different Fulfillment Fee
    // from a two-line order with identical charges.
    existing.fulfillmentFeeTotal =
      existing.pickpackTotal +
      existing.additionalTotal +
      existing.packageTotal;
    existing.grandTotal = numberValue(existing.grandTotal) + metrics.total;

    // PS-488 M3 — deterministic aggregate display fields.
    //
    // id, description, qty and unitCost all belong to a COMPONENT line, not to the
    // aggregate. They survived the collapse purely by first-line spread, so reversing
    // the order the source rows arrived in changed the row the operator saw — and `id`
    // is the table/React key, so one business row could change key between fetches.
    //
    // Pinned to the HIGHEST component id rather than nulled. Nulling is order-
    // independent but destroys real display data: qty feeds displayQty, which ordinary
    // multi-line outbound aggregates depend on. The live query orders by
    // desc(billing_line_items.id), so the highest-id line is the one that arrives first
    // today — pinning to it leaves current output byte-identical while making it
    // independent of arrival order.
    //
    // Identity is never taken from these fields; it comes from the relational column.
    const existingId = Number(existing.id);
    const incomingId = Number(row.id);
    if (Number.isFinite(incomingId) && (!Number.isFinite(existingId) || incomingId > existingId)) {
      existing.id = row.id;
      existing.description = row.description;
      existing.qty = row.qty;
      existing.unitCost = row.unitCost;
    }

    // PS-488 M3 — presence is a UNION across components, never a sum. OR-ing rather than
    // overwriting is what lets a two-line return report both fees present while a
    // one-line return reports exactly one.
    existing.hasReturnPostageLine =
      existing.hasReturnPostageLine === true || isBillingReturnPostageLineType(lineType);
    existing.hasReturnProcessingLine =
      existing.hasReturnProcessingLine === true || isBillingReturnProcessingLineType(lineType);
    if (nonEmpty(lineType)) {
      const seen = Array.isArray(existing.lineTypes) ? existing.lineTypes : [];
      // Deduplicated and SORTED: the set of line types is a property of the aggregate, so
      // it must not depend on the order its components arrived in.
      existing.lineTypes = [...new Set([...seen, String(lineType)])].sort();
    }

    existing.hasPackageCostLine = existing.hasPackageCostLine === true || hasPackageCostLine;
    existing.boxCostNoCharge = existing.boxCostNoCharge === true || boxCostNoCharge;

    for (const field of TEXT_CARRY_FIELDS) carryText(existing, row, field);
    for (const field of VALUE_CARRY_FIELDS) carryValue(existing, row, field);
    for (const field of BOOLEAN_OR_FIELDS) carryBooleanOr(existing, row, field);
    applyBoxCostAlert(existing);
  }

  return order.map((key) => applyDisplayFields(byKey.get(key)!, duplicatedOrderNumbers));
}
