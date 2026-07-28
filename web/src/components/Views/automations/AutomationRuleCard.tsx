import { ChevronDown, ChevronUp, Lock } from "lucide-react";
import { AutomationRowActions } from "./AutomationRowActions";
import { ruleAffordances, type RuleAffordanceInput } from "./rule-row-affordances";

/**
 * One automation rule as a card, for narrow screens.
 *
 * The rules table needs eight columns to be readable and carries
 * min-w-[760px], so on a phone it became a horizontally scrolling strip where
 * the row actions sat off-screen -- the operator had to scroll sideways to
 * find Edit or Delete. At phone width the same rows render as cards instead,
 * which is the same trade every dense table in this app has to make.
 *
 * Deliberately not a second source of truth: every enable/disable decision
 * comes from ruleAffordances, shared with the table, and every handler is the
 * caller's. The only thing that differs between the two is layout.
 */
export function AutomationRuleCard({
  rule,
  position,
  statusClassName,
  triggerLabel,
  scopeLabel,
  selected,
  busy,
  isFirst,
  isLast,
  onSelect,
  onEdit,
  onCopy,
  onDelete,
  onToggleActive,
  onMove,
}: {
  rule: RuleAffordanceInput & {
    id: number;
    description: string | null;
    updatedAt: string;
  };
  /** 1-based evaluation position, matching the table's Order column. */
  position: number;
  statusClassName: string;
  triggerLabel: string;
  scopeLabel: string;
  selected: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const can = ruleAffordances(rule);

  return (
    /* A plain container, deliberately not role="button". The card holds Edit,
       Copy, Delete and the active switch, and nesting those inside a button
       role is invalid ARIA -- it also folds every child's label into the
       card's own accessible name, so "Edit <rule>" resolves to both the card
       and the button. Selection is its own control on the title instead. */
    <div
      data-testid="automation-rule-card"
      className={`rounded-xl bg-surface p-3 ring-1 transition-colors ${
        selected ? "ring-brand/50 bg-brand-bg/40" : "ring-line hover:bg-surface-2"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono text-tiny font-bold text-ink">
          {position}
        </span>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="min-w-0 flex-1 cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <div className="truncate font-bold text-ink">{rule.name}</div>
          <div className="mt-0.5 truncate text-tiny text-ink-3">
            {rule.description || "No description"}
          </div>
        </button>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${statusClassName}`}
        >
          {rule.systemLocked ? <Lock size={10} className="mr-1" /> : null}
          {rule.status}
        </span>
      </div>

      {/* Scope, trigger and last-modified are the table's middle columns. They
          are reference detail rather than things you act on, so they collapse
          to one wrapping line instead of three labelled rows. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny text-ink-2">
        <span>{scopeLabel}</span>
        <span aria-hidden className="text-ink-3">·</span>
        <span>{triggerLabel}</span>
        <span aria-hidden className="text-ink-3">·</span>
        <span className="text-ink-3">
          {new Date(rule.updatedAt).toLocaleDateString()}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={can.isActive}
            aria-label={`${can.isActive ? "Pause" : "Activate"} ${rule.name}`}
            title={can.toggleTitle}
            disabled={!can.canToggleActive || busy}
            onClick={() => onToggleActive()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
              can.isActive ? "bg-brand" : "bg-surface-3 ring-1 ring-line"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                can.isActive ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
          {/* Reorder arrows sit side by side here rather than stacked: a 14px
              stacked pair is under the comfortable touch target on a phone. */}
          <button
            type="button"
            aria-label={`Move ${rule.name} earlier`}
            disabled={isFirst || rule.systemLocked || busy}
            onClick={() => onMove("up")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30"
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            aria-label={`Move ${rule.name} later`}
            disabled={isLast || rule.systemLocked || busy}
            onClick={() => onMove("down")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30"
          >
            <ChevronDown size={16} />
          </button>
        </div>
        <AutomationRowActions
          ruleName={rule.name}
          canEdit={can.canEdit}
          editDisabledReason={can.editDisabledReason}
          canDelete={can.canDelete}
          deleteDisabledReason={can.deleteDisabledReason}
          disabled={busy}
          onEdit={onEdit}
          onCopy={onCopy}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

export default AutomationRuleCard;
