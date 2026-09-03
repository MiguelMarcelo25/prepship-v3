/**
 * DateRangePicker popover placement — collision-aware anchoring.
 *
 * The desktop popover is absolutely positioned against its trigger. It used to
 * be anchored to the trigger's RIGHT edge at a fixed 640px, which is right for
 * a trigger at the end of a toolbar and wrong for one at the start. On the
 * Dashboard the trigger sits at the left edge of the title row, so ~450px of
 * the panel hung past the view's left edge, where `.view-content`'s
 * overflow-x hidden clipped it (2026-09-03: presets column, ‹ arrow and the
 * Sun–Wed columns gone).
 *
 * Pure: the component measures, this decides. Given the trigger's edges and
 * the clipping bounds (all in the same coordinate space) it returns which
 * trigger edge to anchor to and how wide the panel may be:
 *
 *   1. room to the right (anchor left edge, grow right)  → 'left'  @ 640
 *   2. else room to the left (anchor right edge, grow left) → 'right' @ 640
 *   3. else the roomier side, shrunk to its room, never below the minimum.
 */

/** Full two-column width (presets + calendar). */
export const POPOVER_DESKTOP_WIDTH = 640
/** Narrowest width at which the two-column layout is still usable. */
export const POPOVER_MIN_WIDTH = 360
/** Breathing room kept between the panel and the clipping edge. */
export const POPOVER_GUTTER = 12

export type PopoverAlign = 'left' | 'right'

export type PopoverPlacement = {
  /** Which trigger edge the panel is anchored to. */
  align: PopoverAlign
  /** Panel width in px. */
  width: number
}

export type PlacementInput = {
  triggerLeft: number
  triggerRight: number
  boundsLeft: number
  boundsRight: number
}

export function resolvePopoverPlacement(input: PlacementInput): PopoverPlacement {
  const roomRight = input.boundsRight - input.triggerLeft - POPOVER_GUTTER
  const roomLeft = input.triggerRight - input.boundsLeft - POPOVER_GUTTER

  if (roomRight >= POPOVER_DESKTOP_WIDTH) return { align: 'left', width: POPOVER_DESKTOP_WIDTH }
  if (roomLeft >= POPOVER_DESKTOP_WIDTH) return { align: 'right', width: POPOVER_DESKTOP_WIDTH }

  const align: PopoverAlign = roomRight >= roomLeft ? 'left' : 'right'
  const room = Math.floor(Math.max(roomRight, roomLeft))
  const width = Math.max(POPOVER_MIN_WIDTH, Math.min(POPOVER_DESKTOP_WIDTH, room))
  return { align, width }
}
