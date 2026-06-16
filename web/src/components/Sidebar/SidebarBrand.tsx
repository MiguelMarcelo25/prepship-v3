import { IconHome } from './sidebar-icons'

export function SidebarBrand() {
  return (
    <div className="flex h-[72px] items-center border-b border-[var(--color-border-default)] px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/20">
          <IconHome />
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            PrepShip
          </span>
          <span className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            DR Prepper
          </span>
        </div>
      </div>
    </div>
  )
}
