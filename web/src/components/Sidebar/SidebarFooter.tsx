// @ts-nocheck
import { useEffect, useState } from 'react'
import { IconMoon, IconSun } from './sidebar-icons'

export function SidebarFooter() {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (dark) document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
  }, [dark])

  return (
    <div className="flex h-[68px] items-center justify-between border-t border-[var(--color-border-default)] px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative h-2.5 w-2.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-emerald-500" />
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-50" />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
            Connected
          </span>
          <span className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-tertiary)]">
            Gardena, CA · prepshipv4-stable
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setDark((d) => !d)}
        aria-label="Toggle theme"
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-primary)]"
      >
        {dark ? <IconSun /> : <IconMoon />}
      </button>
    </div>
  )
}
