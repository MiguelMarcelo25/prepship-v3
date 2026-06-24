// PS-317 (Phase 3) — column drag-to-reorder interaction hook, extracted verbatim from OrdersView.
// Owns the four drag-state vars + the eight header/dropdown drag handlers. The reorder decision
// itself is delegated to the caller's moveColumn (which runs the unit-guarded computeReorderedColumns
// → buildSavedColumnPrefs → save). The two shared refs (suppressHeaderClickRef so a drag doesn't
// fire the header's sort click; resizeStateRef so a drag is ignored mid-resize) stay owned by
// OrdersView and are passed in — they're also used by the resize/click paths that remain there.
import { useState } from 'react';
import type { DragEvent, MutableRefObject } from 'react';
import type { TableColumnKey } from '../orders-table-columns';

type ResizeState = { key: TableColumnKey; startX: number; startWidth: number } | null;

export type UseColumnDragDeps = {
  moveColumn: (sourceKey: TableColumnKey, targetKey: TableColumnKey) => void;
  suppressHeaderClickRef: MutableRefObject<boolean>;
  resizeStateRef: MutableRefObject<ResizeState>;
};

export function useColumnDrag({ moveColumn, suppressHeaderClickRef, resizeStateRef }: UseColumnDragDeps) {
  const [dragColumnKey, setDragColumnKey] = useState<TableColumnKey | null>(null);
  const [dragOverColumnKey, setDragOverColumnKey] = useState<TableColumnKey | null>(null);
  const [dropdownDragColumnKey, setDropdownDragColumnKey] = useState<TableColumnKey | null>(null);
  const [dropdownDragOverColumnKey, setDropdownDragOverColumnKey] = useState<TableColumnKey | null>(null);

  function finishHeaderDrag() {
    setDragColumnKey(null);
    setDragOverColumnKey(null);
    suppressHeaderClickRef.current = true;
    window.setTimeout(() => {
      suppressHeaderClickRef.current = false;
    }, 150);
  }

  function handleHeaderDragStart(event: DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    if (resizeStateRef.current || key === 'select') {
      event.preventDefault();
      return;
    }

    suppressHeaderClickRef.current = true;
    setDragColumnKey(key);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
  }

  function handleHeaderDragOver(event: DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    if (!dragColumnKey || key === dragColumnKey || key === 'select') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverColumnKey(key);
  }

  function handleHeaderDrop(event: DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    const sourceKey = (event.dataTransfer.getData('text/plain') || dragColumnKey) as TableColumnKey;
    if (!sourceKey || sourceKey === key || key === 'select') return;

    event.preventDefault();
    moveColumn(sourceKey, key);
    finishHeaderDrag();
  }

  function handleDropdownDragStart(event: DragEvent<HTMLDivElement>, key: TableColumnKey) {
    setDropdownDragColumnKey(key);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
  }

  function handleDropdownDragOver(event: DragEvent<HTMLDivElement>, key: TableColumnKey) {
    if (!dropdownDragColumnKey || key === dropdownDragColumnKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropdownDragOverColumnKey(key);
  }

  function handleDropdownDrop(event: DragEvent<HTMLDivElement>, key: TableColumnKey) {
    const sourceKey = (event.dataTransfer.getData('text/plain') || dropdownDragColumnKey) as TableColumnKey;
    if (!sourceKey || sourceKey === key) return;

    event.preventDefault();
    moveColumn(sourceKey, key);
    setDropdownDragColumnKey(null);
    setDropdownDragOverColumnKey(null);
  }

  function finishDropdownDrag() {
    setDropdownDragColumnKey(null);
    setDropdownDragOverColumnKey(null);
  }

  return {
    dragColumnKey,
    dragOverColumnKey,
    dropdownDragColumnKey,
    dropdownDragOverColumnKey,
    handleHeaderDragStart,
    handleHeaderDragOver,
    handleHeaderDrop,
    finishHeaderDrag,
    handleDropdownDragStart,
    handleDropdownDragOver,
    handleDropdownDrop,
    finishDropdownDrag,
  };
}
