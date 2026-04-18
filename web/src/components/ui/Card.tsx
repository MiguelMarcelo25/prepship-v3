import type { ReactNode } from 'react';

export function Card({
  title,
  actions,
  children,
  className = '',
  bodyClassName = 'p-3.5',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={`bg-white rounded-card border border-line shadow-sm overflow-hidden ${className}`}
    >
      {title && (
        <div className="px-3.5 py-2.5 border-b border-line flex items-center gap-2">
          <div className="flex-1 text-[12px] font-bold uppercase tracking-[0.4px] text-ink-2">
            {title}
          </div>
          {actions}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

export function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.4px] text-ink-3 mb-0.5">
        {label}
      </div>
      <div className={`text-sm2 text-ink ${mono ? 'font-mono' : ''}`}>
        {value ?? <span className="text-ink-3">—</span>}
      </div>
    </div>
  );
}
