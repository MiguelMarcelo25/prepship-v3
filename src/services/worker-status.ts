import { env } from '../lib/env';
import { withDeadline } from '../lib/with-deadline';
import { getSetting, setSetting } from './settings';
import { recordWorkerStatusEvent } from './worker-status-events';

const WORKER_STATUS_KEY = 'worker.status.snapshot';
const WORKER_STATUS_STALE_SECONDS = 120;
const WORKER_STATUS_MODES = [
  'api-scheduler',
  'worker-scheduler',
  'print-worker',
  'placeholder',
  'disabled',
] as const;
const WORKER_STATUS_PERSIST_TIMEOUT_MS = Math.max(
  250,
  Math.min(5_000, Number(process.env.WORKER_STATUS_PERSIST_TIMEOUT_MS) || 3_000),
);
const WORKER_STATUS_PERSIST_ABANDON_MS = Math.max(
  15_000,
  Math.min(
    120_000,
    Number(process.env.WORKER_STATUS_PERSIST_ABANDON_MS) || 60_000
  ),
);

type WorkerMode = (typeof WORKER_STATUS_MODES)[number];
type WorkerJobStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export type WorkerJobSnapshot = {
  name: string;
  jobId?: string | null;
  generationId?: string | null;
  lane?: string | null;
  status: WorkerJobStatus;
  startedAt: string | null;
  deadlineAt?: string | null;
  timeoutMs?: number | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
};

export type WorkerStatusSnapshot = {
  version: 1;
  service: 'api' | 'worker';
  mode: WorkerMode;
  schedulerEnabled: boolean;
  placeholder: boolean;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  currentJob: string | null;
  activeLanes?: Record<string, Omit<WorkerActiveLaneStatus, 'ageSeconds'>>;
  syncWatermarks?: {
    ordersCompletedAt: string | null;
    shipmentsCompletedAt: string | null;
  };
  jobs: Record<string, WorkerJobSnapshot>;
};

export type WorkerActiveLaneStatus = {
  jobName: string;
  jobId: string | null;
  generationId: string | null;
  lane: string | null;
  startedAt: string | null;
  ageSeconds: number | null;
  deadlineAt: string | null;
  timeoutMs: number | null;
};

export type WorkerJobExecutionContext = {
  jobId?: string | null;
  generationId?: string | null;
  lane?: string | null;
  startedAtMs?: number;
  timeoutMs?: number | null;
};

const processStartedAt = new Date().toISOString();
let snapshot: WorkerStatusSnapshot = createSnapshot('disabled');
let persistSnapshotInFlight: Promise<void> | null = null;
let persistSnapshotStartedAtMs = 0;

function workerStatusSnapshotKey(mode: WorkerMode): string {
  return `${WORKER_STATUS_KEY}:${mode}`;
}

function createSnapshot(mode: WorkerMode): WorkerStatusSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    service: mode === 'api-scheduler' ? 'api' : 'worker',
    mode,
    schedulerEnabled: mode === 'api-scheduler' || mode === 'worker-scheduler',
    placeholder: mode === 'placeholder',
    pid: process.pid,
    startedAt: processStartedAt,
    heartbeatAt: now,
    currentJob: null,
    activeLanes: {},
    syncWatermarks: {
      ordersCompletedAt: null,
      shipmentsCompletedAt: null,
    },
    jobs: {},
  };
}

