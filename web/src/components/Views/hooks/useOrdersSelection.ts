// PS-166/PS-306/PS-258 (Hook wave): the selection STATE container — derived
// selection memos + the canonical `updateSelection` setter wrapper + the two
// selection-only mutation helpers (`toggleOrderSelection`, `selectOrderRange`).
//
// `selectedOrderIds` is a CONTROLLED PROP (owned by the parent, pushed up via
// `onSelectedOrderIdsChange`), so there is no `useState` to move — this hook owns
// the pure derivations over that prop plus the two helpers that touch ONLY
// selection. Behavior-identical move: the two useMemo bodies, the two derived
// booleans, and the three helper bodies are unchanged (same closures, same deps).
//
// Deliberately LEFT in the OrdersView shell (sibling-state / cross-workflow
// entanglement the task says to keep there):
//   - `clearSelection`, `toggleSkuGroupSelection`, `toggleVisibleSelection`
//     (touch `setAllMatchingSelection` / `setSelectedOrderSnapshots`),
//   - `selectAllMatchingOrders`, `hydrateSelectedOrdersForActions`
//     (touch apiClient / matchingSelectionQuery / snapshots / toast),
//   - the three selection↔snapshot/allMatching/activeOrderId bridge effects,
//   - and the `isReadOnly` shipped/cancelled gates (untouched — they READ
//     selection but remain the single source of truth in OrdersView).
import { useMemo } from 'react'

// `params` is typed `any` to match the type-unchecked OrdersView shell these
// closures came from; this is a verbatim move, not a re-typing. Output
// identifiers and their semantics are unchanged.
export function useOrdersSelection(params: any) {
  const {
    selectedOrderIds,
    visibleOrderIds,
    onSelectedOrderIdsChange,
    onActiveOrderIdChange,
  } = params

  const selectedIdSet = useMemo(() => new Set<number>(selectedOrderIds), [selectedOrderIds])

  const visibleSelectedCount = useMemo(
    () => visibleOrderIds.filter((orderId: number) => selectedIdSet.has(orderId)).length,
    [visibleOrderIds, selectedIdSet],
  )
  const allVisibleSelected = visibleOrderIds.length > 0 && visibleSelectedCount === visibleOrderIds.length
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected

  const updateSelection = (ids: number[]) => {
    const nextIds = [...new Set(ids)]
    onSelectedOrderIdsChange?.(nextIds)
    onActiveOrderIdChange?.((nextIds.length === 1 ? nextIds[0] : null) as number | null)
  }

  const toggleOrderSelection = (orderId: number, checked?: boolean) => {
    const isChecked = selectedIdSet.has(orderId)
    const shouldSelect = checked ?? !isChecked
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, orderId])
      return
    }

    updateSelection(selectedOrderIds.filter((id: number) => id !== orderId))
  }

  const selectOrderRange = (anchorOrderId: number, targetOrderId: number) => {
    const anchorIndex = visibleOrderIds.indexOf(anchorOrderId)
    const targetIndex = visibleOrderIds.indexOf(targetOrderId)
    if (anchorIndex < 0 || targetIndex < 0) {
      toggleOrderSelection(targetOrderId, true)
      return
    }
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    const rangeIds = visibleOrderIds.slice(start, end + 1)
    updateSelection([...selectedOrderIds, ...rangeIds])
  }

  return {
    selectedIdSet,
    visibleSelectedCount,
    allVisibleSelected,
    someVisibleSelected,
    updateSelection,
    toggleOrderSelection,
    selectOrderRange,
  }
}
