// PS-317 (Phase 3) — column RESIZE interaction hook, extracted verbatim from OrdersView. Owns the
// resizing-column state, the resize-only refs (pending widths + the rAF handle), the document
// mousemove/mouseup drag-resize effect, the keyboard resize, and the mouse-down starter. The two
// refs shared with the drag/sort paths (suppressHeaderClickRef so a resize-release doesn't fire the
// header's sort click; resizeStateRef so a header DRAG is ignored mid-resize) stay owned by OrdersView
// and are passed in — useColumnDrag receives the SAME instances. The prefs helpers (read latest /
// build saved / persist) and setColumnPrefs/columnPrefsRef are passed in so the canonical column-prefs
// owner stays in OrdersView; this hook only drives the interaction. handleHeaderKeyDown stays in
// OrdersView (it straddles resize + reorder + sort) and delegates the resize case to resizeColumnByKeyboard.
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import type { TableColumn, TableColumnKey } from '../orders-table-columns';
import { getColumnMinWidth, type ColumnPrefs, type ResolvedColumnPrefs } from '../orders-parity';

type ResizeState = { key: TableColumnKey; startX: number; startWidth: number } | null;

export type UseColumnResizeDeps = {
  getLatestColumnPrefs: () => ResolvedColumnPrefs;
  buildSavedColumnPrefs: (
    columns: Array<{ key: TableColumnKey; label: string; width: number }>,
    hiddenColumns: Set<TableColumnKey>,
    widths: Record<TableColumnKey, number>,
  ) => ColumnPrefs;
  saveColumnPrefsToServer: (nextPrefs: ColumnPrefs) => Promise<void> | void;
  setColumnPrefs: (prefs: ColumnPrefs) => void;
  columnPrefsRef: MutableRefObject<ColumnPrefs | null>;
  currentStatusRef: MutableRefObject<Parameters<typeof getColumnMinWidth>[1]>;
  suppressHeaderClickRef: MutableRefObject<boolean>;
  resizeStateRef: MutableRefObject<ResizeState>;
};

export function useColumnResize({
  getLatestColumnPrefs,
  buildSavedColumnPrefs,
  saveColumnPrefsToServer,
  setColumnPrefs,
  columnPrefsRef,
  currentStatusRef,
  suppressHeaderClickRef,
  resizeStateRef,
}: UseColumnResizeDeps) {
  const [resizingColumnKey, setResizingColumnKey] = useState<TableColumnKey | null>(null);
  const pendingResizeWidthsRef = useRef<Record<TableColumnKey, number> | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const prefs = getLatestColumnPrefs();
      // PS-077: status-aware floor — Shipped/Cancelled "Selected Rate" (key
      // 'bestrate') can shrink below the Awaiting "Best Rate" 175 floor. Read the
      // status from the always-fresh ref (this listener lives in a [] effect).
      const nextWidth = Math.max(getColumnMinWidth(resizeState.key as any, currentStatusRef.current), resizeState.startWidth + (event.clientX - resizeState.startX));
      const nextWidths = {
        ...prefs.widths,
        [resizeState.key]: nextWidth,
      } as Record<string, number>;
      pendingResizeWidthsRef.current = nextWidths;
      if (resizeFrameRef.current == null) {
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          const activeResizeState = resizeStateRef.current;
          const pendingWidths = pendingResizeWidthsRef.current;
          if (!activeResizeState || !pendingWidths) return;

          const latestPrefs = getLatestColumnPrefs();
          const nextPrefs = buildSavedColumnPrefs(latestPrefs.orderedColumns, latestPrefs.hiddenColumns, pendingWidths);
          columnPrefsRef.current = nextPrefs;
          setColumnPrefs(nextPrefs);
        });
      }
    };

    const onMouseUp = () => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const prefs = getLatestColumnPrefs();
      const nextWidths = pendingResizeWidthsRef.current ?? prefs.widths;
      if (resizeFrameRef.current != null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeStateRef.current = null;
      pendingResizeWidthsRef.current = null;
      setResizingColumnKey(null);
      document.body.classList.remove('resizing-active');

      void saveColumnPrefsToServer(buildSavedColumnPrefs(prefs.orderedColumns, prefs.hiddenColumns, nextWidths as any));
      window.setTimeout(() => {
        suppressHeaderClickRef.current = false;
      }, 150);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (resizeFrameRef.current != null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      document.body.classList.remove('resizing-active');
    };
  }, []);

  function resizeColumnByKeyboard(column: TableColumn, delta: number) {
    if (column.key === 'select') return;

    const prefs = getLatestColumnPrefs();
    const currentWidth = (prefs.widths as Record<string, number>)[column.key] ?? column.width;
    const nextWidths = {
      ...prefs.widths,
      [column.key]: Math.max(getColumnMinWidth(column.key as any, currentStatusRef.current), currentWidth + delta),
    };
    void saveColumnPrefsToServer(buildSavedColumnPrefs(prefs.orderedColumns, prefs.hiddenColumns, nextWidths as any));
  }

  function startColumnResize(event: ReactMouseEvent<HTMLDivElement>, column: TableColumn) {
    event.preventDefault();
    event.stopPropagation();

    const prefs = getLatestColumnPrefs();
    resizeStateRef.current = {
      key: column.key,
      startX: event.clientX,
      startWidth: (prefs.widths as Record<string, number>)[column.key] ?? column.width,
    };
    pendingResizeWidthsRef.current = null;
    suppressHeaderClickRef.current = true;
    setResizingColumnKey(column.key);
    document.body.classList.add('resizing-active');
  }

  return { resizingColumnKey, startColumnResize, resizeColumnByKeyboard };
}
