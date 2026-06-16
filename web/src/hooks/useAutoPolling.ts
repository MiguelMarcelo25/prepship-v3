import { useEffect, useRef, useCallback } from 'react'

interface UseAutoPollingOptions {
  enabled?: boolean
  intervalMs?: number
  onData?: (data: any) => void
}

export function useAutoPolling(
  url: string,
  options: UseAutoPollingOptions = {}
) {
  const { enabled = true, intervalMs = 5000, onData } = options
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  const poll = useCallback(async () => {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        onDataRef.current?.(data)
      }
    } catch {
      // silently fail
    }
  }, [url])

  useEffect(() => {
    if (!enabled) return

    // Initial poll
    poll()

    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        await poll()
        schedule()
      }, intervalMs)
    }

    schedule()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [enabled, intervalMs, poll])
}
