// PS-301 — the named action policy for an OrdersView row: the four verbs the card
// adds on top of the PS-173 booleans, plus a machine-readable blockedReasons map per
// disabled verb. Pure. canSelectRow/canEditPackage are awaiting-only, which REINFORCES
// the shipped/cancelled lockdown (the backend says shipped/cancelled rows are not
// selectable/editable). No purchase authority change: createLabel/printToQueue stay
// exactly as narrow as the PS-173 base computed them.

import type { BestRateWorkflowAllowedActions, OrderRowWorkflowState } from './best-rate-workflow-dto';
import type {
  OrderRowLifecycleState,
  OrderRowRateState,
  OrderRowLabelState,
  OrderRowActionVerb,
  OrderRowBlockedReasonCode,
  OrderRowBlockedReasons,
  OrderRowNamedActions,
} from './order-row-states';

export function deriveOrderRowNamedActions(
  rowState: OrderRowWorkflowState,
  lifecycle: OrderRowLifecycleState,
  base: BestRateWorkflowAllowedActions,
): OrderRowNamedActions {
  const awaiting = lifecycle === 'awaiting';
  return {
    canApplyBestRate: rowState === 'final',
    canPrintToQueue: base.canQueueLabel === true,
    canEditPackage: awaiting,
    canSelectRow: awaiting,
  };
}

type BlockedReasonContext = {
  lifecycle: OrderRowLifecycleState;
  rateState: OrderRowRateState;
  labelState: OrderRowLabelState;
};

function reasonForDisabledVerb(verb: OrderRowActionVerb, ctx: BlockedReasonContext): OrderRowBlockedReasonCode {
  if (ctx.lifecycle === 'cancelled') return 'cancelled_lock';
  if (ctx.lifecycle === 'external_shipped') return 'external_shipped';
  if (ctx.lifecycle === 'shipped') return 'shipped_lock';
  if (verb === 'createLabel' || verb === 'printToQueue' || verb === 'applyBestRate') {
    if (ctx.rateState === 'missing_dims') return 'missing_dims';
    if (ctx.rateState === 'unavailable') return 'no_rate';
    if (verb === 'printToQueue' && ctx.labelState === 'queued') return 'already_queued';
    if (verb === 'createLabel' && ctx.labelState === 'active_label') return 'existing_active_label';
    if (verb === 'applyBestRate') return 'rate_not_final';
    return 'needs_current_rate';
  }
  if (ctx.rateState === 'missing_dims') return 'missing_dims';
  return 'needs_current_rate';
}

/** Build blockedReasons for every verb that is currently false. */
export function deriveOrderRowBlockedReasons(
  verbs: Record<OrderRowActionVerb, boolean>,
  ctx: BlockedReasonContext,
): OrderRowBlockedReasons {
  const reasons: OrderRowBlockedReasons = {};
  (Object.keys(verbs) as OrderRowActionVerb[]).forEach((verb) => {
    if (verbs[verb] !== true) reasons[verb] = reasonForDisabledVerb(verb, ctx);
  });
  return reasons;
}
