// PS-258 (slice A): the localStorage column-prefs helpers, extracted VERBATIM
// from OrdersView.tsx. These are PURE/side-effect-bounded readers/writers — no
// React, no hooks, no state, no fetch — so the cache-first display of column
// prefs after reload is owned by one small testable module. OrdersView imports
// the const + both functions and calls them unchanged.
//
//  - readLocalColumnPrefs(): SSR-safe (returns null when window is undefined),
//    returns the parsed ColumnPrefs or null on missing/corrupt JSON. Server
//    persistence is still the source of truth; this is only a fast-path cache.
//  - writeLocalColumnPrefs(prefs): SSR-safe no-op when window is undefined;
//    swallows quota/serialization errors (localStorage is best-effort cache).
//
// Byte-identical refactor only — no logic or behavior change.
import type { ColumnPrefs } from './orders-parity'

export const COLUMN_PREFS_LOCAL_STORAGE_KEY = 'prepship.orders.columnPrefs'

export function readLocalColumnPrefs() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(COLUMN_PREFS_LOCAL_STORAGE_KEY)
    return raw ? JSON.parse(raw) as ColumnPrefs : null
  } catch {
    return null
  }
}

export function writeLocalColumnPrefs(prefs: ColumnPrefs) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLUMN_PREFS_LOCAL_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Server persistence is still the source of truth when localStorage is unavailable.
  }
}
