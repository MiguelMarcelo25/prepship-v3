import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Copy, Pencil, Trash2 } from "lucide-react";

/**
 * Per-row actions menu for the Automations rules table, matching the
 * Edit / Copy / Delete menu ShipStation puts behind the "..." control.
 *
 * Purely presentational: every handler is supplied by the caller and resolves
 * against a backend endpoint. Nothing here decides whether an action is
 * permitted -- the backend re-checks scope, permissions, and delete
 * eligibility regardless of what this menu offers.
 */
export function AutomationRowActions({
  ruleName,
  canEdit,
  editDisabledReason,
  disabled,
  onEdit,
  onCopy,
  onDelete,
}: {
  ruleName: string;
  /** Only an open draft can be edited; published versions are immutable. */
  canEdit: boolean;
  editDisabledReason: string;
  disabled: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape so the menu never strands itself open
  // over a table the operator is trying to read.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    globalThis.document.addEventListener("mousedown", onPointerDown);
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.document.removeEventListener("mousedown", onPointerDown);
      globalThis.document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    setOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={`Actions for ${ruleName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!canEdit}
            title={canEdit ? undefined : editDisabledReason}
            onClick={run(onEdit)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-small text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent"
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={run(onCopy)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-small text-ink hover:bg-surface-2"
          >
            <Copy size={14} /> Copy
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={run(onDelete)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-small text-rose-700 hover:bg-rose-50"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default AutomationRowActions;
