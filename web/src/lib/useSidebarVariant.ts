// @ts-nocheck
import { useEffect, useState } from 'react'
import { SIDEBAR_SPECS } from '../components/Sidebar/variants/sidebar-specs'

// 25 variants total: A–E custom hand-built, F–Y spec-driven via SidebarTemplated.
const HANDCRAFTED: Record<
  string,
  { name: string; tagline: string; swatches: [string, string, string] }
> = {
  A: { name: 'Clean Linear', tagline: 'Light · slate · minimal', swatches: ['#ffffff', '#f1f5f9', '#4f46e5'] },
  B: { name: 'Bold Dark Premium', tagline: 'Dark · gradient · glow', swatches: ['#0f172a', '#1e1b4b', '#a78bfa'] },
  C: { name: 'Executive Glass', tagline: 'Frosted · indigo · refined', swatches: ['#f8fafc', '#ffffff', '#4338ca'] },
  D: { name: 'Calm Aurora', tagline: 'Soft · layered backdrop', swatches: ['#f1f5f9', '#dbeafe', '#a5b4fc'] },
  E: { name: 'Polished Dark · Motion', tagline: 'Dark · animated · pro', swatches: ['#0f172a', '#1e293b', '#6366f1'] },
}

export type SidebarVariantKey = string // open string union; valid keys are A–Y

// Build the master list dynamically from handcrafted + spec-driven entries.
export const SIDEBAR_VARIANTS: Record<
  string,
  { name: string; tagline: string; swatches: [string, string, string] }
> = (() => {
  const out: typeof HANDCRAFTED = { ...HANDCRAFTED }
  for (const key of Object.keys(SIDEBAR_SPECS)) {
    const s = SIDEBAR_SPECS[key]
    out[key] = { name: s.name, tagline: s.tagline, swatches: s.swatches }
  }
  return out
})()

const STORAGE_KEY = 'prepship_sidebar_variant'
const EVENT_NAME = 'prepship_sidebar_variant_change'

const VALID_KEYS = new Set(Object.keys(SIDEBAR_VARIANTS))

function readStored(): SidebarVariantKey {
  // 2026-05-13: sidebar variant is LOCKED to 'A' ("Clean Linear")
  // per operator decision. Previously this read from localStorage
  // so operators could pick variants B–Y via the floating
  // DesignPicker — that picker is now removed (see main.tsx) and
  // the chosen sidebar is hardcoded.
  //
  // To re-enable variant switching: restore the original body
  //   const stored = window.localStorage.getItem(STORAGE_KEY)
  //   if (stored && VALID_KEYS.has(stored)) return stored
  //   return 'A'
  // and re-mount <DesignPicker /> in main.tsx.
  return 'A'
}

export function useSidebarVariant(): {
  variant: SidebarVariantKey
  setVariant: (next: SidebarVariantKey) => void
} {
  const [variant, setVariantState] = useState<SidebarVariantKey>(readStored)

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<SidebarVariantKey>).detail
      if (detail && detail !== variant && VALID_KEYS.has(detail)) {
        setVariantState(detail)
      }
    }
    window.addEventListener(EVENT_NAME, onChange)
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue && VALID_KEYS.has(event.newValue)) {
        setVariantState(event.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [variant])

  const setVariant = (next: SidebarVariantKey) => {
    if (!VALID_KEYS.has(next)) return
    setVariantState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
    }
  }

  return { variant, setVariant }
}
