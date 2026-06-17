// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears
// stale pgboss active rows only, never shipped/cancelled order/shipment data.
/**
 * PS-272 — stuck-active reaper ON-PATH guard (FAKE in-memory db, NO real DB, NO network).
 *
 * The sibling ps-272-stuck-job-reaper-guard.ts pins the PURE selectStuckActiveJobs selector. This
 * guard pins the EFFECTFUL reapStuckActiveJobs flow end-to-end against a fake in-memory `job` table:
 *
 *   1. OFF flag (the default, SYNC_STUCK_JOB_REAPER unset) -> the REAL reapStuckActiveJobs returns
 *      { enabled:false, scanned:0, reaped:0, names:[] } and issues ZERO SQL (true no-op: no DB).
 *   2. ON flag -> the reaper's runtime sequence (SELECT active+allow-listed -> selectStuckActiveJobs
 *      -> UPDATE only the stuck ids) selects ONLY allow-listed rows older than 15 min, and a
 *      fulfillment-outbox row (real ship-confirms) is NEVER in the UPDATE id set.
 *   3. The UPDATE is doubly-guarded: it carries the safe allow-list AND only the selected ids, so a
 *      side-effect job can never be flipped even if a future SELECT widened.
 *
 * The ON case re-enacts the reaper with the REAL exported owner logic (selectStuckActiveJobs +
 * REAPER_SAFE_JOB_NAMES + REAPER_MIN_ACTIVE_AGE_MS) wired to a fake tagged-template `pg` recorder, so
 * it stays faithful to src/services/sync-stuck-job-reaper.ts without ever opening a connection.
 *
 *   npx tsx scripts/ps-272-reaper-onpath-guard.ts
 */

// Provide the env vars the module tree validates at import-time (zod). Set BEFORE importing anything
// that pulls src/lib/env.ts, and force the reaper flag OFF so the real OFF-path call below is inert.
process.env.DATABASE_URL ??= 'postgres://guard:guard@127.0.0.1:5432/guard';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY ??= 'guard-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'guard-service';
process.env.SUPABASE_JWT_SECRET ??= 'guard-jwt';
process.env.SYNC_STUCK_JOB_REAPER = 'false';

import {
  REAPER_MIN_ACTIVE_AGE_MS,
  REAPER_SAFE_JOB_NAMES,
  reapStuckActiveJobs,
  selectStuckActiveJobs,
} from '../src/services/sync-stuck-job-reaper';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// The OFF path asserts directly on the REAL reapStuckActiveJobs (see main): with SYNC_STUCK_JOB_REAPER
// forced off above it early-returns zeros and never reaches any SQL — if it did, the real postgres-js
// client would lazily try to connect and the guard would surface that. The ON path below re-enacts the
// reaper flow against a fake in-memory db using the REAL exported owner logic.
type FakeJobRow = {
  id: string;
  name: string;
  state: string;
  started_on: string | Date | null;
};

type SqlCall = { kind: 'select' | 'update' | 'other'; ids?: string[]; names?: string[] };

/**
 * A fake tagged-template `pg` that mimics the postgres-js call shape used by reapStuckActiveJobs:
 *   - pg(identifier) -> an opaque identifier token (the `${schema}.job` table)
 *   - pg`SELECT ... WHERE state='active' AND name = ANY(${names})` -> returns the matching active rows
 *   - pg`UPDATE ... WHERE id = ANY(${ids}) AND ... name = ANY(${names})` -> records the flip, no return
 * It records every SQL call so the guard can assert exactly which ids/names were touched.
 */
