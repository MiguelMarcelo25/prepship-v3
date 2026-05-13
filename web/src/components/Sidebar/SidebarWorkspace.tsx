// @ts-nocheck
import type { ReactNode } from 'react'
import type { ViewType } from './sidebar-data'
import {
  IconBadge,
  IconBarChart,
  IconBoxes,
  IconDollarSign,
  IconFileText,
  IconMapPin,
  IconPackage,
  IconReceipt,
  IconSettings,
  type IconTone,
} from './sidebar-icons'

interface WorkspaceItem {
  view: ViewType
  icon: ReactNode
  label: string
  tone: IconTone
}

const WORKSPACE_ITEMS: WorkspaceItem[] = [
  { view: 'inventory', icon: <IconBoxes />, label: 'Inventory', tone: 'indigo' },
  // 2026-05-13: Locations moved into Settings → Ship-From Locations tab.
  { view: 'packages', icon: <IconPackage />, label: 'Packages', tone: 'amber' },
  { view: 'rates', icon: <IconDollarSign />, label: 'Rate Shop', tone: 'emerald' },
  { view: 'analysis', icon: <IconBarChart />, label: 'Analytics', tone: 'violet' },
  { view: 'settings', icon: <IconSettings />, label: 'Settings', tone: 'slate' },
  { view: 'billing', icon: <IconReceipt />, label: 'Billing', tone: 'sky' },
  { view: 'manifests', icon: <IconFileText />, label: 'Manifests', tone: 'teal' },
]

function WorkspaceButton({
  item,
  active,
  onClick,
}: {
  item: WorkspaceItem
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group flex h-11 w-full items-center justify-start gap-3 rounded-xl px-3 transition-colors',
        active
          ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-primary)]',
      ].join(' ')}
    >
      <div
        className={[
          'flex shrink-0 items-center justify-center w-4 text-[14px] transition-all',
          active ? 'opacity-100 text-red-500' : 'opacity-0 group-hover:opacity-100',
        ].join(' ')}
      >
        &bull;
      </div>
      <IconBadge tone={item.tone} active={active}>
        {item.icon}
      </IconBadge>
      <span className="flex-1 truncate text-left text-[14.5px]">{item.label}</span>
    </button>
  )
}

interface SidebarWorkspaceProps {
  currentView: ViewType
  onSelect: (view: ViewType) => void
  filter?: string
}

export function SidebarWorkspace({ currentView, onSelect, filter = '' }: SidebarWorkspaceProps) {
  const filteredItems = filter
    ? WORKSPACE_ITEMS.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()))
    : WORKSPACE_ITEMS

  if (filter && filteredItems.length === 0 && !'workspace'.includes(filter.toLowerCase())) {
    return null
  }

  return (
    <div>
      <div className="mb-3 px-1">
        <div className="pt-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          <span className="text-white dark:text-white">&bull;</span>&ensp;Workspace
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {filteredItems.map((item) => (
          <WorkspaceButton
            key={item.view}
            item={item}
            active={currentView === item.view}
            onClick={() => onSelect(item.view)}
          />
        ))}
      </div>
    </div>
  )
}
