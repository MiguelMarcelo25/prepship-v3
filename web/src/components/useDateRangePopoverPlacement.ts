/**
 * Measures where the DateRangePicker trigger sits relative to the nearest
 * ancestor that clips horizontal overflow, and hands the numbers to the pure
 * resolver in ./date-range-picker-placement.ts. Re-measures on open and on
 * window resize; nothing here decides placement policy.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  POPOVER_DESKTOP_WIDTH,
  resolvePopoverPlacement,
  type PopoverPlacement,
} from './date-range-picker-placement'

export type ClipBounds = { left: number; right: number }

/**
 * Visible left/right edges (viewport px) of the nearest ancestor whose
 * overflow-x is not `visible`, intersected with the viewport. Falls back to
 * the viewport itself. `.view-content` (overflow-y auto, and the Dashboard's
 * explicit overflow-x hidden) is the ancestor that clips in practice.
 */
export function findClipBounds(start: HTMLElement): ClipBounds {
  const viewport: ClipBounds = { left: 0, right: window.innerWidth }
  let el: HTMLElement | null = start.parentElement
  while (el && el !== document.body) {
    const overflowX = window.getComputedStyle(el).overflowX
    if (overflowX !== 'visible') {
      const rect = el.getBoundingClientRect()
      return {
        left: Math.max(viewport.left, rect.left),
        right: Math.min(viewport.right, rect.right),
      }
    }
    el = el.parentElement
  }
  return viewport
}

const DEFAULT_PLACEMENT: PopoverPlacement = { align: 'left', width: POPOVER_DESKTOP_WIDTH }

export function useDateRangePopoverPlacement(
  triggerRef: RefObject<HTMLElement>,
  open: boolean,
): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>(DEFAULT_PLACEMENT)

  // Layout effect so the first painted frame already uses the measured side.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const bounds = findClipBounds(trigger)
      setPlacement(resolvePopoverPlacement({
        triggerLeft: rect.left,
        triggerRight: rect.right,
        boundsLeft: bounds.left,
        boundsRight: bounds.right,
      }))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, triggerRef])

  return placement
}