function makeFakePg(table: FakeJobRow[]) {
  const calls: SqlCall[] = [];
  const IDENT = Symbol('pg-identifier');
  const pg = (strings: TemplateStringsArray | string, ...values: unknown[]): unknown => {
    // Identifier path: pg(jobTable) -> a single non-array string arg, no template.
    if (typeof strings === 'string') {
      return { [IDENT]: strings };
    }
    const text = strings.join(' ').toUpperCase();
    if (text.includes('SELECT')) {
      const names = (values.find((v) => Array.isArray(v)) as string[]) ?? [];
      calls.push({ kind: 'select', names });
      const nameSet = new Set(names);
      const rows = table.filter((r) => r.state === 'active' && nameSet.has(r.name));
      return Promise.resolve(rows);
    }
    if (text.includes('UPDATE')) {
      // Two array params in source order: first the ids (id = ANY(${ids})), then the allow-list.
      const arrays = values.filter((v) => Array.isArray(v)) as string[][];
      const ids = arrays[0] ?? [];
      const names = arrays[1] ?? [];
      calls.push({ kind: 'update', ids, names });
      const idSet = new Set(ids);
      const nameSet = new Set(names);
      for (const r of table) {
        if (idSet.has(r.id) && r.state === 'active' && nameSet.has(r.name)) {
          r.state = 'failed';
        }
      }
      return Promise.resolve([]);
    }
    calls.push({ kind: 'other' });
    return Promise.resolve([]);
  };
  return { pg, calls };
}

/**
 * Re-enact reapStuckActiveJobs against a fake pg, using the REAL exported owner logic. Mirrors
 * src/services/sync-stuck-job-reaper.ts step-for-step (SELECT -> selectStuckActiveJobs -> UPDATE).
 */
async function reapWithFakePg(
  fake: ReturnType<typeof makeFakePg>,
  nowMs: number,
): Promise<{ scanned: number; reaped: number; names: string[] }> {
  const { pg } = fake;
  const jobTable = 'pgboss.job';
  const rows = (await (pg as (s: TemplateStringsArray | string, ...v: unknown[]) => Promise<FakeJobRow[]>)`
    SELECT id::text AS id, name, state, started_on
    FROM ${(pg as (s: string) => unknown)(jobTable)}
    WHERE state = 'active'
      AND name = ANY(${REAPER_SAFE_JOB_NAMES as string[]})
  `) as unknown as FakeJobRow[];

  const stuck = selectStuckActiveJobs(rows, {
    nowMs,
    minActiveAgeMs: REAPER_MIN_ACTIVE_AGE_MS,
  });

  if (stuck.length === 0) {
    return { scanned: rows.length, reaped: 0, names: [] };
  }

  const ids = stuck.map((s) => s.id);
  await (pg as (s: TemplateStringsArray | string, ...v: unknown[]) => Promise<unknown>)`
    UPDATE ${(pg as (s: string) => unknown)(jobTable)}
    SET state = 'failed'
    WHERE id = ANY(${ids})
      AND state = 'active'
      AND name = ANY(${REAPER_SAFE_JOB_NAMES as string[]})
  `;

  return { scanned: rows.length, reaped: stuck.length, names: stuck.map((s) => s.name) };
}

const NOW_MS = Date.parse('2026-06-17T12:00:00.000Z');
const THREE_DAYS_AGO = new Date(NOW_MS - 3 * 24 * 60 * 60_000).toISOString();
const FIVE_MIN_AGO = new Date(NOW_MS - 5 * 60_000).toISOString();

