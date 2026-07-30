// PS-471: a periodic tick must never BLOCK on its advisory lock.
//
// 2026-07-30 outage. One transaction was stranded holding
// `shipment_sync.watchdog.tick` (idle in transaction, wait_event=ClientRead,
// 88 minutes, backend_xid NULL). Because the watchdog acquired that lock with
// the BLOCKING pg_advisory_xact_lock, every later tick queued behind the zombie
// and pinned a Supavisor connection for up to statement_timeout. Pooler
// capacity bled away tick by tick: brief 500s, then ~2s stalls, then 24-30s
// stalls on every endpoint including trivial ones. Postgres itself stayed idle
// the whole time -- 1 active query, 27/120 connections. Connections were simply
// never reaching it.
//
// This guard pins BOTH directions, and the second matters as much as the first:
// the periodic caller must skip, and the read-modify-write callers must still
// WAIT. Converting those to try-locks would silently drop writes.
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const owner = readFileSync('src/lib/advisory-session-lock.ts', 'utf8');
const watchdog = readFileSync('src/services/shipment-sync-watchdog.ts', 'utf8');
const comboDefaults = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
const accountState = readFileSync('src/services/shipstation-sync-account-state.ts', 'utf8');
const billing = readFileSync('src/services/billing.ts', 'utf8');
const envFile = readFileSync('src/lib/env.ts', 'utf8');

// --- the canonical owner exposes both primitives -------------------------
check(
  'owner exports a non-blocking tryAdvisoryTransactionLock',
  /export async function tryAdvisoryTransactionLock</.test(owner),
);
check(
  'try variant uses pg_try_advisory_xact_lock',
  owner.includes('pg_try_advisory_xact_lock'),
);
check(
  'try variant reports not-acquired instead of throwing',
  owner.includes('acquired: false'),
);
check(
  'owner still exposes the blocking withAdvisoryTransactionLock',
  /export async function withAdvisoryTransactionLock</.test(owner),
);
check(
  'blocking variant still uses blocking pg_advisory_xact_lock',
  /await transaction`SELECT pg_advisory_xact_lock\(/.test(owner),
);

// --- stranded transactions are bounded -----------------------------------
// SET LOCAL, not a pool startup parameter. The outage showed a waiter surviving
// 85s against a 12s DB_STATEMENT_TIMEOUT_MS, so postgres.js `connection: {...}`
// startup params are not reliably honoured through Supavisor transaction
// pooling. SET LOCAL is transaction-scoped and applies.
check(
  'owner bounds idle-in-transaction with SET LOCAL',
  owner.includes('SET LOCAL idle_in_transaction_session_timeout'),
);
check(
  'idle bound is applied inside BOTH lock variants',
  (owner.match(/await boundIdleInTransaction\(transaction\)/g) ?? []).length >= 2,
);
check(
  'idle bound is configurable via validated env',
  envFile.includes('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS')
    && owner.includes('env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'),
);

// --- the periodic caller SKIPS -------------------------------------------
check(
  'watchdog tick acquires the lock without blocking',
  watchdog.includes('tryAdvisoryTransactionLock(WATCHDOG_TICK_LOCK'),
);
check(
  'watchdog no longer blocks on the tick lock',
  !watchdog.includes('withAdvisoryTransactionLock(WATCHDOG_TICK_LOCK'),
);
check(
  'watchdog imports only the non-blocking primitive',
  !/import \{[^}]*withAdvisoryTransactionLock[^}]*\} from '\.\.\/lib\/advisory-session-lock'/
    .test(watchdog),
);
check(
  'a skipped tick returns a status instead of throwing',
  /if \(outcome\.acquired\) return outcome\.value;/.test(watchdog)
    && watchdog.includes('advanceBacklogCounter: false'),
);
// The skipped tick must not duplicate the work the lock holder is doing.
// persistWatchdogSnapshot / runRecoveryAction stay inside the acquired branch.
check(
  'a skipped tick does not persist a snapshot or run recovery',
  watchdog.indexOf('await persistWatchdogSnapshot(finalStatus)')
    < watchdog.indexOf('if (outcome.acquired) return outcome.value;'),
);

// --- read-modify-write callers MUST still block --------------------------
// Skipping here would drop a write, not just delay it. Anyone "fixing" these
// the same way the watchdog was fixed must fail this guard.
check(
  'combo package defaults still block',
  comboDefaults.includes('withAdvisoryTransactionLock(')
    && !comboDefaults.includes('tryAdvisoryTransactionLock('),
);
check(
  'shipstation account-state snapshot still blocks',
  accountState.includes('withAdvisoryTransactionLock(')
    && !accountState.includes('tryAdvisoryTransactionLock('),
);
check(
  'billing storage writer still blocks',
  billing.includes('pg_advisory_xact_lock')
    && !billing.includes('pg_try_advisory_xact_lock'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-471 advisory lock safety guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-471 advisory lock safety guard');
