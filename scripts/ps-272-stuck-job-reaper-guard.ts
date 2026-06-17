// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears stale pgboss active rows only, never shipped/cancelled order/shipment data.
/**
 * PS-272 — stuck-active pgboss job reaper guard (PURE, NO DB).
 *
 * Tests ONLY the pure selectStuckActiveJobs selector + the REAPER_SAFE_JOB_NAMES allow-list. Uses
 * fixed nowMs + started_on timestamps (no Date.now()). Proves:
 *
 *   1. A fresh-but-very-old active outbox job is NEVER selected (excluded from the allow-list).
 *   2. A 3-day-old active prepship.sync.shipments IS selected.
 *   3. A recently-started (< 15 min) active shipments job is NOT selected.
 *   4. A created/completed shipments job is NOT selected (state filter).
 *   5. external-shipped-classifier, fulfillment-outbox, and fees.walmart-sync are NOT in the
 *      allow-list.
 *
 *   npx tsx scripts/ps-272-stuck-job-reaper-guard.ts
 */
import {
  REAPER_MIN_ACTIVE_AGE_MS,
  REAPER_SAFE_JOB_NAMES,
  selectStuckActiveJobs,
} from '../src/services/sync-stuck-job-reaper';

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Fixed clock: 2026-06-17T12:00:00Z. All started_on values are derived from this — no Date.now().
const NOW_MS = Date.parse('2026-06-17T12:00:00.000Z');
const THREE_DAYS_AGO = new Date(NOW_MS - 3 * 24 * 60 * 60_000).toISOString();
const FIVE_MIN_AGO = new Date(NOW_MS - 5 * 60_000).toISOString();
const TWENTY_MIN_AGO = new Date(NOW_MS - 20 * 60_000).toISOString();
const OPTS = { nowMs: NOW_MS, minActiveAgeMs: REAPER_MIN_ACTIVE_AGE_MS };

// 1) A very-old active fulfillment-outbox job is NEVER selected (excluded — real ship-confirms).
check(
  'a very-old active fulfillment-outbox job is never selected (excluded side-effect job)',
  selectStuckActiveJobs(
    [{ id: 'ob-1', name: 'prepship.sync.fulfillment-outbox', state: 'active', started_on: THREE_DAYS_AGO }],
    OPTS,
  ),
  [],
);

// 2) A 3-day-old active shipments job IS selected.
check(
  'a 3-day-old active prepship.sync.shipments job is selected',
  selectStuckActiveJobs(
    [{ id: 'sh-1', name: 'prepship.sync.shipments', state: 'active', started_on: THREE_DAYS_AGO }],
    OPTS,
  ),
  [{ id: 'sh-1', name: 'prepship.sync.shipments' }],
);

// 3) A recently-started (< 15 min) active shipments job is NOT selected.
check(
  'a recently-started (< 15 min) active shipments job is not selected',
  selectStuckActiveJobs(
    [{ id: 'sh-2', name: 'prepship.sync.shipments', state: 'active', started_on: FIVE_MIN_AGO }],
    OPTS,
  ),
  [],
);

// 3b) Belt: 20 min (> threshold) active shipments IS selected — the boundary holds.
check(
  'a 20-min-old active shipments job is selected (past the 15-min threshold)',
  selectStuckActiveJobs(
    [{ id: 'sh-3', name: 'prepship.sync.shipments', state: 'active', started_on: TWENTY_MIN_AGO }],
    OPTS,
  ),
  [{ id: 'sh-3', name: 'prepship.sync.shipments' }],
);

// 4) A created/completed shipments job is NOT selected (state filter) even if very old.
check(
  'a created/completed shipments job is not selected (state filter)',
  selectStuckActiveJobs(
    [
      { id: 'sh-c1', name: 'prepship.sync.shipments', state: 'created', started_on: null },
      { id: 'sh-c2', name: 'prepship.sync.shipments', state: 'completed', started_on: THREE_DAYS_AGO },
    ],
    OPTS,
  ),
  [],
);

// 4b) An active row with null started_on is not selected (cannot compute age).
check(
  'an active row with null started_on is not selected',
  selectStuckActiveJobs(
    [{ id: 'sh-null', name: 'prepship.sync.shipments', state: 'active', started_on: null }],
    OPTS,
  ),
  [],
);

// 5) Excluded side-effect jobs are NOT in the allow-list.
check(
  'external-shipped-classifier is NOT in REAPER_SAFE_JOB_NAMES',
  REAPER_SAFE_JOB_NAMES.includes('prepship.shipping.external-shipped-classifier'),
  false,
);
check(
  'fulfillment-outbox is NOT in REAPER_SAFE_JOB_NAMES',
  REAPER_SAFE_JOB_NAMES.includes('prepship.sync.fulfillment-outbox'),
  false,
);
check(
  'fees.walmart-sync is NOT in REAPER_SAFE_JOB_NAMES',
  REAPER_SAFE_JOB_NAMES.includes('prepship.fees.walmart-sync'),
  false,
);

// 5b) The expected idempotent jobs ARE in the allow-list.
check(
  'prepship.sync.shipments IS in REAPER_SAFE_JOB_NAMES',
  REAPER_SAFE_JOB_NAMES.includes('prepship.sync.shipments'),
  true,
);

// Mixed batch: only the safe, old, active rows survive (order preserved).
check(
  'a mixed batch selects only safe + old + active rows',
  selectStuckActiveJobs(
    [
      { id: 'o-1', name: 'prepship.sync.orders', state: 'active', started_on: THREE_DAYS_AGO },
      { id: 'ob-2', name: 'prepship.sync.fulfillment-outbox', state: 'active', started_on: THREE_DAYS_AGO },
      { id: 'sh-4', name: 'prepship.sync.shipments', state: 'active', started_on: FIVE_MIN_AGO },
      { id: 'tr-1', name: 'prepship.tracking.poll', state: 'active', started_on: THREE_DAYS_AGO },
    ],
    OPTS,
  ),
  [
    { id: 'o-1', name: 'prepship.sync.orders' },
    { id: 'tr-1', name: 'prepship.tracking.poll' },
  ],
);

if (failures > 0) {
  console.error(`\nFAIL PS-272 stuck-active reaper guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-272 stuck-active reaper guard');
