// Canonical owner of ORDER FINANCIAL REDACTION for non-financial / client_user (portal)
// sessions. Extracted from src/routes/orders.ts so it is PURE (zero imports) and can be
// proven behaviorally by an offline guard — not just grepped. The route still owns WHO can
// view financials (canViewOrderFinancials → hasAppPermission); this module owns WHAT gets
// scrubbed once the answer is "no".

// Money-bearing field names nulled anywhere they appear (recursively). houseMargin is the
// SHIPP house-account margin (PS-220) — INTERNAL, must never reach a client.
export const RATE_MONEY_FIELD_KEYS = new Set([
  'amount',
  'customerRateAmount',
  'rateCostAmount',
  'houseRateAmount',
  'shippingMarginAmount',
  'shippingMarginPct',
  'houseApplied',
  'houseBadgeVisible',
  'customerRateSource',
  'rateCostSource',
  'cost',
  'shipmentCost',
  'otherCost',
  'labelCost',
  'rawCost',
  'rateCost',
  'totalCost',
  'shippingCost',
  'shippingTotal',
  'standardShippingCost',
  'standardShippingTotal',
  'houseMargin', // PS-220: the SHIPP house-account margin is INTERNAL — never to non-financial / client viewers
]);

/** Recursively null every RATE_MONEY_FIELD_KEYS value (objects + arrays); leave everything else. */
export function redactRateMoneyFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactRateMoneyFields(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = RATE_MONEY_FIELD_KEYS.has(key) ? null : redactRateMoneyFields(nested);
  }
  return out as T;
}

/**
 * Redact an order row/payload for a viewer who CANNOT see financials. Returns the row
 * unchanged for financial viewers (operators/admins). For everyone else:
 *  - money fields scrubbed (recursively) on label / selectedRate / bestRate / shipping /
 *    canonicalOrder AND on `overrides` — overrides.bestRateJson carries the PS-220 projected
 *    stamp (houseMargin + nextBestNonHouseRate), which MUST NOT leak to a client (the list +
 *    both detail routes return it). totalCost/houseMargin inside it get nulled here.
 *  - bestRateWorkflow.money + .marketplace nulled outright (defense-in-depth): the tuple
 *    carries base = SHIPP drp_cost, markupAmount = the house margin, and markupSource, whose
 *    field names are NOT in RATE_MONEY_FIELD_KEYS, so the recursive scrub can't reach them and
 *    the build-time canViewFinancials gate must not be the only protection.
 * Clients get their shipping cost from billing (the billed customer_rate), never from here.
 */
export function redactOrderFinancials<T extends Record<string, unknown>>(row: T, canViewFinancials: boolean): T {
  if (canViewFinancials) return row;
  const workflow = row.bestRateWorkflow && typeof row.bestRateWorkflow === 'object' && !Array.isArray(row.bestRateWorkflow)
    ? { ...(row.bestRateWorkflow as Record<string, unknown>), money: null, marketplace: null }
    : row.bestRateWorkflow;
  return {
    ...row,
    label: redactRateMoneyFields(row.label),
    selectedRate: redactRateMoneyFields(row.selectedRate),
    bestRate: redactRateMoneyFields(row.bestRate),
    shipping: redactRateMoneyFields(row.shipping),
    canonicalOrder: redactRateMoneyFields(row.canonicalOrder),
    overrides: redactRateMoneyFields(row.overrides),
    bestRateWorkflow: workflow,
    shippingWorkflowState: redactRateMoneyFields(row.shippingWorkflowState),
  };
}