export function workerActiveLaneStatus(
  status: WorkerStatusSnapshot | null,
  nowMs: number = Date.now(),
): WorkerActiveLaneStatus | null {
  const jobName = status?.currentJob;
  const sharedLane = status?.activeLanes?.['shipstation-sync'];
  if (sharedLane) {
    const startedMs = sharedLane.startedAt ? Date.parse(sharedLane.startedAt) : Number.NaN;
    return {
      ...sharedLane,
      ageSeconds: Number.isFinite(startedMs)
        ? Math.max(0, Math.round((nowMs - startedMs) / 1_000))
        : null,
    };
  }
  if (!jobName) return null;
  const job = status.jobs[jobName];
  const startedMs = job?.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  return {
    jobName,
    jobId: job?.jobId ?? null,
    generationId: job?.generationId ?? null,
    lane: job?.lane ?? null,
    startedAt: job?.startedAt ?? null,
    ageSeconds: Number.isFinite(startedMs)
      ? Math.max(0, Math.round((nowMs - startedMs) / 1_000))
      : null,
    deadlineAt: job?.deadlineAt ?? null,
    timeoutMs: job?.timeoutMs ?? null,
  };
}

function summarizeResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const source = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'synced',
    'pages',
    'inserted',
    'updated',
    'matchedOrders',
    'ordersMarkedShipped',
    'processed',
    'succeeded',
    'failed',
    'skipped',
    'total',
    'refreshed',
    'days',
    'dailyRows',
    'skuRows',
    'inventoryRows',
    'billingRows',
    'lastSyncedAt',
  ]) {
    if (source[key] !== undefined) summary[key] = source[key];
  }
  return Object.keys(summary).length ? summary : null;
}

async function persistSnapshot(): Promise<void> {
  if (persistSnapshotInFlight) {
    const ageMs = Date.now() - persistSnapshotStartedAtMs;
    if (ageMs < WORKER_STATUS_PERSIST_ABANDON_MS) {
      console.warn('[worker-status] persist already in flight; skipping snapshot write');
      return;
    }
    console.warn(
      '[worker-status] abandoning stale status persist; allowing a fresh snapshot write'
    );
    persistSnapshotInFlight = null;
    persistSnapshotStartedAtMs = 0;
  }

  // Worker status is observability. A slow settings write must not hold sync lanes.
  let tracked: Promise<void>;
  persistSnapshotStartedAtMs = Date.now();
  tracked = (async () => {
    const serialized = JSON.stringify(snapshot);
    await setSetting(workerStatusSnapshotKey(snapshot.mode), serialized);
    // Keep the legacy key as the sync-scheduler view. The dedicated print
    // worker must not overwrite it or /sync/status will report scheduler=false.
    if (snapshot.schedulerEnabled) {
      await setSetting(WORKER_STATUS_KEY, serialized);
    }
  })()
    .catch((err) => {
      console.warn(
        '[worker-status] failed to persist status:',
        err instanceof Error ? err.message : err
      );
    })
    .finally(() => {
      if (persistSnapshotInFlight === tracked) {
        persistSnapshotInFlight = null;
        persistSnapshotStartedAtMs = 0;
      }
    });
  persistSnapshotInFlight = tracked;

  try {
    await withDeadline(
      () => tracked,
      WORKER_STATUS_PERSIST_TIMEOUT_MS,
      'worker-status persist'
    );
  } catch (err) {
    console.warn(
      '[worker-status] status persist exceeded deadline; continuing without blocking sync:',
      err instanceof Error ? err.message : err
    );
  }
}

export async function setWorkerMode(mode: WorkerMode): Promise<void> {
  const next = createSnapshot(mode);
  // PS-436: lane ownership is process-local, but completed order/shipment
  // watermarks are durable truth. Preserve only those completion timestamps
  // across worker restarts; never resurrect a prior process's currentJob.
  try {
    const priorRaw = await getSetting(workerStatusSnapshotKey(mode));
    const prior = priorRaw ? JSON.parse(priorRaw) as WorkerStatusSnapshot : null;
    if (prior?.syncWatermarks) {
      next.syncWatermarks = {
        ordersCompletedAt: prior.syncWatermarks.ordersCompletedAt ?? null,
        shipmentsCompletedAt: prior.syncWatermarks.shipmentsCompletedAt ?? null,
      };
    }
  } catch {
    // A missing/corrupt observability snapshot must not block worker startup.
  }
  snapshot = next;
  await persistSnapshot();
}

