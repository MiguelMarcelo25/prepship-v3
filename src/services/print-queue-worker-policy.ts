export const PRINT_QUEUE_WORKER_STALE_AFTER_MS = 210_000;
export const PRINT_QUEUE_SEND_JOB_NAME = 'prepship.print-queue.batch-send';
export const PRINT_QUEUE_WORKER_FATAL_WINDOW_MS = 120_000;
export const PRINT_QUEUE_WORKER_TIMEOUT_FAILURE_LIMIT = 3;
export const PRINT_QUEUE_WORKER_CLOCK_SKEW_LIMIT = 2;
/** Consecutive dropped connections inside the window before the worker exits. */
export const PRINT_QUEUE_WORKER_CONNECTION_LOSS_LIMIT = 2;

export type PrintQueueWorkerConnectionInput = {
  databaseUrl: string;
  dedicatedDatabaseUrl?: string;
  nodeEnv: 'development' | 'production' | 'test';
  runWorker: boolean;
};

export type PrintQueueWorkerHealthFacts = {
  expected: boolean;
  heartbeatAgeSeconds: number | null;
  queueReadOk: boolean;
  durableReadOk: boolean;
  pgBossCreated: number;
  pgBossRetry: number;
  pgBossActive: number;
  pgBossNewestFailureAgeSeconds: number | null;
  pgBossOldestPendingAgeSeconds: number | null;
  pgBossOldestActiveAgeSeconds: number | null;
  durableActive: number;
  durableOldestActiveAgeSeconds: number | null;
  providerPending: number;
  lastWorkerJobStatus: string | null;
  lastWorkerJobAgeSeconds: number | null;
};

export type PrintQueueWorkerHealthVerdict = {
  status: 'ok' | 'fail';
  reasons: string[];
  restartRequired: boolean;
};

export type PrintQueueWorkerFatalSignal =
  | 'statement_timeout'
  | 'idle_in_transaction_timeout'
  | 'timekeeper_skew'
  // A dropped connection is worse than a timeout: pg-boss stops polling but
  // the process keeps running, so Render still reports the worker healthy
  // while it consumes nothing. Observed 2026-07-27 as repeated
  // "read ECONNABORTED" followed by 17 minutes of total silence.
  | 'connection_lost';

export type PrintQueueWorkerFatalSignalState = Record<PrintQueueWorkerFatalSignal, number[]>;

export function isSupabaseTransactionPoolerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543';
  } catch {
    return false;
  }
}

export function resolvePrintQueueWorkerDatabaseUrl(
  input: PrintQueueWorkerConnectionInput,
): string {
  const selected = input.dedicatedDatabaseUrl?.trim() || input.databaseUrl;
  const requiresDedicated = input.nodeEnv === 'production' && input.runWorker;

  if (requiresDedicated && !input.dedicatedDatabaseUrl?.trim()) {
    throw new Error(
      'PRINT_QUEUE_PG_BOSS_DATABASE_URL is required for the production Print Queue worker.',
    );
  }
  if (isSupabaseTransactionPoolerUrl(selected)) {
    throw new Error(
      'The Print Queue worker cannot use the Supabase transaction pooler on port 6543; configure a direct or session-mode port 5432 URL.',
    );
  }
  return selected;
}

export function evaluateQueueSendWorkerAdmission(input: {
  snapshotPresent: boolean;
  snapshotStatus: string | null;
  snapshotRecoveryAttempt: number | null;
  payloadRecoveryAttempt: number;
}): { admit: boolean; reason: string } {
  if (!input.snapshotPresent) return { admit: false, reason: 'durable_snapshot_missing' };
  if (input.snapshotStatus !== 'pending' && input.snapshotStatus !== 'running') {
    return { admit: false, reason: 'durable_job_not_active' };
  }
  if (input.snapshotRecoveryAttempt !== input.payloadRecoveryAttempt) {
    return { admit: false, reason: 'stale_recovery_generation' };
  }
  return { admit: true, reason: 'current_generation' };
}

export function canAutomaticallyRecoverQueueSendJob(providerPendingCount: number): boolean {
  return Number.isFinite(providerPendingCount) && providerPendingCount === 0;
}

