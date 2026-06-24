// PS-317 (Phase 3) — PURE column drag-to-reorder logic, extracted from OrdersView's
// buildMovedColumnPrefs. Given the current ordered columns + a drag source/target key, returns the
// reordered column array (source removed, reinserted at the target's slot), or null when the move
// is invalid: missing/equal keys, or the immovable 'select' (checkbox) column. No React, no state —
// this is the part the e2e column tests can't exercise (synthetic HTML5 drag races Playwright), so
// it carries a focused unit guard instead.

/** The immovable leading checkbox column — never a valid drag source or target. */
export const IMMOVABLE_COLUMN_KEY = 'select' as const;

export function computeReorderedColumns<C extends { key: string }>(
  orderedColumns: readonly C[],
  sourceKey: string | null | undefined,
  targetKey: string | null | undefined,
): C[] | null {
  if (
    !sourceKey ||
    !targetKey ||
    sourceKey === targetKey ||
    sourceKey === IMMOVABLE_COLUMN_KEY ||
    targetKey === IMMOVABLE_COLUMN_KEY
  ) {
    return null;
  }
  const next = [...orderedColumns];
  const sourceIndex = next.findIndex((column) => column.key === sourceKey);
  const targetIndex = next.findIndex((column) => column.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return null;
  next.splice(targetIndex, 0, moved);
  return next;
}