export async function recordWorkerHeartbeat(): Promise<void> {
  snapshot.heartbeatAt = new Date().toISOString();
  await persistSnapshot();
  // PS-256: best-effort durable event (no-op + zero cost when WORKER_STATUS_EVENTS_DURABLE off).
  void recordWorkerStatusEvent({
    service: snapshot.service,
    pid: snapshot.pid,
    eventType: 'heartbeat',
    details: { mode: snapshot.mode, currentJob: snapshot.currentJob },
  });
}

export async function recordWorkerJobStart(
  name: string,
  context: WorkerJobExecutionContext = {},
): Promise<void> {
  const startedAtMs = context.startedAtMs ?? Date.now();
  const now = new Date(startedAtMs).toISOString();
  const timeoutMs = context.timeoutMs ?? null;
  snapshot.currentJob = name;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    jobId: context.jobId ?? null,
    generationId: context.generationId ?? null,
    lane: context.lane ?? null,
    status: 'running',
    startedAt: now,
    deadlineAt: timeoutMs == null ? null : new Date(startedAtMs + timeoutMs).toISOString(),
    timeoutMs,
    finishedAt: null,
    durationMs: null,
    summary: null,
    error: null,
  };
  if (context.lane) {
    snapshot.activeLanes ??= {};
    snapshot.activeLanes[context.lane] = {
      jobName: name,
      jobId: context.jobId ?? null,
      generationId: context.generationId ?? null,
      lane: context.lane,
      startedAt: now,
      deadlineAt: timeoutMs == null ? null : new Date(startedAtMs + timeoutMs).toISOString(),
      timeoutMs,
    };
  }
  await persistSnapshot();
  // PS-256: best-effort durable event (no-op when flag off).
  void recordWorkerStatusEvent({
    service: snapshot.service,
    pid: snapshot.pid,
    eventType: 'job_start',
    jobName: name,
    details: {
      status: 'running',
      startedAt: now,
      jobId: context.jobId ?? null,
      generationId: context.generationId ?? null,
      lane: context.lane ?? null,
      deadlineAt: timeoutMs == null ? null : new Date(startedAtMs + timeoutMs).toISOString(),
      timeoutMs,
    },
  });
}

export async function recordWorkerJobSuccess(
  name: string,
  startedAtMs: number,
  result: unknown
): Promise<void> {
  const now = new Date().toISOString();
  const prior = snapshot.jobs[name];
  snapshot.currentJob = snapshot.currentJob === name ? null : snapshot.currentJob;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    ...prior,
    name,
    status: 'succeeded',
    startedAt: prior?.startedAt ?? new Date(startedAtMs).toISOString(),
    finishedAt: now,
    durationMs: Date.now() - startedAtMs,
    summary: summarizeResult(result),
    error: null,
  };
  if (prior?.lane && snapshot.activeLanes?.[prior.lane]?.jobId === (prior.jobId ?? null)) {
    delete snapshot.activeLanes[prior.lane];
  }
  if (name === 'prepship.sync.orders') {
    snapshot.syncWatermarks ??= { ordersCompletedAt: null, shipmentsCompletedAt: null };
    snapshot.syncWatermarks.ordersCompletedAt = now;
  } else if (name === 'prepship.sync.shipments') {
    snapshot.syncWatermarks ??= { ordersCompletedAt: null, shipmentsCompletedAt: null };
    snapshot.syncWatermarks.shipmentsCompletedAt = now;
  }
  await persistSnapshot();
  // PS-256: best-effort durable event (no-op when flag off).
  void recordWorkerStatusEvent({
    service: snapshot.service,
    pid: snapshot.pid,
    eventType: 'job_complete',
    jobName: name,
    details: { status: 'succeeded', durationMs: Date.now() - startedAtMs },
  });
}

