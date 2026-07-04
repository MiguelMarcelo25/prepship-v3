import { resolveBillingBoxCostAlert } from './billing-box-cost-alert';

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

// The single SQL-row→DTO ingest edge. The billingDetails query selects
// camelCase aliases (drizzle .select map), so the reads here are camel-only;
// missing totals fall back to the lineType inference exactly as before.
function billingLineMetrics(row: BillingDetailReadModelRow) {
  const lineType = row.lineType;
  const lineTotal = numberValue(row.totalCost);
  const pickPack = numberValue(
    row.pickpackTotal ??
      (lineType === 'pick_pack' || lineType === 'pickpack' ? lineTotal : 0),
  );
  const additional = numberValue(
    row.additionalTotal ??
      (lineType === 'additional_unit' || lineType === 'additional' ? lineTotal : 0),
  );
  const packageCost = numberValue(
    row.packageTotal ?? (lineType === 'package_cost' ? lineTotal : 0),
  );
  const shipping = numberValue(
    row.shippingTotal ?? (lineType === 'shipping' ? lineTotal : 0),
  );
  const storage = numberValue(
    row.storageTotal ?? (lineType === 'storage' ? lineTotal : 0),
  );
  const total = numberValue(row.grandTotal ?? row.total) ||
    pickPack + additional + packageCost + shipping + storage;

  return { pickPack, additional, packageCost, shipping, storage, total };
}

function rowKey(row: BillingDetailReadModelRow): string {
  const orderId = row.orderId;
  if (nonEmpty(orderId)) return `order:${String(orderId)}`;
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
] as const;

const VALUE_CARRY_FIELDS = [
  'shipmentId',
  'packageId',
  'providerAccountId',
  'labelProvider',
  'trackingNumber',
  'totalQty',
  'selectedRateCost',
  'actualLabelCost',
  'refUpsRate',
  'refUspsRate',
  'feeWaiverDecision',
  'billingBadges',
] as const;

const BOOLEAN_OR_FIELDS = [
  'hasPackageCostLine',
  'boxCostNoCharge',
  'boxCostAlert',
  'stalePackagePrice',
  'packageCostNeedsReview',
  'shippingZeroNeedsReview',
  'feeWaived',
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

export function toBillingDetailOrderRows(rows: BillingDetailReadModelRow[]): BillingDetailRowDto[] {
  const byKey = new Map<string, BillingDetailRowDto>();
  const order: string[] = [];

  for (const row of rows) {
    const key = rowKey(row);
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
        storageTotal: metrics.storage,
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
    existing.storageTotal = numberValue(existing.storageTotal) + metrics.storage;
    existing.pickPackFeeTotal = existing.pickpackTotal + existing.additionalTotal;
    existing.fulfillmentFeeTotal =
      existing.pickpackTotal +
      existing.additionalTotal +
      existing.packageTotal +
      existing.shippingTotal +
      existing.storageTotal;
    existing.grandTotal = numberValue(existing.grandTotal) + metrics.total;
    existing.hasPackageCostLine = existing.hasPackageCostLine === true || hasPackageCostLine;
    existing.boxCostNoCharge = existing.boxCostNoCharge === true || boxCostNoCharge;

    for (const field of TEXT_CARRY_FIELDS) carryText(existing, row, field);
    for (const field of VALUE_CARRY_FIELDS) carryValue(existing, row, field);
    for (const field of BOOLEAN_OR_FIELDS) carryBooleanOr(existing, row, field);
    applyBoxCostAlert(existing);
  }

  return order.map((key) => byKey.get(key)!);
}
