import { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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
  LogOut,
  Users,
} from 'lucide-react';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import SyncOrdersButton from './SyncOrdersButton';

const statusItems: { status: string; label: string }[] = [
  { status: 'awaiting_shipment', label: 'Awaiting Shipment' },
  { status: 'shipped', label: 'Shipped' },
  { status: 'cancelled', label: 'Cancelled' },
];

const toolItems: { to: string; label: string; icon: typeof Package }[] = [
  { to: '/inventory', label: 'Inventory', icon: Package },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/packages', label: 'Packages', icon: Boxes },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/rates', label: 'Rate Shop', icon: DollarSign },
  { to: '/analysis', label: 'Analysis', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/billing', label: 'Billing', icon: Receipt },
  { to: '/manifest', label: 'Manifest', icon: ClipboardList },
];

type Client = { id: number; name: string };
type ClientStats = {
  clientId: number;
  awaiting: number;
  shipped: number;
  cancelled: number;
};

function useStatusTotal(status: string) {
  const { data } = useQuery({
    queryKey: ['orders-count', status],
    queryFn: () =>
      api.get<Paginated<unknown>>(`/orders${qs({ status, pageSize: 1 })}`),
    staleTime: 30_000,
  });
  return data?.pagination.total ?? null;
}

function StatusRow({ status, label }: { status: string; label: string }) {
  const total = useStatusTotal(status);
  const location = useLocation();

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
    staleTime: 60_000,
  });
  const stats = useQuery({
    queryKey: ['clients-order-stats'],
    queryFn: () => api.get<{ data: ClientStats[] }>('/clients/order-stats'),
    staleTime: 30_000,
  });

  const perClient = useMemo(() => {
    const byId = new Map((clients.data ?? []).map((c) => [c.id, c]));
    return (stats.data?.data ?? [])
      .map((s) => {
        const count =
          status === 'awaiting_shipment'
            ? s.awaiting
            : status === 'shipped'
              ? s.shipped
              : status === 'cancelled'
                ? s.cancelled
                : 0;
        const client = byId.get(s.clientId);
        return count > 0 && client
          ? { clientId: s.clientId, name: client.name, count }
          : null;
      })
      .filter((x): x is { clientId: number; name: string; count: number } => !!x)
      .sort((a, b) => b.count - a.count);
  }, [clients.data, stats.data, status]);

  return (
    <div>
      <NavLink
        to={`/orders/${status}`}
        end={false}
        className={({ isActive: a }) =>
          `flex items-center justify-between px-3 py-[7px] text-sm2 font-semibold border-l-[3px] transition-colors ${
            a
              ? 'bg-brand-bg text-brand border-brand'
              : 'text-ink-2 hover:bg-surface-2 hover:text-ink border-transparent'
          }`
        }
      >
        {({ isActive: a }) => (
          <>
            <span>{label}</span>
            <span
              className={`min-w-[20px] text-center rounded-full px-1.5 py-[1px] text-2xs font-bold ${
                a ? 'bg-brand text-white' : 'bg-surface-3 text-ink-2'
              }`}
            >
              {total ?? '—'}
            </span>
          </>
        )}
      </NavLink>

      {perClient.length > 0 && (
        <div className="pb-1">
          {perClient.map((row) => {
            const targetSearch = `?clientId=${row.clientId}`;
            const isClientActive =
              location.pathname.startsWith(`/orders/${status}`) &&
              location.search.includes(`clientId=${row.clientId}`);
            return (
              <NavLink
                key={row.clientId}
                to={{
                  pathname: `/orders/${status}`,
                  search: targetSearch,
                }}
                className={`flex items-center justify-between pl-7 pr-3 py-[5px] text-[11.5px] border-l-[3px] transition-colors ${
                  isClientActive
                    ? 'bg-brand-bg text-brand border-brand font-semibold'
                    : 'text-ink-2 hover:bg-surface-2 hover:text-ink border-transparent'
                }`}
              >
                <span className="truncate" title={row.name}>
                  {row.name}
                </span>
                <span className="font-mono text-tiny ml-2 shrink-0">
                  {row.count.toLocaleString()}
                </span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
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
  const { user, signOut } = useAuth();
  return (
    <aside className="w-sidebar shrink-0 bg-white border-r border-line flex flex-col h-full">
      <div className="px-3.5 py-3 border-b border-line">
        <div className="flex items-baseline text-[16px] font-extrabold tracking-[-0.4px]">
          <span className="text-ink">PREP</span>
          <span className="text-brand">SHIP</span>
        </div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.4px] text-ink-3">
          Dr Prepper Fulfillment
        </div>
      </div>

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

      <div className="px-2.5 pb-1.5">
        <SyncOrdersButton />
      </div>

      <nav className="flex-1 overflow-y-auto py-1.5">
        {statusItems.map((i) => (
          <StatusRow key={i.status} {...i} />
        ))}
        <div className="h-px mx-3 my-2 bg-line" />
        {toolItems.map((i) => (
          <ToolRow key={i.to} to={i.to} label={i.label} Icon={i.icon} />
        ))}
      </nav>

      <div className="px-3 py-2.5 border-t border-line flex items-center gap-2">
        <div className="flex-1 min-w-0">
          {user && (
            <div className="text-[11px] font-semibold text-ink-2 truncate">
              {user.email}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-3 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
            <span>API connected</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void signOut();
          }}
          className="text-ink-3 hover:text-ink transition-colors"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={13} />
        </button>
      </div>
    </aside>
  );
}
