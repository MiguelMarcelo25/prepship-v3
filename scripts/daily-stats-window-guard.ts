import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  californiaNoonUtcForFulfillmentDate,
  computeFulfillmentShiftWindow,
  formatFulfillmentBoundaryLabel,
} from '../src/lib/time/fulfillment-window';

// PS-047 — the Orders "Daily Strip" fulfillment window must bound TRUE noon
// Pacific (not literal noon UTC). `orders.order_date` now holds real UTC
// instants, so the boundary is 19:00 UTC in PDT and 20:00 UTC in PST. The
// previous bug returned Date.UTC(y, m, d, 12, 0, 0) (~5am PT), silently
// misattributing the 5am–noon PT window to the wrong fulfillment day.

function expectWindow(now: string, fromIso: string, toIso: string, msg: string) {
  const window = computeFulfillmentShiftWindow(new Date(now));
  assert.equal(window.from.toISOString(), fromIso, `${msg} (from)`);
  assert.equal(window.to.toISOString(), toIso, `${msg} (to)`);
}

// --- True noon-Pacific boundary, DST-aware -----------------------------------
assert.equal(
  californiaNoonUtcForFulfillmentDate(2026, 5, 27).toISOString(),
  '2026-05-27T19:00:00.000Z',
  'PDT (summer) noon Pacific must resolve to 19:00 UTC',
);
// Pin the exact reported-screenshot boundary: "May 28, 12pm CA" (PDT) must be
// 19:00Z, NOT the old buggy 12:00Z that inflated the strip to 91 orders.
assert.equal(
  californiaNoonUtcForFulfillmentDate(2026, 5, 28).toISOString(),
  '2026-05-28T19:00:00.000Z',
  'screenshot boundary: May 28 2026 12pm CA must be 19:00Z, not 12:00Z',
);
assert.equal(
  californiaNoonUtcForFulfillmentDate(2026, 1, 14).toISOString(),
  '2026-01-14T20:00:00.000Z',
  'PST (winter) noon Pacific must resolve to 20:00 UTC',
);
assert.notEqual(
  californiaNoonUtcForFulfillmentDate(2026, 5, 27).toISOString(),
  '2026-05-27T12:00:00.000Z',
  'fulfillment boundary must NOT regress to literal noon-UTC',
);

// --- Shift-window state machine (CA-local weekday + 6pm rollover) ------------
// 2026 anchors: May 27 = Wed, May 29 = Fri, May 30 = Sat, May 31 = Sun, Jun 1 = Mon.

// Weekday before 6pm CA (Wed 10:00 AM PDT) -> yesterday noon .. today noon.
expectWindow(
  '2026-05-27T17:00:00.000Z',
  '2026-05-26T19:00:00.000Z',
  '2026-05-27T19:00:00.000Z',
  'weekday before 6pm: prev-noon to today-noon',
);

// Weekday after 6pm CA (Wed 7:00 PM PDT) -> today noon .. tomorrow noon.
expectWindow(
  '2026-05-28T02:00:00.000Z',
  '2026-05-27T19:00:00.000Z',
  '2026-05-28T19:00:00.000Z',
  'weekday after 6pm: today-noon to tomorrow-noon',
);

// Saturday (10:00 AM PDT) -> Friday noon .. Monday noon (weekend hold).
expectWindow(
  '2026-05-30T17:00:00.000Z',
  '2026-05-29T19:00:00.000Z',
  '2026-06-01T19:00:00.000Z',
  'Saturday holds Friday-noon to Monday-noon',
);

// Sunday (3:00 PM PDT) -> Friday noon .. Monday noon.
expectWindow(
  '2026-05-31T22:00:00.000Z',
  '2026-05-29T19:00:00.000Z',
  '2026-06-01T19:00:00.000Z',
  'Sunday holds Friday-noon to Monday-noon',
);

// Monday before 6pm (9:00 AM PDT) -> Friday noon .. Monday noon (hold until 6pm).
expectWindow(
  '2026-06-01T16:00:00.000Z',
  '2026-05-29T19:00:00.000Z',
  '2026-06-01T19:00:00.000Z',
  'Monday before 6pm still holds Friday-noon to Monday-noon',
);

// Friday after 6pm (8:00 PM PDT) -> Friday noon .. Monday noon (start weekend hold).
expectWindow(
  '2026-05-30T03:00:00.000Z',
  '2026-05-29T19:00:00.000Z',
  '2026-06-01T19:00:00.000Z',
  'Friday after 6pm opens Friday-noon to Monday-noon',
);

// Winter / PST weekday before 6pm (Wed Jan 14, 10:00 AM PST) -> noon = 20:00 UTC.
expectWindow(
  '2026-01-14T18:00:00.000Z',
  '2026-01-13T20:00:00.000Z',
  '2026-01-14T20:00:00.000Z',
  'PST weekday before 6pm uses 20:00 UTC noon boundaries',
);

// --- Anti-regression: a live window must never be literal noon-UTC -----------
const summerWindow = computeFulfillmentShiftWindow(new Date('2026-05-27T17:00:00.000Z'));
assert(
  !summerWindow.from.toISOString().endsWith('T12:00:00.000Z') &&
    !summerWindow.to.toISOString().endsWith('T12:00:00.000Z'),
  'fulfillment window boundaries must not be literal noon-UTC (old bug)',
);

// --- Label reads noon Pacific in both DST states -----------------------------
assert.equal(
  formatFulfillmentBoundaryLabel(new Date('2026-05-27T19:00:00.000Z')),
  'May 27, 12pm PT',
  'PDT noon boundary must label as 12pm',
);
assert.equal(
  formatFulfillmentBoundaryLabel(new Date('2026-01-14T20:00:00.000Z')),
  'Jan 14, 12pm PT',
  'PST noon boundary must label as 12pm',
);

// --- Wiring guard ------------------------------------------------------------
assert.match(
  readFileSync('src/routes/orders.ts', 'utf8'),
  /computeFulfillmentShiftWindow/,
  'daily-stats route must consume the shared fulfillment-window helper',
);
assert.match(
  readFileSync('package.json', 'utf8'),
  /test:daily-stats-window/,
  'package.json must expose the daily-stats window guard',
);

console.log('PASS daily-stats CA noon-window guard');
