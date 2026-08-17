/**
 * PS-502 decision 7 — who may make a replacement billable, and until when.
 *
 * PURE AND UNLOCKED. A policy predicate over facts the caller already holds: no database, no
 * billing write, no shipment read. The writers that act on this verdict are locked.
 *
 * FROZEN CONTRACT (DJ, pinned comment — supersedes the card description):
 *
 *   - liability_owner = 'operator' (our fault) FORCES billable = false.
 *   - liability_owner = 'client'   -> billable may be selected.
 *   - Operators create replacements but cannot set or change `billable`.
 *     `replacements:billing` is NOT in the default operator role.
 *   - Changing billability requires `replacements:billing` + `financials:write`
 *     + a written reason + an activity event.
 *   - Editable through `approved`; FROZEN at `label_created`. After finalization it is never
 *     rewritten — differences become adjustments via
 *     reconcileFinalizedBillingReplacementAdjustment.
 *
 * WHY 'operator' IS A HARD FLOOR AND NOT A DEFAULT
 *
 * "Our fault, so we pay" is the whole point of recording liability. If a permission could
 * override it, the column would document an intention rather than enforce one, and a client
 * could be charged for a mistake the warehouse already admitted to. Permission governs the
 * `client` case only.
 *
 * WHY IT FREEZES AT `label_created` RATHER THAN AT `shipped`
 *
 * `label_created` is the first point where money has been irreversibly committed — postage is
 * bought there, not at ship. Allowing the charge basis to move after that would let the
 * billed story diverge from the purchase that actually happened.
 */

import type { ReplacementStatus } from './replacement-state-machine';

export type ReplacementLiabilityOwner = 'operator' | 'client';

/** Statuses in which billability is still editable. Everything later is frozen. */
export const BILLABILITY_EDITABLE_STATUSES: readonly ReplacementStatus[] = [
  'requested',
  'review',
  'approved',
];

export const REPLACEMENT_BILLING_PERMISSION = 'replacements:billing';
export const FINANCIALS_WRITE_PERMISSION = 'financials:write';

export type BillabilityActor = {
  /** Every permission the actor holds. The caller resolves the role; this only reads it. */
  permissions: readonly string[];
};

export type BillabilityChange = {
  liabilityOwner: ReplacementLiabilityOwner;
  status: ReplacementStatus;
  /** What the caller is asking to set. */
  requestedBillable: boolean;
  actor: BillabilityActor;
  reason?: string | null;
  /** True once the owning invoice is finalized. */
  finalized?: boolean;
};

export type BillabilityVerdict =
  | { allowed: true; billable: boolean }
  | { allowed: false; code: BillabilityRefusalCode; detail: string };

export type BillabilityRefusalCode =
  | 'REPLACEMENT_BILLABLE_FORBIDDEN_FOR_OPERATOR_LIABILITY'
  | 'REPLACEMENT_BILLABLE_FROZEN'
  | 'REPLACEMENT_BILLABLE_FINALIZED'
  | 'REPLACEMENT_BILLABLE_FORBIDDEN'
  | 'REPLACEMENT_BILLABLE_REASON_REQUIRED';

function hasPermission(actor: BillabilityActor, permission: string): boolean {
  return Array.isArray(actor?.permissions) && actor.permissions.includes(permission);
}

/**
 * The billability a replacement must carry given its liability owner alone, or null when the
 * owner does not dictate it.
 *
 * Separate from the permission check so the forced case is legible on its own: an
 * operator-liable replacement is non-billable regardless of who is asking.
 */
export function forcedBillability(owner: ReplacementLiabilityOwner): boolean | null {
  return owner === 'operator' ? false : null;
}

/**
 * May this actor set billability to this value, on a replacement in this state?
 *
 * Order matters and is deliberate. The liability floor is checked BEFORE permission, so the
 * refusal an operator-liable replacement produces names the real reason rather than telling a
 * finance user they lack a permission that would not have helped.
 */
export function evaluateBillabilityChange(change: BillabilityChange): BillabilityVerdict {
  const forced = forcedBillability(change.liabilityOwner);

  if (forced !== null && change.requestedBillable !== forced) {
    return {
      allowed: false,
      code: 'REPLACEMENT_BILLABLE_FORBIDDEN_FOR_OPERATOR_LIABILITY',
      detail:
        'liability_owner=operator forces billable=false. Reassign liability to the client ' +
        'before billing this replacement, rather than overriding the charge.',
    };
  }

  // Setting it to the value it is already forced to is a no-op, not a privileged action.
  if (forced !== null && change.requestedBillable === forced) {
    return { allowed: true, billable: forced };
  }

  if (change.finalized === true) {
    return {
      allowed: false,
      code: 'REPLACEMENT_BILLABLE_FINALIZED',
      detail:
        'the owning invoice is finalized. Billability is never rewritten after finalization — ' +
        'the difference becomes an append-only adjustment via ' +
        'reconcileFinalizedBillingReplacementAdjustment.',
    };
  }

  if (!BILLABILITY_EDITABLE_STATUSES.includes(change.status)) {
    return {
      allowed: false,
      code: 'REPLACEMENT_BILLABLE_FROZEN',
      detail:
        `billability is editable through approved and frozen from label_created onward; ` +
        `this replacement is ${change.status}. Postage is committed at label_created, so the ` +
        `charge basis cannot move after it.`,
    };
  }

  if (
    !hasPermission(change.actor, REPLACEMENT_BILLING_PERMISSION)
    || !hasPermission(change.actor, FINANCIALS_WRITE_PERMISSION)
  ) {
    return {
      allowed: false,
      code: 'REPLACEMENT_BILLABLE_FORBIDDEN',
      detail:
        `setting billability requires both ${REPLACEMENT_BILLING_PERMISSION} and ` +
        `${FINANCIALS_WRITE_PERMISSION}. Operators create replacements but do not decide who pays.`,
    };
  }

  if (typeof change.reason !== 'string' || change.reason.trim() === '') {
    return {
      allowed: false,
      code: 'REPLACEMENT_BILLABLE_REASON_REQUIRED',
      detail: 'a written reason is required and is recorded as an activity event.',
    };
  }

  return { allowed: true, billable: change.requestedBillable };
}
