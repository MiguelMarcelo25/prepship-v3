import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_THEME_ID, findTheme, THEMES, type Theme } from './themes'

const STORAGE_KEY = 'prepship_theme'

interface ThemeContextValue {
  theme: Theme
  themes: Theme[]
  setThemeId: (id: string) => void
  isDark: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
  // Convenience hooks for any CSS that wants to gate on theme id or mode.
  root.dataset.theme = theme.id
  root.dataset.themeMode = theme.mode
  // Also reflect on body so legacy CSS that references body[data-theme] works.
  if (document.body) {
    document.body.dataset.theme = theme.id
    document.body.dataset.themeMode = theme.mode
  }
  // Hint to the browser for native form controls (scrollbars, dialogs, etc.)
  root.style.colorScheme = theme.mode
}

function readStoredId(): string {
  // 2026-05-13: theme is LOCKED to DEFAULT_THEME_ID ('indigo' aka
  // "Sky Blue") per operator decision. Previously this read from
  // localStorage so operators could pick alternate themes via the
  // floating DesignPicker — that picker is now removed (see
  // main.tsx) and the chosen theme is hardcoded.
  //
  // To re-enable theme switching: restore the original body
  //   `return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME_ID`
  // and re-mount <DesignPicker /> in main.tsx.
  //
  // Note: the useEffect below still writes the active id to
  // localStorage every render. That's harmless — keeps the storage
  // value in sync with the locked theme so if we ever re-enable
  // the picker, returning operators land on Sky Blue instead of
  // whatever stale id they last picked.
  return DEFAULT_THEME_ID
}

interface ProviderProps {
  children: ReactNode
}

export function ThemeProvider({ children }: ProviderProps) {
  const [themeId, setThemeIdState] = useState<string>(() => readStoredId())
  const theme = useMemo(() => findTheme(themeId), [themeId])

  // Apply theme synchronously on first render so there's no flash of the
  // previous theme's variables while React mounts.
  useState(() => {
    applyTheme(theme)
    return undefined
  })

  useEffect(() => {
    applyTheme(theme)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme.id)
    }
  }, [theme])

  const setThemeId = useCallback((id: string) => {
    setThemeIdState(id)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themes: THEMES,
      setThemeId,
      isDark: theme.mode === 'dark',
    }),
    [theme, setThemeId],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    // Fallback so components don't crash if ThemeProvider isn't mounted yet
    // (e.g. unit tests). Returns the default theme as a no-op context.
    return {
      theme: findTheme(DEFAULT_THEME_ID),
      themes: THEMES,
      setThemeId: () => {},
      isDark: false,
    }
  }
  return ctx
}
