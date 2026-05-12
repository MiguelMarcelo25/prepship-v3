// Variant-selection hook for the Clients page. Mirrors the
// useSidebarVariant pattern: localStorage-backed key, custom-event
// broadcast on change so any open instances of the variant picker
// stay in sync.
//
// 10 variants total (01–10). The picker UI lives in pages/Clients.tsx
// and calls setVariant() to switch.

import { useEffect, useState } from 'react'

export type ClientsVariantKey =
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06'
  | '07'
  | '08'
  | '09'
  | '10'

export interface ClientsVariantMeta {
  key: ClientsVariantKey
  name: string
  tagline: string
  // Three-color preview swatch shown in the picker — first is the
  // canvas, second is the dominant accent, third is the ink/text.
  swatches: [string, string, string]
}

export const CLIENTS_VARIANTS: Record<ClientsVariantKey, ClientsVariantMeta> = {
  '01': {
    key: '01',
    name: 'Original',
    tagline: 'Restored · classic card grid',
    swatches: ['#ffffff', '#2a5bd7', '#1a1f2e'],
  },
  '02': {
    key: '02',
    name: 'Editorial Portfolio',
    tagline: 'Cream paper · magazine spread',
    swatches: ['#fbf8f3', '#03A9F4', '#0d1424'],
  },
  '03': {
    key: '03',
    name: 'Data Table',
    tagline: 'Dense · sortable · operator-tool',
    swatches: ['#fafafa', '#0ea5e9', '#0f172a'],
  },
  '04': {
    key: '04',
    name: 'Dark Glass',
    tagline: 'Slate-950 · frosted · brand glow',
    swatches: ['#0b1220', '#03A9F4', '#e2e8f0'],
  },
  '05': {
    key: '05',
    name: 'Minimal List',
    tagline: 'Whitespace · tight rows',
    swatches: ['#ffffff', '#171717', '#525252'],
  },
  '06': {
    key: '06',
    name: 'Brutalist Mono',
    tagline: 'Ivory · ink · monospace',
    swatches: ['#f5f3ed', '#0a0a0a', '#0a0a0a'],
  },
  '07': {
    key: '07',
    name: 'Magazine Mosaic',
    tagline: 'Uneven tiles · hero card',
    swatches: ['#fef3c7', '#dc2626', '#1f1f1f'],
  },
  '08': {
    key: '08',
    name: 'Spreadsheet',
    tagline: 'Hard borders · gridded · Excel-feel',
    swatches: ['#f9fafb', '#16a34a', '#111827'],
  },
  '09': {
    key: '09',
    name: 'Kanban Board',
    tagline: 'Active · Inactive · columns',
    swatches: ['#f1f5f9', '#0d9488', '#0f172a'],
  },
  '10': {
    key: '10',
    name: 'Showcase Hero',
    tagline: 'Big stats · feature cards',
    swatches: ['#fffbeb', '#7c3aed', '#1e1b4b'],
  },
}

export const CLIENTS_VARIANT_KEYS = Object.keys(CLIENTS_VARIANTS) as ClientsVariantKey[]

const STORAGE_KEY = 'prepship_clients_variant'
const EVENT_NAME = 'prepship_clients_variant_change'
const DEFAULT_VARIANT: ClientsVariantKey = '02'

function readStored(): ClientsVariantKey {
  if (typeof window === 'undefined') return DEFAULT_VARIANT
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) as ClientsVariantKey | null
    if (raw && raw in CLIENTS_VARIANTS) return raw
  } catch {
    /* localStorage blocked */
  }
  return DEFAULT_VARIANT
}

export function useClientsVariant(): {
  variant: ClientsVariantKey
  setVariant: (next: ClientsVariantKey) => void
} {
  const [variant, setVariantState] = useState<ClientsVariantKey>(readStored)

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ClientsVariantKey>).detail
      if (detail && detail in CLIENTS_VARIANTS) {
        setVariantState(detail)
      }
    }
    window.addEventListener(EVENT_NAME, onChange)
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue && e.newValue in CLIENTS_VARIANTS) {
        setVariantState(e.newValue as ClientsVariantKey)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setVariant = (next: ClientsVariantKey) => {
    if (!(next in CLIENTS_VARIANTS)) return
    setVariantState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* localStorage blocked — non-fatal */
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
  }

  return { variant, setVariant }
}