export async function recordWorkerJobFailure(
  name: string,
  startedAtMs: number,
  err: unknown
): Promise<void> {
  const now = new Date().toISOString();
  const prior = snapshot.jobs[name];
  snapshot.currentJob = snapshot.currentJob === name ? null : snapshot.currentJob;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    ...prior,
    name,
    status: 'failed',
    startedAt: prior?.startedAt ?? new Date(startedAtMs).toISOString(),
    finishedAt: now,
    durationMs: Date.now() - startedAtMs,
    summary: null,
    error: err instanceof Error ? err.message : String(err),
  };
  if (prior?.lane && snapshot.activeLanes?.[prior.lane]?.jobId === (prior.jobId ?? null)) {
    delete snapshot.activeLanes[prior.lane];
  }
  await persistSnapshot();
  // PS-256: best-effort durable event (no-op when flag off).
  void recordWorkerStatusEvent({
    service: snapshot.service,
    pid: snapshot.pid,
    eventType: 'job_failed',
    jobName: name,
    details: {
      status: 'failed',
      durationMs: Date.now() - startedAtMs,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

export async function recordWorkerJobSkipped(
  name: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    status: 'skipped',
    startedAt: null,
    finishedAt: now,
    durationMs: null,
    summary: { reason },
    error: null,
  };
  await persistSnapshot();
}

export async function getPersistedWorkerStatus(): Promise<{
  status: WorkerStatusSnapshot | null;
  stale: boolean;
  heartbeatAgeSeconds: number | null;
  activeLane: WorkerActiveLaneStatus | null;
  snapshots: Record<
    string,
    {
      status: WorkerStatusSnapshot;
      stale: boolean;
      heartbeatAgeSeconds: number | null;
    }
  >;
}> {
  function parse(raw: string | null): {
    status: WorkerStatusSnapshot;
    stale: boolean;
    heartbeatAgeSeconds: number | null;
  } | null {
    if (!raw) return null;
    let status: WorkerStatusSnapshot;
    try {
      status = JSON.parse(raw) as WorkerStatusSnapshot;
    } catch {
      return null;
    }
    const heartbeatMs = Date.parse(status.heartbeatAt);
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
      ? Math.max(0, Math.round((Date.now() - heartbeatMs) / 1000))
      : null;
    return {
      status,
      stale: heartbeatAgeSeconds === null || heartbeatAgeSeconds > WORKER_STATUS_STALE_SECONDS,
      heartbeatAgeSeconds,
    };
  }

  const roleEntries = await Promise.all(
    WORKER_STATUS_MODES.map(
      async (mode) =>
        [mode, parse(await getSetting(workerStatusSnapshotKey(mode)))] as const,
    ),
  );
  const snapshots: Record<
    string,
    {
      status: WorkerStatusSnapshot;
      stale: boolean;
      heartbeatAgeSeconds: number | null;
    }
  > = {};
  for (const [mode, parsed] of roleEntries) {
    if (parsed) snapshots[mode] = parsed;
  }

  const schedulerSnapshots = Object.values(snapshots)
    .filter((entry) => entry.status.schedulerEnabled)
    .sort((a, b) => Date.parse(b.status.heartbeatAt) - Date.parse(a.status.heartbeatAt));
  const selectedScheduler =
    schedulerSnapshots.find((entry) => !entry.stale) ?? schedulerSnapshots[0] ?? null;
  const legacy = parse(await getSetting(WORKER_STATUS_KEY));
  const selected = selectedScheduler ?? legacy ?? null;

  if (!selected) {
    return {
      status: null,
      stale: true,
      heartbeatAgeSeconds: null,
      activeLane: null,
      snapshots,
    };
  }
  return {
    ...selected,
    activeLane: workerActiveLaneStatus(selected.status),
    snapshots,
  };
}

export function getApiRuntimeStatus() {
  return {
    schedulerEnabled: env.RUN_SYNC_SCHEDULER,
    workerPlaceholder: env.WORKER_PLACEHOLDER,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: processStartedAt,
  };
}
