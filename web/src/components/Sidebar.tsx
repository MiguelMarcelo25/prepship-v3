import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Package,
  MapPin,
  Boxes,
  DollarSign,
  BarChart3,
  Settings as SettingsIcon,
  Receipt,
  ClipboardList,
  Search,
} from 'lucide-react';
import { api, qs, type Paginated } from '../lib/api';

const statusItems: { status: string; label: string }[] = [
  { status: 'awaiting_shipment', label: 'Awaiting Shipment' },
  { status: 'shipped', label: 'Shipped' },
  { status: 'cancelled', label: 'Cancelled' },
];

const toolItems: { to: string; label: string; icon: typeof Package }[] = [
  { to: '/inventory', label: 'Inventory', icon: Package },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/packages', label: 'Packages', icon: Boxes },
  { to: '/rates', label: 'Rate Shop', icon: DollarSign },
  { to: '/analysis', label: 'Analysis', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/billing', label: 'Billing', icon: Receipt },
  { to: '/manifest', label: 'Manifest', icon: ClipboardList },
];

function useStatusCount(status: string) {
  const { data } = useQuery({
    queryKey: ['orders-count', status],
    queryFn: () =>
      api.get<Paginated<unknown>>(`/orders${qs({ status, pageSize: 1 })}`),
    staleTime: 30_000,
  });
  return data?.pagination.total ?? null;
}

function StatusRow({ status, label }: { status: string; label: string }) {
  const count = useStatusCount(status);
  return (
    <NavLink
      to={`/orders/${status}`}
      className={({ isActive }) =>
        `flex items-center justify-between px-3 py-[7px] text-sm2 font-semibold border-l-[3px] transition-colors ${
          isActive
            ? 'bg-brand-bg text-brand border-brand'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink border-transparent'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span>{label}</span>
          <span
            className={`min-w-[20px] text-center rounded-full px-1.5 py-[1px] text-2xs font-bold ${
              isActive ? 'bg-brand text-white' : 'bg-surface-3 text-ink-2'
            }`}
          >
            {count ?? '—'}
          </span>
        </>
      )}
    </NavLink>
  );
}

function ToolRow({
  to,
  label,
  Icon,
}: {
  to: string;
  label: string;
  Icon: typeof Package;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-[7px] text-sm2 font-semibold border-l-[3px] transition-colors ${
          isActive
            ? 'bg-brand-bg text-brand border-brand'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink border-transparent'
        }`
      }
    >
      <Icon size={14} className="shrink-0" />
      <span>{label}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  return (
    <aside className="w-sidebar shrink-0 bg-white border-r border-line flex flex-col h-full">
      {/* Logo */}
      <div className="px-3.5 py-3 border-b border-line">
        <div className="flex items-baseline text-[16px] font-extrabold tracking-[-0.4px]">
          <span className="text-ink">PREP</span>
          <span className="text-brand">SHIP</span>
        </div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.4px] text-ink-3">
          Dr Prepper Fulfillment
        </div>
      </div>

      {/* Search */}
      <div className="px-2.5 pt-2.5 pb-1.5">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search"
            className="w-full rounded-btn border border-line-2 bg-white pl-7 pr-2.5 py-[7px] text-[12px] text-ink placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none"
          />
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-1.5">
        {statusItems.map((i) => (
          <StatusRow key={i.status} {...i} />
        ))}
        <div className="h-px mx-3 my-2 bg-line" />
        {toolItems.map((i) => (
          <ToolRow key={i.to} to={i.to} label={i.label} Icon={i.icon} />
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 py-2.5 border-t border-line flex items-center gap-2 text-[10.5px] text-ink-3">
        <span className="w-1.5 h-1.5 rounded-full bg-ok" />
        <span>API connected</span>
      </div>
    </aside>
  );
}
