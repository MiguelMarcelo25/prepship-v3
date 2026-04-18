import { NavLink } from 'react-router-dom';
import {
  Package,
  MapPin,
  Boxes,
  DollarSign,
  BarChart3,
  Receipt,
  Settings,
  ShoppingCart,
  Truck,
  Search,
  Users,
} from 'lucide-react';

type NavItem = {
  to: string;
  label: string;
  icon: typeof Package;
};

const primary: NavItem[] = [
  { to: '/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/shipments', label: 'Shipments', icon: Truck },
];

const tools: NavItem[] = [
  { to: '/packages', label: 'Packages', icon: Boxes },
  { to: '/clients', label: 'Clients', icon: Users },
];

const later: NavItem[] = [
  { to: '/inventory', label: 'Inventory', icon: Package },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/rates', label: 'Rate Shop', icon: DollarSign },
  { to: '/analysis', label: 'Analysis', icon: BarChart3 },
  { to: '/billing', label: 'Billing', icon: Receipt },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Section({ title }: { title: string }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.6px] text-ink-3">
      {title}
    </div>
  );
}

function Item({ item, disabled }: { item: NavItem; disabled?: boolean }) {
  const Icon = item.icon;
  const base =
    'group flex items-center gap-2 px-3 py-[7px] text-sm2 font-semibold border-l-[3px] transition-colors';
  if (disabled) {
    return (
      <div
        className={`${base} border-transparent text-ink-4 cursor-not-allowed select-none`}
        title="Coming soon"
      >
        <Icon size={14} className="shrink-0" />
        <span>{item.label}</span>
      </div>
    );
  }
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `${base} ${
          isActive
            ? 'bg-brand-bg text-brand border-brand'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink border-transparent'
        }`
      }
    >
      <Icon size={14} className="shrink-0" />
      <span>{item.label}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  return (
    <aside className="w-sidebar shrink-0 bg-white border-r border-line flex flex-col h-full">
      {/* Logo */}
      <div className="px-3.5 py-3 border-b border-line">
        <div className="flex items-baseline gap-0 text-[16px] font-extrabold tracking-[-0.4px]">
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
      <nav className="flex-1 overflow-y-auto py-1">
        <Section title="Workflow" />
        {primary.map((i) => (
          <Item key={i.to} item={i} />
        ))}
        <Section title="Catalog" />
        {tools.map((i) => (
          <Item key={i.to} item={i} />
        ))}
        <Section title="Coming soon" />
        {later.map((i) => (
          <Item key={i.to} item={i} disabled />
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
