import { Copy, Loader2, Pencil, Trash2 } from "lucide-react";

/**
 * Per-row actions for the Automations rules table: Edit, Copy, Delete.
 *
 * Rendered as three inline icon buttons rather than a "..." dropdown. The
 * table scrolls horizontally (overflow-x-auto), which establishes a clipping
 * context -- an absolutely positioned menu gets cut off at the container edge
 * instead of overlaying the page. Inline buttons sidestep that entirely and
 * keep every action visible without a second click.
 *
 * Purely presentational: every handler is supplied by the caller and resolves
 * against a backend endpoint. Nothing here decides whether an action is
 * permitted -- the backend re-checks scope, permissions, and delete
 * eligibility regardless of what this row offers.
 *
 * Shared by the desktop table row and the mobile card, so a colour or state
 * change here lands in both.
 */

/**
 * Each action carries its colour at rest rather than only on hover, so the
 * destructive one is distinguishable from the safe ones before you touch it --
 * on a phone there is no hover at all, so a hover-only tint meant three
 * identical grey glyphs.
 *
 * `disabled:text-ink-3` deliberately overrides the per-action colour: a
 * greyed-out red trash still reads as "delete, armed" at 35% opacity, which is
 * exactly wrong for a rule that cannot be deleted.
 */
const BUTTON_BASE =
  "inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:text-ink-3 disabled:hover:bg-transparent";

export function AutomationRowActions({
  ruleName,
  canEdit,
  editDisabledReason,
  canDelete,
  deleteDisabledReason,
  disabled,
  pending,
  onEdit,
  onCopy,
  onDelete,
}: {
  ruleName: string;
  /** Only an open draft can be edited; published versions are immutable. */
  canEdit: boolean;
  editDisabledReason: string;
  /** System-locked rules cannot be removed at all. */
  canDelete: boolean;
  deleteDisabledReason: string;
  disabled: boolean;
  /**
   * Which of this row's actions is waiting on the server, if any.
   *
   * A mutation disables every control in the list so two cannot overlap. That
   * is correct but indistinguishable from a frozen page: opening a published
   * rule has to clone it into a draft server-side first, and for that round
   * trip the whole table greyed out with nothing to say why. The spinner marks
   * which button is responsible.
   */
  pending?: "edit" | "copy" | "delete" | null;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const stop = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action();
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        aria-label={`Edit ${ruleName}`}
        title={canEdit ? `Edit ${ruleName}` : editDisabledReason}
        disabled={disabled || !canEdit}
        onClick={stop(onEdit)}
        className={`${BUTTON_BASE} text-brand hover:bg-brand-bg`}
      >
        {pending === "edit" ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
      </button>
      <button
        type="button"
        aria-label={`Copy ${ruleName}`}
        title={`Duplicate ${ruleName} as a new draft`}
        disabled={disabled}
        onClick={stop(onCopy)}
        // Violet, the tone ConfirmModal already uses for duplicate-style
        // actions. Deliberately not another blue -- next to Edit at 15px, two
        // blues are one blur.
        className={`${BUTTON_BASE} text-violet-600 hover:bg-violet-50`}
      >
        {pending === "copy" ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />}
      </button>
      <button
        type="button"
        aria-label={`Delete ${ruleName}`}
        title={canDelete ? `Delete ${ruleName}` : deleteDisabledReason}
        disabled={disabled || !canDelete}
        onClick={stop(onDelete)}
        className={`${BUTTON_BASE} text-rose-600 hover:bg-rose-50`}
      >
        {pending === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
      </button>
    </div>
  );
}

export default AutomationRowActions;
