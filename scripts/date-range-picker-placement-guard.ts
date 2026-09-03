/**
 * DateRangePicker popover placement guard (collision-aware anchoring).
 *
 * Offline/static: pure function, no DOM, no DB, no network.
 *
 * The live defect this pins (2026-09-03, Dashboard). The desktop popover was
 * always anchored to the trigger's RIGHT edge at a fixed 640px. On the
 * Dashboard the trigger sits at the left edge of the title row (x 268..457
 * inside a view whose left edge is 247), so the panel spanned -183..457 and
 * `.view-content`'s overflow-x hidden clipped everything left of 247: the
 * presets column, the previous-month arrow and the Sun–Wed columns vanished.
 *
 * The resolver must pick the trigger edge with room, and when neither side has
 * 640px it must shrink the panel to the roomier side instead of overflowing.
 */
import {
  POPOVER_DESKTOP_WIDTH,
  POPOVER_GUTTER,
  POPOVER_MIN_WIDTH,
  resolvePopoverPlacement,
} from '../web/src/components/date-range-picker-placement';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// The 2026-09-03 screenshot: trigger at the left of a wide view.
const screenshot = { triggerLeft: 268, triggerRight: 457, boundsLeft: 247, boundsRight: 1900 };

// ── The regression itself ────────────────────────────────────────────────────
{
  const p = resolvePopoverPlacement(screenshot);
  check('trigger at the left edge of a wide view opens RIGHTWARD (align left)', p.align === 'left', p);
  check('and keeps the full desktop width', p.width === POPOVER_DESKTOP_WIDTH, p);
  const panelLeft = p.align === 'left' ? screenshot.triggerLeft : screenshot.triggerRight - p.width;
  const panelRight = panelLeft + p.width;
  check('the panel lies entirely inside the clip bounds',
    panelLeft >= screenshot.boundsLeft && panelRight <= screenshot.boundsRight,
    { panelLeft, panelRight });
}

// ── The other end of a toolbar keeps the old behaviour ───────────────────────
{
  const p = resolvePopoverPlacement({ triggerLeft: 1500, triggerRight: 1690, boundsLeft: 247, boundsRight: 1900 });
  check('trigger at the right edge opens LEFTWARD (align right)', p.align === 'right', p);
  check('at the full desktop width', p.width === POPOVER_DESKTOP_WIDTH, p);
}

// ── Both sides fit: prefer the conventional down-right dropdown ──────────────
{
  const p = resolvePopoverPlacement({ triggerLeft: 900, triggerRight: 1090, boundsLeft: 0, boundsRight: 2000 });
  check('when both sides fit, the panel opens rightward', p.align === 'left', p);
}

// ── Neither side fits: shrink to the roomier side ────────────────────────────
{
  const input = { triggerLeft: 268, triggerRight: 457, boundsLeft: 247, boundsRight: 800 };
  const p = resolvePopoverPlacement(input);
  const roomRight = input.boundsRight - input.triggerLeft - POPOVER_GUTTER;
  check('narrow view: picks the roomier side', p.align === 'left', p);
  check('narrow view: shrinks to that room (minus gutter)', p.width === roomRight, { p, roomRight });
  check('narrow view: still inside the bounds',
    input.triggerLeft + p.width <= input.boundsRight, { p });
}

// ── Floor and ceiling ────────────────────────────────────────────────────────
{
  const tiny = resolvePopoverPlacement({ triggerLeft: 268, triggerRight: 457, boundsLeft: 247, boundsRight: 600 });
  check('never shrinks below the minimum usable width', tiny.width === POPOVER_MIN_WIDTH, tiny);
  const huge = resolvePopoverPlacement({ triggerLeft: 5000, triggerRight: 5200, boundsLeft: 0, boundsRight: 20000 });
  check('never grows past the desktop width', huge.width === POPOVER_DESKTOP_WIDTH, huge);
  check('constants are sane: min < desktop', POPOVER_MIN_WIDTH < POPOVER_DESKTOP_WIDTH);
}

// ── Exactly enough room counts as fitting ────────────────────────────────────
{
  const exact = resolvePopoverPlacement({
    triggerLeft: 100, triggerRight: 200,
    boundsLeft: 0, boundsRight: 100 + POPOVER_DESKTOP_WIDTH + POPOVER_GUTTER,
  });
  check('exactly desktop width + gutter to the right fits rightward', exact.align === 'left' && exact.width === POPOVER_DESKTOP_WIDTH, exact);
}

if (failures > 0) {
  console.error(`\n${failures} placement check(s) FAILED`);
  process.exit(1);
}
console.log('\nPASS DateRangePicker popover placement guard');
