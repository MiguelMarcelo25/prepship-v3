export const TABLE_VIRTUALIZATION_THRESHOLD = 40
export const TABLE_VIRTUALIZATION_OVERSCAN = 8

export function shouldVirtualizeTable(rowCount: number): boolean {
  return rowCount > TABLE_VIRTUALIZATION_THRESHOLD
}

export function getVirtualTablePadding(
  items: ReadonlyArray<{ start: number; end: number }>,
  totalSize: number,
): { paddingTop: number; paddingBottom: number } {
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return { paddingTop: 0, paddingBottom: 0 }
  return {
    paddingTop: Math.max(0, first.start),
    paddingBottom: Math.max(0, totalSize - last.end),
  }
}
