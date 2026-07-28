/**
 * Reads the in-flight mutation key back into "which button on THIS row is
 * spinning".
 *
 * The panel tracks one busy key at a time (`draft:12`, `copy:12`, ...) because
 * only one mutation may be in flight. The row actions need the inverse view:
 * given that key, is one of my three buttons the reason everything is
 * disabled? Without it a slow request greys out the whole list with no
 * indication of what is happening or where.
 *
 * `draft:` maps to edit -- opening a published rule clones its live version
 * into a draft first, and that clone is the request the operator is waiting on.
 */
export type RowPendingAction = 'edit' | 'copy' | 'delete' | null;

const KEY_TO_ACTION: Record<string, Exclude<RowPendingAction, null>> = {
  draft: 'edit',
  copy: 'copy',
  delete: 'delete',
};

export function rowPendingAction(busy: string | null, ruleId: number): RowPendingAction {
  if (!busy) return null;
  const separator = busy.indexOf(':');
  if (separator < 0) return null;
  if (busy.slice(separator + 1) !== String(ruleId)) return null;
  return KEY_TO_ACTION[busy.slice(0, separator)] ?? null;
}
