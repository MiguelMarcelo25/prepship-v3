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

// Stable per-name color palette for client pills (matches the old PrepShip
// look of multi-colored client badges in the orders table).
const clientPalette: { bg: string; text: string }[] = [
  { bg: 'bg-[#eef2ff]', text: 'text-[#3730a3]' },
  { bg: 'bg-[#fff4e6]', text: 'text-[#c05212]' },
  { bg: 'bg-[#dcfce7]', text: 'text-[#166534]' },
  { bg: 'bg-[#fee2e2]', text: 'text-[#991b1b]' },
  { bg: 'bg-[#f3e8ff]', text: 'text-[#6b21a8]' },
  { bg: 'bg-[#ffe4e6]', text: 'text-[#9f1239]' },
  { bg: 'bg-[#cffafe]', text: 'text-[#155e75]' },
  { bg: 'bg-[#fef3c7]', text: 'text-[#854d0e]' },
  { bg: 'bg-[#e0e7ff]', text: 'text-[#3730a3]' },
  { bg: 'bg-[#ccfbf1]', text: 'text-[#115e59]' },
];

function hashName(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function ClientBadge({ name }: { name: string }) {
  const c = clientPalette[hashName(name) % clientPalette.length]!;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-tiny font-bold ${c.bg} ${c.text} whitespace-nowrap`}
      title={name}
    >
      {name}
    </span>
  );
}
