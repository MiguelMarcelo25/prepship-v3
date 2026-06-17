// PS-258 (slice B): scheduleNonCriticalOrdersWork, extracted VERBATIM from
// OrdersView.tsx. This is a PURE/closure-free module-level scheduling helper —
// no React, no hooks, no component state, no fetch — so the "defer non-critical
// Orders work to idle time" policy lives in one small strictly-typed module.
// OrdersView imports the function and calls it unchanged at its two call sites.
//
// Behavior (unchanged):
//  - SSR-safe: returns a no-op canceller when window is undefined.
//  - Skips the callback if it was cancelled or the tab is not visible at run
//    time (avoids burning work for a backgrounded tab).
//  - Prefers requestIdleCallback (with a timeout fallback) and degrades to
//    setTimeout when the browser lacks idle-callback support.
//  - Returns a canceller that flips the cancelled flag and tears down whichever
//    timer/idle handle was registered.
//
// Byte-identical refactor only — no logic or behavior change.
export function scheduleNonCriticalOrdersWork(callback: () => void, delayMs = 2500) {
  if (typeof window === 'undefined') return () => { }
  let cancelled = false
  const run = () => {
    if (cancelled || document.visibilityState !== 'visible') return
    callback()
  }

  if ('requestIdleCallback' in window) {
    const idleId = window.requestIdleCallback(run, { timeout: delayMs })
    return () => {
      cancelled = true
      window.cancelIdleCallback?.(idleId)
    }
  }

  const timeoutId = (window as Window).setTimeout(run, delayMs)
  return () => {
    cancelled = true
    window.clearTimeout(timeoutId)
  }
}