export function evaluatePrintQueueWorkerHealth(
  facts: PrintQueueWorkerHealthFacts,
  staleAfterMs = PRINT_QUEUE_WORKER_STALE_AFTER_MS,
): PrintQueueWorkerHealthVerdict {
  if (!facts.expected) return { status: 'ok', reasons: [], restartRequired: false };

  const staleAfterSeconds = Math.ceil(staleAfterMs / 1000);
  const reasons: string[] = [];
  const restartReasons: string[] = [];
  const addRestartReason = (reason: string) => {
    reasons.push(reason);
    restartReasons.push(reason);
  };

  if (!facts.queueReadOk) addRestartReason('pgboss_health_read_failed');
  if (!facts.durableReadOk) addRestartReason('durable_health_read_failed');
  if (facts.heartbeatAgeSeconds === null) addRestartReason('worker_heartbeat_missing');
  else if (facts.heartbeatAgeSeconds > staleAfterSeconds) {
    addRestartReason('worker_heartbeat_stale');
  }
  if (
    facts.durableActive > 0 &&
    (facts.durableOldestActiveAgeSeconds === null ||
      facts.durableOldestActiveAgeSeconds > staleAfterSeconds)
  ) {
    addRestartReason('durable_batch_stale');
  }
  if (
    facts.pgBossCreated + facts.pgBossRetry > 0 &&
    (facts.pgBossOldestPendingAgeSeconds === null ||
      facts.pgBossOldestPendingAgeSeconds > staleAfterSeconds)
  ) {
    addRestartReason('pgboss_claim_stale');
  }
  if (
    facts.pgBossActive > 0 &&
    (facts.pgBossOldestActiveAgeSeconds === null ||
      facts.pgBossOldestActiveAgeSeconds > staleAfterSeconds) &&
    (facts.durableActive === 0 ||
      facts.durableOldestActiveAgeSeconds === null ||
      facts.durableOldestActiveAgeSeconds > staleAfterSeconds)
  ) {
    addRestartReason('pgboss_active_without_progress');
  }
  if (
    facts.pgBossNewestFailureAgeSeconds !== null &&
    facts.pgBossNewestFailureAgeSeconds <= staleAfterSeconds &&
    facts.pgBossCreated + facts.pgBossRetry + facts.pgBossActive > 0
  ) {
    reasons.push('pgboss_recent_failure');
  }
  if (
    facts.lastWorkerJobStatus === 'failed' &&
    facts.lastWorkerJobAgeSeconds !== null &&
    facts.lastWorkerJobAgeSeconds <= staleAfterSeconds &&
    facts.pgBossCreated + facts.pgBossRetry + facts.pgBossActive > 0
  ) {
    reasons.push('worker_job_recent_failure');
  }
  if (facts.providerPending > 0) reasons.push('provider_reconciliation_required');

  return {
    status: reasons.length > 0 ? 'fail' : 'ok',
    reasons,
    restartRequired: restartReasons.length > 0,
  };
}

export function createPrintQueueWorkerFatalSignalState(): PrintQueueWorkerFatalSignalState {
  return {
    statement_timeout: [],
    idle_in_transaction_timeout: [],
    timekeeper_skew: [],
    connection_lost: [],
  };
}

export function recordPrintQueueWorkerFatalSignal(
  state: PrintQueueWorkerFatalSignalState,
  signal: PrintQueueWorkerFatalSignal,
  nowMs = Date.now(),
): { state: PrintQueueWorkerFatalSignalState; fatal: boolean } {
  const cutoff = nowMs - PRINT_QUEUE_WORKER_FATAL_WINDOW_MS;
  const next: PrintQueueWorkerFatalSignalState = {
    statement_timeout: state.statement_timeout.filter((at) => at >= cutoff),
    idle_in_transaction_timeout: state.idle_in_transaction_timeout.filter((at) => at >= cutoff),
    timekeeper_skew: state.timekeeper_skew.filter((at) => at >= cutoff),
    connection_lost: state.connection_lost.filter((at) => at >= cutoff),
  };
  next[signal] = [...next[signal], nowMs];
  const timeoutFailures = next.statement_timeout.length + next.idle_in_transaction_timeout.length;
  return {
    state: next,
    fatal:
      timeoutFailures >= PRINT_QUEUE_WORKER_TIMEOUT_FAILURE_LIMIT ||
      next.timekeeper_skew.length >= PRINT_QUEUE_WORKER_CLOCK_SKEW_LIMIT ||
      // Lower bar than timeouts on purpose. A timeout means a query failed but
      // the loop is alive; a dropped connection can mean the loop is already
      // dead, and every extra second is a queue nobody is draining.
      next.connection_lost.length >= PRINT_QUEUE_WORKER_CONNECTION_LOSS_LIMIT,
  };
}

export function classifyPrintQueueWorkerFatalError(
  error: unknown,
): Exclude<PrintQueueWorkerFatalSignal, 'timekeeper_skew'> | null {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = typeof candidate?.message === 'string'
    ? candidate.message.toLowerCase()
    : String(error ?? '').toLowerCase();
  if (code === '25P03' || message.includes('idle-in-transaction timeout')) {
    return 'idle_in_transaction_timeout';
  }
  if (code === '57014' || message.includes('statement timeout')) return 'statement_timeout';
  // Socket-level drops and server-side disconnects. Previously every one of
  // these fell through to null, so the worker logged the error and kept
  // running with a pg-boss loop that had already stopped claiming jobs.
  if (
    code === 'ECONNABORTED'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
    || code === 'ENOTFOUND'
    // 08006 connection_failure, 08003 connection_does_not_exist,
    // 08001 unable_to_connect, 57P01 admin_shutdown, 57P02 crash_shutdown,
    // 57P03 cannot_connect_now.
    || code === '08006'
    || code === '08003'
    || code === '08001'
    || code === '57P01'
    || code === '57P02'
    || code === '57P03'
    || message.includes('econnaborted')
    || message.includes('econnreset')
    || message.includes('connection terminated')
    || message.includes('connection closed')
    || message.includes('server closed the connection')
    || message.includes('terminating connection')
  ) {
    return 'connection_lost';
  }
  return null;
}
