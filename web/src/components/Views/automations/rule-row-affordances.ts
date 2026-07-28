/**
 * What a rule row lets an operator do, and why not when it doesn't.
 *
 * The rules list renders as a table on wide screens and as cards on narrow
 * ones. Those are two different JSX trees for the same row, so every
 * enable/disable decision lives here instead of being written twice -- a card
 * that offered Delete on a rule the table greyed out would be a real bug, not
 * a cosmetic one.
 *
 * Display only. The backend re-checks all of this; see deleteAutomationRule
 * and openAutomationDraft. Nothing here grants permission, it only avoids
 * offering buttons that are guaranteed to fail.
 */

export interface RuleAffordanceInput {
  status: 'draft' | 'active' | 'paused' | 'archived'
  systemLocked: boolean
  hasExecutionHistory: boolean
  name: string
}

export interface RuleAffordances {
  canEdit: boolean
  editDisabledReason: string
  canDelete: boolean
  deleteDisabledReason: string
  /** The active switch is meaningless for draft and archived rules. */
  canToggleActive: boolean
  toggleTitle: string
  isActive: boolean
}

export function ruleAffordances(rule: RuleAffordanceInput): RuleAffordances {
  const { status, systemLocked, hasExecutionHistory, name } = rule

  return {
    canEdit: !systemLocked && status !== 'archived',
    editDisabledReason: systemLocked
      ? 'System-locked rules cannot be edited'
      : 'Archived rules cannot be edited. Copy this rule to revive it.',

    // Publication does not block deletion -- execution does. A rule published
    // during testing that never matched an order has no audit trail to keep.
    canDelete: !systemLocked && !hasExecutionHistory,
    deleteDisabledReason: systemLocked
      ? 'System-locked rules cannot be deleted'
      : 'This rule has already run on orders. Archive it instead — that hides it while keeping the record of what it did.',

    canToggleActive: !systemLocked && status !== 'draft' && status !== 'archived',
    toggleTitle: status === 'draft'
      ? 'Publish this draft to activate it'
      : status === 'archived'
        ? 'Archived rules cannot be reactivated'
        : status === 'paused'
          ? `Resume ${name}`
          : `Pause ${name}`,
    isActive: status === 'active',
  }
}
