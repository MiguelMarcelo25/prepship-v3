// @ts-nocheck
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export type MarkupType = 'amount' | 'percent' | 'pct' | 'flat'

export interface Markup {
  type: MarkupType
  value: number
}

export type MarkupsMap = Record<string, Markup>

export interface MarkupsContextValue {
  markups: MarkupsMap
  loading: boolean
  error: string | null
  applyMarkup: (basePrice: number, markup: Markup) => number
  saveMarkup: (pidOrCarrier: number | string, type: MarkupType, value: number) => Promise<void>
  clearRateCache: () => Promise<void>
  refreshMarkups: () => Promise<void>
}

const MarkupsContext = createContext<MarkupsContextValue | null>(null)

export function MarkupsProvider({ children }: { children: ReactNode }) {
  const [markups, setMarkups] = useState<MarkupsMap>({})
  const [loading] = useState(false)
  const [error] = useState<string | null>(null)

  const applyMarkup = useCallback((basePrice: number, markup: Markup): number => {
    if (!markup || !markup.value) return basePrice
    return markup.type === 'pct' || markup.type === 'percent'
      ? basePrice * (1 + markup.value / 100)
      : basePrice + markup.value
  }, [])

  const saveMarkup = useCallback(
    async (pidOrCarrier: number | string, type: MarkupType, value: number) => {
      setMarkups((prev) => ({ ...prev, [pidOrCarrier]: { type, value } }))
    },
    []
  )

  const clearRateCache = useCallback(async () => {
    /* v4 stub */
  }, [])

  const refreshMarkups = useCallback(async () => {
    /* v4 stub */
  }, [])

  const value: MarkupsContextValue = {
    markups,
    loading,
    error,
    applyMarkup,
    saveMarkup,
    clearRateCache,
    refreshMarkups,
  }

  return <MarkupsContext.Provider value={value}>{children}</MarkupsContext.Provider>
}

export function useMarkups(): MarkupsContextValue {
  const ctx = useContext(MarkupsContext)
  if (!ctx) throw new Error('useMarkups called outside MarkupsProvider')
  return ctx
}
