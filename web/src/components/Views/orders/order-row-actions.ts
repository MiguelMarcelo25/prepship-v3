// PS-301 (FE consumption, slice 1): the frontend READER for the backend-owned row-workflow
// contract stamped on `order.bestRateWorkflow` by withOrderRowWorkflow — the SOURCE OF TRUTH for
// whether a row may be acted on. This lets OrdersView CONSUME the backend verdict (the named action
// verbs, the 5 state axes, and the per-verb blockedReasons) instead of re-deriving row gating in
// the frontend.
//
// PURE + read-only: this owns NO policy. When the backend has not enriched a row (legacy / pre-
// deploy cache edge), every verb reads `null` so the caller FALLS BACK to its existing FE behavior
// and NEVER fabricates — nor revokes — an action the backend did not explicitly speak to. The
// shipped/cancelled lock is REINFORCED, not weakened: canEditPackage / canSelectRow are awaiting-
// only on the backend, so a shipped/cancelled row reports them not-granted.
//
// Self-contained (no React / no heavy imports) so it is unit-testable under node.

export type OrderRowActionVerb =
  | 'browseRates'
  | 'recalculate'
  | 'applyBestRate'
  | 'createLabel'
  | 'printToQueue'
  | 'markExternalShipped'
  | 'editPackage'
  | 'selectRow'

export type OrderRowBlockedReasonCode =
  | 'missing_dims'
  | 'rate_not_final'
  | 'needs_current_rate'
  | 'no_rate'
  | 'existing_active_label'
  | 'already_queued'
  | 'shipped_lock'
  | 'cancelled_lock'
  | 'external_shipped'

// `null` = the backend did not enrich this row → the caller keeps its existing FE behavior.
export type OrderRowAllowedActions = {
  canApplyBestRate: boolean | null
  canPrintToQueue: boolean | null
  canEditPackage: boolean | null
  canSelectRow: boolean | null
  canBrowseRates: boolean | null
  canRecalculate: boolean | null
  canQueueLabel: boolean | null
  canMarkExternalShipped: boolean | null
}

export type OrderRowStateAxes = {
  lifecycleState: string | null
  rateState: string | null
  labelState: string | null
  queueState: string | null
  packageState: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

// Mirror the established precedence (orders-row-display getRowWorkflow): a nested shipping-model
// workflow wins over the top-level one; both are tolerated because the row DTO carries it at the
// top level while some wrapped shapes nest it.
function readWorkflow(order: unknown): Record<string, unknown> | null {
  const rec = asRecord(order)
  if (!rec) return null
  return asRecord(rec.bestRateWorkflow) ?? asRecord(asRecord(rec.shippingModel)?.bestRateWorkflow)
}

export function getOrderRowAllowedActions(order: unknown): OrderRowAllowedActions {
  const actions = asRecord(readWorkflow(order)?.allowedActions)
  return {
    canApplyBestRate: asBoolOrNull(actions?.canApplyBestRate),
    canPrintToQueue: asBoolOrNull(actions?.canPrintToQueue),
    canEditPackage: asBoolOrNull(actions?.canEditPackage),
    canSelectRow: asBoolOrNull(actions?.canSelectRow),
    canBrowseRates: asBoolOrNull(actions?.canBrowseRates),
    canRecalculate: asBoolOrNull(actions?.canRecalculate),
    canQueueLabel: asBoolOrNull(actions?.canQueueLabel),
    canMarkExternalShipped: asBoolOrNull(actions?.canMarkExternalShipped),
  }
}

export function getOrderRowStateAxes(order: unknown): OrderRowStateAxes {
  const wf = readWorkflow(order)
  return {
    lifecycleState: asString(wf?.lifecycleState),
    rateState: asString(wf?.rateState),
    labelState: asString(wf?.labelState),
    queueState: asString(wf?.queueState),
    packageState: asString(wf?.packageState),
  }
}

export function getOrderRowBlockedReasons(
  order: unknown,
): Partial<Record<OrderRowActionVerb, OrderRowBlockedReasonCode>> {
  const raw = asRecord(readWorkflow(order)?.blockedReasons)
  if (!raw) return {}
  const out: Partial<Record<OrderRowActionVerb, OrderRowBlockedReasonCode>> = {}
  for (const [verb, code] of Object.entries(raw)) {
    const value = asString(code)
    if (value) out[verb as OrderRowActionVerb] = value as OrderRowBlockedReasonCode
  }
  return out
}

// Human-readable explanation for a backend reason code — for the slice-2 "why is this blocked?"
// affordance. Display-only; the backend still OWNS the verdict.
const BLOCKED_REASON_LABEL: Record<OrderRowBlockedReasonCode, string> = {
  missing_dims: 'Add dimensions to rate this order',
  rate_not_final: 'The best rate is still being calculated',
  needs_current_rate: 'Re-rate needed — the saved rate no longer matches the current request',
  no_rate: 'No rate is available for this order',
  existing_active_label: 'This order already has an active label',
  already_queued: 'This label is already in the print queue',
  shipped_lock: 'This order has shipped and is locked',
  cancelled_lock: 'This order is cancelled and is locked',
  external_shipped: 'This order was shipped outside the system',
}

export function getOrderRowActionBlockedReason(order: unknown, verb: OrderRowActionVerb): string | null {
  const code = getOrderRowBlockedReasons(order)[verb]
  return code ? BLOCKED_REASON_LABEL[code] : null
}
