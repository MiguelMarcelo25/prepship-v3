import { NO_BOX_COST_BILLING_BADGE, resolveBillingBoxCostAlert } from './billing-box-cost-alert';
import { isCancelledNoChargeBillingRow } from './billing-cancelled-no-charge';
import { isBillingReturnLineType } from './billing-row-status';
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
      returnPostage: 0, returnProcessing: 0,
    };
  }

  const lineType = row.lineType;
  const lineTotal = numberValue(row.totalCost);
  const pickPack = numberValue(
    row.pickpackTotal ??
      // PS-488 AC-4: return_processing_fee is the canonical portal name for the same
      // charge as return_processing. Missing it here sends the fee to no total at all.
      (lineType === 'pick_pack' || lineType === 'pickpack'
        || lineType === 'return_processing' || lineType === 'return_processing_fee'
        ? lineTotal : 0),
  );
  const additional = numberValue(
    row.additionalTotal ??
      (lineType === 'additional_unit' || lineType === 'additional' ? lineTotal : 0),
  );
  const packageCost = numberValue(
    row.packageTotal ?? (lineType === 'package_cost' ? lineTotal : 0),
  );
  const shipping = numberValue(
    // PS-488 AC-4: return_postage is the canonical portal name for return_label.
    row.shippingTotal ?? (lineType === 'shipping' || lineType === 'return_label'
      || lineType === 'return_postage' || lineType === 'return' ? lineTotal : 0),
  );
  const storage = numberValue(
    row.storageTotal ?? (lineType === 'storage' ? lineTotal : 0),
  );
  const adjustment = numberValue(
    row.adjustmentTotal ?? (lineType === 'billing_adjustment' ? lineTotal : 0),
  );
  const explicitTotal = nonEmpty(row.grandTotal)
    ? numberValue(row.grandTotal)
    : nonEmpty(row.total)
      ? numberValue(row.total)
      : null;
  const total = explicitTotal ??
    pickPack + additional + packageCost + shipping + storage + adjustment;

  // PS-488 AC-6: dedicated buckets so the Billing columns render a backend number
  // rather than the FE inferring return money out of shipping/pickpack. Both the
  // canonical portal names and PrepShip's historical ones count, since frozen rows
  // carry the old spelling and are never rewritten.
  const returnPostage = lineType === 'return_postage' || lineType === 'return_label' ? lineTotal : 0;
  const returnProcessing = lineType === 'return_processing_fee' || lineType === 'return_processing' ? lineTotal : 0;

  return { pickPack, additional, packageCost, shipping, storage, adjustment, total, returnPostage, returnProcessing };
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

function applyDisplayFields(row: BillingDetailRowDto, duplicatedOrderNumbers: Set<string>): BillingDetailRowDto {
  // PS-488 M3 — identity FIRST. applyCancelledNoCharge must know whether this is a
  // Return row before it decides whether to zero it, and rowType is what tells it.
  // Running the zeroing first meant the decision was made with the answer missing.
  applyRowIdentity(row);
  applyCancelledNoCharge(row);
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
        storageTotal: metrics.storage,
        adjustmentTotal: metrics.adjustment,
        pickPackFeeTotal: metrics.pickPack + metrics.additional,
        fulfillmentFeeTotal: metrics.pickPack + metrics.additional + metrics.packageCost + metrics.shipping + metrics.storage,
        grandTotal: metrics.total,
        totalCost: 0,
        hasPackageCostLine,
        boxCostNoCharge,
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
    existing.storageTotal = numberValue(existing.storageTotal) + metrics.storage;
    existing.adjustmentTotal = numberValue(existing.adjustmentTotal) + metrics.adjustment;
    existing.pickPackFeeTotal = existing.pickpackTotal + existing.additionalTotal;
    existing.fulfillmentFeeTotal =
      existing.pickpackTotal +
      existing.additionalTotal +
      existing.packageTotal +
      existing.shippingTotal +
      existing.storageTotal;
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

    existing.hasPackageCostLine = existing.hasPackageCostLine === true || hasPackageCostLine;
    existing.boxCostNoCharge = existing.boxCostNoCharge === true || boxCostNoCharge;

    for (const field of TEXT_CARRY_FIELDS) carryText(existing, row, field);
    for (const field of VALUE_CARRY_FIELDS) carryValue(existing, row, field);
    for (const field of BOOLEAN_OR_FIELDS) carryBooleanOr(existing, row, field);
    applyBoxCostAlert(existing);
  }

  return order.map((key) => applyDisplayFields(byKey.get(key)!, duplicatedOrderNumbers));
}
