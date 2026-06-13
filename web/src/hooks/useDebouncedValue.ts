// PS-166 (Wave 2a3): generic debounce hook, moved VERBATIM out of
// OrdersView.tsx into the shared hooks directory. Strict TypeScript.
// The orders-request-pressure guard pins this definition here and the
// 350ms search call site in OrdersView.
import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, value])

  return debounced
}
