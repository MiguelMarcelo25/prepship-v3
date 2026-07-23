import 'dotenv/config';
import postgres from 'postgres';

const LEGACY_SESSION_LOCK_NAMES = [
  'prepship.worker.shipstation-carrier-account-snapshots',
  'prepship.scheduler.Shopify orders sync',
  'prepship.scheduler.inventory import-from-orders',
  'prepship.scheduler.inventory sync-products',
  'prepship.scheduler.fulfillment outbox',
  'prepship.scheduler.reporting metrics refresh',
  'prepship.scheduler.external-shipped classifier',
  'prepship.scheduler.shipment tracking poll',
  'prepship.scheduler.walmart fees sync',
] as const;

const EXPECTED_LOCK_NAMES = [
  'prepship.worker.shipstation-stately-consumers',
  'prepship.sync.lane.shipstation-sync',
] as const;

type LockOverviewRow = {
  application_name: string;
  ownership_signal: 'session_idle' | 'transaction_active';
  lock_count: number;
  all_granted: boolean;
  max_age_seconds: number;
};

type NamedLockRow = {
  lockName: string;
  category: 'legacy' | 'expected';
  lockCount: number;
  sessionIdleCount: number;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const lockSql = postgres(databaseUrl, {
  prepare: false,
  max: 1,
  connect_timeout: 10,
  idle_timeout: 5,
  connection: {
    application_name: 'ps439-readonly-lock-audit',
    statement_timeout: 10_000,
  },
});

try {
  const report = await lockSql.begin(async (tx) => {
    await tx`set transaction read only`;
    const overview = await tx<LockOverviewRow[]>`
      select
        coalesce(nullif(a.application_name, ''), 'unnamed') as application_name,
        case
          when a.xact_start is null then 'session_idle'
          else 'transaction_active'
        end as ownership_signal,
        count(*)::int as lock_count,
        bool_and(l.granted) as all_granted,
        max(
          extract(epoch from (now() - coalesce(a.xact_start, a.backend_start)))::int
        )::int as max_age_seconds
      from pg_locks l
      join pg_stat_activity a using (pid)
      where l.locktype = 'advisory'
      group by 1, 2
      order by 1, 2
    `;

    const named: NamedLockRow[] = [];
    for (const [category, names] of [
      ['legacy', LEGACY_SESSION_LOCK_NAMES],
      ['expected', EXPECTED_LOCK_NAMES],
    ] as const) {
      for (const lockName of names) {
        const [row] = await tx<Array<{ lock_count: number; session_idle_count: number }>>`
          with lock_key as (
            select hashtext(${lockName})::bigint as value
          )
          select
            count(l.pid)::int as lock_count,
            count(l.pid) filter (where a.xact_start is null)::int as session_idle_count
          from lock_key k
          left join pg_locks l
            on l.locktype = 'advisory'
           and l.classid::bigint = ((k.value >> 32) & 4294967295)
           and l.objid::bigint = (k.value & 4294967295)
           and l.objsubid = 1
          left join pg_stat_activity a using (pid)
        `;
        named.push({
          lockName,
          category,
          lockCount: Number(row?.lock_count ?? 0),
          sessionIdleCount: Number(row?.session_idle_count ?? 0),
        });
      }
    }

    return { overview, named };
  });

  const legacyLocksHeld = report.named
    .filter((row) => row.category === 'legacy' && row.lockCount > 0);
  const unnamedIdleLocks = report.overview
    .filter(
      (row) => row.application_name === 'unnamed' && row.ownership_signal === 'session_idle',
    )
    .reduce((total, row) => total + Number(row.lock_count), 0);
  const status = legacyLocksHeld.length === 0 && unnamedIdleLocks === 0
    ? 'pass'
    : 'attention';

  console.log(JSON.stringify({
    taskId: 'PS-439',
    mode: 'transaction-read-only',
    status,
    legacyLocksHeld,
    unnamedIdleLocks,
    overview: report.overview,
    namedLocks: report.named,
  }));
  if (status !== 'pass') process.exitCode = 1;
} finally {
  await lockSql.end({ timeout: 1 });
}
