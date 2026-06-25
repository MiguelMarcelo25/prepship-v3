// PS-317: the column-visibility dropdown's UI state, pulled out of OrdersView. Owns open/close, the
// outside-click close, and anchoring the menu under the topbar Columns button. The topbar toggles it
// by bumping columnMenuRequestId. Pure UI — no column data lives here.
import { useEffect, useRef, useState } from 'react';

export function useColumnMenu(columnMenuRequestId: number) {
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columnMenuPos, setColumnMenuPos] = useState<{ top: number; right: number } | null>(null);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);

  // Toggle when the topbar Columns button fires a request.
  useEffect(() => {
    if (columnMenuRequestId === 0) return;
    setColumnMenuOpen((open) => !open);
  }, [columnMenuRequestId]);

  // Close on an outside click (but not on the menu itself or its topbar anchor).
  useEffect(() => {
    if (!columnMenuOpen) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.react-column-menu')) return;
      if (target?.closest('[data-columns-anchor]')) return;
      setColumnMenuOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [columnMenuOpen]);

  // Anchor the menu under the topbar Columns button; re-measure on resize/scroll.
  useEffect(() => {
    if (!columnMenuOpen) {
      setColumnMenuPos(null);
      return;
    }
    const measure = () => {
      const anchor = document.querySelector<HTMLElement>('[data-columns-anchor]');
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setColumnMenuPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [columnMenuOpen]);

  return { columnMenuOpen, setColumnMenuOpen, columnMenuPos, columnMenuRef };
}
