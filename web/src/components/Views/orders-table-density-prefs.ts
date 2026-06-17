// PS-258 (slice C): useTableDensityPreference, extracted VERBATIM from OrdersView.
// Pure localStorage-backed row-density preference for the orders table — SSR-safe
// init plus a persist-on-change effect, with ZERO parent coupling (it owns only
// its own state). Byte-identical refactor: same storage key, same default
// ('cozy'), same validation set. OrdersView imports the hook and calls it
// unchanged at its single call site.
//
// Density steps (unchanged):
//   - narrow: ~24px row, 11px font (max rows visible)
//   - cozy:   ~34px row, 12.5px font (default — what the table had before)
//   - wide:   ~48px row, 13px font (more breathing room)
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export type TableDensity = 'narrow' | 'cozy' | 'wide'

const STORAGE_KEY = 'orders_table_density'

export function useTableDensityPreference(): [TableDensity, Dispatch<SetStateAction<TableDensity>>] {
  const [tableDensity, setTableDensity] = useState<TableDensity>(() => {
    if (typeof window === 'undefined') return 'cozy'
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return saved === 'narrow' || saved === 'cozy' || saved === 'wide' ? saved : 'cozy'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, tableDensity)
  }, [tableDensity])
  return [tableDensity, setTableDensity]
}
