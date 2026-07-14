import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'

export type MarkupType = 'amount' | 'percent' | 'pct' | 'flat'

export interface Markup {
  type: MarkupType
  value: number
}

export type MarkupsMap = Record<string, Markup>

export interface MarkupsContextValue {
  markups: MarkupsMap
  loading: boolean
  saveMarkup: (pidOrCarrier: number | string, type: MarkupType, value: number) => Promise<void>
}

const MarkupsContext = createContext<MarkupsContextValue | null>(null)

// Each markup is stored as a separate row in the `settings` table under a
// `markup.<pidOrCarrier>` key with a JSON-encoded {type, value} payload.
// Keeps all markups loadable in one narrow GET /settings/markups call while allowing
// individual PUTs for updates.
const MARKUP_PREFIX = 'markup.'

function getInitialMarkupHydrationDelayMs(pathname: string): number {
  return pathname.startsWith('/orders') ? 3500 : 0
}

function keyFor(pidOrCarrier: number | string): string {
  return `${MARKUP_PREFIX}${pidOrCarrier}`
}

function parseMarkupValue(raw: unknown): Markup | null {
  if (raw == null) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    const type = (parsed as any).type
    const value = Number((parsed as any).value ?? 0)
    if (!Number.isFinite(value)) return null
    if (type !== 'amount' && type !== 'percent' && type !== 'pct' && type !== 'flat') {
      return null
    }
    return { type, value }
  } catch {
    return null
  }
}

export function MarkupsProvider({ children }: { children: ReactNode }) {
  const { session, loading: authLoading } = useAuth()
  const [markups, setMarkups] = useState<MarkupsMap>({})
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshMarkups = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<any>('/settings/markups')
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      const next: MarkupsMap = {}
      for (const row of rows) {
        const k = row?.key
        if (typeof k !== 'string' || !k.startsWith(MARKUP_PREFIX)) continue
        const parsed = parseMarkupValue(row?.value)
        if (parsed) next[k.slice(MARKUP_PREFIX.length)] = parsed
      }
      if (mountedRef.current) setMarkups(next)
    } catch {
      // Preserve the last successfully loaded settings snapshot.
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  // Hydrate from /settings/markups after auth so markup edits survive reload.
  // Gate on auth: the endpoint is Supabase-authed, so fire only once auth has
  // resolved AND a session token exists (the MarkupsProvider sits inside
  // AuthProvider but mounts synchronously, before supabase.auth.getSession
  // finishes — firing too early produces a 401 on every page load).
  useEffect(() => {
    if (authLoading || !session?.access_token) return

    let cancelled = false
    let started = false

    const start = () => {
      if (cancelled || started || document.visibilityState !== 'visible') return
      started = true
      void refreshMarkups()
    }

    const delayMs = getInitialMarkupHydrationDelayMs(window.location.pathname)
    const timerId = window.setTimeout(start, delayMs)
    const onVisibilityChange = () => start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      window.clearTimeout(timerId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [authLoading, session?.access_token, refreshMarkups])

  const saveMarkup = useCallback(
    async (pidOrCarrier: number | string, type: MarkupType, value: number) => {
      // Optimistic update so the UI stays responsive even if the PUT is slow.
      setMarkups((prev) => ({ ...prev, [pidOrCarrier]: { type, value } }))
      await api.put<any>(`/settings/${encodeURIComponent(keyFor(pidOrCarrier))}`, {
        value: JSON.stringify({ type, value }),
      })
    },
    []
  )

  // Memoize the context value so consumers don't re-render on unrelated
  // parent updates — previously a fresh object was allocated every render.
  const value = useMemo<MarkupsContextValue>(
    () => ({
      markups,
      loading,
      saveMarkup,
    }),
    [markups, loading, saveMarkup]
  )

  return <MarkupsContext.Provider value={value}>{children}</MarkupsContext.Provider>
}

export function useMarkups(): MarkupsContextValue {
  const ctx = useContext(MarkupsContext)
  if (!ctx) throw new Error('useMarkups called outside MarkupsProvider')
  return ctx
}