async function main(): Promise<void> {
  // 1) OFF path: real reaper, zero SQL.
  const off = await reapStuckActiveJobs();
  check('OFF: real reaper returns enabled=false (inert)', off.enabled === false);
  check('OFF: real reaper reaped 0 / scanned 0 (no DB touched)', off.reaped === 0 && off.scanned === 0);
  check('OFF: real reaper returns an empty names list', off.names.length === 0);

  // 2) ON path: a backlog with both safe-stuck rows and an excluded outbox row.
  const table: FakeJobRow[] = [
    { id: 'o-1', name: 'prepship.sync.orders', state: 'active', started_on: THREE_DAYS_AGO },
    { id: 'sh-1', name: 'prepship.sync.shipments', state: 'active', started_on: THREE_DAYS_AGO },
    { id: 'sh-young', name: 'prepship.sync.shipments', state: 'active', started_on: FIVE_MIN_AGO },
    { id: 'ob-1', name: 'prepship.sync.fulfillment-outbox', state: 'active', started_on: THREE_DAYS_AGO },
    { id: 'cl-1', name: 'prepship.shipping.external-shipped-classifier', state: 'active', started_on: THREE_DAYS_AGO },
    { id: 'done-1', name: 'prepship.sync.orders', state: 'completed', started_on: THREE_DAYS_AGO },
  ];
  const fake = makeFakePg(table);
  const res = await reapWithFakePg(fake, NOW_MS);

  check('ON: only the two old, safe, active rows are reaped', res.reaped === 2);
  check(
    'ON: reaped names are exactly orders + shipments (order preserved)',
    JSON.stringify(res.names) === JSON.stringify(['prepship.sync.orders', 'prepship.sync.shipments']),
  );

  const selectCall = fake.calls.find((c) => c.kind === 'select');
  const updateCall = fake.calls.find((c) => c.kind === 'update');
  check('ON: a SELECT was issued', selectCall != null);
  check('ON: an UPDATE was issued', updateCall != null);

  // The SELECT is already narrowed to the allow-list (belt) — the outbox/classifier never even surface.
  check(
    'ON: SELECT name filter carries the allow-list (no side-effect job names)',
    !!selectCall?.names &&
      !selectCall.names.includes('prepship.sync.fulfillment-outbox') &&
      !selectCall.names.includes('prepship.shipping.external-shipped-classifier'),
  );

  // The UPDATE id set NEVER contains the excluded outbox / classifier / young / completed rows.
  const updIds = updateCall?.ids ?? [];
  check('ON: UPDATE never touches the fulfillment-outbox id', !updIds.includes('ob-1'));
  check('ON: UPDATE never touches the external-shipped-classifier id', !updIds.includes('cl-1'));
  check('ON: UPDATE never touches the < 15-min young shipments id', !updIds.includes('sh-young'));
  check('ON: UPDATE never touches the completed row id', !updIds.includes('done-1'));
  check(
    'ON: UPDATE id set is exactly the two stuck safe rows',
    JSON.stringify([...updIds].sort()) === JSON.stringify(['o-1', 'sh-1']),
  );

  // The UPDATE is doubly-guarded with the allow-list too (belt-and-suspenders with the id set).
  check(
    'ON: UPDATE name filter ALSO carries the allow-list (double guard)',
    !!updateCall?.names &&
      !updateCall.names.includes('prepship.sync.fulfillment-outbox') &&
      updateCall.names.includes('prepship.sync.shipments'),
  );

  // The fake table reflects only the safe rows flipped to 'failed'; outbox stays 'active'.
  check(
    'ON: in the fake db the outbox row is STILL active (never flipped)',
    table.find((r) => r.id === 'ob-1')?.state === 'active',
  );
  check(
    'ON: in the fake db both stuck safe rows are now failed',
    table.find((r) => r.id === 'o-1')?.state === 'failed' &&
      table.find((r) => r.id === 'sh-1')?.state === 'failed',
  );

  // 3) ON path with NO stuck rows -> a SELECT but NO UPDATE (no needless write).
  const fake2 = makeFakePg([
    { id: 'sh-y', name: 'prepship.sync.shipments', state: 'active', started_on: FIVE_MIN_AGO },
    { id: 'ob-y', name: 'prepship.sync.fulfillment-outbox', state: 'active', started_on: THREE_DAYS_AGO },
  ]);
  const res2 = await reapWithFakePg(fake2, NOW_MS);
  check('ON (no stuck): reaped 0', res2.reaped === 0);
  check('ON (no stuck): a SELECT ran but NO UPDATE was issued', fake2.calls.some((c) => c.kind === 'select') && !fake2.calls.some((c) => c.kind === 'update'));

  if (failures > 0) {
    console.error(`\nFAIL PS-272 reaper on-path guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-272 reaper on-path guard');
  // The OFF reaper never opens a connection (lazy postgres-js client), but importing db/client.js
  // constructs the pool; exit cleanly so an idle pool can't keep the loop alive.
  process.exit(0);
}

void main();
