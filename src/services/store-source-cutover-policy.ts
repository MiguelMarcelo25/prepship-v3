export function normalizeShipStationStoreIds(values: unknown[]): number[] {
  const out = new Set<number>();
  for (const value of values) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) out.add(Math.trunc(n));
  }
  return [...out].sort((a, b) => a - b);
}

export function filterShipStationStoreIdsForCutover(
  storeIds: readonly number[],
  activeCutoverStoreIds: ReadonlySet<number>,
): number[] {
  return storeIds
    .map((id) => Math.trunc(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0 && !activeCutoverStoreIds.has(id));
}

export function defaultCutoverSyncAnchorAt(now = new Date()): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}
