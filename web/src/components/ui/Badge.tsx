import type { ReactNode } from 'react';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  brand: 'bg-brand text-white',
  ok: 'bg-ok-bg text-ok-dark',
  warn: 'bg-warn-bg text-[#92400e]',
  danger: 'bg-danger-bg text-[#991b1b]',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full px-1.5 py-[1px] text-2xs font-bold min-w-[20px] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const statusMap: Record<string, Tone> = {
  awaiting_shipment: 'warn',
  awaiting_payment: 'warn',
  shipped: 'ok',
  on_hold: 'neutral',
  cancelled: 'danger',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = statusMap[status] ?? 'neutral';
  const label = status.replace(/_/g, ' ');
  return (
    <Badge tone={tone} className="uppercase tracking-wide">
      {label}
    </Badge>
  );
}
