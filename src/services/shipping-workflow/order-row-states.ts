// PS-301 — the named state-axis contract for an OrdersView row. These are the
// distinct, display-safe axes the card requires the backend DTO to carry so the
// frontend stops reconstructing workflow/shippability decisions. Pure type module
// (no imports) so both the DTO owner and the per-axis derivers can share it without
// a runtime cycle. Additive: every axis is emitted only via withOrderRowWorkflow.

export type OrderRowLifecycleState =
  | 'awaiting'
  | 'shipped'
  | 'cancelled'
  | 'external_shipped'
  | 'blocked'
  | 'unknown';

export type OrderRowRateState =
  | 'missing_dims'
  | 'pending'
  | 'final'
  | 'stale'
  | 'expired'
  | 'blocked'
  | 'unavailable';

export type OrderRowLabelState =
  | 'none'
  | 'active_label'
  | 'queued'
  | 'printed'
  | 'duplicate_risk'
  | 'missing_label_url';

export type OrderRowQueueState =
  | 'can_queue'
  | 'blocked'
  | 'already_queued'
  | 'recovery_available'
  | 'needs_current_rate';

export type OrderRowPackageState =
  | 'resolved'
  | 'needs_dims'
  | 'stale_rate_impact'
  | 'source';

// The card's eight named action verbs (superset of the PS-173 booleans).
export type OrderRowActionVerb =
  | 'browseRates'
  | 'recalculate'
  | 'applyBestRate'
  | 'createLabel'
  | 'printToQueue'
  | 'markExternalShipped'
  | 'editPackage'
  | 'selectRow';

// Machine-readable reason a verb is disabled — keyed per verb in blockedReasons.
export type OrderRowBlockedReasonCode =
  | 'missing_dims'
  | 'rate_not_final'
  | 'needs_current_rate'
  | 'no_rate'
  | 'existing_active_label'
  | 'already_queued'
  | 'shipped_lock'
  | 'cancelled_lock'
  | 'external_shipped';

export type OrderRowBlockedReasons = Partial<Record<OrderRowActionVerb, OrderRowBlockedReasonCode>>;

// The named verbs the card adds on top of the PS-173 booleans (all optional/additive
// on BestRateWorkflowAllowedActions so legacy callers' output is byte-identical).
export type OrderRowNamedActions = {
  canApplyBestRate: boolean;
  canPrintToQueue: boolean;
  canEditPackage: boolean;
  canSelectRow: boolean;
};
