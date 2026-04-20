import { useEffect, useRef } from 'react';

export type ColumnDef = { id: string; label: string };

export default function ColumnsPopover({
  columns,
  visible,
  onToggle,
  onClose,
}: {
  columns: ColumnDef[];
  visible: Set<string>;
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', click);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', click);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-white border border-line rounded-card shadow-lg py-1.5"
    >
      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.6px] text-ink-3 border-b border-line mb-1">
        Toggle columns
      </div>
      {columns.map((col) => (
        <label
          key={col.id}
          className="flex items-center gap-2 px-3 py-1 text-sm2 text-ink-2 hover:bg-surface-2 cursor-pointer select-none"
        >
          <input
            type="checkbox"
            checked={visible.has(col.id)}
            onChange={() => onToggle(col.id)}
            className="accent-brand"
          />
          <span>{col.label}</span>
        </label>
      ))}
    </div>
  );
}
